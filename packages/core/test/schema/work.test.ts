import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { refusal, TestDatabase } from "../TestDatabase.ts";

it.effect("a Project needs a Property", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const refused = yield* refusal(
      sql`INSERT INTO projects (id, title) VALUES ('proj1', 'Kitchen remodel')`,
    );
    expect(refused).toBe("NOT NULL");
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a Project holds one Quote per Vendor", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO properties (id, name) VALUES ('p1', 'Maple Street house')`;
    yield* sql`INSERT INTO vendors (id, name) VALUES
      ('v1', 'Bright Electric'),
      ('v2', 'Glow Landscape Lighting')`;
    yield* sql`INSERT INTO projects (id, property_id, title) VALUES
      ('proj1', 'p1', 'Outdoor lighting'),
      ('proj2', 'p1', 'Kitchen remodel')`;
    yield* sql`INSERT INTO quotes (id, project_id, vendor_id, amount_cents)
               VALUES ('q1', 'proj1', 'v1', 420000)`;

    const refused = yield* refusal(
      sql`INSERT INTO quotes (id, project_id, vendor_id, amount_cents)
          VALUES ('q2', 'proj1', 'v1', 390000)`,
    );
    expect(refused).toBe("UNIQUE");

    // Another Vendor on the same Project, and the same Vendor on another Project, are fine.
    yield* sql`INSERT INTO quotes (id, project_id, vendor_id) VALUES
      ('q3', 'proj1', 'v2'),
      ('q4', 'proj2', 'v1')`;
    expect(yield* sql`SELECT count(*) AS n FROM quotes`).toEqual([{ n: 3 }]);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("Work can exist with no Property", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Work needs a Property or an Item, which code enforces. This Belonging is at no Property.
    yield* sql`INSERT INTO items (id, name) VALUES ('i1', 'Bike')`;
    yield* sql`INSERT INTO work (id, kind, title) VALUES ('w1', 'repair', 'Replaced the bike chain')`;
    yield* sql`INSERT INTO work_items (work_id, item_id) VALUES ('w1', 'i1')`;

    expect(yield* sql`SELECT title, property, items FROM work_log`).toEqual([
      { title: "Replaced the bike chain", property: null, items: '["Bike"]' },
    ]);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("work_log shows the Project, Spaces, and Items of a piece of Work", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO properties (id, name) VALUES ('p1', 'Maple Street house')`;
    yield* sql`INSERT INTO spaces (id, property_id, name) VALUES
      ('s1', 'p1', 'Kitchen'),
      ('s2', 'p1', 'Pantry')`;
    yield* sql`INSERT INTO items (id, name, scope, property_id) VALUES
      ('i1', 'Dishwasher', 'fixture', 'p1'),
      ('i2', 'Range hood', 'fixture', 'p1')`;
    yield* sql`INSERT INTO projects (id, property_id, title) VALUES ('proj1', 'p1', 'Kitchen remodel')`;
    yield* sql`INSERT INTO work (id, property_id, project_id, kind, title)
               VALUES ('w1', 'p1', 'proj1', 'improvement', 'Installed the new appliances')`;
    yield* sql`INSERT INTO work_spaces (work_id, space_id) VALUES ('w1', 's1'), ('w1', 's2')`;
    yield* sql`INSERT INTO work_items (work_id, item_id) VALUES ('w1', 'i1'), ('w1', 'i2')`;

    const [work] = yield* sql<{ project: string; spaces: string; items: string }>`
      SELECT project, spaces, items FROM work_log WHERE id = 'w1'`;
    expect(work!.project).toBe("Kitchen remodel");
    expect(JSON.parse(work!.spaces).sort()).toEqual(["Kitchen", "Pantry"]);
    expect(JSON.parse(work!.items).sort()).toEqual(["Dishwasher", "Range hood"]);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a Schedule points at exactly one of a Property or an Item", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO properties (id, name) VALUES ('p1', 'Maple Street house')`;
    yield* sql`INSERT INTO items (id, name) VALUES ('i1', 'Fridge')`;

    yield* sql`INSERT INTO schedules (id, property_id, title, interval_days, next_due_on)
               VALUES ('sched1', 'p1', 'Clean the gutters', 180, '2026-11-01')`;
    yield* sql`INSERT INTO schedules (id, item_id, title, interval_days, next_due_on)
               VALUES ('sched2', 'i1', 'Replace fridge water filter', 180, '2026-12-15')`;
    expect(yield* sql`SELECT count(*) AS n FROM schedules`).toEqual([{ n: 2 }]);

    const both = yield* refusal(
      sql`INSERT INTO schedules (id, property_id, item_id, title, interval_days, next_due_on)
          VALUES ('sched3', 'p1', 'i1', 'Replace fridge water filter', 180, '2026-12-15')`,
    );
    expect(both).toBe("CHECK");

    const neither = yield* refusal(
      sql`INSERT INTO schedules (id, title, interval_days, next_due_on)
          VALUES ('sched4', 'Clean the gutters', 180, '2026-11-01')`,
    );
    expect(neither).toBe("CHECK");
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a Schedule's due date is required and is a full date", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO properties (id, name) VALUES ('p1', 'Maple Street house')`;

    const missing = yield* refusal(
      sql`INSERT INTO schedules (id, property_id, title, interval_days)
          VALUES ('sched1', 'p1', 'Clean the gutters', 180)`,
    );
    expect(missing).toBe("NOT NULL");

    for (const partial of ["2026", "2026-11"]) {
      const refused = yield* refusal(
        sql`INSERT INTO schedules (id, property_id, title, interval_days, next_due_on)
            VALUES ('sched1', 'p1', 'Clean the gutters', 180, ${partial})`,
      );
      expect(refused).toBe("CHECK");
    }
  }).pipe(Effect.provide(TestDatabase)),
);
