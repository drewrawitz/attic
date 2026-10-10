import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

// Attic's infrastructure. Alchemy only declares resources here (ADR 0005). The Worker itself
// is the plain module in apps/server, and it reads these bindings from its `env`.

// The stage that `vp run deploy` targets. Its Worker is named plain `attic`.
const PRODUCTION = "prod";

export const DB = Cloudflare.D1.Database("DB", { migrations: "./migrations" });
export const FILES = Cloudflare.R2.Bucket("FILES");
export const OAUTH_KV = Cloudflare.KV.Namespace("OAUTH_KV");

// Signs the cookie that remembers which clients a browser has already allowed. Alchemy makes
// it once and keeps it in its state, so every deploy binds the same value and nobody has to
// set one by hand.
export const ConsentSecret = Alchemy.Random("ConsentSecret");

// Registration and the sign-in page are open to anyone, and each use writes to KV, which
// Workers Free caps at 1,000 writes a day (ADR 0012). These limit how many of each one
// address gets in a minute. The binding has no resource behind it. `namespaceId` is only a
// number that keeps a limit's counters apart from every other limit in the account.
export const REGISTER_LIMIT = Cloudflare.RateLimit("REGISTER_LIMIT", {
  namespaceId: 1801,
  simple: { limit: 5, period: 60 },
});
export const AUTHORIZE_LIMIT = Cloudflare.RateLimit("AUTHORIZE_LIMIT", {
  namespaceId: 1802,
  simple: { limit: 10, period: 60 },
});

// Where the Worker reaches Google once a person has signed in there.
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

export const Worker = Cloudflare.Worker(
  "Worker",
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    const { dev } = yield* Alchemy.AlchemyContext;
    // Unset and empty mean the same: the Worker is served from its workers.dev address.
    const domain = (yield* Config.String("ATTIC_DOMAIN").pipe(Config.withDefault(""))).trim();

    // A deploy fails without the sign-in settings, since nobody could get in. `alchemy dev`
    // and the tests start without them, and the sign-in page then says which one is missing.
    const setting = (name: string) =>
      dev ? Config.String(name).pipe(Config.withDefault("")) : Config.NonEmptyString(name);
    const secret = (name: string) => setting(name).pipe(Config.map(Redacted.make));
    // Only dev mode reads another address for Google, which is how the tests stand in for
    // it. A deploy always binds Google's own.
    const googleUrl = (name: string, url: string) =>
      dev ? Config.String(name).pipe(Config.withDefault(url)) : Config.succeed(url);
    const consentSecret = yield* ConsentSecret;

    return {
      // A stage name may hold underscores, which a workers.dev hostname cannot.
      name: stage === PRODUCTION ? "attic" : `attic-${stage.replaceAll("_", "-")}`,
      main: "./apps/server/src/worker.ts",
      // The newest date the workerd inside this Alchemy version accepts, so that
      // `alchemy dev` and a deploy run under the same date. Raise it when Alchemy is upgraded.
      compatibility: { flags: ["nodejs_compat"], date: "2026-09-25" },
      // A string binds as plain text and a redacted value as a secret.
      env: {
        DB,
        FILES,
        OAUTH_KV,
        REGISTER_LIMIT,
        AUTHORIZE_LIMIT,
        GOOGLE_CLIENT_ID: yield* setting("GOOGLE_CLIENT_ID"),
        GOOGLE_CLIENT_SECRET: yield* secret("GOOGLE_CLIENT_SECRET"),
        GOOGLE_TOKEN_URL: yield* googleUrl("GOOGLE_TOKEN_URL", GOOGLE_TOKEN_URL),
        GOOGLE_USERINFO_URL: yield* googleUrl("GOOGLE_USERINFO_URL", GOOGLE_USERINFO_URL),
        ALLOWED_EMAILS: yield* secret("ALLOWED_EMAILS"),
        CONSENT_SECRET: consentSecret.text,
      },
      // Local dev has no use for a domain.
      ...(domain !== "" && !dev ? { domain } : {}),
    };
  }),
);

export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;

// A deploy keeps its state in the Cloudflare state store, so it does not depend on one
// machine's disk. `alchemy dev` and the tests only describe local simulators, so their state
// stays in .alchemy/ and they need no Cloudflare account (ADR 0013).
const state = Layer.unwrap(
  Alchemy.AlchemyContext.useSync(({ dev }) => (dev ? Alchemy.localState() : Cloudflare.state())),
);

export default Alchemy.Stack(
  "attic",
  { providers: Cloudflare.providers(), state },
  Effect.gen(function* () {
    const db = yield* DB;
    const worker = yield* Worker;

    return { url: worker.url, databaseId: db.databaseId };
  }),
);
