import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { TestDatabase } from "../TestDatabase.ts";

it.effect("current_properties counts a Partial date end as its whole period", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // The view reads the database's clock, so the dates around today come from it too.
    const [days] = yield* sql<{ today: string; yesterday: string; tomorrow: string }>`
      SELECT date('now') AS today, date('now', '-1 day') AS yesterday, date('now', '+1 day') AS tomorrow`;
    const { today, yesterday, tomorrow } = days!;
    const thisYear = today.slice(0, 4);
    const thisMonth = today.slice(0, 7);
    const lastYear = String(Number(thisYear) - 1);

    yield* sql`INSERT INTO properties (id, name, end_on) VALUES
      ('p1', 'No end', NULL),
      ('p2', 'Ends this year', ${thisYear}),
      ('p3', 'Ends this month', ${thisMonth}),
      ('p4', 'Ends today', ${today}),
      ('p5', 'Ends tomorrow', ${tomorrow}),
      ('p6', 'Ended yesterday', ${yesterday}),
      ('p7', 'Ended last year', ${lastYear})`;

    const current = yield* sql`SELECT name FROM current_properties ORDER BY id`;
    expect(current).toEqual([
      { name: "No end" },
      { name: "Ends this year" },
      { name: "Ends this month" },
      { name: "Ends today" },
      { name: "Ends tomorrow" },
    ]);
  }).pipe(Effect.provide(TestDatabase)),
);
