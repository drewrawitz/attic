import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { TestDatabase } from "../TestDatabase.ts";

it.effect("inventory leaves out Gone Items", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO items (id, name, status) VALUES
      ('i1', 'Couch', 'active'),
      ('i2', 'Old TV', 'listed'),
      ('i3', 'Treadmill', 'sold'),
      ('i4', 'Crib', 'given'),
      ('i5', 'Umbrella', 'lost'),
      ('i6', 'Bike', 'stolen'),
      ('i7', 'Laptop', 'destroyed')`;

    const names = yield* sql`SELECT name, status FROM inventory ORDER BY id`;
    expect(names).toEqual([
      { name: "Couch", status: "active" },
      { name: "Old TV", status: "listed" },
    ]);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect(
  "inventory leaves out the Fixtures of a Property that is no longer current, and keeps Belongings wherever they are",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO properties (id, name, end_on) VALUES
        ('p1', 'Maple Street house', NULL),
        ('p2', 'Old apartment', '2020-08')`;
      yield* sql`INSERT INTO items (id, name, scope, property_id) VALUES
        ('i1', 'Water heater', 'fixture', 'p1'),
        ('i2', 'Landlord fridge', 'fixture', 'p2'),
        ('i3', 'Couch', 'belonging', 'p1'),
        ('i4', 'Bookshelf', 'belonging', 'p2'),
        ('i5', 'Bike', 'belonging', NULL)`;

      const names = yield* sql`SELECT name, property FROM inventory ORDER BY id`;
      expect(names).toEqual([
        { name: "Water heater", property: "Maple Street house" },
        { name: "Couch", property: "Maple Street house" },
        { name: "Bookshelf", property: "Old apartment" },
        { name: "Bike", property: null },
      ]);
    }).pipe(Effect.provide(TestDatabase)),
);

it.effect("inventory counts an Item's photos and Receipts", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO items (id, name) VALUES ('i1', 'Couch'), ('i2', 'Bike')`;
    yield* sql`INSERT INTO documents (id, kind, r2_key, mime_type, sha256) VALUES
      ('d1', 'photo',   'files/d1', 'image/jpeg',      'hash-1'),
      ('d2', 'photo',   'files/d2', 'image/jpeg',      'hash-2'),
      ('d3', 'receipt', 'files/d3', 'application/pdf', 'hash-3'),
      ('d4', 'manual',  'files/d4', 'application/pdf', 'hash-4')`;
    yield* sql`INSERT INTO document_links (document_id, entity_type, entity_id) VALUES
      ('d1', 'item', 'i1'),
      ('d2', 'item', 'i1'),
      ('d3', 'item', 'i1'),
      ('d4', 'item', 'i1')`;

    const counts = yield* sql`SELECT name, photos, receipts FROM inventory ORDER BY id`;
    expect(counts).toEqual([
      { name: "Couch", photos: 2, receipts: 1 },
      { name: "Bike", photos: 0, receipts: 0 },
    ]);
  }).pipe(Effect.provide(TestDatabase)),
);
