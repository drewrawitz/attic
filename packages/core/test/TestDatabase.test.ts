import { expect, it } from "@effect/vitest";
import { Deferred, Effect } from "effect";
import { SqlClient } from "effect/sql";
import { refusal, TestDatabase } from "./TestDatabase.ts";

// The starter Categories are the last statement in 0001_init.sql, and 'other' is its last row.
it.effect("applies the migration through to its last statement", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`SELECT name FROM categories WHERE id = 'other'`;
    expect(rows).toEqual([{ name: "Other" }]);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("enforces foreign keys", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const refused = yield* refusal(
      sql`INSERT INTO spaces (id, property_id, name) VALUES ('s1', 'no-such-property', 'Kitchen')`,
    );
    expect(refused).toBe("FOREIGN KEY");
  }).pipe(Effect.provide(TestDatabase)),
);

// Two databases are alive at once here, each holding a Property with the same id.
it.effect("gives every test a database of its own", () =>
  Effect.gen(function* () {
    const bothAdded = yield* Deferred.make<void>();
    let added = 0;
    const addProperty = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO properties (id, name) VALUES ('p1', 'Maple Street house')`;
      if (++added === 2) yield* Deferred.succeed(bothAdded, undefined);
      yield* Deferred.await(bothAdded);
      return yield* sql`SELECT count(*) AS n FROM properties`;
    }).pipe(Effect.provide(TestDatabase));

    const counts = yield* Effect.all([addProperty, addProperty], { concurrency: 2 });
    expect(counts).toEqual([[{ n: 1 }], [{ n: 1 }]]);
  }),
);
