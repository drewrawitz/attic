import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { test } from "./support/harness.ts";
import { householdClient, householdCommand } from "./support/household.ts";
import { callOnWorker } from "./support/mcp-client.ts";

// The two commands that put the made-up household into a stage's database and take it out
// again, run against the database the Worker reads, on local D1. What they left there is read
// back through the Worker's own `query`.

test(
  "the load and remove commands leave every table as it was, and say how many rows went each way",
  Effect.gen(function* () {
    const { url, token } = yield* householdClient;
    const rowsOf = async (sql: string) => {
      const { result } = await callOnWorker(url, token, "query", { sql });
      const answer = JSON.parse(result!.content[0].text) as {
        rows: ReadonlyArray<Record<string, unknown>>;
      };
      return answer.rows;
    };
    // Every row of every table of Attic's, by table. D1 and Alchemy keep tables of their own
    // in the same database, and theirs start with an underscore.
    const everyTable = Effect.promise(async () => {
      const tables = await rowsOf(`
        SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT GLOB '_*' AND name NOT GLOB 'sqlite_*'
         ORDER BY name`);
      const rows: Record<string, ReadonlyArray<unknown>> = {};
      for (const { name } of tables) {
        rows[String(name)] = await rowsOf(`SELECT * FROM ${String(name)} ORDER BY rowid`);
      }
      return rows;
    });
    const count = (tables: Record<string, ReadonlyArray<unknown>>) =>
      Object.values(tables).reduce((sum, rows) => sum + rows.length, 0);

    yield* householdCommand("remove");
    const without = yield* everyTable;

    const loaded = yield* householdCommand("load");
    const withIt = yield* everyTable;
    const inTheSet = count(withIt) - count(without);
    expect(inTheSet).toBeGreaterThan(50);
    expect(loaded).toEqual({ removed: 0, loaded: inTheSet });

    // A second load replaces the first copy and leaves one.
    expect(yield* householdCommand("load")).toEqual({ removed: inTheSet, loaded: inTheSet });
    expect(count(yield* everyTable)).toBe(count(withIt));

    // Removing says how many rows it took out, and leaves none behind.
    expect(yield* householdCommand("remove")).toEqual({ removed: inTheSet, loaded: 0 });
    expect(yield* everyTable).toEqual(without);
  }),
);
