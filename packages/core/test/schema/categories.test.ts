import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { TestDatabase } from "../TestDatabase.ts";

it.effect("item_in_category returns the primary Category, the extras, and all their parents", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO categories (id, name, parent_id) VALUES ('cardio', 'Cardio', 'fitness')`;
    yield* sql`INSERT INTO categories (id, name, parent_id)
               VALUES ('treadmills', 'Treadmills', 'cardio')`;
    yield* sql`INSERT INTO items (id, name, category_id) VALUES ('i1', 'Treadmill', 'treadmills')`;
    yield* sql`INSERT INTO item_categories (item_id, category_id) VALUES ('i1', 'networking')`;
    yield* sql`INSERT INTO items (id, name, category_id) VALUES ('i2', 'Couch', 'furniture')`;

    const categories = yield* sql`SELECT category_id FROM item_in_category
                                  WHERE item_id = 'i1' ORDER BY category_id`;
    expect(categories).toEqual([
      { category_id: "cardio" },
      { category_id: "electronics" },
      { category_id: "fitness" },
      { category_id: "networking" },
      { category_id: "treadmills" },
    ]);

    const fitness = yield* sql`SELECT item_id FROM item_in_category WHERE category_id = 'fitness'`;
    expect(fitness).toEqual([{ item_id: "i1" }]);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("item_in_category still returns when the Category tree contains a cycle", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // power-tools already sits under tools, so this closes a loop.
    yield* sql`UPDATE categories SET parent_id = 'power-tools' WHERE id = 'tools'`;
    yield* sql`INSERT INTO items (id, name, category_id) VALUES ('i1', 'Drill', 'power-tools')`;

    const categories = yield* sql`SELECT category_id FROM item_in_category
                                  WHERE item_id = 'i1' ORDER BY category_id`;
    expect(categories).toEqual([{ category_id: "power-tools" }, { category_id: "tools" }]);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("an Item inherits data.expects from every Category it sits under", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // electronics expects brand, model, and serial. computers, under it, expects nothing more.
    yield* sql`INSERT INTO categories (id, name, parent_id, data)
               VALUES ('laptops', 'Laptops', 'computers', '{"expects":["screen_size"]}')`;
    yield* sql`UPDATE categories SET data = '{"expects":["asset_tag","serial"]}' WHERE id = 'office'`;
    yield* sql`INSERT INTO items (id, name, category_id) VALUES ('i1', 'Work laptop', 'laptops')`;
    yield* sql`INSERT INTO item_categories (item_id, category_id) VALUES ('i1', 'office')`;

    const expected = yield* sql`
      SELECT DISTINCT e.value AS key
        FROM item_in_category ic
        JOIN categories c ON c.id = ic.category_id
        JOIN json_each(c.data, '$.expects') e
       WHERE ic.item_id = 'i1'
       ORDER BY key`;
    expect(expected).toEqual([
      { key: "asset_tag" },
      { key: "brand" },
      { key: "model" },
      { key: "screen_size" },
      { key: "serial" },
    ]);
  }).pipe(Effect.provide(TestDatabase)),
);
