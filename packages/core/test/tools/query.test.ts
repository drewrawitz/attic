import { expect, it } from "@effect/vitest";
import { Cause, Effect, Layer, Logger, Stream } from "effect";
import { Reactivity } from "effect/reactivity";
import { SqlClient, Statement } from "effect/sql";
import { callTool } from "../../src/tool.ts";
import { query } from "../../src/tools/query.ts";

// `query` is tested through the real Worker on local D1, in test/query.test.ts at the root,
// because its guard leans on how D1 behaves. Nothing gets past that guard, so the check behind
// it cannot be reached there. Here it is handed what D1 would say if something had.

// A database that answers every statement with `result`, in the place of D1.
const answering = (result: unknown) => {
  const unused = () => Effect.die("query only asks for the driver's own result");
  return Layer.effect(
    SqlClient.SqlClient,
    SqlClient.make({
      acquirer: Effect.succeed({
        executeRaw: () => Effect.succeed(result),
        execute: unused,
        executeValues: unused,
        executeValuesUnprepared: unused,
        executeUnprepared: unused,
        executeStream: () => Stream.die("query only asks for the driver's own result"),
      }),
      compiler: Statement.makeCompilerSqlite(),
      spanAttributes: [],
    }),
  ).pipe(Layer.provide(Reactivity.layer));
};

// Calls `query` with the log kept in memory. Returns what the client was sent and what was
// logged.
const asked = (result: unknown) =>
  Effect.gen(function* () {
    const logged: string[] = [];
    const keep = Logger.make(({ message, cause }) => {
      logged.push(`${String(message)} ${Cause.pretty(cause)}`);
    });
    const sent = yield* callTool(
      query,
      { sql: "SELECT name FROM vendors" },
      answering(result),
    ).pipe(Effect.provide(Logger.layer([keep])));
    return { sent, logged };
  });

const ROWS = [{ name: "Pipewise Plumbing" }];

it.effect("a result that says nothing changed goes to the client", () =>
  Effect.gen(function* () {
    const { sent, logged } = yield* asked({ results: ROWS, meta: { changed_db: false } });

    expect(sent).toEqual({ text: '{"rows":[{"name":"Pipewise Plumbing"}]}', isError: false });
    expect(logged).toEqual([]);
  }),
);

it.effect("a result that says the database changed is a loud error, and no rows go out", () =>
  Effect.gen(function* () {
    const { sent, logged } = yield* asked({ results: ROWS, meta: { changed_db: true } });

    expect(sent.isError).toBe(true);
    expect(sent.text).toContain("changed the database");
    expect(sent.text).not.toContain("Pipewise");
    // It is in the Worker's log too, with the SQL that did it.
    expect(logged).toEqual([expect.stringContaining("SELECT name FROM vendors")]);
  }),
);

// If D1 ever stops saying whether the database changed, nobody can tell that it did not.
it.effect("a result that does not say whether the database changed is not passed on", () =>
  Effect.gen(function* () {
    const { sent, logged } = yield* asked({ results: ROWS, meta: {} });

    expect(sent).toEqual({
      text: "Attic hit an error it did not expect. The details are in the Worker's log.",
      isError: true,
    });
    expect(logged).toEqual([expect.stringContaining("changed_db")]);
  }),
);
