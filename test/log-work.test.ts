import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { onDatabase } from "./support/database.ts";
import { test } from "./support/harness.ts";
import {
  asClientWith,
  householdClient,
  ULID,
  type Call,
  type Fields,
  type Listed,
} from "./support/household.ts";
import { mcp } from "./support/mcp-client.ts";

// What `log_work` does is tested on Node SQLite, in packages/core. In the Worker a list of 50
// is one D1 batch of more than two hundred statements (ADR 0006), the Items and the Spaces of
// each piece of Work are read into its Change by a statement inside that batch, and `query`
// only runs on D1. So these go through the real Worker on local D1, with the made-up household
// loaded. Its Maple Street house is the one Current property.

// What these tests save. Nothing else in the database has these names.
const JOB = "Shed job";
const SHED = "Potting shed";
const LEANTO = "Shed lean-to";
const BUILDER = "Shed and Fence Plumbing";
const JOBS = `SELECT id FROM work WHERE title GLOB '${JOB}*'`;

// Takes out what these tests wrote. No tool deletes a record yet, and the database is kept
// between runs, so each test starts and ends with this. The Items and the Spaces a piece of
// Work names go with it.
const cleanUp = onDatabase(
  `DELETE FROM changes WHERE id IN (
     SELECT change_id FROM change_records
      WHERE (entity_type = 'work' AND entity_id IN (${JOBS}))
         OR (entity_type = 'space'
             AND entity_id IN (SELECT id FROM spaces WHERE name IN ('${SHED}', '${LEANTO}')))
         OR (entity_type = 'vendor'
             AND entity_id IN (SELECT id FROM vendors WHERE name = '${BUILDER}')))`,
  `DELETE FROM notes WHERE entity_type = 'work' AND entity_id IN (${JOBS})`,
  `DELETE FROM work WHERE title GLOB '${JOB}*'`,
  `DELETE FROM spaces WHERE name IN ('${SHED}', '${LEANTO}')`,
  `DELETE FROM vendors WHERE name = '${BUILDER}'`,
);

// A test body that calls tools as a signed-in client, on a database with none of the above.
const asClient = asClientWith(cleanUp);

const FRIDGE = "seed-item-fridge";
const TREADMILL = "seed-item-treadmill";

test(
  "a signed-in client is told what log_work takes, for one piece of Work and for a list",
  Effect.gen(function* () {
    const { url, token } = yield* householdClient;
    const { message } = yield* Effect.promise(() => mcp(url, { method: "tools/list" }, token));
    const { result } = message as {
      result: { tools: { name: string; description: string }[] };
    };
    const tool = result.tools.find(({ name }) => name === "log_work");

    // A field says what it is for beside its type, and an optional one takes null or nothing.
    const described = (field: Fields) => ({ ...field, description: expect.any(String) });
    const optional = (field: Fields) => ({ anyOf: [described(field), { type: "null" }] });
    const text = optional({ type: "string" });
    const fields = {
      id: text,
      kind: optional({
        type: "string",
        enum: ["repair", "maintenance", "improvement", "inspection", "other"],
      }),
      title: text,
      description: text,
      date: text,
      // A cost is in dollars, and is never below zero.
      cost: optional({ type: "number", minimum: 0 }),
      // It is true or false at the tool, and 1 or 0 in the table.
      diy: optional({ type: "boolean" }),
      vendor: text,
      property: text,
      item_ids: optional({ type: "array", items: { type: "string" } }),
      spaces: optional({ type: "array", items: described({ type: "string" }) }),
      data: optional({ type: "object" }),
      note: text,
      clear: optional({
        type: "array",
        items: { type: "string", enum: ["property", "description", "date", "cost", "vendor"] },
      }),
    };
    expect(tool).toEqual(
      expect.objectContaining({
        inputSchema: expect.objectContaining({
          type: "object",
          properties: {
            ...fields,
            // An entry of a list has the fields of one piece of Work, and takes no key but
            // those.
            work: optional({
              type: "array",
              minItems: 1,
              maxItems: 50,
              items: { type: "object", properties: fields, additionalProperties: false },
            }),
          },
          additionalProperties: false,
        }),
        // MCP has a client assume a tool may destroy things unless it says otherwise.
        annotations: { readOnlyHint: false, destructiveHint: false },
      }),
    );

    // What the description has to say, because nothing else tells a client.
    for (const said of [
      "Work is always finished.",
      "It belongs to a Project, and is logged here once it is done.",
      "Work needs a Property or at least one Item.",
      "everything paid for the job, materials included",
      "It is never added to an Item's price.",
      "On DIY Work the Vendor is where the materials came from.",
      "Each list replaces the whole set",
      "Work at no Property takes no Spaces",
      "Repainting is Work that names the Space.",
      "`data.replaced`",
      "save_space",
      "The whole list is one Change.",
    ]) {
      expect(tool?.description, said).toContain(said);
    }
  }),
);

// How many pieces of Work these tests have logged, as `query` counts them.
const jobs = (call: Call) =>
  Effect.map(
    call("query", { sql: `SELECT count(*) AS jobs FROM work WHERE title GLOB '${JOB}*'` }),
    (counted) => (counted.rows as [{ jobs: number }])[0].jobs,
  );

test(
  "Work logged with Items and Spaces comes back from get_record, and an update replaces both",
  asClient((call) =>
    Effect.gen(function* () {
      const logged = yield* call("log_work", {
        kind: "improvement",
        title: `${JOB}: ran a water line to the shed`,
        description: "A frost-proof line from the garage, with a shutoff inside.",
        date: "2026-05",
        cost: 1240.5,
        vendor: BUILDER,
        item_ids: [FRIDGE, TREADMILL],
        spaces: [SHED, "garage"],
        data: { permit: "SEED-PERMIT-0901" },
        note: "The shutoff is behind the potting bench.",
      });
      const [shed, builder, work, note] = logged.created as [Listed, Listed, Listed, Listed];
      expect(logged).toMatchObject({
        change_id: expect.stringMatching(ULID),
        created: [
          { type: "space", id: expect.stringMatching(ULID), name: SHED },
          { type: "vendor", id: expect.stringMatching(ULID), name: BUILDER },
          {
            type: "work",
            id: expect.stringMatching(ULID),
            name: `${JOB}: ran a water line to the shed`,
          },
          {
            type: "note",
            id: expect.stringMatching(ULID),
            name: "The shutoff is behind the potting bench.",
          },
        ],
        updated: [],
      });

      // The Work as get_record returns it, which is what the save sent back.
      const stored = {
        id: work.id,
        property_id: "seed-property-maple",
        project_id: null,
        kind: "improvement",
        title: `${JOB}: ran a water line to the shed`,
        description: "A frost-proof line from the garage, with a shutoff inside.",
        date: "2026-05",
        cost: 1240.5,
        diy: 0,
        vendor_id: builder.id,
        schedule_id: null,
        data: { permit: "SEED-PERMIT-0901" },
      };
      const record = yield* call("get_record", { type: "work", id: work.id });
      expect(record).toMatchObject({
        type: "work",
        ...stored,
        property: "Maple Street house",
        vendor: BUILDER,
        items: [
          { id: FRIDGE, name: "Fridge" },
          { id: TREADMILL, name: "Treadmill" },
        ],
        spaces: [
          { id: "seed-space-garage", name: "Garage" },
          { id: shed.id, name: SHED },
        ],
        notes: [{ id: note.id, body: "The shutoff is behind the potting bench." }],
        // On D1 the snapshot is read inside the batch, the Items and the Spaces with it.
        changes: [
          {
            id: logged.change_id,
            tool: "log_work",
            undoes: null,
            before: null,
            after: {
              ...stored,
              items: [FRIDGE, TREADMILL],
              spaces: [shed.id, "seed-space-garage"].sort(),
            },
          },
        ],
      });
      expect(logged.record).toEqual(record);

      // It shows on each Item, on each Space, and on the Vendor, in the same Change.
      const shown = { id: work.id, title: `${JOB}: ran a water line to the shed` };
      const made = { id: logged.change_id, tool: "log_work", before: null };
      expect(
        ((yield* call("get_record", { type: "item", id: TREADMILL })).work as Fields[]).map(
          ({ id }) => id,
        ),
      ).toContain(work.id);
      expect(yield* call("get_record", { type: "space", id: shed.id })).toMatchObject({
        property: "Maple Street house",
        work: [shown],
        changes: [made],
      });
      expect(yield* call("get_record", { type: "vendor", id: builder.id })).toMatchObject({
        work: [shown],
        changes: [made],
      });
      expect(yield* call("get_record", { type: "note", id: note.id })).toMatchObject({
        property: "Maple Street house",
        attached_to: [{ type: "work", id: work.id }],
        changes: [made],
      });

      // The view a client writes SQL against names them all.
      const viewed = yield* call("query", {
        sql: `SELECT property, vendor, cost_cents, diy, items, spaces FROM work_log
               WHERE id = '${work.id}'`,
      });
      const [row] = viewed.rows as [Fields];
      expect(row).toMatchObject({
        property: "Maple Street house",
        vendor: BUILDER,
        cost_cents: 124050,
        diy: 0,
      });
      expect((JSON.parse(row.items as string) as string[]).sort()).toEqual(["Fridge", "Treadmill"]);
      expect((JSON.parse(row.spaces as string) as string[]).sort()).toEqual(["Garage", SHED]);

      // On D1 each set is replaced by two statements inside the batch, and the Change has
      // both sets before and after.
      const updated = yield* call("log_work", {
        id: work.id,
        diy: true,
        item_ids: [TREADMILL],
        spaces: [LEANTO, SHED.toUpperCase()],
        clear: ["cost"],
      });
      const [leanto] = updated.created as [Listed];
      expect(updated).toMatchObject({
        created: [{ type: "space", name: LEANTO }],
        updated: [{ type: "work", id: work.id }],
        record: {
          cost: null,
          diy: 1,
          date: "2026-05",
          items: [{ id: TREADMILL }],
          spaces: [
            { id: shed.id, name: SHED },
            { id: leanto.id, name: LEANTO },
          ],
          changes: [
            {
              id: updated.change_id,
              before: {
                cost: 1240.5,
                diy: 0,
                items: [FRIDGE, TREADMILL],
                spaces: [shed.id, "seed-space-garage"].sort(),
              },
              after: {
                cost: null,
                diy: 1,
                items: [TREADMILL],
                spaces: [shed.id, leanto.id].sort(),
              },
            },
            { id: logged.change_id, before: null },
          ],
        },
      });

      // An Item that is not there refuses the call, and the Work keeps what it had.
      const refused = yield* call("log_work", { id: work.id, item_ids: ["no-such-item"] });
      expect(refused.refused).toContain('There is no Item with the id "no-such-item".');
      expect(yield* call("get_record", { type: "work", id: work.id })).toMatchObject({
        items: [{ id: TREADMILL }],
      });
    }),
  ),
);

test(
  "a list of 50 pieces of Work is saved in one call, as one Change on D1",
  asClient((call) =>
    Effect.gen(function* () {
      // Every entry names the same new Space and the same new Vendor, in one case or another,
      // and an Item, and has a Note of its own.
      const list = Array.from({ length: 50 }, (_, at) => ({
        kind: "maintenance",
        title: `${JOB} ${at + 1}`,
        date: "2026-08",
        cost: at + 0.99,
        diy: at % 2 === 0,
        vendor: at % 2 === 0 ? BUILDER : BUILDER.toLowerCase(),
        item_ids: [at % 2 === 0 ? FRIDGE : TREADMILL],
        spaces: [at % 2 === 0 ? SHED : SHED.toUpperCase(), "Garage"],
        note: `Entry ${at + 1} of the list.`,
      }));
      const logged = yield* call("log_work", { work: list });

      const created = logged.created as Listed[];
      expect(logged).toEqual({
        change_id: expect.stringMatching(ULID),
        created: expect.any(Array),
        updated: [],
      });
      // One Space and one Vendor, then each piece of Work in the order of the list, with its
      // Note after it.
      expect(created.map(({ type }) => type)).toEqual([
        "space",
        "vendor",
        ...Array.from({ length: 50 }, () => ["work", "note"]).flat(),
      ]);
      expect(created.slice(0, 3)).toEqual([
        { type: "space", id: expect.stringMatching(ULID), name: SHED },
        { type: "vendor", id: expect.stringMatching(ULID), name: BUILDER },
        { type: "work", id: expect.stringMatching(ULID), name: `${JOB} 1` },
      ]);
      expect(yield* jobs(call)).toBe(50);
      const [space, vendor] = created as [Listed, Listed];
      const last = created[100]!;
      expect(last).toEqual({ type: "work", id: expect.stringMatching(ULID), name: `${JOB} 50` });

      // The last of them is in the same Change as the first, and so are the Space and the
      // Vendor.
      const made = { id: logged.change_id, tool: "log_work", before: null };
      expect(yield* call("get_record", { type: "work", id: last.id })).toMatchObject({
        title: `${JOB} 50`,
        cost: 49.99,
        diy: 0,
        property: "Maple Street house",
        vendor_id: vendor.id,
        items: [{ id: TREADMILL }],
        spaces: [{ id: "seed-space-garage" }, { id: space.id }],
        notes: [{ body: "Entry 50 of the list." }],
        changes: [
          {
            ...made,
            after: { items: [TREADMILL], spaces: [space.id, "seed-space-garage"].sort() },
          },
        ],
      });
      const shed = yield* call("get_record", { type: "space", id: space.id });
      expect(shed).toMatchObject({ name: SHED, changes: [made] });
      expect(shed.work).toHaveLength(50);

      // A list with one bad entry leaves nothing behind, and a list of more than 50 is turned
      // away before the tool runs.
      const bad = yield* call("log_work", {
        work: [
          { kind: "repair", title: `${JOB} 51`, spaces: [LEANTO] },
          { kind: "repair", title: `${JOB} 52`, item_ids: ["no-such-item"] },
        ],
      });
      expect(bad.refused).toContain(
        'Nothing was saved, because 1 of the 2 entries in `work` was refused. Entries are counted from 0.\nwork.1: There is no Item with the id "no-such-item".',
      );
      const long = Array.from({ length: 51 }, (_, at) => ({
        kind: "repair",
        title: `${JOB} ${at + 60}`,
      }));
      expect((yield* call("log_work", { work: long })).refused).toContain(
        "Expected at most 50 pieces of Work in one call.",
      );
      expect(yield* jobs(call)).toBe(50);
      const leantos = yield* call("query", {
        sql: `SELECT count(*) AS spaces FROM spaces WHERE name = '${LEANTO}'`,
      });
      expect(leantos).toEqual({ rows: [{ spaces: 0 }] });
    }),
  ),
);

// Two of the questions in AGENTS.md, asked the way a client asks them: with the SQL the
// schema's own comments give, through `query`. The made-up household has Work of its own, so
// these look at the Work the test logged.
test(
  "repairs and improvements since March 2023, and the plumber used last, are answered with query",
  asClient((call) =>
    Effect.gen(function* () {
      const logged = yield* call("log_work", {
        work: [
          // In January, before March.
          { kind: "repair", title: `${JOB}: rehung the door`, date: "2023-01-15", cost: 60 },
          // Dated only to the year, which stands for the whole of it.
          { kind: "improvement", title: `${JOB}: new roof`, date: "2023", cost: 2100.75 },
          {
            kind: "repair",
            title: `${JOB}: fixed the tap`,
            date: "2026-10-01",
            cost: 95,
            vendor: BUILDER,
            spaces: [SHED],
          },
          // Neither a repair nor an improvement.
          { kind: "maintenance", title: `${JOB}: oiled the hinges`, date: "2026-09", diy: true },
        ],
      });
      expect(logged.refused).toBeUndefined();

      const since = yield* call("query", {
        sql: `SELECT date, kind, title, cost_cents, vendor, spaces FROM work_log
               WHERE kind IN ('repair', 'improvement') AND (date >= '2023-03' OR date = '2023')
                 AND title GLOB '${JOB}*'
               ORDER BY date`,
      });
      expect(since).toEqual({
        rows: [
          {
            date: "2023",
            kind: "improvement",
            title: `${JOB}: new roof`,
            cost_cents: 210075,
            vendor: null,
            spaces: "[]",
          },
          {
            date: "2026-10-01",
            kind: "repair",
            title: `${JOB}: fixed the tap`,
            cost_cents: 9500,
            vendor: BUILDER,
            spaces: `["${SHED}"]`,
          },
        ],
      });

      // "Who did we use for plumbing last time?" A Vendor made on first use has a name and
      // nothing else, so the client gives it its role, and then asks by the role.
      const plumber = yield* call("save_vendor", { name: BUILDER, role: "plumber" });
      expect(plumber.refused).toBeUndefined();
      const last = yield* call("query", {
        sql: `SELECT v.name, w.date FROM work w JOIN vendors v ON v.id = w.vendor_id
               WHERE v.role = 'plumber' ORDER BY w.date DESC LIMIT 1`,
      });
      expect(last).toEqual({ rows: [{ name: BUILDER, date: "2026-10-01" }] });
    }),
  ),
);
