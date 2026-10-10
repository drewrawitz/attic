import { expect, it } from "@effect/vitest";
import { Cause, Effect, Layer, Logger, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { callTool, defineTool, NoInput, ToolError } from "../src/tool.ts";
import { call } from "./call.ts";
import { TestDatabase } from "./TestDatabase.ts";

// Made-up tools. Each one stands for a kind of ending a real tool can come to.
const categoryName = defineTool({
  name: "category_name",
  description: "Returns the name of one Category.",
  input: Schema.Struct({ id: Schema.String }),
  annotations: { readOnlyHint: true },
  run: ({ id }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const [category] = yield* sql<{ name: string }>`SELECT name FROM categories WHERE id = ${id}`;
      if (category === undefined) {
        return yield* new ToolError({
          message: `There is no Category "${id}". Call get_schema to see the ones there are.`,
        });
      }
      return { id, name: category.name };
    }),
});

it.effect("what a tool returns goes to the client as JSON", () =>
  Effect.gen(function* () {
    const result = yield* call(categoryName, { id: "power-tools" });
    expect(result).toEqual({ text: '{"id":"power-tools","name":"Power tools"}', isError: false });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a failure the caller can act on goes to the client as the tool wrote it", () =>
  Effect.gen(function* () {
    const result = yield* call(categoryName, { id: "gardening" });
    expect(result).toEqual({
      text: 'There is no Category "gardening". Call get_schema to see the ones there are.',
      isError: true,
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// A tool whose query the database turns down, and two that throw: one inside its program and
// one before it has made a program at all.
const badQuery = defineTool({
  name: "bad_query",
  description: "Reads a table that does not exist.",
  input: NoInput,
  annotations: { readOnlyHint: true },
  run: () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql`SELECT secret FROM no_such_table`;
    }),
});

const throws = defineTool({
  name: "throws",
  description: "Throws.",
  input: NoInput,
  annotations: { readOnlyHint: true },
  run: () =>
    Effect.sync(() => {
      throw new Error("the fridge serial is XK-4471");
    }),
});

const throwsFirst = defineTool({
  name: "throws_first",
  description: "Throws before it returns a program.",
  input: NoInput,
  annotations: { readOnlyHint: true },
  run: () => {
    throw new Error("the lease runs until 2027-06");
  },
});

// All a client hears of a failure nobody planned for.
const UNEXPECTED = {
  text: "Attic hit an error it did not expect. The details are in the Worker's log.",
  isError: true,
};

// Runs a tool with the log kept in memory. Returns what the client was sent and what was
// logged, each line with the cause it carried.
const readingLog = <R>(called: Effect.Effect<unknown, never, R>) =>
  Effect.gen(function* () {
    const logged: string[] = [];
    const keep = Logger.make(({ message, cause }) => {
      logged.push(`${String(message)} ${Cause.pretty(cause)}`);
    });
    const result = yield* called.pipe(Effect.provide(Logger.layer([keep])));
    return { result, logged };
  });

it.effect("a query the database turns down is logged, and the client is told nothing of it", () =>
  Effect.gen(function* () {
    const { result, logged } = yield* readingLog(call(badQuery, {}));

    expect(result).toEqual(UNEXPECTED);
    expect(logged).toEqual([expect.stringContaining("no_such_table")]);
    expect(logged[0]).toContain("bad_query");
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a tool that throws is logged, and the client is told nothing of it", () =>
  Effect.gen(function* () {
    const { result, logged } = yield* readingLog(call(throws, {}));

    expect(result).toEqual(UNEXPECTED);
    expect(logged).toEqual([expect.stringContaining("the fridge serial is XK-4471")]);
  }).pipe(Effect.provide(TestDatabase)),
);

// The MCP SDK sends a client the message of anything that is thrown at it, so nothing may
// get that far.
it.effect("a tool that throws before its program starts ends the same way", () =>
  Effect.gen(function* () {
    const { result, logged } = yield* readingLog(call(throwsFirst, {}));

    expect(result).toEqual(UNEXPECTED);
    expect(logged).toEqual([expect.stringContaining("the lease runs until 2027-06")]);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a database that cannot be opened ends the same way", () =>
  Effect.gen(function* () {
    const unreachable = Layer.effect(
      SqlClient.SqlClient,
      Effect.fail(new Error("no database is bound as DB")),
    );
    const { result, logged } = yield* readingLog(
      callTool(categoryName, { id: "tools" }, unreachable),
    );

    expect(result).toEqual(UNEXPECTED);
    expect(logged).toEqual([expect.stringContaining("no database is bound as DB")]);
  }),
);
