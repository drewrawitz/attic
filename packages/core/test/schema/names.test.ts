import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { refusal, TestDatabase } from "../TestDatabase.ts";

it.effect("a Property name is unique ignoring case", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO properties (id, name) VALUES ('p1', 'Maple Street house')`;

    const refused = yield* refusal(
      sql`INSERT INTO properties (id, name) VALUES ('p2', 'MAPLE STREET HOUSE')`,
    );
    expect(refused).toBe("UNIQUE");
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a Space name is unique ignoring case within its Property", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO properties (id, name) VALUES ('p1', 'Maple Street house')`;
    yield* sql`INSERT INTO properties (id, name) VALUES ('p2', 'Downtown rental')`;
    yield* sql`INSERT INTO spaces (id, property_id, name) VALUES ('s1', 'p1', 'Kitchen')`;

    const refused = yield* refusal(
      sql`INSERT INTO spaces (id, property_id, name) VALUES ('s2', 'p1', 'kitchen')`,
    );
    expect(refused).toBe("UNIQUE");

    yield* sql`INSERT INTO spaces (id, property_id, name) VALUES ('s3', 'p2', 'Kitchen')`;
    const kitchens = yield* sql`SELECT property_id FROM spaces ORDER BY property_id`;
    expect(kitchens).toEqual([{ property_id: "p1" }, { property_id: "p2" }]);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a Vendor name is unique ignoring case", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO vendors (id, name) VALUES ('v1', 'Ace Plumbing')`;

    const refused = yield* refusal(
      sql`INSERT INTO vendors (id, name) VALUES ('v2', 'ace plumbing')`,
    );
    expect(refused).toBe("UNIQUE");
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a Property, a Space, and a Vendor are found by name whatever the case", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO properties (id, name) VALUES ('p1', 'Maple Street house')`;
    yield* sql`INSERT INTO spaces (id, property_id, name) VALUES ('s1', 'p1', 'Kitchen')`;
    yield* sql`INSERT INTO vendors (id, name) VALUES ('v1', 'Ace Plumbing')`;

    expect(yield* sql`SELECT id FROM properties WHERE name = 'maple street HOUSE'`).toEqual([
      { id: "p1" },
    ]);
    expect(yield* sql`SELECT id FROM spaces WHERE property_id = 'p1' AND name = 'KITCHEN'`).toEqual(
      [{ id: "s1" }],
    );
    expect(yield* sql`SELECT id FROM vendors WHERE name = 'ace plumbing'`).toEqual([{ id: "v1" }]);
  }).pipe(Effect.provide(TestDatabase)),
);
