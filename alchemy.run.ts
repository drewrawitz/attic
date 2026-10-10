import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

// Attic's infrastructure. Alchemy only declares resources here (ADR 0005). The Worker itself
// is the plain module in apps/server, and it reads these bindings from its `env`.

// The stage that `vp run deploy` targets. Its Worker is named plain `attic`.
const PRODUCTION = "prod";

export const DB = Cloudflare.D1.Database("DB", { migrations: "./migrations" });
export const FILES = Cloudflare.R2.Bucket("FILES");
export const OAUTH_KV = Cloudflare.KV.Namespace("OAUTH_KV");

export const Worker = Cloudflare.Worker(
  "Worker",
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    const { dev } = yield* Alchemy.AlchemyContext;
    // Unset and empty mean the same: the Worker is served from its workers.dev address.
    const domain = (yield* Config.String("ATTIC_DOMAIN").pipe(Config.withDefault(""))).trim();

    return {
      // A stage name may hold underscores, which a workers.dev hostname cannot.
      name: stage === PRODUCTION ? "attic" : `attic-${stage.replaceAll("_", "-")}`,
      main: "./apps/server/src/worker.ts",
      // The newest date the workerd inside this Alchemy version accepts, so that
      // `alchemy dev` and a deploy run under the same date. Raise it when Alchemy is upgraded.
      compatibility: { flags: ["nodejs_compat"], date: "2026-09-25" },
      env: { DB, FILES, OAUTH_KV },
      // Local dev has no use for a domain.
      ...(domain !== "" && !dev ? { domain } : {}),
    };
  }),
);

export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;

// A deploy keeps its state in the Cloudflare state store, so it does not depend on one
// machine's disk. `alchemy dev` and the tests only describe local simulators, so their state
// stays in .alchemy/ and they need no Cloudflare account.
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
