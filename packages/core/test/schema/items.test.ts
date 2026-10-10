import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { checkList, refusal, TestDatabase } from "../TestDatabase.ts";

it.effect("a Fixture needs a Property", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO properties (id, name) VALUES ('p1', 'Maple Street house')`;

    const refused = yield* refusal(
      sql`INSERT INTO items (id, name, scope) VALUES ('i1', 'Water heater', 'fixture')`,
    );
    expect(refused).toBe("CHECK");

    yield* sql`INSERT INTO items (id, name, scope, property_id)
               VALUES ('i1', 'Water heater', 'fixture', 'p1')`;
    expect(yield* sql`SELECT name FROM items`).toEqual([{ name: "Water heater" }]);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a Belonging can have no Property", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO items (id, name, scope) VALUES ('i1', 'Bike', 'belonging')`;

    expect(yield* sql`SELECT name, property_id FROM items`).toEqual([
      { name: "Bike", property_id: null },
    ]);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("an Item's scope is fixture or belonging", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO properties (id, name) VALUES ('p1', 'Maple Street house')`;

    const scopes = ["fixture", "belonging"];
    expect(yield* checkList("items", "scope")).toEqual(scopes);
    for (const scope of scopes) {
      yield* sql`INSERT INTO items (id, name, scope, property_id) VALUES (${scope}, 'Fridge', ${scope}, 'p1')`;
    }
    expect(yield* sql`SELECT count(*) AS n FROM items`).toEqual([{ n: 2 }]);

    const refused = yield* refusal(
      sql`INSERT INTO items (id, name, scope, property_id) VALUES ('i3', 'Fridge', 'landlord', 'p1')`,
    );
    expect(refused).toBe("CHECK");
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("an Item's status is active, listed, sold, given, lost, stolen, or destroyed", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const statuses = ["active", "listed", "sold", "given", "lost", "stolen", "destroyed"];
    expect(yield* checkList("items", "status")).toEqual(statuses);
    for (const status of statuses) {
      yield* sql`INSERT INTO items (id, name, status) VALUES (${status}, 'Couch', ${status})`;
    }
    expect(yield* sql`SELECT count(*) AS n FROM items`).toEqual([{ n: 7 }]);

    // ADR 0009 dropped this status. A thrown-away Item is deleted.
    const refused = yield* refusal(
      sql`INSERT INTO items (id, name, status) VALUES ('i8', 'Couch', 'discarded')`,
    );
    expect(refused).toBe("CHECK");
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("brand, model, serial, and warranty_until are readable as columns", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO items (id, name, data) VALUES ('i1', 'Fridge',
      '{"brand":"Samsung","model":"RF28R7351SR","serial":"0A1B2C3D","warranty_until":"2026-06"}')`;
    yield* sql`INSERT INTO items (id, name) VALUES ('i2', 'Couch')`;

    const fridge = yield* sql`SELECT brand, model, serial, warranty_until FROM items
                              WHERE model = 'RF28R7351SR'`;
    expect(fridge).toEqual([
      { brand: "Samsung", model: "RF28R7351SR", serial: "0A1B2C3D", warranty_until: "2026-06" },
    ]);

    const couch =
      yield* sql`SELECT brand, model, serial, warranty_until FROM items WHERE id = 'i2'`;
    expect(couch).toEqual([{ brand: null, model: null, serial: null, warranty_until: null }]);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("two json_patch writes to different Parts keep both", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO items (id, name, data) VALUES ('i1', 'Fridge', '{"brand":"Samsung"}')`;

    yield* sql`UPDATE items SET data = json_patch(data,
      '{"parts":{"water-filter":{"part_number":"DA97-17376B"}}}') WHERE id = 'i1'`;
    yield* sql`UPDATE items SET data = json_patch(data,
      '{"parts":{"air-filter":{"part_number":"DA97-17587A"}}}') WHERE id = 'i1'`;

    const [fridge] = yield* sql<{ data: string }>`SELECT data FROM items WHERE id = 'i1'`;
    expect(JSON.parse(fridge!.data)).toEqual({
      brand: "Samsung",
      parts: {
        "water-filter": { part_number: "DA97-17376B" },
        "air-filter": { part_number: "DA97-17587A" },
      },
    });
  }).pipe(Effect.provide(TestDatabase)),
);
