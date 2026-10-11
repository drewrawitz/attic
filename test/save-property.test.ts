import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { onDatabase } from "./support/database.ts";
import { test } from "./support/harness.ts";
import { answerFrom, householdClient, type Answer } from "./support/household.ts";
import { mcp } from "./support/mcp-client.ts";

// What `save_property` does is tested on Node SQLite, in packages/core, where an atomic batch
// is a transaction. In the Worker it is D1's own batch (ADR 0006), and the snapshots of a
// Change are read by statements inside that batch. So these go through the real Worker on
// local D1.

type Fields = Record<string, unknown>;

// The Properties these tests save. Nothing else in the database has these names.
const BIRCH = "Birch Road cabin";
const REFUSED = "Cedar Hill flat";
const NAMES = `'${BIRCH}', '${REFUSED}'`;

// Takes out what these tests wrote, and the trigger one of them plants. No tool deletes a
// Property, and the database is kept between runs, so each test starts and ends with this.
const cleanUp = onDatabase(
  `DROP TRIGGER IF EXISTS refuse_change_records`,
  `DELETE FROM changes WHERE id IN (
     SELECT change_id FROM change_records
      WHERE entity_type = 'property'
        AND entity_id IN (SELECT id FROM properties WHERE name IN (${NAMES})))`,
  `DELETE FROM properties WHERE name IN (${NAMES})`,
);

// A test body that calls tools as a signed-in client, on a database with none of the above.
const asClient = <E, R>(
  body: (
    call: (tool: string, input: unknown) => Effect.Effect<Answer<Fields>>,
  ) => Effect.Effect<void, E, R>,
) =>
  Effect.gen(function* () {
    const client = yield* householdClient;
    yield* cleanUp;
    yield* body((tool, input) =>
      Effect.promise(() => answerFrom<Fields>(client, tool, input)),
    ).pipe(Effect.ensuring(Effect.orDie(cleanUp)));
  });

test(
  "a signed-in client is told what save_property takes, and that it writes without destroying",
  Effect.gen(function* () {
    const { url, token } = yield* householdClient;
    const { message } = yield* Effect.promise(() => mcp(url, { method: "tools/list" }, token));
    const { result } = message as { result: { tools: { name: string }[] } };

    // An optional field takes null or nothing, and says what it is for beside its type.
    const optional = (field: Fields) => ({
      anyOf: [{ ...field, description: expect.any(String) }, { type: "null" }],
    });
    expect(result.tools.find(({ name }) => name === "save_property")).toEqual(
      expect.objectContaining({
        description: expect.stringContaining("data.lease_until"),
        inputSchema: expect.objectContaining({
          type: "object",
          properties: {
            id: optional({ type: "string" }),
            name: optional({ type: "string" }),
            tenure: optional({ type: "string", enum: ["own", "rent", "other"] }),
            address: optional({ type: "string" }),
            start_on: optional({ type: "string" }),
            end_on: optional({ type: "string" }),
            data: optional({ type: "object" }),
            clear: optional({
              type: "array",
              items: { type: "string", enum: ["address", "start_on", "end_on"] },
            }),
          },
          // No key but these. `data` above says nothing of the kind, so it takes any key.
          additionalProperties: false,
        }),
        // MCP has a client assume a tool may destroy things unless it says otherwise.
        annotations: { readOnlyHint: false, destructiveHint: false },
      }),
    );
  }),
);

// A ULID: 26 characters of Crockford's base 32.
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

test(
  "a Property saved through the Worker comes back from get_record, with the Change that made it",
  asClient((call) =>
    Effect.gen(function* () {
      const saved = yield* call("save_property", {
        name: BIRCH,
        tenure: "rent",
        start_on: "2024-06",
        data: { lease_until: "2027-06", parking: null },
      });
      expect(saved).toEqual({
        change_id: expect.stringMatching(ULID),
        created: [{ type: "property", id: expect.stringMatching(ULID), name: BIRCH }],
        updated: [],
        record: expect.objectContaining({ type: "property", name: BIRCH }),
      });
      const { id } = (saved.created as Fields[])[0]!;

      const whole = {
        id,
        name: BIRCH,
        tenure: "rent",
        address: null,
        start_on: "2024-06",
        end_on: null,
        data: { lease_until: "2027-06" },
        created_at: expect.any(String),
        updated_at: expect.any(String),
      };
      const record = yield* call("get_record", { type: "property", id });
      expect(record).toMatchObject({
        ...whole,
        changes: [
          { id: saved.change_id, tool: "save_property", undoes: null, before: null, after: whole },
        ],
      });
      expect(saved.record).toEqual(record);

      // The same name in another case is the same Property. On D1 the merge patch and both
      // snapshots are the work of statements inside one batch.
      const again = yield* call("save_property", {
        name: BIRCH.toUpperCase(),
        end_on: "2027-06-30",
        data: { lease_until: null, deposit_cents: 180000 },
        clear: ["start_on"],
      });
      const after = { ...whole, start_on: null, end_on: "2027-06-30", data: { deposit: 1800 } };
      expect(again).toMatchObject({
        created: [],
        updated: [{ type: "property", id, name: BIRCH }],
        record: {
          ...after,
          changes: [
            { id: again.change_id, tool: "save_property", before: whole, after },
            { id: saved.change_id, before: null, after: whole },
          ],
        },
      });
    }),
  ),
);

// The MCP layer checks a call against the tool's input before the tool runs.
test(
  "a date that does not exist is turned away with the forms a date can take",
  asClient((call) =>
    Effect.gen(function* () {
      const { refused } = yield* call("save_property", { name: BIRCH, start_on: "2023-13" });
      expect(refused).toContain("Input validation error");
      expect(refused).toContain("2023, 2023-06, or 2023-06-12");

      const there = yield* call("query", {
        sql: `SELECT count(*) AS properties FROM properties WHERE name IN (${NAMES})`,
      });
      expect(there).toEqual({ rows: [{ properties: 0 }] });
    }),
  ),
);

// A fact with no field of its own goes in `data`. Sent beside the fields it is turned away,
// where it was once dropped and the save went through without it.
test(
  "a field save_property does not have is turned away by name, and nothing is saved",
  asClient((call) =>
    Effect.gen(function* () {
      const { refused } = yield* call("save_property", { name: BIRCH, sqft: 240, note: "x" });
      const fields =
        "There is no field with this name. The fields are: id, name, tenure, address, start_on, end_on, data, clear. A fact with no field of its own goes inside data.";
      expect(refused).toBe(
        `Input validation error: Invalid arguments for tool save_property: sqft: ${fields}, note: ${fields}`,
      );

      const there = yield* call("query", {
        sql: `SELECT count(*) AS properties FROM properties WHERE name IN (${NAMES})`,
      });
      expect(there).toEqual({ rows: [{ properties: 0 }] });

      // Inside `data` the same fact is kept.
      const saved = yield* call("save_property", { name: BIRCH, data: { sqft: 240 } });
      expect(saved.record).toMatchObject({ name: BIRCH, data: { sqft: 240 } });
    }),
  ),
);

// The rows of a Change are the last thing a batch writes, after the Property's own row. A
// trigger that refuses them fails a create at its last statement and an update at its second.
test(
  "a batch that D1 refuses partway leaves nothing behind: no row and no Change",
  asClient((call) =>
    Effect.gen(function* () {
      const tables = call("query", {
        sql: `SELECT (SELECT json_group_array(json_object('name', name, 'tenure', tenure))
                        FROM properties WHERE name IN (${NAMES})) AS properties,
                     (SELECT count(*) FROM changes) AS changes,
                     (SELECT count(*) FROM change_records) AS change_records`,
      });
      const first = yield* call("save_property", { name: BIRCH });
      expect(first.refused).toBeUndefined();
      const before = yield* tables;
      expect(before.rows).toEqual([
        expect.objectContaining({ properties: `[{"name":"${BIRCH}","tenure":"own"}]` }),
      ]);

      yield* onDatabase(
        `CREATE TRIGGER refuse_change_records BEFORE INSERT ON change_records
         BEGIN SELECT RAISE(ABORT, 'refused by the test'); END`,
      );
      const unexpected = {
        refused: "Attic hit an error it did not expect. The details are in the Worker's log.",
      };
      expect(yield* call("save_property", { name: REFUSED, tenure: "rent" })).toEqual(unexpected);
      expect(yield* call("save_property", { name: BIRCH, tenure: "rent" })).toEqual(unexpected);

      expect(yield* tables).toEqual(before);

      // With the trigger gone, the same save goes through.
      yield* onDatabase(`DROP TRIGGER refuse_change_records`);
      expect(yield* call("save_property", { name: REFUSED, tenure: "rent" })).toMatchObject({
        created: [{ type: "property", name: REFUSED }],
      });
    }),
  ),
);
