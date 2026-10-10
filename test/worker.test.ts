import { readdirSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { expect } from "@effect/vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import Stack from "../alchemy.run.ts";
import { browser, newAddress, newNetwork, type Browser } from "./support/browser.ts";
import { startFakeGoogle, type GoogleAccount } from "./support/fake-google.ts";
import { authorizeUrl, exchange, mcp, REDIRECT_URI, register } from "./support/mcp-client.ts";

// Runs the whole stack on Alchemy's local simulators: the Worker in workerd, with local D1,
// R2, and KV behind its bindings. Nothing here touches a Cloudflare account, and nothing
// calls Google. The Worker's two calls to Google go to a stand-in on this machine, which
// knows the OAuth client the tests pretend the User created.
const GOOGLE_CLIENT = { id: "test-google-client", secret: "test-google-secret" };
const google = await startFakeGoogle(GOOGLE_CLIENT);

const { test, beforeAll, afterAll, deploy } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

// The tests bring their own sign-in settings, so they pass on a fresh clone and are not
// changed by whatever a local .env holds.
const SETTINGS: Record<string, string | undefined> = {
  GOOGLE_CLIENT_ID: GOOGLE_CLIENT.id,
  GOOGLE_CLIENT_SECRET: GOOGLE_CLIENT.secret,
  GOOGLE_TOKEN_URL: google.tokenUrl,
  GOOGLE_USERINFO_URL: google.userinfoUrl,
  ALLOWED_EMAILS: " Allowed@Example.com , second@example.com ",
};

// Deploys the stack with those settings, or with some of them changed or left unset, the
// way the User would after editing .env. For these names the tests are the only source, so a
// setting left unset here stays unset whatever the environment or .env says. Everything else
// is still read from there. A second deploy replaces the Worker in place: it keeps its
// address, its KV, and its database.
const deployWith = (changed: Record<string, string | undefined> = {}) =>
  Effect.flatMap(ConfigProvider.ConfigProvider, (environment) => {
    const settings = { ...SETTINGS, ...changed };
    const fromTests = ConfigProvider.fromEnv({
      env: Object.fromEntries(
        Object.entries(settings).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
    });
    return deploy(Stack).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.make((path) =>
          (String(path[0]) in settings ? fromTests : environment).load(path),
        ),
      ),
    );
  });

// There is no `afterAll(destroy(Stack))`. In 2.0.0-beta.81 it never returns behind the
// harness's sidecar process, and the sidecar stays on because it is how `alchemy dev` runs.
// So this stack's local state stays in .alchemy/ between runs, and these tests have to keep
// passing against whatever an earlier run left there.
const stack = beforeAll(
  Effect.gen(function* () {
    const outputs = yield* deployWith();
    // The OAuth metadata needs no token, so it answers as soon as workerd is serving.
    yield* Test.getWhenReady(`${outputs.url}/.well-known/oauth-authorization-server`);
    return outputs;
  }),
);

afterAll(Effect.promise(() => google.close()));

// A test body that talks to the Worker over HTTP, given its address.
const onWorker = (body: (url: string) => Promise<void>) =>
  Effect.flatMap(stack, ({ url }) => Effect.promise(() => body(url!)));

// A Google account whose email is on the allowlist. The setting spells it
// " Allowed@Example.com " and Google spells it another way again, so a sign-in only works
// if both sides are compared ignoring case and the spaces around them.
const ALLOWED_ACCOUNT: GoogleAccount = {
  sub: "1001",
  email: "ALLOWED@example.COM",
  email_verified: true,
  name: "Pat Example",
};

// A call to a tool, and the tool result the Worker answers with.
const callTool = async (url: string, token: string, name: string, input: unknown = {}) => {
  const call = { method: "tools/call", params: { name, arguments: input } };
  return (await mcp(url, call, token)).message as {
    result?: { isError?: boolean; content: [{ type: string; text: string }] };
    error?: { code: number; message: string };
  };
};

// The names the migrations create.
const created = (kind: "TABLE" | "VIEW") => {
  const dir = new URL("../migrations/", import.meta.url);
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .flatMap((name) => [
      ...readFileSync(new URL(name, dir), "utf8").matchAll(
        new RegExp(`^CREATE ${kind} (\\w+)`, "gm"),
      ),
    ])
    .map((match) => match[1])
    .sort();
};

const consentHandle = (html: string) => /name="handle" value="([^"]+)"/.exec(html)![1]!;

// A new client registers and sends a person to the sign-in page, from the same address.
const openSignIn = async (url: string) => {
  const person = browser();
  const registered = await register(url, "Test client", person.address);
  const client = (await registered.json()) as { client_id: string };
  const page = await person.get(authorizeUrl(url, client.client_id));
  return { person, client, page };
};

// The person answers the consent page. Returns where the Worker sends the browser next.
const answerConsent = async (url: string, person: Browser, page: Response, decision: string) =>
  person.post(`${url}/authorize`, { handle: consentHandle(await page.text()), decision });

// A new client registers, and a person allows it on the consent page. `atGoogle` is where
// the Worker sends the browser next, which is Google's sign-in page.
const allowNewClient = async (url: string) => {
  const { person, client, page } = await openSignIn(url);
  const allowed = await answerConsent(url, person, page, "approve");
  return { person, client, allowed, atGoogle: new URL(allowed.headers.get("location")!) };
};

// Google sends the browser back to the Worker's callback with `answer`, plus the state the
// Worker gave it.
const comeBack = (url: string, person: Browser, atGoogle: URL, answer: Record<string, string>) =>
  person.get(
    `${url}/callback?${new URLSearchParams({
      ...answer,
      state: atGoogle.searchParams.get("state")!,
    }).toString()}`,
  );

// The whole browser part of sign-in: allow the client, sign in to Google as `account`, and
// come back to the Worker's callback. `back` is where the Worker sends the browser last.
const signInAs = async (url: string, account: GoogleAccount) => {
  const { person, client, atGoogle } = await allowNewClient(url);
  const back = await comeBack(url, person, atGoogle, { code: google.signIn(atGoogle, account) });
  return { client, back };
};

// Where a redirect sends the client, and what it carries.
const sentToClient = (redirect: Response) => {
  const toClient = new URL(redirect.headers.get("location")!);
  return {
    status: redirect.status,
    address: `${toClient.origin}${toClient.pathname}`,
    error: toClient.searchParams.get("error"),
    state: toClient.searchParams.get("state"),
    code: toClient.searchParams.get("code"),
  };
};

// Signs in as `account` and returns the token the client ends up holding.
const tokenFor = async (url: string, account: GoogleAccount) => {
  const { client, back } = await signInAs(url, account);
  const token = (await (
    await exchange(url, client.client_id, sentToClient(back).code!)
  ).json()) as {
    access_token: string;
  };
  return token.access_token;
};

// What a client is sent when sign-in is refused: an error, its own state, and no code.
const refusedWith = (error: string) => ({
  status: 302,
  address: REDIRECT_URI,
  error,
  state: "client-state",
  code: null,
});

test(
  "the stack comes up on the local simulators",
  Effect.gen(function* () {
    const { url, databaseId } = yield* stack;
    expect(url).toMatch(/^http:\/\/localhost:/);
    // A dev: id is Alchemy's mark for a local simulator.
    expect(databaseId).toMatch(/^dev:/);
  }),
);

test(
  "POST /mcp without a token is rejected and points the client at the sign-in metadata",
  onWorker(async (url) => {
    const { response } = await mcp(url, { method: "tools/list" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      `resource_metadata="${url}/.well-known/oauth-protected-resource/mcp"`,
    );
  }),
);

test(
  "POST /mcp with a made-up token is rejected",
  onWorker(async (url) => {
    const { response } = await mcp(url, { method: "tools/list" }, "someone:made:this-up");
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(`error="invalid_token"`);
  }),
);

test(
  "a client can register, and its name is escaped on the consent page",
  onWorker(async (url) => {
    const person = browser();
    const registered = await register(url, `<script>alert("x")</script> & co`, person.address);
    expect(registered.status).toBe(201);
    const client = (await registered.json()) as { client_id: string };

    const page = await person.get(authorizeUrl(url, client.client_id));
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; co");
    expect(html).not.toContain("<script");
  }),
);

test(
  "the consent page says where access will be sent and cannot be put in a frame",
  onWorker(async (url) => {
    const { page } = await openSignIn(url);
    const html = await page.text();
    expect(html).toContain("access is sent to <strong>localhost</strong>");
    expect(html).toContain("That is an app on this computer.");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  }),
);

test(
  "allowing a client sends the browser to Google, asking only who the person is",
  onWorker(async (url) => {
    const { allowed, atGoogle } = await allowNewClient(url);
    expect(allowed.status).toBe(302);
    expect(`${atGoogle.origin}${atGoogle.pathname}`).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(Object.fromEntries(atGoogle.searchParams)).toEqual({
      client_id: GOOGLE_CLIENT.id,
      redirect_uri: `${url}/callback`,
      response_type: "code",
      scope: "openid email profile",
      state: expect.stringMatching(/.{16,}/),
      code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      code_challenge_method: "S256",
    });
  }),
);

test(
  "pressing Deny on the consent page sends the client a refusal",
  onWorker(async (url) => {
    const { person, page } = await openSignIn(url);
    const denied = await answerConsent(url, person, page, "deny");
    expect(sentToClient(denied)).toEqual(refusedWith("access_denied"));
  }),
);

test(
  "a client the browser has already allowed goes straight to Google the next time",
  onWorker(async (url) => {
    const { client, person } = await allowNewClient(url);

    const again = await person.get(authorizeUrl(url, client.client_id));
    expect(again.status).toBe(302);
    expect(new URL(again.headers.get("location")!).hostname).toBe("accounts.google.com");
  }),
);

test(
  "a consent form that was already used shows a page and sends the browser nowhere",
  onWorker(async (url) => {
    const { person, page } = await openSignIn(url);
    const form = { handle: consentHandle(await page.text()), decision: "approve" };
    await person.post(`${url}/authorize`, form);

    const again = await person.post(`${url}/authorize`, form);
    expect(again.status).toBe(400);
    expect(again.headers.get("location")).toBeNull();
    expect(await again.text()).toContain("Sign-in did not finish");
  }),
);

test(
  "a verified email on the allowlist completes sign-in, and the client gets a token",
  onWorker(async (url) => {
    const { client, back } = await signInAs(url, ALLOWED_ACCOUNT);
    const sent = sentToClient(back);
    expect(sent).toEqual({
      status: 302,
      address: REDIRECT_URI,
      error: null,
      state: "client-state",
      code: expect.any(String),
    });

    const token = await exchange(url, client.client_id, sent.code!);
    expect(token.status).toBe(200);
    expect(await token.json()).toMatchObject({
      access_token: expect.any(String),
      token_type: "bearer",
      resource: `${url}/mcp`,
    });
  }),
);

test(
  "an email that is not on the allowlist is denied",
  onWorker(async (url) => {
    const { back } = await signInAs(url, {
      ...ALLOWED_ACCOUNT,
      sub: "2002",
      email: "stranger@example.com",
    });
    expect(sentToClient(back)).toEqual(refusedWith("access_denied"));
  }),
);

test(
  "an email on the allowlist that Google has not verified is denied",
  onWorker(async (url) => {
    const { back } = await signInAs(url, { ...ALLOWED_ACCOUNT, email_verified: false });
    expect(sentToClient(back)).toEqual(refusedWith("access_denied"));
  }),
);

test(
  "an error from Google on the callback ends in the error redirect, not a token",
  onWorker(async (url) => {
    const { person, atGoogle } = await allowNewClient(url);
    // The person pressed Cancel on Google's page. A code that would work is sent along too,
    // to show that the error wins over it.
    const back = await comeBack(url, person, atGoogle, {
      error: "access_denied",
      code: google.signIn(atGoogle, ALLOWED_ACCOUNT),
    });
    expect(sentToClient(back)).toEqual(refusedWith("access_denied"));
  }),
);

test(
  "a code that Google does not accept ends in an error for the client, not a token",
  onWorker(async (url) => {
    const { person, atGoogle } = await allowNewClient(url);
    const back = await comeBack(url, person, atGoogle, { code: "not-from-google" });
    expect(sentToClient(back)).toEqual(refusedWith("server_error"));
  }),
);

test(
  "a signed-in client can call get_schema, which reads the Worker's own database",
  onWorker(async (url) => {
    const { result } = await callTool(url, await tokenFor(url, ALLOWED_ACCOUNT), "get_schema");
    expect(result).toMatchObject({ isError: false, content: [{ type: "text" }] });

    const schema = JSON.parse(result!.content[0].text) as {
      tables: { name: string; sql: string }[];
      views: { name: string; sql: string }[];
      categories: { id: string }[];
      conventions: string;
      partial_dates: string;
      data_keys: { item: Record<string, string> };
    };
    // D1 and Alchemy keep tables of their own in this database, which the Node SQLite under
    // the tests in packages/core does not have. None of them may be passed off as Attic's.
    expect(schema.tables.map(({ name }) => name).sort()).toEqual(created("TABLE"));
    expect(schema.views.map(({ name }) => name).sort()).toEqual(created("VIEW"));
    expect(schema.tables.find(({ name }) => name === "items")?.sql).toMatch(/^CREATE TABLE items/);
    // The migration seeds the starter Categories, and power-tools sits under tools.
    expect(schema.categories.find(({ id }) => id === "tools")).toEqual({
      id: "tools",
      name: "Tools",
      expects: [],
      children: [{ id: "power-tools", name: "Power tools", expects: [], children: [] }],
    });
    expect(schema.conventions).toContain("Conventions inside `data`:");
    expect(schema.partial_dates).toContain("Partial dates");
    expect(schema.data_keys.item).toHaveProperty("parts");
  }),
);

test(
  "a signed-in client is told that get_schema takes nothing and only reads, and hello is gone",
  onWorker(async (url) => {
    const token = await tokenFor(url, ALLOWED_ACCOUNT);
    const { message } = await mcp(url, { method: "tools/list" }, token);
    const { result } = message as { result: { tools: unknown[] } };
    // An object that takes nothing, in the plainest words JSON Schema has. Some clients turn
    // a tool away if its schema leads with anything fancier, such as `not`.
    expect(result.tools).toEqual([
      expect.objectContaining({
        name: "get_schema",
        description: expect.stringContaining("Category tree"),
        inputSchema: { type: "object", additionalProperties: false },
        annotations: { readOnlyHint: true },
      }),
    ]);

    // The placeholder tool this one replaced is gone, not only left off the list.
    const hello = await callTool(url, token, "hello");
    expect(hello.result).toBeUndefined();
    expect(hello.error?.message).toContain("hello not found");
  }),
);

test(
  "input that does not fit a tool's schema comes back as a validation error",
  onWorker(async (url) => {
    const token = await tokenFor(url, ALLOWED_ACCOUNT);
    const { result } = await callTool(url, token, "get_schema", { property: "Maple Street" });
    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: expect.stringContaining("Input validation error") }],
    });
    expect(result!.content[0].text).toContain("property");
  }),
);

// Registration and the sign-in page are open to anyone, and each use writes to KV. These
// pin how many of each one caller gets in a minute.
test(
  "registrations past five a minute from one address are refused",
  onWorker(async (url) => {
    const address = newAddress();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      statuses.push((await register(url, "Test client", address)).status);
    }
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
    // Another address still gets through.
    expect((await register(url, "Test client", newAddress())).status).toBe(201);
  }),
);

// One network can hand itself any number of IPv6 addresses, so a fresh address must not
// mean a fresh allowance. The last address is the fifth one written out the long way.
test(
  "addresses on the same IPv6 network share one limit",
  onWorker(async (url) => {
    const network = newNetwork();
    const [, , third, fourth] = network.split(":");
    const addresses = [
      `${network}::1`,
      `${network}::2`,
      `${network}:aaaa:bbbb:cccc:dddd`,
      `${network}::ffff`,
      `${network}:1::`,
      `2001:0db8:${third!.padStart(4, "0")}:${fourth!.padStart(4, "0")}:0001:0000:0000:0000`,
    ];
    const statuses: number[] = [];
    for (const address of addresses) {
      statuses.push((await register(url, "Test client", address)).status);
    }
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
  }),
);

test(
  "a browser's preflight check does not count toward the registration limit",
  onWorker(async (url) => {
    const address = newAddress();
    for (let attempt = 0; attempt < 6; attempt++) {
      await fetch(`${url}/register`, {
        method: "OPTIONS",
        headers: { "cf-connecting-ip": address, origin: "http://localhost:6274" },
      });
    }
    expect((await register(url, "Test client", address)).status).toBe(201);
  }),
);

test(
  "requests for the sign-in page past ten a minute from one address are refused",
  onWorker(async (url) => {
    // Opening the sign-in page is the first of the ten.
    const { person, client, page } = await openSignIn(url);
    const statuses = [page.status];
    for (let attempt = 1; attempt < 11; attempt++) {
      statuses.push((await person.get(authorizeUrl(url, client.client_id))).status);
    }
    expect(statuses).toEqual([...Array.from({ length: 10 }, () => 200), 429]);
    // Another address still gets through.
    expect((await browser().get(authorizeUrl(url, client.client_id))).status).toBe(200);
  }),
);

// Every token is tied to the address the Worker is reached at, and the OAuth provider only
// accepts plain http for this machine.
test(
  "a request over plain http for any host but this machine is turned away",
  onWorker(async (url) => {
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        `${url}/mcp`,
        { method: "POST", setHost: false, headers: { host: "attic.example.com" } },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on("error", reject);
      request.end();
    });
    expect(status).toBe(400);
  }),
);

test(
  "nothing answers at any other address",
  onWorker(async (url) => {
    expect((await fetch(`${url}/`)).status).toBe(404);
    expect((await fetch(`${url}/callback`, { method: "POST" })).status).toBe(404);
  }),
);

// A second deploy returns a moment before the restarted Worker takes over, and until then
// the old one still answers. So what follows a change of settings is checked until it holds.
const eventually = (check: (url: string) => Promise<void>) =>
  Effect.flatMap(stack, ({ url }) =>
    Effect.retry(
      Effect.tryPromise(() => check(url!)),
      Schedule.max([Schedule.spaced("50 millis"), Schedule.recurs(100)]),
    ),
  );

// Puts the settings back for whatever runs next.
const restoreSettings = deployWith().pipe(
  Effect.andThen(
    eventually(async (url) => {
      expect((await browser().get(`${url}/authorize`)).status).not.toBe(503);
    }),
  ),
  Effect.orDie,
);

// These change the Worker's settings for one test, so they sit at the end of the file.
test(
  "with sign-in settings missing, the sign-in page says which ones",
  Effect.gen(function* () {
    yield* deployWith({ GOOGLE_CLIENT_SECRET: undefined, ALLOWED_EMAILS: undefined });

    yield* eventually(async (url) => {
      const page = await browser().get(`${url}/authorize`);
      const html = await page.text();
      expect(page.status).toBe(503);
      expect(html).toContain("Missing: GOOGLE_CLIENT_SECRET, ALLOWED_EMAILS.");
    });
  }).pipe(Effect.ensuring(restoreSettings)),
);

test(
  "a token stops working at the tools once its email is taken off the allowlist",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const token = yield* Effect.promise(() => tokenFor(url!, ALLOWED_ACCOUNT));
    yield* deployWith({ ALLOWED_EMAILS: "second@example.com" });

    yield* eventually(async (url) => {
      const { result } = await callTool(url, token, "get_schema");
      expect(result).toEqual({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("not allowed") }],
      });
    });
  }).pipe(Effect.ensuring(restoreSettings)),
);
