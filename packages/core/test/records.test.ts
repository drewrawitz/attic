import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { RECORD_TYPES, SHAPES, snapshot, type RecordShape } from "../src/records.ts";
import { checkList, TestDatabase } from "./TestDatabase.ts";

// A Change's snapshot is the whole record, and a record is put back from it. A column that a
// later migration adds and nobody lists here would be missing from both, and this catches it.
it.effect("each type lists every column of its table that can be written, with the id first", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const [type, shape] of Object.entries<RecordShape>(SHAPES)) {
      // A generated column is hidden, and cannot be written.
      const writable = yield* sql<{ name: string }>`
          SELECT name FROM pragma_table_xinfo(${shape.table}) WHERE hidden = 0 ORDER BY name`;
      expect([...shape.columns].sort(), type).toEqual(writable.map(({ name }) => name));
      expect(shape.columns[0], type).toBe("id");
    }
  }).pipe(Effect.provide(TestDatabase)),
);

// The table each type is kept in.
const typeOf = new Map(
  Object.entries<RecordShape>(SHAPES).map(([type, { table }]) => [table, type]),
);

// The columns of a table that point at a table some type is kept in, with that type. A column
// that points at a table no type is kept in yet is left out.
const pointing = Effect.fnUntraced(function* (table: string) {
  const sql = yield* SqlClient.SqlClient;
  const keys = yield* sql<{ from: string; table: string }>`
    SELECT "from", "table" FROM pragma_foreign_key_list(${table})`;
  return Object.fromEntries(
    keys.flatMap((key) => {
      const type = typeOf.get(key.table);
      return type === undefined ? [] : [[key.from, type]];
    }),
  );
});

// `undo` asks what points at a record before it takes one out, and goes by what each type says
// it points at. A foreign key nobody lists here would let a record go while a row still points
// at it, or let the database empty that row with no Change to say so.
it.effect("each type says what it points at, as the foreign keys of its tables have it", () =>
  Effect.gen(function* () {
    for (const [type, shape] of Object.entries<RecordShape>(SHAPES)) {
      expect(yield* pointing(shape.table), type).toEqual(shape.pointsAt);
      for (const set of shape.links) {
        expect(yield* pointing(set.table), set.name).toEqual({
          [set.from]: type,
          [set.to]: set.of,
        });
      }
    }
  }).pipe(Effect.provide(TestDatabase)),
);

// A Note points at its record by type and id, and the table says which types by a CHECK list.
it.effect("a type that is attached by type and id says which types, as its table has it", () =>
  Effect.gen(function* () {
    for (const [type, { table, attachedBy }] of Object.entries<RecordShape>(SHAPES)) {
      if (attachedBy === undefined) continue;
      const allowed = yield* checkList(table, attachedBy.typeColumn);
      // A type no tool writes yet is left out, as a column that points at one is.
      const written = allowed.filter((each) => Object.hasOwn(SHAPES, each ?? ""));
      expect([...attachedBy.of].sort(), type).toEqual(written.sort());
    }
  }).pipe(Effect.provide(TestDatabase)),
);

// The tables that point at a record of some type and are not a type's own table or a link
// set's. `undo` does not ask about these, so a row in one would be deleted or emptied with the
// record it points at, and no Change would say so. No tool writes them yet. A tool that does
// adds its type to `SHAPES`, which takes its table off this list. `document_links` points by
// type and id, as a Note does, with no foreign key to find it by: it joins with its Documents.
const NOT_WRITTEN_YET = ["documents", "project_spaces", "projects", "quotes", "schedules"];

it.effect("a table undo does not ask about is one no tool writes yet", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const asked = new Set(
      Object.values<RecordShape>(SHAPES).flatMap(({ table, links }) => [
        table,
        ...links.map((set) => set.table),
      ]),
    );
    const tables = yield* sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`;
    const unasked: string[] = [];
    for (const { name } of tables) {
      if (asked.has(name)) continue;
      if (Object.keys(yield* pointing(name)).length > 0) unasked.push(name);
    }
    expect(unasked).toEqual(NOT_WRITTEN_YET);
  }).pipe(Effect.provide(TestDatabase)),
);

// `undo` asks whether a name is still free before it gives one back. A unique index nobody
// lists here would refuse that batch with no word on which record has the name.
it.effect("each type says which columns no two records can share, as its table has it", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const [type, shape] of Object.entries<RecordShape>(SHAPES)) {
      // The indexes a UNIQUE in the table's definition made. The one on its id is not among them.
      const indexes = yield* sql<{ columns: string }>`
        SELECT (SELECT json_group_array(name)
                  FROM (SELECT name FROM pragma_index_info(made.name) ORDER BY seqno)) AS columns
          FROM pragma_index_list(${shape.table}) AS made
         WHERE made.origin = 'u'`;
      expect(
        indexes.map(({ columns }) => JSON.parse(columns)),
        type,
      ).toEqual(shape.unique === undefined ? [] : [shape.unique]);
    }
  }).pipe(Effect.provide(TestDatabase)),
);

// `undo` puts rows back in the order of the types, and takes them out in the other.
it("each type comes after the types it points at", () => {
  const types: ReadonlyArray<string> = RECORD_TYPES;
  expect(Object.keys(SHAPES)).toEqual(types);
  for (const [type, shape] of Object.entries<RecordShape>(SHAPES)) {
    const at = types.indexOf(type);
    const pointedAt = [...Object.values(shape.pointsAt), ...shape.links.map((set) => set.of)];
    // A Category points at the Category it is under, which is the one type that points at itself.
    for (const other of pointedAt) expect(types.indexOf(other), type).toBeLessThanOrEqual(at);
    // A record that can be attached to one of any type comes after them all.
    if (shape.attachedBy !== undefined) expect(at, type).toBe(types.length - 1);
  }
});

// An Item has a link set: its extra Categories.
it.effect("a snapshot has each link set as a list of ids, in a fixed order", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO items (id, name, category_id, data) VALUES
        ('item-watch', 'Running watch', 'electronics', '{"brand":"Garmin"}'),
        ('item-couch', 'Sectional couch', 'furniture', '{}')`;
    yield* sql`
      INSERT INTO item_categories (item_id, category_id) VALUES
        ('item-watch', 'sports'), ('item-watch', 'fitness')`;

    const rows = yield* sql.unsafe<{ snapshot: string }>(
      `SELECT ${snapshot(SHAPES.item)} AS snapshot FROM items AS record ORDER BY record.id`,
    );
    // An Item's snapshot has every column of its row. These are the three this is about.
    const snapshots = rows.map((row) => {
      const { id, data, extra_categories } = JSON.parse(row.snapshot);
      return { id, data, extra_categories };
    });
    expect(snapshots).toEqual([
      { id: "item-couch", data: {}, extra_categories: [] },
      { id: "item-watch", data: { brand: "Garmin" }, extra_categories: ["fitness", "sports"] },
    ]);
  }).pipe(Effect.provide(TestDatabase)),
);
