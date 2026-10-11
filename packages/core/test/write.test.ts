import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { defineTool } from "../src/tool.ts";
import { saveProperty } from "../src/tools/save-property.ts";
import { Write } from "../src/write.ts";
import { call, readingLog, UNEXPECTED } from "./call.ts";
import { TestDatabase } from "./TestDatabase.ts";

// What a save does with the Change log is tested through save_property. These are the two
// things no real tool does yet, each with a made-up tool: a write that deletes, and a call that
// writes twice.

// No real tool deletes a Property. This one does, the way a tool that deletes will: one step,
// about the record it takes out.
const removeProperty = defineTool({
  name: "remove_property",
  description: "Deletes a Property.",
  input: Schema.Struct({ id: Schema.String }),
  annotations: { destructiveHint: true },
  run: ({ id }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const write = yield* Write;
      const statement = sql`DELETE FROM properties WHERE id = ${id}`;
      return { change_id: yield* write.run([{ type: "property", id, statement }]) };
    }),
});

it.effect("a write that deletes a record has it whole in `before`, and null in `after`", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* call(saveProperty, {
      name: "Elm Court apartment",
      tenure: "rent",
      data: { lease_until: "2022-07" },
    });

    const removed = yield* call(removeProperty, { id: "id-0001" });
    expect(removed).toEqual({ text: '{"change_id":"id-0003"}', isError: false });
    expect(yield* sql`SELECT count(*) AS properties FROM properties`).toEqual([{ properties: 0 }]);

    const [change] = yield* sql<{ tool: string; before: string; after: string | null }>`
      SELECT changes.tool, touched.entity_type, touched.entity_id, touched.before, touched.after
        FROM change_records AS touched
        JOIN changes ON changes.id = touched.change_id
       WHERE changes.id = 'id-0003'`;
    expect(change).toMatchObject({
      tool: "remove_property",
      entity_type: "property",
      entity_id: "id-0001",
      after: null,
    });
    expect(JSON.parse(change!.before)).toEqual({
      id: "id-0001",
      name: "Elm Court apartment",
      tenure: "rent",
      address: null,
      start_on: null,
      end_on: null,
      data: { lease_until: "2022-07" },
      created_at: expect.any(String),
      updated_at: expect.any(String),
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// One call is one Change. Two writes would be two batches, and nothing would undo the first if
// the second failed.
const writesTwice = defineTool({
  name: "writes_twice",
  description: "Asks for two writes in one call.",
  input: Schema.Struct({ id: Schema.String }),
  annotations: {},
  run: ({ id }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const write = yield* Write;
      const renamed = (name: string) => ({
        type: "property" as const,
        id,
        statement: sql`UPDATE properties SET name = ${name} WHERE id = ${id}`,
      });
      yield* write.run([renamed("First")]);
      return yield* write.run([renamed("Second")]);
    }),
});

it.effect("a call that asks for a second write is stopped before it runs", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* call(saveProperty, { name: "Elm Court apartment" });

    const { result, logged } = yield* readingLog(call(writesTwice, { id: "id-0001" }));
    expect(result).toEqual(UNEXPECTED);
    expect(logged).toEqual([expect.stringContaining("One call is one Change")]);

    expect(yield* sql`SELECT name FROM properties`).toEqual([{ name: "First" }]);
    expect(yield* sql`SELECT tool FROM changes ORDER BY id`).toEqual([
      { tool: "save_property" },
      { tool: "writes_twice" },
    ]);
  }).pipe(Effect.provide(TestDatabase)),
);
