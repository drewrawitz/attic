import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { loadHousehold, removeHousehold } from "./household.ts";
import { TestDatabase } from "./TestDatabase.ts";

// Every row of every table, by table.
const everyTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name`;
  const rows: Record<string, ReadonlyArray<unknown>> = {};
  for (const { name } of tables) rows[name] = yield* sql`SELECT * FROM ${sql(name)} ORDER BY rowid`;
  return rows;
});

const counts = (tables: Record<string, ReadonlyArray<unknown>>) =>
  Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.length]));

it.effect("loading the made-up household and then removing it leaves every table as it was", () =>
  Effect.gen(function* () {
    const before = yield* everyTable;

    yield* loadHousehold;
    const loaded = counts(yield* everyTable);
    yield* removeHousehold;

    expect(yield* everyTable).toEqual(before);
    // It has a row for every table but the change log, which only a write tool fills.
    const untouched = Object.keys(before).filter((name) => loaded[name] === before[name]!.length);
    expect(untouched).toEqual(["change_records", "changes"]);
  }).pipe(Effect.provide(TestDatabase)),
);

// The commands that load it run as an Alchemy Action, which may be run again after a failure.
it.effect("loading the made-up household twice leaves one copy of it", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    const once = counts(yield* everyTable);

    yield* loadHousehold;

    expect(counts(yield* everyTable)).toEqual(once);
  }).pipe(Effect.provide(TestDatabase)),
);

// Removing goes by this prefix, so a record without it would be left behind.
it.effect("every record of the made-up household has an id that starts with seed-", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const before = yield* everyTable;
    yield* loadHousehold;

    const strays: string[] = [];
    for (const table of Object.keys(before)) {
      const columns = yield* sql<{ name: string }>`
        SELECT name FROM pragma_table_info(${table}) WHERE name = 'id'`;
      if (columns.length === 0) continue;
      const added = yield* sql<{ id: string }>`SELECT id FROM ${sql(table)}`;
      const known = new Set(before[table]!.map((row) => (row as { id: string }).id));
      strays.push(
        ...added.map(({ id }) => id).filter((id) => !known.has(id) && !id.startsWith("seed-")),
      );
    }
    expect(strays).toEqual([]);
  }).pipe(Effect.provide(TestDatabase)),
);
