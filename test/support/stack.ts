import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import Stack from "../../alchemy.run.ts";
import { browser, type Browser } from "./browser.ts";
import { startFakeGoogle, type GoogleAccount } from "./fake-google.ts";
import { authorizeUrl, exchange, mcp, register } from "./mcp-client.ts";

// What every test file that talks to the Worker starts from: the stack, a stand-in for Google,
// and a client that signs in and calls tools. A file that imports this deploys the stack before
// its first test. The files share one stage, one Worker, and one port, so they run one after
// another (see `fileParallelism` in vite.config.ts).
//
// Runs the whole stack on Alchemy's local simulators: the Worker in workerd, with local D1,
// R2, and KV behind its bindings. Nothing here touches a Cloudflare account, and nothing
// calls Google. The Worker's two calls to Google go to a stand-in on this machine, which
// knows the OAuth client the tests pretend the User created.
export const GOOGLE_CLIENT = { id: "test-google-client", secret: "test-google-secret" };
export const google = await startFakeGoogle(GOOGLE_CLIENT);

const harness = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});
const { afterAll } = harness;
export const { test, beforeAll, deploy } = harness;

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
export const deployWith = (changed: Record<string, string | undefined> = {}) =>
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
export const stack = beforeAll(
  Effect.gen(function* () {
    const outputs = yield* deployWith();
    // The OAuth metadata needs no token, so it answers as soon as workerd is serving.
    yield* Test.getWhenReady(`${outputs.url}/.well-known/oauth-authorization-server`);
    return outputs;
  }),
);

afterAll(Effect.promise(() => google.close()));

// A test body that talks to the Worker over HTTP, given its address.
export const onWorker = (body: (url: string) => Promise<void>) =>
  Effect.flatMap(stack, ({ url }) => Effect.promise(() => body(url!)));

// A Google account whose email is on the allowlist. The setting spells it
// " Allowed@Example.com " and Google spells it another way again, so a sign-in only works
// if both sides are compared ignoring case and the spaces around them.
export const ALLOWED_ACCOUNT: GoogleAccount = {
  sub: "1001",
  email: "ALLOWED@example.COM",
  email_verified: true,
  name: "Pat Example",
};

// A call to a tool, and the tool result the Worker answers with.
export const callOnWorker = async (
  url: string,
  token: string,
  name: string,
  input: unknown = {},
) => {
  const call = { method: "tools/call", params: { name, arguments: input } };
  return (await mcp(url, call, token)).message as {
    result?: { isError?: boolean; content: [{ type: string; text: string }] };
    error?: { code: number; message: string };
  };
};

export const consentHandle = (html: string) => /name="handle" value="([^"]+)"/.exec(html)![1]!;

// A new client registers and sends a person to the sign-in page, from the same address.
export const openSignIn = async (url: string) => {
  const person = browser();
  const registered = await register(url, "Test client", person.address);
  const client = (await registered.json()) as { client_id: string };
  const page = await person.get(authorizeUrl(url, client.client_id));
  return { person, client, page };
};

// The person answers the consent page. Returns where the Worker sends the browser next.
export const answerConsent = async (
  url: string,
  person: Browser,
  page: Response,
  decision: string,
) => person.post(`${url}/authorize`, { handle: consentHandle(await page.text()), decision });

// A new client registers, and a person allows it on the consent page. `atGoogle` is where
// the Worker sends the browser next, which is Google's sign-in page.
export const allowNewClient = async (url: string) => {
  const { person, client, page } = await openSignIn(url);
  const allowed = await answerConsent(url, person, page, "approve");
  return { person, client, allowed, atGoogle: new URL(allowed.headers.get("location")!) };
};

// Google sends the browser back to the Worker's callback with `answer`, plus the state the
// Worker gave it.
export const comeBack = (
  url: string,
  person: Browser,
  atGoogle: URL,
  answer: Record<string, string>,
) =>
  person.get(
    `${url}/callback?${new URLSearchParams({
      ...answer,
      state: atGoogle.searchParams.get("state")!,
    }).toString()}`,
  );

// The whole browser part of sign-in: allow the client, sign in to Google as `account`, and
// come back to the Worker's callback. `back` is where the Worker sends the browser last.
export const signInAs = async (url: string, account: GoogleAccount) => {
  const { person, client, atGoogle } = await allowNewClient(url);
  const back = await comeBack(url, person, atGoogle, { code: google.signIn(atGoogle, account) });
  return { client, back };
};

// Where a redirect sends the client, and what it carries.
export const sentToClient = (redirect: Response) => {
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
export const tokenFor = async (url: string, account: GoogleAccount) => {
  const { client, back } = await signInAs(url, account);
  const token = (await (
    await exchange(url, client.client_id, sentToClient(back).code!)
  ).json()) as {
    access_token: string;
  };
  return token.access_token;
};
