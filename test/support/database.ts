import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { ATTIC, DATABASE } from "../../household/stack.ts";
import { deploy } from "./harness.ts";

// Runs SQL of a test's own on the database the Worker reads, as one atomic batch. A test needs
// it for what no tool does: planting a trigger, or taking out the rows it wrote. Like the
// commands in household/, it is a small stack that finds the database the `attic` stack made
// and holds one Action, which reaches local D1 through Alchemy's own client. Its state stays
// on this machine, as the rest of the tests' does (ADR 0013).
const sqlStack = (statements: ReadonlyArray<string>) =>
  Alchemy.Stack(
    "attic-test-sql",
    { providers: Cloudflare.providers(), state: Alchemy.localState() },
    Effect.gen(function* () {
      const database = yield* Cloudflare.D1.Database.ref(DATABASE, { stack: ATTIC });

      const Sql = Alchemy.Action(
        "Sql",
        Effect.gen(function* () {
          const db = yield* Cloudflare.D1.QueryDatabase(database);
          return (input: { statements: ReadonlyArray<string> }) =>
            Effect.gen(function* () {
              const results = yield* db.batch(input.statements.map((sql) => db.prepare(sql)));
              return { ran: results.length };
            });
        }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseLocal)),
      );

      return yield* Sql({ statements });
    }),
  );

/** Runs these statements on the Worker's database. `force` runs them even when the last run was the same. */
export const onDatabase = (...statements: ReadonlyArray<string>) =>
  deploy(sqlStack(statements), { force: true });
