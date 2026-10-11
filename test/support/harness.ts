import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import Stack from "../../alchemy.run.ts";
import { startFakeGoogle } from "./fake-google.ts";

// What every test file that talks to the Worker starts from: the stack, and a stand-in for
// Google. A file that imports this deploys the stack before its first test. The files share one
// stage, one Worker, and one port, so they run one after another (see `fileParallelism` in
// vite.config.ts).
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
