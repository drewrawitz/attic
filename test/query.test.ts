import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { householdStack, type Operation } from "../household/stack.ts";
import { beforeAll, deploy, stack, test } from "./support/harness.ts";
import { callOnWorker, mcp } from "./support/mcp-client.ts";
import { ALLOWED_ACCOUNT, tokenFor } from "./support/sign-in.ts";

// `query` is guarded by how D1 behaves, and the Node SQLite under the tests in packages/core is
// not the same build (ADR 0006). So everything here goes through the real Worker on local D1.

// Runs one of the two commands the way `vp run household:load` and `vp run household:remove`
// run them: by deploying the stack in household/, which finds the Worker's database and runs
// one batch on it. `force` makes it run even when its last run did the same thing.
const command = (operation: Operation) => deploy(householdStack(operation), { force: true });

// A client that has signed in, with the made-up household loaded.
const signedIn = beforeAll(
  Effect.gen(function* () {
    const { url } = yield* stack;
    yield* command("load");
    return { url: url!, token: yield* Effect.promise(() => tokenFor(url!, ALLOWED_ACCOUNT)) };
  }),
);

// What `query` sends back: the rows, and a note when there were more. A refusal is its text.
interface Answer {
  readonly rows?: ReadonlyArray<Record<string, unknown>>;
  readonly note?: string;
  readonly refused?: string;
}

const ask = async (client: { url: string; token: string }, sql: string): Promise<Answer> => {
  const { result } = await callOnWorker(client.url, client.token, "query", { sql });
  const text = result!.content[0].text;
  return result!.isError === true ? { refused: text } : (JSON.parse(text) as Answer);
};

// A test body that asks `query` things, as that client.
const asking = (body: (query: (sql: string) => Promise<Answer>) => Promise<void>) =>
  Effect.flatMap(signedIn, (client) => Effect.promise(() => body((sql) => ask(client, sql))));

test(
  "query returns the rows of a SELECT as stored: cents as integers and data as text",
  asking(async (query) => {
    expect(
      await query(`SELECT name, price_cents, data FROM items WHERE id = 'seed-item-microwave'`),
    ).toEqual({
      rows: [
        {
          name: "Microwave",
          price_cents: 17999,
          data: '{"brand":"Panasonic","model":"NN-SN686S","serial":"SEED-MICROWAVE-0001"}',
        },
      ],
    });
  }),
);

test(
  "a signed-in client is told that query takes one SQL string, only reads, and to call get_schema first",
  Effect.gen(function* () {
    const { url, token } = yield* signedIn;
    const { message } = yield* Effect.promise(() => mcp(url, { method: "tools/list" }, token));
    const { result } = message as { result: { tools: { name: string }[] } };

    expect(result.tools.find(({ name }) => name === "query")).toEqual(
      expect.objectContaining({
        description: expect.stringContaining("Call get_schema first"),
        inputSchema: expect.objectContaining({
          type: "object",
          properties: { sql: { type: "string", description: expect.stringContaining("SELECT") } },
          required: ["sql"],
        }),
        annotations: { readOnlyHint: true },
      }),
    );
  }),
);

// This one is also "What fitness products do I own?". The treadmill is filed under Cardio, a
// child of Fitness, and the watch is electronics first. The exercise bike was sold.
test(
  "query returns the rows of a WITH",
  asking(async (query) => {
    expect(
      await query(`
        WITH fitness AS (SELECT item_id FROM item_in_category WHERE category_id = 'fitness')
        SELECT name, category FROM inventory
         WHERE id IN (SELECT item_id FROM fitness)
         ORDER BY name`),
    ).toEqual({
      rows: [
        { name: "Adjustable dumbbells", category: "Fitness" },
        { name: "Running watch", category: "Electronics" },
        { name: "Treadmill", category: "Cardio" },
      ],
    });
  }),
);

// Inside the wrapper only a SELECT or a WITH is valid SQL, so each of these is a syntax error
// before it runs.
test(
  "query refuses a statement that is not a SELECT or a WITH, and the table it aimed at is unchanged",
  asking(async (query) => {
    const vendors = `SELECT * FROM vendors ORDER BY id`;
    const before = await query(vendors);
    expect(before.rows).toHaveLength(8);

    for (const statement of [
      `DELETE FROM vendors`,
      `UPDATE vendors SET name = 'Gone'`,
      `INSERT INTO vendors (id, name) VALUES ('seed-vendor-ninth', 'A ninth Vendor')`,
      `DROP TABLE vendors`,
      `PRAGMA foreign_keys = OFF`,
      `ATTACH DATABASE 'vendors.db' AS vendors`,
    ]) {
      const { refused } = await query(statement);
      expect(refused, statement).toContain("syntax error");
    }
    expect((await query(`DELETE FROM vendors`)).refused).toContain(`near "DELETE": syntax error`);

    expect(await query(vendors)).toEqual(before);
  }),
);

// D1 runs every statement in a string, and a string can close the wrapper early and open it
// again: `SELECT 1); DELETE FROM notes; SELECT * FROM (SELECT 2`. No statement can follow
// another without a semicolon, so none is allowed, wherever it sits.
test(
  "query refuses any semicolon: two statements, a trailing one, and one inside a string",
  asking(async (query) => {
    const notes = `SELECT * FROM notes ORDER BY id`;
    const before = await query(notes);
    expect(before.rows).toHaveLength(6);

    for (const sql of [
      `SELECT 1; DELETE FROM notes`,
      `SELECT 1); DELETE FROM notes; SELECT * FROM (SELECT 2`,
      `SELECT name FROM vendors;`,
      `SELECT name FROM vendors WHERE name = 'Pipewise; Plumbing'`,
    ]) {
      const { refused } = await query(sql);
      expect(refused, sql).toContain("semicolon");
    }
    // A string that needs one can still be matched.
    expect((await query(`SELECT name FROM vendors;`)).refused).toContain("char(59)");
    expect(await query(`SELECT 'a' || char(59) || 'b' AS joined`)).toEqual({
      rows: [{ joined: "a;b" }],
    });

    expect(await query(notes)).toEqual(before);
  }),
);

// The numbers 1 to `rows`, one to a row.
const counting = (rows: number) =>
  `WITH RECURSIVE counting (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM counting WHERE n < ${rows}) SELECT n FROM counting`;

test(
  "query returns at most 500 rows, and says so only when the result was cut",
  asking(async (query) => {
    const over = await query(counting(501));
    expect(over.rows).toHaveLength(500);
    expect(over.rows!.at(-1)).toEqual({ n: 500 });
    expect(over.note).toContain("first 500 rows");

    const exactly = await query(counting(500));
    expect(exactly.rows).toHaveLength(500);
    expect(exactly).not.toHaveProperty("note");

    // A query can comment out the wrapper's own LIMIT. It still gets 500 rows and the note.
    const unlimited = await query(`${counting(700)}) /*`);
    expect(unlimited.rows).toHaveLength(500);
    expect(unlimited.note).toContain("first 500 rows");
  }),
);

// The wrapper's closing bracket sits on a line of its own, where a comment cannot reach it.
test(
  "query runs a statement that ends in a comment",
  asking(async (query) => {
    expect(
      await query(`SELECT name FROM vendors WHERE role = 'hvac' -- who services the furnace`),
    ).toEqual({ rows: [{ name: "Hearth Heating and Air" }] });
  }),
);

// A list of forbidden words would have turned this one away.
test(
  "query runs a search for a title containing the word update",
  asking(async (query) => {
    expect(await query(`SELECT title FROM work WHERE title LIKE '%update%'`)).toEqual({
      rows: [{ title: "Updated the thermostat to a smart model" }],
    });
  }),
);

test(
  "a SQL mistake comes back as a tool error with SQLite's own message",
  asking(async (query) => {
    expect((await query(`SELECT nope FROM vendors`)).refused).toContain("no such column: nope");
    expect((await query(`SELECT name FROM vendor`)).refused).toContain("no such table: vendor");
    // SQLite reads the misspelled word as a table's name, and trips on the word after next.
    expect((await query(`SELEC name FROM vendors`)).refused).toContain(`near "FROM": syntax error`);
    // It points the client at where to look the names up.
    expect((await query(`SELECT nope FROM vendors`)).refused).toContain("get_schema");
  }),
);

// SQLite counts from the start of what it ran, which begins with the wrapper.
test(
  "where SQLite says a mistake is, it is counted in the caller's SQL",
  asking(async (query) => {
    const { refused } = await query(`SELECT nope FROM vendors`);
    expect(refused).toContain("no such column: nope at offset 7");
  }),
);

// The questions in AGENTS.md that plain SQL answers, asked of the made-up household.

// The water heater is dated only `2023`, which stands for the whole year. The gutter was
// repaired that January, before March.
test(
  "every repair and improvement since March 2023, with receipts, including the one dated 2023",
  asking(async (query) => {
    const since = (dates: string) => `
      SELECT date, kind, title, cost_cents, vendor, documents FROM work_log
       WHERE kind IN ('repair', 'improvement') AND (${dates})
       ORDER BY date`;

    expect(await query(since(`date >= '2023-03' OR date = '2023'`))).toEqual({
      rows: [
        {
          date: "2023",
          kind: "improvement",
          title: "Replaced the water heater",
          cost_cents: 185000,
          vendor: "Pipewise Plumbing",
          documents:
            '[{"id":"seed-doc-water-heater-receipt","kind":"receipt","title":"Water heater invoice"}]',
        },
        {
          date: "2023-06-12",
          kind: "repair",
          title: "Replaced the kitchen faucet cartridge",
          cost_cents: 28500,
          vendor: "Pipewise Plumbing",
          documents:
            '[{"id":"seed-doc-faucet-receipt","kind":"receipt","title":"Pipewise invoice 1187"}]',
        },
        {
          date: "2024-03-09",
          kind: "improvement",
          title: "Updated the thermostat to a smart model",
          cost_cents: 24900,
          vendor: null,
          documents:
            '[{"id":"seed-doc-thermostat-receipt","kind":"receipt","title":"Thermostat order confirmation"}]',
        },
        {
          date: "2026-06-06",
          kind: "improvement",
          title: "Trenched and laid cable for the path lights",
          cost_cents: 45000,
          vendor: null,
          documents: "[]",
        },
        {
          date: "2026-06-20",
          kind: "improvement",
          title: "Installed the lighting transformer and an outdoor outlet",
          cost_cents: 38000,
          vendor: "Brightside Electric",
          documents:
            '[{"id":"seed-doc-transformer-receipt","kind":"receipt","title":"Brightside invoice 3320"}]',
        },
      ],
    });

    // The plain comparison that get_schema warns about loses the water heater.
    const plain = await query(since(`date >= '2023-03'`));
    expect(plain.rows!.map(({ date }) => date)).toEqual([
      "2023-06-12",
      "2024-03-09",
      "2026-06-06",
      "2026-06-20",
    ]);
  }),
);

test(
  "the fridge's water filter and where it was bought last, and the microwave's exact model",
  asking(async (query) => {
    // Where a Part was bought last is the Vendor on the latest Work for its Schedule.
    expect(
      await query(`
        SELECT json_extract(i.data, '$.parts."water-filter".part_number') AS part_number,
               (SELECT v.name FROM work w
                  JOIN schedules s ON s.id = w.schedule_id
                  JOIN vendors v ON v.id = w.vendor_id
                 WHERE s.item_id = i.id ORDER BY w.date DESC LIMIT 1) AS bought_last_from
          FROM items i WHERE i.name = 'Fridge'`),
    ).toEqual({ rows: [{ part_number: "DA97-17376B", bought_last_from: "Filter Depot" }] });

    expect(await query(`SELECT brand, model FROM inventory WHERE name = 'Microwave'`)).toEqual({
      rows: [{ brand: "Panasonic", model: "NN-SN686S" }],
    });
  }),
);

// `inventory` is what the User has now. It leaves out the two Gone Items, and the dishwasher
// that stayed at the former Property.
test(
  "what was paid for everything the User has, and what is missing a Receipt or a photo",
  asking(async (query) => {
    expect(
      await query(`SELECT count(*) AS items, sum(price_cents) AS paid_cents FROM inventory`),
    ).toEqual({
      rows: [{ items: 8, paid_cents: 815498 }],
    });

    const missing = await query(
      `SELECT name FROM inventory WHERE photos = 0 OR receipts = 0 ORDER BY name`,
    );
    expect(missing.rows!.map(({ name }) => name)).toEqual([
      "Adjustable dumbbells",
      "Microwave",
      "Running watch",
      "Sectional couch",
      "Standing desk",
      "Water heater",
    ]);
  }),
);

test(
  "what was sold in 2026, and which stolen Items have not been paid out",
  asking(async (query) => {
    expect(
      await query(`
        SELECT name, status_on, price_cents, proceeds_cents FROM items
         WHERE status = 'sold' AND status_on >= '2026'`),
    ).toEqual({
      rows: [
        {
          name: "Exercise bike",
          status_on: "2026-03-14",
          price_cents: 65000,
          proceeds_cents: 30000,
        },
      ],
    });

    expect(
      await query(`
        SELECT name, status_on, price_cents FROM items
         WHERE status IN ('stolen', 'destroyed') AND proceeds_cents IS NULL`),
    ).toEqual({
      rows: [{ name: "Electric bike", status_on: "2025-09-02", price_cents: 240000 }],
    });
  }),
);

// The living room has wall paint of its own and no trim entry, so its trim is the Property's.
test(
  "what paint is in the living room",
  asking(async (query) => {
    expect(
      await query(`
        SELECT json_extract(s.data, '$.paint.walls.color') AS walls,
               json_extract(s.data, '$.paint.walls.code') AS walls_code,
               json_extract(s.data, '$.paint.trim.color') AS trim,
               json_extract(p.data, '$.paint.trim.color') AS property_trim
          FROM spaces s JOIN current_properties p ON p.id = s.property_id
         WHERE s.name = 'living room'`),
    ).toEqual({
      rows: [
        { walls: "Agreeable Gray", walls_code: "SW 7029", trim: null, property_trim: "Pure White" },
      ],
    });
  }),
);

test(
  "who did the plumbing last time, and who quoted the outdoor lighting and for how much",
  asking(async (query) => {
    // Old Town Plumbing was the plumber before, at the former Property.
    expect(
      await query(`
        SELECT v.name, w.date FROM work w JOIN vendors v ON v.id = w.vendor_id
         WHERE v.role = 'plumber' ORDER BY w.date DESC LIMIT 1`),
    ).toEqual({ rows: [{ name: "Pipewise Plumbing", date: "2023-06-12" }] });

    expect(
      await query(`
        SELECT v.name AS vendor, q.amount_cents, q.quoted_on
          FROM quotes q
          JOIN projects p ON p.id = q.project_id
          JOIN vendors v ON v.id = q.vendor_id
         WHERE p.title = 'Outdoor lighting' ORDER BY q.quoted_on`),
    ).toEqual({
      rows: [
        { vendor: "Brightside Electric", amount_cents: 420000, quoted_on: "2026-04-18" },
        { vendor: "Glow Landscape Lighting", amount_cents: 365000, quoted_on: "2026-05-02" },
      ],
    });
  }),
);

// The dates in the made-up household are fixed, so "due" is asked as of a fixed day.
test(
  "what maintenance is coming up, and what was already due on 2026-10-10",
  asking(async (query) => {
    expect(
      await query(`SELECT title, next_due_on FROM schedules WHERE active = 1 ORDER BY next_due_on`),
    ).toEqual({
      rows: [
        { title: "Service the furnace", next_due_on: "2026-09-08" },
        { title: "Replace fridge water filter", next_due_on: "2026-12-17" },
      ],
    });

    expect(
      await query(`SELECT title FROM schedules WHERE active = 1 AND next_due_on <= '2026-10-10'`),
    ).toEqual({ rows: [{ title: "Service the furnace" }] });
  }),
);

// This takes the made-up household out part-way through, so it is the last test in the file,
// and it puts the set back when it is done.
test(
  "the load and remove commands leave every table as it was, and say how many rows went each way",
  Effect.gen(function* () {
    const client = yield* signedIn;
    const rowsOf = async (sql: string) => (await ask(client, sql)).rows!;
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

    yield* command("remove");
    const without = yield* everyTable;

    const loaded = yield* command("load");
    const withIt = yield* everyTable;
    const inTheSet = count(withIt) - count(without);
    expect(inTheSet).toBeGreaterThan(50);
    expect(loaded).toEqual({ removed: 0, loaded: inTheSet });

    // A second load replaces the first copy and leaves one.
    expect(yield* command("load")).toEqual({ removed: inTheSet, loaded: inTheSet });
    expect(count(yield* everyTable)).toBe(count(withIt));

    // Removing says how many rows it took out, and leaves none behind.
    expect(yield* command("remove")).toEqual({ removed: inTheSet, loaded: 0 });
    expect(yield* everyTable).toEqual(without);
  }).pipe(Effect.ensuring(Effect.orDie(command("load")))),
);
