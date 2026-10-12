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

// What `undo` does is tested on Node SQLite, in packages/core. In the Worker an undo is one
// D1 batch, and D1 holds each statement of it to the foreign keys (ADR 0006). The statements
// read a Change's snapshots inside that batch with JSON functions, and so do the reads before
// it, in forms Node SQLite takes and D1 might not. So these go through the real Worker on
// local D1, with the made-up household loaded. Its Maple Street house is the one Current
// property.

// What these tests save. Every name starts with the same word, in one case or another, and
// nothing else in the database has a name that does.
const TRUNK = "Trunk of winter coats";
const LOFT = "Trunk loft";
const LANDING = "Trunk landing";
const LATCH = "Trunk and Latch";
const KEY = "Trunk came with one key.";
const OURS = `LIKE 'Trunk%'`;

// Takes out what these tests wrote. An undo takes a record out and leaves its Changes, which
// are kept forever, and the database is kept between runs. So the Changes are found by what
// their snapshots call a record, whether the record is still there or not. A Change and the
// undo of it name the same records, so they go in the one statement, which the pointer from
// an undo to its Change needs.
const cleanUp = onDatabase(
  `DELETE FROM changes WHERE id IN (
     SELECT change_id FROM change_records
      WHERE coalesce(json_extract(coalesce(after, before), '$.name'),
                     json_extract(coalesce(after, before), '$.title'),
                     json_extract(coalesce(after, before), '$.body')) ${OURS})`,
  `DELETE FROM notes WHERE body ${OURS}`,
  `DELETE FROM work WHERE title ${OURS}`,
  `DELETE FROM items WHERE name ${OURS}`,
  `DELETE FROM spaces WHERE name ${OURS}`,
  `DELETE FROM vendors WHERE name ${OURS}`,
);

// A test body that calls tools as a signed-in client, on a database with none of the above.
const asClient = asClientWith(cleanUp);

// How many rows these tests have in each table, as `query` counts them.
const counting = (call: Call) =>
  Effect.map(
    call("query", {
      sql: `SELECT (SELECT count(*) FROM items WHERE name ${OURS}) AS items,
                   (SELECT count(*) FROM item_categories
                     WHERE item_id IN (SELECT id FROM items WHERE name ${OURS})) AS item_categories,
                   (SELECT count(*) FROM spaces WHERE name ${OURS}) AS spaces,
                   (SELECT count(*) FROM vendors WHERE name ${OURS}) AS vendors,
                   (SELECT count(*) FROM notes WHERE body ${OURS}) AS notes,
                   (SELECT count(*) FROM work WHERE title ${OURS}) AS work`,
    }),
    (counted) => (counted.rows as [Fields])[0],
  );
const NONE = { items: 0, item_categories: 0, spaces: 0, vendors: 0, notes: 0, work: 0 };

// A record as get_record returns it, without its Changes: what it is, whatever was done to it.
const apartFromChanges = (record: Fields) => ({ ...record, changes: undefined });

// The trunk, saved the way a client saves an Item: in a Space and from a Vendor that are both
// made on first use, with extra Categories and a Note.
const savingTheTrunk = (call: Call) =>
  call("save_item", {
    name: TRUNK,
    space: LOFT,
    bought_from: LATCH,
    category: "furniture",
    extra_categories: ["decor", "office"],
    price: 85,
    data: { brand: "Steamer" },
    note: KEY,
  });

test(
  "a signed-in client is told what undo takes, and that it writes without being a delete",
  Effect.gen(function* () {
    const { url, token } = yield* householdClient;
    const { message } = yield* Effect.promise(() => mcp(url, { method: "tools/list" }, token));
    const { result } = message as {
      result: { tools: { name: string; description: string }[] };
    };
    const tool = result.tools.find(({ name }) => name === "undo");
    expect(tool).toEqual(
      expect.objectContaining({
        inputSchema: expect.objectContaining({
          type: "object",
          properties: { change_id: { type: "string", description: expect.any(String) } },
          required: ["change_id"],
          additionalProperties: false,
        }),
        // MCP has a client assume a tool may destroy things unless it says otherwise.
        annotations: { readOnlyHint: false, destructiveHint: false },
      }),
    );

    // What the description has to say, because nothing else tells a client.
    for (const said of [
      "Every tool that writes returns the id of its Change as `change_id`",
      "get_record lists a record's latest Changes",
      "A record the Change created is taken out.",
      "A Change is undone whole or not at all.",
      "Undo those first, in that order, and then this one.",
      "The error names what uses it.",
      "The error says which record is missing and which Change took it out.",
      "Rename the other record first, or undo the Change that made it.",
      "An undo is a Change too, so it can be undone, and then the records are as the first Change left them.",
      "No tool deletes a Property.",
    ]) {
      expect(tool?.description, said).toContain(said);
    }
  }),
);

// An Item points at its Space, and the Space at its Property. So the rows of one Change go out
// in an order, and D1 refuses the batch at the first statement that leaves a row pointing at
// nothing.
test(
  "an Item saved with a new Space, then undone, leaves neither",
  asClient((call) =>
    Effect.gen(function* () {
      const saved = yield* savingTheTrunk(call);
      const [space, vendor, item, note] = saved.created as [Listed, Listed, Listed, Listed];
      expect(yield* counting(call)).toEqual({
        ...NONE,
        items: 1,
        item_categories: 2,
        spaces: 1,
        vendors: 1,
        notes: 1,
      });

      const undone = yield* call("undo", { change_id: saved.change_id });
      expect(undone).toEqual({
        change_id: expect.stringMatching(ULID),
        // By type, and then by id.
        taken_out: [item, note, space, vendor],
        restored: [],
        put_back: [],
      });
      expect(yield* counting(call)).toEqual(NONE);

      // The undo is a Change of its own, which says what it undid and has each record whole.
      const recorded = yield* call("query", {
        sql: `SELECT change.tool, change.undoes, touched.entity_type,
                     json_extract(touched.before, '$.name') AS was, touched.after
                FROM changes AS change
                JOIN change_records AS touched ON touched.change_id = change.id
               WHERE change.id = '${String(undone.change_id)}'
                 AND touched.entity_type IN ('item', 'space')
               ORDER BY touched.entity_type`,
      });
      const undid = { tool: "undo", undoes: saved.change_id, after: null };
      expect(recorded.rows).toEqual([
        { ...undid, entity_type: "item", was: TRUNK },
        { ...undid, entity_type: "space", was: LOFT },
      ]);
    }),
  ),
);

// Each of the three things an undo does to a record is a statement of its own kind on D1: a
// row is restored by an UPDATE that reads the Change, and put back by an INSERT that does.
test(
  "an update, a create, and an undo are each undone on D1, and what is in the way is named",
  asClient((call) =>
    Effect.gen(function* () {
      const saved = yield* savingTheTrunk(call);
      const [space, vendor, item, note] = saved.created as [Listed, Listed, Listed, Listed];
      const getting = call("get_record", { type: "item", id: item.id });
      const was = yield* getting;

      // Every field changes, and the save makes a Space of its own.
      const updated = yield* call("save_item", {
        id: item.id,
        name: `${TRUNK}, painted`,
        space: LANDING,
        category: "decor",
        extra_categories: ["furniture"],
        data: { brand: null, color: "blue" },
        clear: ["price"],
      });
      const [landing] = updated.created as [Listed];

      // The update stands between the save and its undo.
      const early = yield* call("undo", { change_id: saved.change_id });
      expect(early.refused).toMatch(
        new RegExp(
          String.raw`changed again since, and undoing it would write over that\. Undo the later Changes first, newest first:\n"${String(updated.change_id)}", made by save_item at \d{4}-\d{2}-\d{2}T[\d:.]+Z$`,
        ),
      );

      expect(yield* call("undo", { change_id: updated.change_id })).toEqual({
        change_id: expect.stringMatching(ULID),
        taken_out: [landing],
        restored: [item],
        put_back: [],
      });
      const restored = yield* getting;
      expect(apartFromChanges(restored)).toEqual(apartFromChanges(was));
      expect(restored).toMatchObject({
        name: TRUNK,
        space: LOFT,
        category: "Furniture",
        extra_categories: [{ id: "decor" }, { id: "office" }],
        price: 85,
        data: { brand: "Steamer" },
        changes: [
          { tool: "undo", undoes: updated.change_id },
          { id: updated.change_id },
          { id: saved.change_id },
        ],
      });

      // A second Item from the same Vendor never touched the Vendor, and uses it all the same.
      const lid = yield* call("save_item", { name: `${TRUNK}, the lid`, bought_from: LATCH });
      const [second] = lid.created as [Listed];
      const inUse = yield* call("undo", { change_id: saved.change_id });
      expect(inUse.refused).toContain(
        `The Vendor "${LATCH}" (${vendor.id}) is used by the Item "${second.name}" (${second.id}).`,
      );
      expect(yield* counting(call)).toMatchObject({ items: 2, vendors: 1 });

      // With the lid undone, and the update undone, nothing is in the way.
      yield* call("undo", { change_id: lid.change_id });
      const undone = yield* call("undo", { change_id: saved.change_id });
      const four = [item, note, space, vendor];
      expect(undone).toMatchObject({ taken_out: four, restored: [], put_back: [] });
      expect(yield* counting(call)).toEqual(NONE);

      // Undoing that undo puts all four back, under the ids they had.
      expect(yield* call("undo", { change_id: undone.change_id })).toMatchObject({
        taken_out: [],
        restored: [],
        put_back: four,
      });
      const back = yield* getting;
      expect(apartFromChanges(back)).toEqual(apartFromChanges(was));
      expect(back).toMatchObject({
        space: LOFT,
        bought_from: LATCH,
        extra_categories: [{ id: "decor" }, { id: "office" }],
        notes: [{ body: KEY }],
      });
    }),
  ),
);

// Work keeps its Items and its Spaces in tables of their own, which an undo empties and fills
// again from the Change.
test(
  "an update of Work is undone on D1 with its Items and its Spaces, and then the Work itself",
  asClient((call) =>
    Effect.gen(function* () {
      const saved = yield* savingTheTrunk(call);
      const [space, vendor, item, note] = saved.created as [Listed, Listed, Listed, Listed];
      const logged = yield* call("log_work", {
        kind: "maintenance",
        title: "Trunk hinges oiled",
        item_ids: [item.id],
        spaces: [LOFT],
        vendor: LATCH,
      });
      const work = (logged.record as Fields).id;
      const getting = call("get_record", { type: "work", id: work });
      const was = yield* getting;

      const updated = yield* call("log_work", {
        id: work,
        item_ids: ["seed-item-fridge"],
        spaces: [LANDING, "Kitchen"],
        cost: 12.5,
      });
      expect(updated.record).toMatchObject({
        items: [{ id: "seed-item-fridge" }],
        spaces: [{ name: "Kitchen" }, { name: LANDING }],
      });

      expect(yield* call("undo", { change_id: updated.change_id })).toMatchObject({
        taken_out: [{ type: "space", name: LANDING }],
        restored: [{ type: "work", id: work, name: "Trunk hinges oiled" }],
      });
      const restored = yield* getting;
      expect(apartFromChanges(restored)).toEqual(apartFromChanges(was));
      expect(restored).toMatchObject({ items: [{ id: item.id }], spaces: [{ name: LOFT }] });

      // The Work is on the trunk, so the trunk stays until the Work is undone.
      const inUse = yield* call("undo", { change_id: saved.change_id });
      expect(inUse.refused).toContain(`is used by the Work "Trunk hinges oiled" (${String(work)})`);
      yield* call("undo", { change_id: logged.change_id });
      expect(yield* call("undo", { change_id: saved.change_id })).toMatchObject({
        taken_out: [item, note, space, vendor],
      });
      expect(yield* counting(call)).toEqual(NONE);
    }),
  ),
);

// The two reads for what an undo brings back: a record that would point at one that is not
// there, and a record whose name another has taken. Each is a join on the Change's own JSON.
test(
  "an undo that would point at a record that is not there, or reuse a taken name, is refused on D1",
  asClient((call) =>
    Effect.gen(function* () {
      const made = yield* call("save_vendor", { name: LATCH });
      const [vendor] = made.created as [Listed];
      const saved = yield* call("save_item", { name: TRUNK, bought_from: LATCH });
      const [item] = saved.created as [Listed];
      const cleared = yield* call("save_item", { id: item.id, clear: ["bought_from"] });

      // Nothing points at the Vendor now, so it is taken out. The save that cleared it cannot
      // be undone while the Vendor is not there.
      const removed = yield* call("undo", { change_id: made.change_id });
      expect(removed).toMatchObject({ taken_out: [vendor] });
      const pointing = yield* call("undo", { change_id: cleared.change_id });
      expect(pointing.refused).toContain(
        `The Vendor with the id "${vendor.id}" is not there now, and the Item "${TRUNK}" (${item.id}) would point at it. The Change "${String(removed.change_id)}" took it out.`,
      );

      // A second Vendor takes the name, whatever its case. Then the first cannot come back.
      const second = yield* call("save_vendor", { name: LATCH.toUpperCase() });
      const [taker] = second.created as [Listed];
      const named = yield* call("undo", { change_id: removed.change_id });
      expect(named.refused).toContain(
        `The Vendor "${LATCH}" (${vendor.id}) would be called that again, and the Vendor "${taker.name}" (${taker.id}) has the name now.`,
      );
      expect(yield* counting(call)).toMatchObject({ items: 1, vendors: 1 });

      // With the second Vendor undone, the first comes back, and then the trunk points at it.
      yield* call("undo", { change_id: second.change_id });
      expect(yield* call("undo", { change_id: removed.change_id })).toMatchObject({
        put_back: [vendor],
      });
      expect(yield* call("undo", { change_id: cleared.change_id })).toMatchObject({
        restored: [item],
      });
      expect(yield* call("get_record", { type: "item", id: item.id })).toMatchObject({
        bought_from: LATCH,
        vendor_id: vendor.id,
      });
    }),
  ),
);
