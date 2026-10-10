import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { State } from "alchemy/State";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { loadStatements, removeStatements } from "./records.ts";

// The stack in alchemy.run.ts and its database, by the names they have there.
const ATTIC = "attic";
const DATABASE = "DB";

// A stage that `vp run dev` or the tests made keeps its state in .alchemy/ on this machine, and
// a deployed stage keeps it in the Cloudflare state store (ADR 0013). A command is told only
// the stage's name, so it looks on this machine first. A local stage is then reached with no
// Cloudflare account, the same as `vp run dev`.
const state = Layer.unwrap(
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    const local = Alchemy.localState();
    const onThisMachine = yield* State.pipe(
      Effect.flatten,
      Effect.flatMap((store) => store.listStages(ATTIC)),
      Effect.provide(local),
      Effect.orDie,
    );
    return onThisMachine.includes(stage) ? local : Cloudflare.state();
  }),
);

/** What a command does with the made-up household. */
export type Operation = "load" | "remove";

/**
 * A stack whose one job is to put the made-up household into a stage's database, or to take it
 * out. It declares no resource of its own: it finds the database the `attic` stack made for
 * the same stage and runs one atomic batch on it, through Alchemy's own D1 client. That client
 * reaches a local database through the simulator and a deployed one over Cloudflare's API.
 *
 * It says how many rows went each way. A load first removes any earlier copy, so `removed` is
 * zero the first time.
 */
export const householdStack = (operation: Operation) =>
  Alchemy.Stack(
    "attic-household",
    { providers: Cloudflare.providers(), state },
    Effect.gen(function* () {
      const database = yield* Cloudflare.D1.Database.ref(DATABASE, { stack: ATTIC });

      const Household = Alchemy.Action(
        "Household",
        Effect.gen(function* () {
          const db = yield* Cloudflare.D1.QueryDatabase(database);
          return (input: { operation: Operation }) =>
            Effect.gen(function* () {
              const statements = input.operation === "load" ? loadStatements : removeStatements;
              const results = yield* db.batch(
                statements.map(({ sql, params }) => db.prepare(sql).bind(...params)),
              );
              const rows = (from: number, to?: number) =>
                results.slice(from, to).reduce((sum, result) => sum + result.meta.changes, 0);
              // Both lists open with the same DELETEs, and a load goes on to its INSERTs.
              const deletes = removeStatements.length;
              return { removed: rows(0, deletes), loaded: rows(deletes) };
            });
        }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseLocal)),
      );

      return yield* Household({ operation });
    }),
  );
