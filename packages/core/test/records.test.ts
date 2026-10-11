import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { SHAPES, snapshot, type RecordShape } from "../src/records.ts";
import { TestDatabase } from "./TestDatabase.ts";

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

// No tool writes a record with a link set yet, so this one is read with a shape of its own:
// an Item, cut down to two columns, with its extra Categories.
it.effect("a snapshot has each link set as a list of ids, in a fixed order", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const item: RecordShape = {
      table: "items",
      columns: ["id", "data"],
      links: [
        { name: "extra_categories", table: "item_categories", from: "item_id", to: "category_id" },
      ],
    };
    yield* sql`
      INSERT INTO items (id, name, category_id, data) VALUES
        ('item-watch', 'Running watch', 'electronics', '{"brand":"Garmin"}'),
        ('item-couch', 'Sectional couch', 'furniture', '{}')`;
    yield* sql`
      INSERT INTO item_categories (item_id, category_id) VALUES
        ('item-watch', 'sports'), ('item-watch', 'fitness')`;

    const rows = yield* sql.unsafe<{ snapshot: string }>(
      `SELECT ${snapshot(item)} AS snapshot FROM items AS record ORDER BY record.id`,
    );
    expect(rows.map((row) => JSON.parse(row.snapshot))).toEqual([
      { id: "item-couch", data: {}, extra_categories: [] },
      { id: "item-watch", data: { brand: "Garmin" }, extra_categories: ["fitness", "sports"] },
    ]);
  }).pipe(Effect.provide(TestDatabase)),
);
