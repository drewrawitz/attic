import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { SHAPES, snapshot, type RecordType } from "../../src/records.ts";
import { addNote } from "../../src/tools/add-note.ts";
import { getRecord } from "../../src/tools/get-record.ts";
import { logWork } from "../../src/tools/log-work.ts";
import { saveCategory } from "../../src/tools/save-category.ts";
import { saveItem } from "../../src/tools/save-item.ts";
import { saveProperty } from "../../src/tools/save-property.ts";
import { saveSpace } from "../../src/tools/save-space.ts";
import { saveVendor } from "../../src/tools/save-vendor.ts";
import { undo } from "../../src/tools/undo.ts";
import { Ids } from "../../src/write.ts";
import { answer, call, callAsClient, readingLog, todayIs, UNEXPECTED } from "../call.ts";
import { TestDatabase } from "../TestDatabase.ts";

// A call the way a client sends one: checked against the tool's input first.
const calling = (tool: Parameters<typeof callAsClient>[0]) => (input: unknown) =>
  callAsClient(tool, input).pipe(Effect.map(answer));

const undoing = (changeId: string) => calling(undo)({ change_id: changeId });

const getting = (type: string, id: string) =>
  call(getRecord, { type, id }).pipe(Effect.map(answer));

// A record as get_record returns it, without its Changes: what it is, whatever was done to it.
const apartFromChanges = (record: Record<string, unknown>) => ({ ...record, changes: undefined });

// The test database hands out ids in order. A save takes one for each record it creates, and
// then one for its Change. An undo takes one, for its Change.

// No tool deletes a Property. Undoing the Change that made one is the one way to take it out.
it.effect("undoing the Change that made a Property takes the Property out", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const saved = yield* calling(saveProperty)({ name: "Elm Court apartment", tenure: "rent" });
    expect(saved.change_id).toBe("id-0002");

    expect(yield* undoing("id-0002")).toEqual({
      change_id: "id-0003",
      taken_out: [{ type: "property", id: "id-0001", name: "Elm Court apartment" }],
      restored: [],
      put_back: [],
    });
    expect(yield* sql`SELECT count(*) AS properties FROM properties`).toEqual([{ properties: 0 }]);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("undoing an update puts every field back, `data` and the extra Categories included", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* calling(saveProperty)({ name: "Maple Street house" });
    const created = yield* calling(saveItem)({
      name: "Running watch",
      space: "Office",
      category: "electronics",
      extra_categories: ["fitness", "sports"],
      acquired_on: "2024-03",
      price: 249.99,
      bought_from: "Stride Sports",
      data: { brand: "Garmin", model: "Forerunner 255", serial: "GX-1" },
    });
    const watch = (created.record as { id: string }).id;
    const was = yield* getting("item", watch);

    // Every field changes, and the save makes a Space and a Vendor of its own.
    const updated = yield* calling(saveItem)({
      id: watch,
      name: "Trail watch",
      space: "Hallway",
      scope: "fixture",
      category: "sports",
      extra_categories: ["electronics"],
      price: 199,
      bought_from: "Second Wind",
      data: { model: null, color: "black" },
      clear: ["acquired_on"],
    });
    const [hallway, secondWind] = updated.created as { id: string }[];

    const undone = yield* undoing(updated.change_id as string);
    expect(undone).toEqual({
      change_id: expect.any(String),
      // The Space and the Vendor the update made are of no use to the Item as it was.
      taken_out: [
        { type: "space", id: hallway!.id, name: "Hallway" },
        { type: "vendor", id: secondWind!.id, name: "Second Wind" },
      ],
      restored: [{ type: "item", id: watch, name: "Running watch" }],
      put_back: [],
    });

    // The Item is as it was, `updated_at` included.
    const is = yield* getting("item", watch);
    expect(apartFromChanges(is)).toEqual(apartFromChanges(was));
    expect(is).toMatchObject({
      name: "Running watch",
      space: "Office",
      scope: "belonging",
      category: "Electronics",
      extra_categories: [
        { id: "fitness", name: "Fitness" },
        { id: "sports", name: "Sports and recreation" },
      ],
      acquired_on: "2024-03",
      price: 249.99,
      bought_from: "Stride Sports",
      data: { brand: "Garmin", model: "Forerunner 255", serial: "GX-1" },
    });
    expect(yield* sql`SELECT name FROM spaces ORDER BY name`).toEqual([{ name: "Office" }]);
    expect(yield* sql`SELECT name FROM vendors ORDER BY name`).toEqual([{ name: "Stride Sports" }]);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("an undo is a Change too, which says what it undid, and get_record shows it", () =>
  Effect.gen(function* () {
    yield* calling(saveProperty)({ name: "Elm Court apartment", data: { lease_until: "2022-07" } });
    yield* calling(saveProperty)({
      id: "id-0001",
      name: "Elm Court flat",
      tenure: "rent",
      data: { lease_until: null, parking: "street" },
    });
    const first = { name: "Elm Court apartment", tenure: "own", data: { lease_until: "2022-07" } };
    const second = { name: "Elm Court flat", tenure: "rent", data: { parking: "street" } };

    expect(yield* undoing("id-0003")).toEqual({
      change_id: "id-0004",
      taken_out: [],
      restored: [{ type: "property", id: "id-0001", name: "Elm Court apartment" }],
      put_back: [],
    });
    // The undo has the record before and after, as any Change has.
    expect(yield* getting("property", "id-0001")).toMatchObject({
      ...first,
      changes: [
        { id: "id-0004", tool: "undo", undoes: "id-0003", before: second, after: first },
        { id: "id-0003", tool: "save_property", undoes: null, before: first, after: second },
        { id: "id-0002", tool: "save_property", undoes: null, before: null, after: first },
      ],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// An Item saved the way a client saves one: with a Space and a Vendor that are made on first
// use, extra Categories, and a Note. Returns what the save sent back.
const savingTheWatch = Effect.gen(function* () {
  yield* calling(saveProperty)({ name: "Maple Street house" });
  return yield* calling(saveItem)({
    name: "Running watch",
    space: "Office",
    category: "electronics",
    extra_categories: ["fitness", "sports"],
    price: 249.99,
    bought_from: "Stride Sports",
    data: { brand: "Garmin" },
    note: "The strap is a replacement.",
  });
});

// How many rows each table an Item's save writes to has.
const counting = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [counts] = yield* sql<Record<string, number>>`
    SELECT (SELECT count(*) FROM items) AS items,
           (SELECT count(*) FROM item_categories) AS item_categories,
           (SELECT count(*) FROM spaces) AS spaces,
           (SELECT count(*) FROM vendors) AS vendors,
           (SELECT count(*) FROM notes) AS notes`;
  return counts;
});

it.effect(
  "undoing the Change that created an Item takes out the Space, the Vendor, and the Note it made",
  () =>
    Effect.gen(function* () {
      const saved = yield* savingTheWatch;
      // The Property is id-0001, and its Change id-0002.
      expect(saved).toMatchObject({
        change_id: "id-0007",
        created: [{ type: "space" }, { type: "vendor" }, { type: "item" }, { type: "note" }],
      });
      expect(yield* counting).toEqual({
        items: 1,
        item_categories: 2,
        spaces: 1,
        vendors: 1,
        notes: 1,
      });

      // What was taken out, by type and then by id.
      expect(yield* undoing("id-0007")).toEqual({
        change_id: "id-0008",
        taken_out: [
          { type: "item", id: "id-0005", name: "Running watch" },
          { type: "note", id: "id-0006", name: "The strap is a replacement." },
          { type: "space", id: "id-0003", name: "Office" },
          { type: "vendor", id: "id-0004", name: "Stride Sports" },
        ],
        restored: [],
        put_back: [],
      });
      expect(yield* counting).toEqual({
        items: 0,
        item_categories: 0,
        spaces: 0,
        vendors: 0,
        notes: 0,
      });
    }).pipe(Effect.provide(TestDatabase)),
);

it.effect("undoing the undo leaves the records as the first Change left them", () =>
  Effect.gen(function* () {
    const saved = yield* savingTheWatch;
    const was = yield* getting("item", "id-0005");
    yield* undoing(saved.change_id as string);

    expect(yield* undoing("id-0008")).toEqual({
      change_id: "id-0009",
      taken_out: [],
      restored: [],
      put_back: [
        { type: "item", id: "id-0005", name: "Running watch" },
        { type: "note", id: "id-0006", name: "The strap is a replacement." },
        { type: "space", id: "id-0003", name: "Office" },
        { type: "vendor", id: "id-0004", name: "Stride Sports" },
      ],
    });

    // The Item is as the save left it: in its Space, from its Vendor, with its extra
    // Categories and its Note, and under the id it had.
    const is = yield* getting("item", "id-0005");
    expect(apartFromChanges(is)).toEqual(apartFromChanges(was));
    expect(is).toMatchObject({
      space: "Office",
      bought_from: "Stride Sports",
      extra_categories: [{ id: "fitness" }, { id: "sports" }],
      notes: [{ id: "id-0006", body: "The strap is a replacement." }],
      changes: [
        { id: "id-0009", tool: "undo", undoes: "id-0008", before: null },
        { id: "id-0008", tool: "undo", undoes: "id-0007", after: null },
        { id: "id-0007", tool: "save_item", undoes: null, before: null },
      ],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a Change id that is not there is an error that names it", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* calling(saveProperty)({ name: "Elm Court apartment" });

    expect(yield* undoing("id-0404")).toEqual({
      refused:
        'There is no Change with the id "id-0404". The id of a Change is in the reply of the tool that made it, and get_record lists the latest Changes of a record.',
    });
    // Nothing was written: the Property is there, and its Change is the only one.
    expect(yield* sql`SELECT id, tool FROM changes`).toEqual([
      { id: "id-0002", tool: "save_property" },
    ]);
  }).pipe(Effect.provide(TestDatabase)),
);

// How a refusal writes the time of a Change: a full UTC timestamp.
const AT = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z`;

// The Change of the watch touched four records. Two of them are saved again afterwards.
it.effect(
  "a record changed again since is refused with the later Changes, and undoing those clears the way",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* savingTheWatch;
      yield* calling(saveSpace)({ name: "Office", data: { sqft: 120 } });
      yield* calling(saveVendor)({ name: "Stride Sports", role: "retailer" });
      const before = yield* counting;

      // The Item and its Note are as the Change left them. It is refused whole all the same.
      const refused = yield* undoing("id-0007");
      expect(refused.refused).toMatch(
        new RegExp(
          String.raw`^Nothing was undone, because records the Change "id-0007" touched have been changed again since, and undoing it would write over that\. Undo the later Changes first, newest first:
"id-0009", made by save_vendor at ${AT}
"id-0008", made by save_space at ${AT}$`,
        ),
      );
      expect(yield* counting).toEqual(before);
      expect(yield* sql`SELECT count(*) AS changes FROM changes`).toEqual([{ changes: 4 }]);

      // With the newest of them undone, one record of the four has been changed since. The
      // Change is refused whole all the same, and nothing is written.
      expect(yield* undoing("id-0009")).toMatchObject({ change_id: "id-0010" });
      expect((yield* undoing("id-0007")).refused).toMatch(
        new RegExp(String.raw`newest first:\n"id-0008", made by save_space at ${AT}$`),
      );
      expect(yield* counting).toEqual(before);
      expect(yield* sql`SELECT count(*) AS changes FROM changes`).toEqual([{ changes: 5 }]);

      // A Change and the undo of it leave nothing behind, so neither is in the way.
      expect(yield* undoing("id-0008")).toMatchObject({ change_id: "id-0011" });
      expect(yield* undoing("id-0007")).toMatchObject({
        change_id: "id-0012",
        taken_out: [{ type: "item" }, { type: "note" }, { type: "space" }, { type: "vendor" }],
      });
      expect(yield* counting).toEqual({
        items: 0,
        item_categories: 0,
        spaces: 0,
        vendors: 0,
        notes: 0,
      });
    }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a Change that was undone already is refused, and says which Change undid it", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* calling(saveProperty)({ name: "Elm Court apartment" });
    yield* undoing("id-0002");

    expect(yield* undoing("id-0002")).toEqual({
      refused:
        'Nothing was undone, because the Change "id-0002" was undone already, by the Change "id-0003". Undoing "id-0003" leaves the records as "id-0002" left them.',
    });
    expect(yield* sql`SELECT count(*) AS changes FROM changes`).toEqual([{ changes: 2 }]);

    // Once that undo is undone, the Property is back, and the first Change can be undone again.
    expect(yield* undoing("id-0003")).toMatchObject({ put_back: [{ id: "id-0001" }] });
    expect(yield* undoing("id-0002")).toMatchObject({
      change_id: "id-0005",
      taken_out: [{ type: "property", id: "id-0001", name: "Elm Court apartment" }],
    });
    expect(yield* sql`SELECT count(*) AS properties FROM properties`).toEqual([{ properties: 0 }]);
  }).pipe(Effect.provide(TestDatabase)),
);

// The save of the watch made the Vendor on first use. A second Item bought from it did not
// touch the Vendor, so no later Change is in the way. The Vendor is in use all the same.
it.effect("undoing the Change that made a Vendor another Item now uses is refused", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* savingTheWatch;
    const shoes = yield* calling(saveItem)({ name: "Trail shoes", bought_from: "stride sports" });
    expect(shoes).toMatchObject({
      change_id: "id-0009",
      created: [{ type: "item", id: "id-0008", name: "Trail shoes" }],
    });
    const before = yield* counting;

    expect(yield* undoing("id-0007")).toEqual({
      refused: `Nothing was undone, because undoing the Change "id-0007" would take out what other records use now. Point those records elsewhere first, or undo the Changes that made them use it:
The Vendor "Stride Sports" (id-0004) is used by the Item "Trail shoes" (id-0008).`,
    });
    expect(yield* counting).toEqual(before);
    expect(yield* sql`SELECT count(*) AS changes FROM changes`).toEqual([{ changes: 3 }]);

    // With the shoes bought elsewhere, nothing uses the Vendor, and the undo goes through.
    yield* calling(saveItem)({ id: "id-0008", clear: ["bought_from"] });
    expect(yield* undoing("id-0007")).toMatchObject({
      taken_out: [{ type: "item" }, { type: "note" }, { type: "space" }, { type: "vendor" }],
    });
    expect(yield* sql`SELECT name FROM items`).toEqual([{ name: "Trail shoes" }]);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("undoing a change of status takes the dated Note out and puts the status back", () =>
  Effect.gen(function* () {
    yield* todayIs("2026-10-11");
    yield* calling(saveProperty)({ name: "Maple Street house" });
    yield* calling(saveItem)({ name: "Sectional couch", price: 1200 });
    const sold = yield* calling(saveItem)({ id: "id-0003", status: "sold", proceeds: 450 });
    expect(sold.record).toMatchObject({
      status: "sold",
      status_on: "2026-10-11",
      proceeds: 450,
      notes: [{ id: "id-0005", body: "Marked sold on 2026-10-11 for $450.00." }],
    });

    expect(yield* undoing("id-0006")).toEqual({
      change_id: "id-0007",
      taken_out: [{ type: "note", id: "id-0005", name: "Marked sold on 2026-10-11 for $450.00." }],
      restored: [{ type: "item", id: "id-0003", name: "Sectional couch" }],
      put_back: [],
    });
    expect(yield* getting("item", "id-0003")).toMatchObject({
      status: "active",
      status_on: null,
      proceeds: null,
      price: 1200,
      notes: [],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("undoing a list save of 50 Items takes all 50 out", () =>
  Effect.gen(function* () {
    yield* calling(saveProperty)({ name: "Maple Street house" });
    const saved = yield* calling(saveItem)({
      items: Array.from({ length: 50 }, (_, at) => ({
        name: `Moving box ${at + 1}`,
        space: "Garage",
        bought_from: "Box and Tape",
        extra_categories: ["office"],
      })),
    });
    expect(yield* counting).toEqual({
      items: 50,
      item_categories: 50,
      spaces: 1,
      vendors: 1,
      notes: 0,
    });

    const undone = yield* undoing(saved.change_id as string);
    const takenOut = undone.taken_out as { type: string; name: string }[];
    expect(takenOut.map(({ type }) => type)).toEqual([
      ...Array.from({ length: 50 }, () => "item"),
      "space",
      "vendor",
    ]);
    // In the order of their ids, which is the order the list had them in.
    expect(takenOut.slice(0, 50).map(({ name }) => name)).toEqual(
      Array.from({ length: 50 }, (_, at) => `Moving box ${at + 1}`),
    );
    expect(undone).toMatchObject({ restored: [], put_back: [] });
    expect(yield* counting).toEqual({
      items: 0,
      item_categories: 0,
      spaces: 0,
      vendors: 0,
      notes: 0,
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// Moving day in small: a list that moves three Items to another Property. Each loses its
// Space and is filed again, and the Note on one of them moves with it.
it.effect("undoing a list update restores every Item in it, and the Note that moved", () =>
  Effect.gen(function* () {
    yield* calling(saveProperty)({ name: "Maple Street house" });
    yield* calling(saveProperty)({ name: "Birch Lane house", start_on: "2030" });
    const boxes = yield* calling(saveItem)({
      items: [1, 2, 3].map((box) => ({
        name: `Moving box ${box}`,
        property: "Maple Street house",
        space: "Garage",
        category: "office",
        extra_categories: ["tools", "kitchen"],
        ...(box === 3 ? { note: "Fragile, this way up." } : {}),
      })),
    });
    const ids = (boxes.created as { type: string; id: string }[])
      .filter(({ type }) => type === "item")
      .map(({ id }) => id);
    const were = yield* Effect.forEach(ids, (id) => getting("item", id));

    const moved = yield* calling(saveItem)({
      items: ids.map((id) => ({
        id,
        property: "Birch Lane house",
        category: "tools",
        extra_categories: ["office"],
      })),
    });
    expect(moved.updated).toHaveLength(4);

    const undone = yield* undoing(moved.change_id as string);
    expect(undone).toMatchObject({
      taken_out: [],
      restored: [{ type: "item" }, { type: "item" }, { type: "item" }, { type: "note" }],
      put_back: [],
    });
    const are = yield* Effect.forEach(ids, (id) => getting("item", id));
    expect(are.map(apartFromChanges)).toEqual(were.map(apartFromChanges));
    expect(are[2]).toMatchObject({
      property: "Maple Street house",
      space: "Garage",
      category: "Office",
      extra_categories: [{ id: "kitchen" }, { id: "tools" }],
    });
    const [note] = (are[2] as { notes: { id: string }[] }).notes;
    expect(yield* getting("note", note!.id)).toMatchObject({
      body: "Fragile, this way up.",
      property: "Maple Street house",
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// Work as a client logs it: on an Item, in two Spaces, by a Vendor, with a Note. Returns the
// id of the Work, and the ids of the two Items there are.
const loggingTheLeak = Effect.gen(function* () {
  yield* calling(saveProperty)({ name: "Maple Street house" });
  const saved = yield* calling(saveItem)({
    items: [{ name: "Kitchen sink" }, { name: "Dishwasher" }],
  });
  const [sink, dishwasher] = (saved.created as { id: string }[]).map(({ id }) => id);
  const logged = yield* calling(logWork)({
    kind: "repair",
    title: "Fixed the leak under the sink",
    date: "2026-09",
    cost: 180,
    vendor: "Pipewise Plumbing",
    item_ids: [sink],
    spaces: ["Kitchen", "Basement"],
    note: "The trap was cracked.",
  });
  return { leak: (logged.record as { id: string }).id, sink: sink!, dishwasher: dishwasher! };
});

it.effect("undoing an update of Work puts its Items and its Spaces back as they were", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { leak, dishwasher } = yield* loggingTheLeak;
    const was = yield* getting("work", leak);

    // Both sets are replaced, and the save makes a Space of its own.
    const updated = yield* calling(logWork)({
      id: leak,
      title: "Replaced the dishwasher hose",
      cost: 95.5,
      item_ids: [dishwasher],
      spaces: ["Utility closet"],
      data: { permit: "none" },
    });
    expect(updated.record).toMatchObject({
      items: [{ name: "Dishwasher" }],
      spaces: [{ name: "Utility closet" }],
    });

    expect(yield* undoing(updated.change_id as string)).toMatchObject({
      taken_out: [{ type: "space", name: "Utility closet" }],
      restored: [{ type: "work", id: leak, name: "Fixed the leak under the sink" }],
      put_back: [],
    });
    const is = yield* getting("work", leak);
    expect(apartFromChanges(is)).toEqual(apartFromChanges(was));
    expect(is).toMatchObject({
      cost: 180,
      data: {},
      items: [{ name: "Kitchen sink" }],
      spaces: [{ name: "Basement" }, { name: "Kitchen" }],
    });
    expect(yield* sql`SELECT name FROM spaces ORDER BY name`).toEqual([
      { name: "Basement" },
      { name: "Kitchen" },
    ]);
  }).pipe(Effect.provide(TestDatabase)),
);

// No tool deletes a record yet. So the Change of a delete is written here the way a tool's
// write records one: under the next id, with each record whole in `before`, with its link
// sets, and null in `after`. Returns the id of the Change.
const deletingByHand = (...records: ReadonlyArray<readonly [type: RecordType, id: string]>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const change = yield* (yield* Ids).next;
    yield* sql`INSERT INTO changes (id, tool) VALUES (${change}, 'delete_record')`;
    for (const [type, id] of records) {
      const shape = SHAPES[type];
      yield* sql.unsafe(
        `INSERT INTO change_records (change_id, entity_type, entity_id, before)
         SELECT ?, ?, record.id, ${snapshot(shape)} FROM ${shape.table} AS record
          WHERE record.id = ?`,
        [change, type, id],
      );
    }
    // A link set goes with its row.
    for (const [type, id] of records) {
      yield* sql.unsafe(`DELETE FROM ${SHAPES[type].table} WHERE id = ?`, [id]);
    }
    return change;
  });

it.effect("undoing a delete puts the row back with its link sets", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { leak, sink } = yield* loggingTheLeak;
    const was = yield* getting("work", leak);
    const [note] = (was as { notes: { id: string }[] }).notes;

    const deleted = yield* deletingByHand(["note", note!.id], ["work", leak]);
    expect(yield* sql`SELECT count(*) AS links FROM work_items`).toEqual([{ links: 0 }]);
    expect(yield* sql`SELECT count(*) AS links FROM work_spaces`).toEqual([{ links: 0 }]);
    expect((yield* getting("work", leak)).refused).toContain("There is no Work");

    expect(yield* undoing(deleted)).toEqual({
      change_id: expect.any(String),
      taken_out: [],
      restored: [],
      put_back: [
        { type: "note", id: note!.id, name: "The trap was cracked." },
        { type: "work", id: leak, name: "Fixed the leak under the sink" },
      ],
    });
    // The Work is as it was: on its Item, in its two Spaces, with its Note.
    const is = yield* getting("work", leak);
    expect(apartFromChanges(is)).toEqual(apartFromChanges(was));
    expect(is).toMatchObject({
      items: [{ id: sink, name: "Kitchen sink" }],
      spaces: [{ name: "Basement" }, { name: "Kitchen" }],
      notes: [{ id: note!.id, body: "The trap was cracked." }],
      changes: [
        { tool: "undo", undoes: deleted, before: null },
        { id: deleted, tool: "delete_record", after: null },
        { tool: "log_work", before: null },
      ],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// A Note points at its record by type and id, and no foreign key holds that. The Note was added
// by a Change of its own, which never touched the Item.
it.effect("undoing the Change that made an Item is refused while a later Note is on it", () =>
  Effect.gen(function* () {
    yield* savingTheWatch;
    const added = yield* calling(addNote)({
      body: "The battery lasts two weeks.",
      attach_to: { type: "item", id: "id-0005" },
    });
    expect(added.change_id).toBe("id-0009");
    const before = yield* counting;

    // The Note the save itself wrote goes out with the Item, so it is not in the way.
    expect(yield* undoing("id-0007")).toEqual({
      refused: `Nothing was undone, because undoing the Change "id-0007" would take out what other records use now. Point those records elsewhere first, or undo the Changes that made them use it:
The Item "Running watch" (id-0005) is used by the Note "The battery lasts two weeks." (id-0008).`,
    });
    expect(yield* counting).toEqual(before);

    yield* undoing("id-0009");
    expect(yield* undoing("id-0007")).toMatchObject({
      taken_out: [{ type: "item" }, { type: "note" }, { type: "space" }, { type: "vendor" }],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// Deleting a Property's row would take its Spaces with it, and leave its Items at no Property,
// with no Change to say so. So a Property goes out only while nothing is at it.
it.effect("undoing the Change that made a Property is refused while anything is at it", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // The watch is in the Office, and its Note is at the Property too.
    yield* savingTheWatch;

    expect(yield* undoing("id-0002")).toEqual({
      refused: `Nothing was undone, because undoing the Change "id-0002" would take out what other records use now. Point those records elsewhere first, or undo the Changes that made them use it:
The Property "Maple Street house" (id-0001) is used by the Space "Office" (id-0003), the Item "Running watch" (id-0005), the Note "The strap is a replacement." (id-0006).`,
    });
    expect(yield* sql`SELECT name FROM properties`).toEqual([{ name: "Maple Street house" }]);
    expect(yield* sql`SELECT name FROM spaces`).toEqual([{ name: "Office" }]);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a record that many others use is refused with the first few, and a count", () =>
  Effect.gen(function* () {
    // The save of the first box makes the Garage. Seven more go in it afterwards.
    yield* calling(saveProperty)({ name: "Maple Street house" });
    const first = yield* calling(saveItem)({ name: "Moving box 1", space: "Garage" });
    yield* calling(saveItem)({
      items: Array.from({ length: 7 }, (_, at) => ({
        name: `Moving box ${at + 2}`,
        space: "garage",
      })),
    });

    const refused = yield* undoing(first.change_id as string);
    expect(refused.refused).toContain(
      'The Space "Garage" (id-0003) is used by the Item "Moving box 2" (id-0006), the Item "Moving box 3" (id-0007), the Item "Moving box 4" (id-0008), the Item "Moving box 5" (id-0009), the Item "Moving box 6" (id-0010), and 2 more.',
    );
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a Note is named by the start of its body, as the reply of its save names it", () =>
  Effect.gen(function* () {
    yield* calling(saveProperty)({ name: "Maple Street house" });
    const body =
      "The breaker panel is in the garage, behind the shelving on the left wall, and breaker 14 is the one for the garage outlets.";
    const added = yield* calling(addNote)({ body });
    const [note] = added.created as { name: string }[];
    expect(note).toEqual({
      type: "note",
      id: "id-0003",
      name: "The breaker panel is in the garage, behind the shelving on the left wall, and br…",
    });

    expect(yield* undoing(added.change_id as string)).toMatchObject({ taken_out: [note] });
  }).pipe(Effect.provide(TestDatabase)),
);

// Every type a tool writes is one `undo` knows. A Change with a record of another type was not
// written by this code, and undoing the rest of it would leave that record as it is.
it.effect("a Change with a record of a type nothing writes is not undone in part", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* calling(saveProperty)({ name: "Elm Court apartment" });
    yield* sql`
      INSERT INTO change_records (change_id, entity_type, entity_id, after)
      VALUES ('id-0002', 'gadget', 'gadget-1', '{"id":"gadget-1"}')`;

    const { result, logged } = yield* readingLog(call(undo, { change_id: "id-0002" }));
    expect(result).toEqual(UNEXPECTED);
    expect(logged).toEqual([expect.stringContaining('no type of record called "gadget"')]);
    expect(yield* sql`SELECT name FROM properties`).toEqual([{ name: "Elm Court apartment" }]);
    expect(yield* sql`SELECT count(*) AS changes FROM changes`).toEqual([{ changes: 1 }]);
  }).pipe(Effect.provide(TestDatabase)),
);

const NOT_THERE =
  "Nothing was undone, because a record would come back pointing at one that is not there now. Put that one back first, by undoing the Change that took it out:";

// The mirror of a record in use. The drill was bought from a Vendor, and a later save cleared
// that. Nothing points at the Vendor then, so the Change that made it can be undone. Undoing
// the save that cleared it would point the drill at a Vendor that is not there.
it.effect("an undo that would point a record at one that is not there is refused", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* calling(saveProperty)({ name: "Maple Street house" });
    yield* calling(saveVendor)({ name: "Tool Depot" });
    yield* calling(saveItem)({ name: "Cordless drill", bought_from: "Tool Depot" });
    yield* calling(saveItem)({ id: "id-0005", clear: ["bought_from"] });
    expect(yield* undoing("id-0004")).toMatchObject({
      change_id: "id-0008",
      taken_out: [{ type: "vendor", id: "id-0003", name: "Tool Depot" }],
    });

    expect(yield* undoing("id-0007")).toEqual({
      refused: `${NOT_THERE}
The Vendor with the id "id-0003" is not there now, and the Item "Cordless drill" (id-0005) would point at it. The Change "id-0008" took it out.`,
    });
    expect(yield* sql`SELECT vendor_id FROM items`).toEqual([{ vendor_id: null }]);
    expect(yield* sql`SELECT count(*) AS changes FROM changes`).toEqual([{ changes: 5 }]);

    // With the Vendor back, the drill can point at it again.
    yield* undoing("id-0008");
    expect(yield* undoing("id-0007")).toMatchObject({ restored: [{ id: "id-0005" }] });
    expect(yield* getting("item", "id-0005")).toMatchObject({ bought_from: "Tool Depot" });
  }).pipe(Effect.provide(TestDatabase)),
);

// A Note points at its record by type and id, and no foreign key would turn this one away.
it.effect("an undo that would put a Note back on a record that is not there is refused", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* calling(saveProperty)({ name: "Maple Street house" });
    yield* calling(saveItem)({ name: "Cordless drill" });
    yield* calling(addNote)({
      body: "The chuck key is taped to the cord.",
      attach_to: { type: "item", id: "id-0003" },
    });
    // The Note goes out, and then the drill, which nothing points at any more.
    expect(yield* undoing("id-0006")).toMatchObject({ change_id: "id-0007" });
    expect(yield* undoing("id-0004")).toMatchObject({ change_id: "id-0008" });

    expect(yield* undoing("id-0007")).toEqual({
      refused: `${NOT_THERE}
The Item with the id "id-0003" is not there now, and the Note "The chuck key is taped to the cord." (id-0005) would point at it. The Change "id-0008" took it out.`,
    });
    expect(yield* sql`SELECT count(*) AS notes FROM notes`).toEqual([{ notes: 0 }]);

    yield* undoing("id-0008");
    yield* undoing("id-0007");
    expect(yield* getting("item", "id-0003")).toMatchObject({
      notes: [{ id: "id-0005", body: "The chuck key is taped to the cord." }],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// Work points at its Items through a link set.
it.effect("an undo that would link Work to an Item that is not there is refused", () =>
  Effect.gen(function* () {
    yield* calling(saveProperty)({ name: "Maple Street house" });
    const sink = yield* calling(saveItem)({ name: "Kitchen sink" });
    const tap = yield* calling(saveItem)({ name: "Kitchen tap" });
    const [sinkId, tapId] = [sink, tap].map((saved) => (saved.record as { id: string }).id);
    const logged = yield* calling(logWork)({
      kind: "repair",
      title: "Fixed the leak",
      item_ids: [sinkId, tapId],
    });
    const leak = (logged.record as { id: string }).id;
    const narrowed = yield* calling(logWork)({ id: leak, item_ids: [tapId] });
    const sinkOut = yield* undoing(sink.change_id as string);
    expect(sinkOut).toMatchObject({ taken_out: [{ type: "item", id: sinkId }] });

    expect(yield* undoing(narrowed.change_id as string)).toEqual({
      refused: `${NOT_THERE}
The Item with the id "${sinkId}" is not there now, and the Work "Fixed the leak" (${leak}) would point at it. The Change "${String(sinkOut.change_id)}" took it out.`,
    });
    expect(yield* getting("work", leak)).toMatchObject({ items: [{ id: tapId }] });
  }).pipe(Effect.provide(TestDatabase)),
);

const NAME_HELD =
  "Nothing was undone, because a record would get back a name that another record has now. Rename the other record first, or undo the Change that made it:";

// There is one Vendor for each name, whatever its case. The first one is renamed, and a second
// one is saved under the name it had.
it.effect("an undo that would give a record a name another has now is refused", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* calling(saveVendor)({ name: "Acme Supply" });
    yield* calling(saveVendor)({ id: "id-0001", name: "Acme Hardware" });
    yield* calling(saveVendor)({ name: "ACME supply" });

    expect(yield* undoing("id-0003")).toEqual({
      refused: `${NAME_HELD}
The Vendor "Acme Supply" (id-0001) would be called that again, and the Vendor "ACME supply" (id-0004) has the name now.`,
    });
    expect(yield* sql`SELECT name FROM vendors ORDER BY id`).toEqual([
      { name: "Acme Hardware" },
      { name: "ACME supply" },
    ]);
    expect(yield* sql`SELECT count(*) AS changes FROM changes`).toEqual([{ changes: 3 }]);

    // With the second one undone, the name is free again.
    yield* undoing("id-0005");
    expect(yield* undoing("id-0003")).toMatchObject({
      restored: [{ type: "vendor", id: "id-0001", name: "Acme Supply" }],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// The likeliest way there: a save is undone, done again by hand, and then the undo is undone.
// A Space has its name to itself at its Property only, so the same name elsewhere is not in
// the way.
it.effect(
  "an undo that would put a Space back under a name in use at its Property is refused",
  () =>
    Effect.gen(function* () {
      yield* calling(saveProperty)({ name: "Maple Street house" });
      yield* calling(saveProperty)({ name: "Birch Lane house" });
      const first = yield* calling(saveSpace)({ property: "Maple Street house", name: "Workshop" });
      const undone = yield* undoing(first.change_id as string);

      // The same name at the other Property does not stop the Space coming back.
      const elsewhere = yield* calling(saveSpace)({
        property: "Birch Lane house",
        name: "Workshop",
      });
      const back = yield* undoing(undone.change_id as string);
      expect(back).toMatchObject({ put_back: [{ type: "space", name: "Workshop" }] });

      // At its own Property it does.
      const again = yield* undoing(back.change_id as string);
      const second = yield* calling(saveSpace)({
        property: "Maple Street house",
        name: "workshop",
      });
      const [workshop] = first.created as { id: string }[];
      const [taker] = second.created as { id: string }[];
      expect(yield* undoing(again.change_id as string)).toEqual({
        refused: `${NAME_HELD}
The Space "Workshop" (${workshop!.id}) would be called that again, and the Space "workshop" (${taker!.id}) has the name now.`,
      });
      expect(elsewhere.refused).toBeUndefined();
    }).pipe(Effect.provide(TestDatabase)),
);

// The rows of a Change go out one type at a time: the Note and the Item, then the Vendor, then
// the Space. A trigger that refuses the Space fails the batch after the others are out.
it.effect("an undo the database refuses partway leaves nothing behind: no row and no Change", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* savingTheWatch;
    const before = yield* counting;
    yield* sql`
      CREATE TRIGGER refuse_spaces BEFORE DELETE ON spaces
      BEGIN SELECT RAISE(ABORT, 'refused by the test'); END`;

    const { result, logged } = yield* readingLog(undoing("id-0007"));
    expect(result).toEqual({ refused: UNEXPECTED.text });
    expect(logged).toEqual([expect.stringContaining("refused by the test")]);
    expect(yield* counting).toEqual(before);
    expect(yield* sql`SELECT id, tool FROM changes ORDER BY id`).toEqual([
      { id: "id-0002", tool: "save_property" },
      { id: "id-0007", tool: "save_item" },
    ]);

    // With the trigger gone, the same undo goes through.
    yield* sql`DROP TRIGGER refuse_spaces`;
    expect(yield* undoing("id-0007")).toMatchObject({
      taken_out: [{ type: "item" }, { type: "note" }, { type: "space" }, { type: "vendor" }],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// An undo and the Change it undid leave nothing behind only when both came later. The undo of
// an older Change is a later Change like any other: it put the record back to an earlier time.
it.effect("the undo of an older Change stands in the way like any other later Change", () =>
  Effect.gen(function* () {
    yield* calling(saveProperty)({ name: "Elm Court apartment" });
    yield* calling(saveProperty)({ id: "id-0001", address: "4 Elm Court" });
    yield* calling(saveProperty)({ id: "id-0001", tenure: "rent" });
    // The newer save is undone, and then the older one, which that clears the way for.
    expect(yield* undoing("id-0004")).toMatchObject({ change_id: "id-0005" });
    expect(yield* undoing("id-0003")).toMatchObject({ change_id: "id-0006" });
    expect(yield* getting("property", "id-0001")).toMatchObject({ address: null, tenure: "own" });

    // Undoing the first undo would bring the address back with the tenure, over the second.
    expect((yield* undoing("id-0005")).refused).toMatch(
      new RegExp(
        String.raw`newest first:\n"id-0006", made by undo at ${AT}, which undid "id-0003"$`,
      ),
    );
    expect(yield* getting("property", "id-0001")).toMatchObject({ address: null, tenure: "own" });

    // In order, both come back.
    yield* undoing("id-0006");
    expect(yield* undoing("id-0005")).toMatchObject({ restored: [{ id: "id-0001" }] });
    expect(yield* getting("property", "id-0001")).toMatchObject({
      address: "4 Elm Court",
      tenure: "rent",
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// A Category's id is a slug the caller chooses, so the same id can be saved again once the
// Category is out. That save is a later Change of the same record.
it.effect("a Category is restored, kept while an Item is in it, and taken out", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const camping = sql<{ name: string; parent_id: string | null; data: string }>`
      SELECT name, parent_id, data FROM categories WHERE id = 'camping'`;
    yield* calling(saveProperty)({ name: "Maple Street house" });
    const created = yield* calling(saveCategory)({
      id: "camping",
      name: "Camping",
      parent: "outdoor",
      data: { expects: ["brand"] },
    });
    const updated = yield* calling(saveCategory)({
      id: "camping",
      name: "Camping gear",
      parent: "sports",
      data: { expects: ["brand", "model"] },
    });

    expect(yield* undoing(updated.change_id as string)).toMatchObject({
      taken_out: [],
      restored: [{ type: "category", id: "camping", name: "Camping" }],
    });
    expect(yield* camping).toEqual([
      { name: "Camping", parent_id: "outdoor", data: '{"expects":["brand"]}' },
    ]);

    // An Item is filed under it by a save that never touched the Category.
    const tent = yield* calling(saveItem)({ name: "Four-person tent", category: "camping" });
    const tentId = (tent.record as { id: string }).id;
    expect((yield* undoing(created.change_id as string)).refused).toContain(
      `The Category "Camping" (camping) is used by the Item "Four-person tent" (${tentId}).`,
    );

    yield* calling(saveItem)({ id: tentId, category: "outdoor" });
    const takenOut = yield* undoing(created.change_id as string);
    expect(takenOut).toMatchObject({
      taken_out: [{ type: "category", id: "camping", name: "Camping" }],
    });
    expect(yield* camping).toEqual([]);

    // The id is saved again. The first Category cannot come back over the second.
    const again = yield* calling(saveCategory)({ id: "camping", name: "Camping trips" });
    expect((yield* undoing(takenOut.change_id as string)).refused).toMatch(
      new RegExp(
        String.raw`newest first:\n"${String(again.change_id)}", made by save_category at ${AT}$`,
      ),
    );
    expect(yield* camping).toMatchObject([{ name: "Camping trips", parent_id: null }]);
  }).pipe(Effect.provide(TestDatabase)),
);

// No tool makes a Change like this one, so it is written by hand: one Vendor is deleted, and
// another is made under the name it had. An undo brings a row back before it takes one out,
// so the first Vendor would come back while the second still has the name.
it.effect(
  "a Change that gave one record a name it took from another says it cannot be undone",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* calling(saveVendor)({ name: "Acme Supply" });
      const change = yield* (yield* Ids).next;
      yield* sql`INSERT INTO changes (id, tool) VALUES (${change}, 'replace_vendor')`;
      const recording = (column: "before" | "after", id: string) =>
        sql.unsafe(
          `INSERT INTO change_records (change_id, entity_type, entity_id, ${column})
         SELECT ?, 'vendor', record.id, ${snapshot(SHAPES.vendor)} FROM vendors AS record
          WHERE record.id = ?`,
          [change, id],
        );
      yield* recording("before", "id-0001");
      yield* sql`DELETE FROM vendors WHERE id = 'id-0001'`;
      yield* sql`INSERT INTO vendors (id, name) VALUES ('vendor-two', 'Acme Supply')`;
      yield* recording("after", "vendor-two");

      expect(yield* undoing(change)).toEqual({
        refused: `Nothing was undone, because the Change "id-0003" gave one record a name it took from another, and an undo cannot give the name back while the other record still has it. This Change cannot be undone. Put the records right with the other tools instead:
The Vendor "Acme Supply" (id-0001) would be called that again, and the Vendor "Acme Supply" (vendor-two), which the same Change wrote, has the name.`,
      });
      expect(yield* sql`SELECT id FROM vendors`).toEqual([{ id: "vendor-two" }]);
      expect(yield* sql`SELECT count(*) AS changes FROM changes`).toEqual([{ changes: 2 }]);
    }).pipe(Effect.provide(TestDatabase)),
);

const LOOP =
  "Nothing was undone, because a record would be back under one that is under it already, and that would make a loop. One of the others in the loop has to come out from under its parent first, by a save of it or by undoing the Change that put it there:";

// A save refuses a parent that would make a loop. An undo gives a Category its parent back
// with no save, and the Change that put the parent under it touched another record, so no
// later Change is in the way.
it.effect("an undo that would bring a Category back under one that is under it is refused", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const under = sql`
      SELECT id, parent_id FROM categories WHERE id IN ('camping', 'tents') ORDER BY id`;
    yield* calling(saveCategory)({ id: "camping", name: "Camping" });
    yield* calling(saveCategory)({ id: "tents", name: "Tents", parent: "camping" });
    const cleared = yield* calling(saveCategory)({ id: "tents", clear: ["parent"] });
    const swapped = yield* calling(saveCategory)({ id: "camping", parent: "tents" });

    expect(yield* undoing(cleared.change_id as string)).toEqual({
      refused: `${LOOP}
The Category "Tents" (tents) would be back under the Category "Camping" (camping), which is under the Category "Tents" (tents).`,
    });
    expect(yield* under).toEqual([
      { id: "camping", parent_id: "tents" },
      { id: "tents", parent_id: null },
    ]);
    expect(yield* sql`SELECT count(*) AS changes FROM changes`).toEqual([{ changes: 4 }]);

    // With Camping out from under it, Tents can go back under Camping.
    yield* undoing(swapped.change_id as string);
    expect(yield* undoing(cleared.change_id as string)).toMatchObject({
      restored: [{ type: "category", id: "tents", name: "Tents" }],
    });
    expect(yield* under).toEqual([
      { id: "camping", parent_id: null },
      { id: "tents", parent_id: "camping" },
    ]);
  }).pipe(Effect.provide(TestDatabase)),
);

// What each of these Categories is under.
const parentsOf = (...ids: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ id: string; parent_id: string | null }>`
      SELECT id, parent_id FROM categories WHERE id IN ${sql.in(ids)}`;
    return Object.fromEntries(rows.map(({ id, parent_id }) => [id, parent_id]));
  });

it.effect("a loop by way of a third Category is refused, and the error names all three", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* calling(saveCategory)({ id: "camping", name: "Camping" });
    yield* calling(saveCategory)({ id: "tents", name: "Tents", parent: "camping" });
    yield* calling(saveCategory)({ id: "tent-stakes", name: "Tent stakes", parent: "tents" });
    const cleared = yield* calling(saveCategory)({ id: "tents", clear: ["parent"] });
    yield* calling(saveCategory)({ id: "camping", parent: "tent-stakes" });

    expect(yield* undoing(cleared.change_id as string)).toEqual({
      refused: `${LOOP}
The Category "Tents" (tents) would be back under the Category "Camping" (camping), which is under the Category "Tent stakes" (tent-stakes), which is under the Category "Tents" (tents).`,
    });
    expect(yield* parentsOf("camping", "tents", "tent-stakes")).toEqual({
      camping: "tent-stakes",
      tents: null,
      "tent-stakes": "tents",
    });
    expect(yield* sql`SELECT count(*) AS changes FROM changes`).toEqual([{ changes: 5 }]);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("undoing a change of parent that makes no loop goes through", () =>
  Effect.gen(function* () {
    yield* calling(saveCategory)({ id: "camping", name: "Camping", parent: "outdoor" });
    yield* calling(saveCategory)({ id: "tents", name: "Tents", parent: "camping" });
    const cleared = yield* calling(saveCategory)({ id: "tents", clear: ["parent"] });
    // A Category goes under the Tents, and the one above them moves, each by a save that
    // never touched the Tents.
    yield* calling(saveCategory)({ id: "tent-stakes", name: "Tent stakes", parent: "tents" });
    yield* calling(saveCategory)({ id: "camping", parent: "sports" });

    expect(yield* undoing(cleared.change_id as string)).toMatchObject({
      restored: [{ type: "category", id: "tents", name: "Tents" }],
    });
    expect(yield* parentsOf("camping", "tents", "tent-stakes")).toEqual({
      camping: "sports",
      tents: "camping",
      "tent-stakes": "tents",
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// An undo made before loops were refused could leave one, and so could two saves at the same
// moment (ADR 0006). The Tents are not in this one. They would only be under it.
it.effect(
  "an undo goes through under a loop that was there already, and does not walk it forever",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* calling(saveCategory)({ id: "camping", name: "Camping", parent: "outdoor" });
      yield* calling(saveCategory)({ id: "tents", name: "Tents", parent: "camping" });
      const cleared = yield* calling(saveCategory)({ id: "tents", clear: ["parent"] });
      yield* sql`UPDATE categories SET parent_id = 'camping' WHERE id = 'outdoor'`;

      expect(yield* undoing(cleared.change_id as string)).toMatchObject({
        restored: [{ type: "category", id: "tents", name: "Tents" }],
      });
      expect(yield* parentsOf("tents")).toEqual({ tents: "camping" });
    }).pipe(Effect.provide(TestDatabase)),
);

// No tool deletes a Category yet. One that is deleted while another is under it has to point
// that one elsewhere in the same Change, so the Change is written here by hand: the Shelters
// are deleted, and the Tents that were under them go to the top. An undo puts the Shelters
// back under Camping, and the Tents back under the Shelters.
it.effect("an undo that would put a Category back into a loop is refused", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* calling(saveCategory)({ id: "camping", name: "Camping" });
    yield* calling(saveCategory)({ id: "shelters", name: "Shelters", parent: "camping" });
    yield* calling(saveCategory)({ id: "tents", name: "Tents", parent: "shelters" });

    const deleted = yield* (yield* Ids).next;
    yield* sql`INSERT INTO changes (id, tool) VALUES (${deleted}, 'delete_record')`;
    const recording = (column: "before" | "after") =>
      sql.unsafe(
        `INSERT INTO change_records (change_id, entity_type, entity_id, ${column})
         SELECT ?, 'category', record.id, ${snapshot(SHAPES.category)} FROM categories AS record
          WHERE record.id IN ('shelters', 'tents')
         ON CONFLICT (change_id, entity_type, entity_id) DO UPDATE SET ${column} = excluded.${column}`,
        [deleted],
      );
    yield* recording("before");
    yield* sql`UPDATE categories SET parent_id = NULL WHERE id = 'tents'`;
    yield* sql`DELETE FROM categories WHERE id = 'shelters'`;
    yield* recording("after");
    const swapped = yield* calling(saveCategory)({ id: "camping", parent: "tents" });

    // The loop has two Categories the undo brings back, and is said once.
    expect(yield* undoing(deleted)).toEqual({
      refused: `${LOOP}
The Category "Shelters" (shelters) would be back under the Category "Camping" (camping), which is under the Category "Tents" (tents), which would be back under the Category "Shelters" (shelters).`,
    });
    expect(yield* parentsOf("camping", "shelters", "tents")).toEqual({
      camping: "tents",
      tents: null,
    });
    expect(yield* sql`SELECT count(*) AS changes FROM changes`).toEqual([{ changes: 5 }]);

    yield* undoing(swapped.change_id as string);
    expect(yield* undoing(deleted)).toMatchObject({
      restored: [{ type: "category", id: "tents" }],
      put_back: [{ type: "category", id: "shelters" }],
    });
    expect(yield* parentsOf("camping", "shelters", "tents")).toEqual({
      camping: null,
      shelters: "camping",
      tents: "shelters",
    });
  }).pipe(Effect.provide(TestDatabase)),
);

const leftBehind = (toUndo: string) =>
  `Nothing was undone, because undoing the Change "${toUndo}" would move a record, and what was added to it since would stay behind. Undo the Change that added that first, and then this one:`;

// A Note on a record is at that record's Property, and a save that moves the record moves its
// Notes in the same Change. This Note was added after the move, by a Change that never touched
// the Item, so no later Change is in the way.
it.effect("an undo that would move an Item away from a Note added to it since is refused", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* calling(saveProperty)({ name: "Maple Street house" });
    yield* calling(saveProperty)({ name: "Birch Lane house" });
    const saved = yield* calling(saveItem)({ name: "Desk", property: "Maple Street house" });
    const desk = (saved.record as { id: string }).id;
    const moved = yield* calling(saveItem)({ id: desk, property: "Birch Lane house" });
    const added = yield* calling(addNote)({
      body: "The left drawer sticks.",
      attach_to: { type: "item", id: desk },
    });
    const [note] = added.created as { id: string }[];

    expect(yield* undoing(moved.change_id as string)).toEqual({
      refused: `${leftBehind(moved.change_id as string)}
The Item "Desk" (${desk}) would go back to where it was, and the Note "The left drawer sticks." (${note!.id}) on it would stay. The Change "${String(added.change_id)}" added the Note.`,
    });
    expect(yield* getting("item", desk)).toMatchObject({
      property: "Birch Lane house",
      notes: [{ id: note!.id }],
    });
    expect(yield* getting("note", note!.id)).toMatchObject({ property: "Birch Lane house" });
    expect(yield* sql`SELECT count(*) AS changes FROM changes`).toEqual([{ changes: 5 }]);

    // With the Note out, the Desk goes back to the Property it was at.
    yield* undoing(added.change_id as string);
    expect(yield* undoing(moved.change_id as string)).toMatchObject({
      restored: [{ type: "item", id: desk, name: "Desk" }],
    });
    expect(yield* getting("item", desk)).toMatchObject({
      property: "Maple Street house",
      notes: [],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// Work moves the same way. The Note it was logged with moved with it, in the Change to undo,
// so that one goes back with the Work and is not in the way. The one added since is.
it.effect("an undo that would move Work away from a Note added to it since is refused", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* calling(saveProperty)({ name: "Maple Street house" });
    yield* calling(saveProperty)({ name: "Birch Lane house" });
    const logged = yield* calling(logWork)({
      kind: "repair",
      title: "Patched the fence",
      property: "Maple Street house",
      note: "Two boards were rotten.",
    });
    const fence = (logged.record as { id: string }).id;
    const moved = yield* calling(logWork)({ id: fence, property: "Birch Lane house" });
    expect(moved.updated).toMatchObject([{ type: "work" }, { type: "note" }]);
    const added = yield* calling(addNote)({
      body: "The gate latch still sticks.",
      attach_to: { type: "work", id: fence },
    });
    const [later] = added.created as { id: string }[];

    expect(yield* undoing(moved.change_id as string)).toEqual({
      refused: `${leftBehind(moved.change_id as string)}
The Work "Patched the fence" (${fence}) would go back to where it was, and the Note "The gate latch still sticks." (${later!.id}) on it would stay. The Change "${String(added.change_id)}" added the Note.`,
    });
    expect(yield* sql`SELECT body, property_id FROM notes ORDER BY id`).toEqual([
      { body: "Two boards were rotten.", property_id: "id-0003" },
      { body: "The gate latch still sticks.", property_id: "id-0003" },
    ]);
    expect(yield* getting("work", fence)).toMatchObject({ property: "Birch Lane house" });
    expect(yield* sql`SELECT count(*) AS changes FROM changes`).toEqual([{ changes: 5 }]);

    // With the later Note out, the Work goes back, and the Note it was logged with goes too.
    yield* undoing(added.change_id as string);
    expect(yield* undoing(moved.change_id as string)).toMatchObject({
      restored: [{ type: "note" }, { type: "work", id: fence }],
    });
    expect(yield* getting("work", fence)).toMatchObject({
      property: "Maple Street house",
      notes: [{ body: "Two boards were rotten." }],
    });
    expect(yield* sql`SELECT body, property_id FROM notes`).toEqual([
      { body: "Two boards were rotten.", property_id: "id-0001" },
    ]);
  }).pipe(Effect.provide(TestDatabase)),
);

// The same rule from the other side. The Note is a record of the Change, and its Item is not:
// the Note was taken out by an undo, and the Desk moved while it was out. Undoing that undo
// would put the Note back at the Property it was at, which the Desk has left.
it.effect("an undo that would put a Note back where its Item no longer is is refused", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* calling(saveProperty)({ name: "Maple Street house" });
    yield* calling(saveProperty)({ name: "Birch Lane house" });
    const saved = yield* calling(saveItem)({ name: "Desk", property: "Maple Street house" });
    const desk = (saved.record as { id: string }).id;
    const added = yield* calling(addNote)({
      body: "The left drawer sticks.",
      attach_to: { type: "item", id: desk },
    });
    const [note] = added.created as { id: string }[];
    const takenOut = yield* undoing(added.change_id as string);
    // The Note is out, so the save that moves the Desk has no Note to move with it.
    const moved = yield* calling(saveItem)({ id: desk, property: "Birch Lane house" });
    expect(moved.updated).toEqual([{ type: "item", id: desk, name: "Desk" }]);

    expect(yield* undoing(takenOut.change_id as string)).toEqual({
      refused: `Nothing was undone, because a record would come back where the one it is on no longer is. Move that one back first, or undo the Change that moved it:
The Note "The left drawer sticks." (${note!.id}) would come back on the Item "Desk" (${desk}), which has moved since. The Change "${String(moved.change_id)}" moved the Item.`,
    });
    expect(yield* sql`SELECT count(*) AS notes FROM notes`).toEqual([{ notes: 0 }]);
    expect(yield* sql`SELECT count(*) AS changes FROM changes`).toEqual([{ changes: 6 }]);

    // With the Desk back, the Note comes back at the Property the Desk is at.
    yield* undoing(moved.change_id as string);
    expect(yield* undoing(takenOut.change_id as string)).toMatchObject({
      put_back: [{ type: "note", id: note!.id }],
    });
    expect(yield* getting("note", note!.id)).toMatchObject({ property: "Maple Street house" });
    expect(yield* getting("item", desk)).toMatchObject({
      property: "Maple Street house",
      notes: [{ id: note!.id }],
    });
  }).pipe(Effect.provide(TestDatabase)),
);
