import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { refusal, TestDatabase } from "../TestDatabase.ts";

// One of each record that can be pointed at, with a second one to re-point to.
const seed = [
  `INSERT INTO properties (id, name) VALUES ('p1', 'Maple Street house')`,
  `INSERT INTO categories (id, name, parent_id) VALUES ('cardio', 'Cardio', 'fitness')`,
  `INSERT INTO vendors (id, name) VALUES ('v1', 'Ace Plumbing'), ('v2', 'Best Plumbing')`,
  `INSERT INTO spaces (id, property_id, name) VALUES ('s1', 'p1', 'Kitchen'), ('s2', 'p1', 'Pantry')`,
  `INSERT INTO projects (id, property_id, title) VALUES
     ('proj1', 'p1', 'Kitchen remodel'), ('proj2', 'p1', 'Pantry shelving')`,
];

const pointers = [
  {
    pointedAt: "a Category that is an Item's primary Category",
    point: [`INSERT INTO items (id, name, category_id) VALUES ('i1', 'Treadmill', 'cardio')`],
    remove: `DELETE FROM categories WHERE id = 'cardio'`,
    repoint: `UPDATE items SET category_id = 'fitness' WHERE category_id = 'cardio'`,
  },
  {
    pointedAt: "a Category that is an Item's extra Category",
    point: [
      `INSERT INTO items (id, name) VALUES ('i1', 'Smart watch')`,
      `INSERT INTO item_categories (item_id, category_id) VALUES ('i1', 'cardio')`,
    ],
    remove: `DELETE FROM categories WHERE id = 'cardio'`,
    repoint: `UPDATE item_categories SET category_id = 'fitness' WHERE category_id = 'cardio'`,
  },
  {
    pointedAt: "a Category that has a child Category",
    point: [
      `INSERT INTO categories (id, name, parent_id) VALUES ('treadmills', 'Treadmills', 'cardio')`,
    ],
    remove: `DELETE FROM categories WHERE id = 'cardio'`,
    repoint: `UPDATE categories SET parent_id = 'fitness' WHERE parent_id = 'cardio'`,
  },
  {
    pointedAt: "a Vendor an Item was bought from",
    point: [`INSERT INTO items (id, name, vendor_id) VALUES ('i1', 'Faucet', 'v1')`],
    remove: `DELETE FROM vendors WHERE id = 'v1'`,
    repoint: `UPDATE items SET vendor_id = 'v2' WHERE vendor_id = 'v1'`,
  },
  {
    pointedAt: "a Vendor that gave a Quote",
    point: [`INSERT INTO quotes (id, project_id, vendor_id) VALUES ('q1', 'proj1', 'v1')`],
    remove: `DELETE FROM vendors WHERE id = 'v1'`,
    repoint: `UPDATE quotes SET vendor_id = 'v2' WHERE vendor_id = 'v1'`,
  },
  {
    pointedAt: "a Vendor that did Work",
    point: [
      `INSERT INTO work (id, property_id, kind, title, vendor_id)
       VALUES ('w1', 'p1', 'repair', 'Fixed the leak', 'v1')`,
    ],
    remove: `DELETE FROM vendors WHERE id = 'v1'`,
    repoint: `UPDATE work SET vendor_id = 'v2' WHERE vendor_id = 'v1'`,
  },
  {
    pointedAt: "a Vendor named on a Document",
    point: [
      `INSERT INTO documents (id, r2_key, mime_type, sha256, vendor_id)
       VALUES ('d1', 'files/d1', 'application/pdf', 'hash-1', 'v1')`,
    ],
    remove: `DELETE FROM vendors WHERE id = 'v1'`,
    repoint: `UPDATE documents SET vendor_id = 'v2' WHERE vendor_id = 'v1'`,
  },
  {
    pointedAt: "a Space that holds an Item",
    point: [
      `INSERT INTO items (id, name, property_id, space_id) VALUES ('i1', 'Fridge', 'p1', 's1')`,
    ],
    remove: `DELETE FROM spaces WHERE id = 's1'`,
    repoint: `UPDATE items SET space_id = 's2' WHERE space_id = 's1'`,
  },
  {
    pointedAt: "a Space that a Project covers",
    point: [`INSERT INTO project_spaces (project_id, space_id) VALUES ('proj1', 's1')`],
    remove: `DELETE FROM spaces WHERE id = 's1'`,
    repoint: `UPDATE project_spaces SET space_id = 's2' WHERE space_id = 's1'`,
  },
  {
    pointedAt: "a Space where Work was done",
    point: [
      `INSERT INTO work (id, property_id, kind, title) VALUES ('w1', 'p1', 'repair', 'Fixed the leak')`,
      `INSERT INTO work_spaces (work_id, space_id) VALUES ('w1', 's1')`,
    ],
    remove: `DELETE FROM spaces WHERE id = 's1'`,
    repoint: `UPDATE work_spaces SET space_id = 's2' WHERE space_id = 's1'`,
  },
  {
    pointedAt: "a Project that has Work",
    point: [
      `INSERT INTO work (id, property_id, project_id, kind, title)
       VALUES ('w1', 'p1', 'proj1', 'improvement', 'Installed the cabinets')`,
    ],
    remove: `DELETE FROM projects WHERE id = 'proj1'`,
    repoint: `UPDATE work SET project_id = 'proj2' WHERE project_id = 'proj1'`,
  },
];

it.effect.each(pointers)(
  "deleting $pointedAt is refused until the rows are re-pointed",
  ({ point, remove, repoint }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const statement of [...seed, ...point]) yield* sql.unsafe(statement);

      expect(yield* refusal(sql.unsafe(remove))).toBe("FOREIGN KEY");

      yield* sql.unsafe(repoint);
      yield* sql.unsafe(remove);
      expect(yield* sql`SELECT changes() AS deleted`).toEqual([{ deleted: 1 }]);
    }).pipe(Effect.provide(TestDatabase)),
);

it.effect("deleting an Item keeps its Work and removes its Work links and its Schedules", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO properties (id, name) VALUES ('p1', 'Maple Street house')`;
    yield* sql`INSERT INTO items (id, name, scope, property_id)
               VALUES ('i1', 'Dishwasher', 'fixture', 'p1')`;
    yield* sql`INSERT INTO schedules (id, item_id, title, interval_days, next_due_on)
               VALUES ('sched1', 'i1', 'Clean the dishwasher filter', 90, '2026-12-01')`;
    yield* sql`INSERT INTO work (id, property_id, kind, title, schedule_id)
               VALUES ('w1', 'p1', 'maintenance', 'Cleaned the dishwasher filter', 'sched1')`;
    yield* sql`INSERT INTO work_items (work_id, item_id) VALUES ('w1', 'i1')`;

    yield* sql`DELETE FROM items WHERE id = 'i1'`;

    expect(yield* sql`SELECT title, schedule_id FROM work`).toEqual([
      { title: "Cleaned the dishwasher filter", schedule_id: null },
    ]);
    expect(yield* sql`SELECT count(*) AS n FROM work_items`).toEqual([{ n: 0 }]);
    expect(yield* sql`SELECT count(*) AS n FROM schedules`).toEqual([{ n: 0 }]);
  }).pipe(Effect.provide(TestDatabase)),
);
