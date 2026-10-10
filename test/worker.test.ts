import { expect } from "@effect/vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import Stack from "../alchemy.run.ts";
import { browser, newAddress, type Browser } from "./support/browser.ts";
import { startFakeGoogle, type GoogleAccount } from "./support/fake-google.ts";
import { authorizeUrl, exchange, mcp, REDIRECT_URI, register } from "./support/mcp-client.ts";

// Runs the whole stack on Alchemy's local simulators: the Worker in workerd, with local D1,
// R2, and KV behind its bindings. Nothing here touches a Cloudflare account, and nothing
// calls Google. The Worker's two calls to Google go to a stand-in on this machine.
const google = await startFakeGoogle({ id: "test-google-client", secret: "test-google-secret" });

const { test, beforeAll, afterAll, deploy } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

// The tests bring their own sign-in settings, so they pass on a fresh clone and are not
// changed by whatever a local .env holds.
const SETTINGS = {
  GOOGLE_CLIENT_ID: "test-google-client",
  GOOGLE_CLIENT_SECRET: "test-google-secret",
  GOOGLE_TOKEN_URL: google.tokenUrl,
  GOOGLE_USERINFO_URL: google.userinfoUrl,
  ALLOWED_EMAILS: " Allowed@Example.com , second@example.com ",
};

// Deploys the stack with those settings, or with some of them changed, the way a host
// would after editing .env. They are read ahead of the environment and .env, which still
// answer for everything else. A second deploy replaces the Worker in place: it keeps its
// address, its KV, and its database.
const deployWith = (changed: Partial<typeof SETTINGS> = {}) =>
  Effect.flatMap(ConfigProvider.ConfigProvider, (environment) =>
    deploy(Stack).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.orElse(
          ConfigProvider.fromEnv({ env: { ...SETTINGS, ...changed } }),
          environment,
        ),
      ),
    ),
  );

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

const PAT: GoogleAccount = {
  sub: "1001",
  email: "allowed@example.com",
  email_verified: true,
  name: "Pat Example",
};

const consentHandle = (html: string) => /name="handle" value="([^"]+)"/.exec(html)![1]!;

// A new client registers from the same address as the person who will sign in with it.
const newClient = async (url: string, person: Browser, name = "Test client") => {
  const registered = await register(url, name, person.address);
  return (await registered.json()) as { client_id: string };
};

// A new client registers, and a person allows it on the consent page. Returns where the
// Worker sends the browser next, which is Google's sign-in page.
const allowNewClient = async (url: string, person = browser()) => {
  const client = await newClient(url, person);
  const page = await person.get(authorizeUrl(url, client.client_id));
  const allowed = await person.post(`${url}/authorize`, {
    handle: consentHandle(await page.text()),
    decision: "approve",
  });
  return { client, person, allowed };
};

// The whole browser part of sign-in: allow the client, sign in to Google as `account`, and
// come back to the Worker's callback. Returns where the Worker sends the browser last.
const signInAs = async (url: string, account: GoogleAccount) => {
  const { client, person, allowed } = await allowNewClient(url);
  const atGoogle = new URL(allowed.headers.get("location")!);
  const back = await person.get(
    `${url}/callback?${new URLSearchParams({
      code: google.signIn(atGoogle, account),
      state: atGoogle.searchParams.get("state")!,
    }).toString()}`,
  );
  return { client, back };
};

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
  "allowing a client sends the browser to Google, asking only who the person is",
  onWorker(async (url) => {
    const { allowed } = await allowNewClient(url);
    expect(allowed.status).toBe(302);

    const atGoogle = new URL(allowed.headers.get("location")!);
    expect(`${atGoogle.origin}${atGoogle.pathname}`).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(Object.fromEntries(atGoogle.searchParams)).toEqual({
      client_id: "test-google-client",
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
  "a verified email on the allowlist completes sign-in, and the client gets a token",
  onWorker(async (url) => {
    const { client, back } = await signInAs(url, PAT);
    expect(back.status).toBe(302);

    const toClient = new URL(back.headers.get("location")!);
    expect(`${toClient.origin}${toClient.pathname}`).toBe(REDIRECT_URI);
    expect(toClient.searchParams.get("state")).toBe("client-state");

    const token = await exchange(url, client.client_id, toClient.searchParams.get("code")!);
    expect(token.status).toBe(200);
    expect(await token.json()).toMatchObject({
      access_token: expect.any(String),
      token_type: "bearer",
      resource: `${url}/mcp`,
    });
  }),
);

// What a client is sent when sign-in is refused: an error, its own state, and no code.
const refusal = (back: Response) => {
  const toClient = new URL(back.headers.get("location")!);
  return {
    status: back.status,
    address: `${toClient.origin}${toClient.pathname}`,
    error: toClient.searchParams.get("error"),
    state: toClient.searchParams.get("state"),
    code: toClient.searchParams.get("code"),
  };
};

const ACCESS_DENIED = {
  status: 302,
  address: REDIRECT_URI,
  error: "access_denied",
  state: "client-state",
  code: null,
};

test(
  "an email that is not on the allowlist is denied",
  onWorker(async (url) => {
    const { back } = await signInAs(url, { ...PAT, sub: "2002", email: "stranger@example.com" });
    expect(refusal(back)).toEqual(ACCESS_DENIED);
  }),
);

test(
  "an email on the allowlist that Google has not verified is denied",
  onWorker(async (url) => {
    const { back } = await signInAs(url, { ...PAT, email_verified: false });
    expect(refusal(back)).toEqual(ACCESS_DENIED);
  }),
);

test(
  "an error from Google on the callback ends in the error redirect, not a token",
  onWorker(async (url) => {
    const { person, allowed } = await allowNewClient(url);
    const atGoogle = new URL(allowed.headers.get("location")!);
    // The person pressed Cancel on Google's page. Google also sends a code here to show
    // that the error wins over it.
    const back = await person.get(
      `${url}/callback?${new URLSearchParams({
        error: "access_denied",
        code: google.signIn(atGoogle, PAT),
        state: atGoogle.searchParams.get("state")!,
      }).toString()}`,
    );
    expect(refusal(back)).toEqual(ACCESS_DENIED);
  }),
);

// Signs in as `account` and returns the token the client ends up holding.
const tokenFor = async (url: string, account: GoogleAccount) => {
  const { client, back } = await signInAs(url, account);
  const code = new URL(back.headers.get("location")!).searchParams.get("code")!;
  const token = (await (await exchange(url, client.client_id, code)).json()) as {
    access_token: string;
  };
  return token.access_token;
};

test(
  "a signed-in client can call the placeholder tool",
  onWorker(async (url) => {
    const token = await tokenFor(url, PAT);
    const { message } = await mcp(
      url,
      { method: "tools/call", params: { name: "hello", arguments: {} } },
      token,
    );

    const { result } = message as { result: { content: [{ type: string; text: string }] } };
    expect(result.content).toHaveLength(1);
    // The migration seeds the starter Categories, so a count above zero also shows that the
    // Worker's database has the schema.
    expect(JSON.parse(result.content[0].text)).toEqual({
      message: "Hello from Attic",
      email: "allowed@example.com",
      categories: expect.toSatisfy((count: number) => count > 0),
    });
  }),
);

test(
  "a signed-in client is told what the placeholder tool takes and that it only reads",
  onWorker(async (url) => {
    const { message } = await mcp(url, { method: "tools/list" }, await tokenFor(url, PAT));
    const { result } = message as { result: { tools: unknown[] } };
    expect(result.tools).toEqual([
      expect.objectContaining({
        name: "hello",
        inputSchema: expect.objectContaining({ type: "object" }),
        annotations: { readOnlyHint: true },
      }),
    ]);
  }),
);

// Registration and the sign-in page are open to anyone, and each use writes to KV. These two
// pin how many of each one address gets in a minute.
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
    const person = browser();
    const client = await newClient(url, person);

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt++) {
      statuses.push((await person.get(authorizeUrl(url, client.client_id))).status);
    }
    expect(statuses).toEqual([...Array.from({ length: 10 }, () => 200), 429]);
    // Another address still gets through.
    expect((await browser().get(authorizeUrl(url, client.client_id))).status).toBe(200);
  }),
);

test(
  "pressing Deny on the consent page sends the client a refusal",
  onWorker(async (url) => {
    const person = browser();
    const client = await newClient(url, person);
    const page = await person.get(authorizeUrl(url, client.client_id));

    const denied = await person.post(`${url}/authorize`, {
      handle: consentHandle(await page.text()),
      decision: "deny",
    });
    expect(refusal(denied)).toEqual(ACCESS_DENIED);
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
  "the consent page says where access will be sent and cannot be put in a frame",
  onWorker(async (url) => {
    const person = browser();
    const client = await newClient(url, person);

    const page = await person.get(authorizeUrl(url, client.client_id));
    const html = await page.text();
    expect(html).toContain("access is sent to <strong>localhost</strong>");
    expect(html).toContain("That is an app on this computer.");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  }),
);

test(
  "a consent form that was already used shows a page and sends the browser nowhere",
  onWorker(async (url) => {
    const person = browser();
    const client = await newClient(url, person);
    const page = await person.get(authorizeUrl(url, client.client_id));
    const form = { handle: consentHandle(await page.text()), decision: "approve" };
    await person.post(`${url}/authorize`, form);

    const again = await person.post(`${url}/authorize`, form);
    expect(again.status).toBe(400);
    expect(again.headers.get("location")).toBeNull();
    expect(await again.text()).toContain("Sign-in did not finish");
  }),
);

test(
  "a code that Google does not accept ends in an error for the client, not a token",
  onWorker(async (url) => {
    const { person, allowed } = await allowNewClient(url);
    const atGoogle = new URL(allowed.headers.get("location")!);
    const back = await person.get(
      `${url}/callback?${new URLSearchParams({
        code: "not-from-google",
        state: atGoogle.searchParams.get("state")!,
      }).toString()}`,
    );
    expect(refusal(back)).toEqual({ ...ACCESS_DENIED, error: "server_error" });
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
    // Blank, not empty: an empty value counts as unset, and .env would answer for it.
    yield* deployWith({ GOOGLE_CLIENT_ID: " ", ALLOWED_EMAILS: " " });

    yield* eventually(async (url) => {
      const page = await browser().get(`${url}/authorize`);
      const html = await page.text();
      expect(page.status).toBe(503);
      expect(html).toContain("GOOGLE_CLIENT_ID");
      expect(html).toContain("ALLOWED_EMAILS");
      expect(html).not.toContain("GOOGLE_CLIENT_SECRET");
    });
  }).pipe(Effect.ensuring(restoreSettings)),
);

test(
  "a token stops working at the tools once its email is taken off the allowlist",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const token = yield* Effect.promise(() => tokenFor(url!, PAT));
    yield* deployWith({ ALLOWED_EMAILS: "second@example.com" });

    yield* eventually(async (url) => {
      const { message } = await mcp(
        url,
        { method: "tools/call", params: { name: "hello", arguments: {} } },
        token,
      );
      expect(message).toMatchObject({
        result: {
          isError: true,
          content: [{ type: "text", text: expect.stringContaining("not allowed") }],
        },
      });
    });
  }).pipe(Effect.ensuring(restoreSettings)),
);
