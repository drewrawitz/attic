import { expect } from "@effect/vitest";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { DB } from "../alchemy.run.ts";

// Node SQLite and D1 are not the same build (ADR 0006), so rules pinned on Node SQLite could
// still fail on D1. These checks run the real migration on Alchemy's local D1 and exercise
// the SQLite features the schema leans on hardest.

const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

type Client = Cloudflare.D1.QueryDatabaseClient;

// Alchemy's way to query D1 from Node is `QueryDatabase` with the `QueryDatabaseLocal` layer,
// and it only resolves inside an Action. So each check deploys a scratch stack that holds the
// database and one Action, and the Action's output is what the check asserts on. Every check
// starts from a freshly migrated database.
const onDatabase = <A>(
  stack: Test.ScratchStack,
  run: (db: Client) => Effect.Effect<A, never, Alchemy.RuntimeContext>,
) =>
  stack.deploy(
    Effect.gen(function* () {
      yield* DB;
      const check = Alchemy.Action(
        "Check",
        Effect.gen(function* () {
          const db = yield* Cloudflare.D1.QueryDatabase(DB);
          return () => run(db);
        }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseLocal)),
      );
      return yield* check({});
    }),
  );

const rows = <Row>(db: Client, sql: string, ...values: unknown[]) =>
  Effect.map(
    db
      .prepare(sql)
      .bind(...values)
      .all<Row>(),
    (result) => result.results,
  );

// The client reports a failed statement as a defect, so a refusal is read off the cause.
const refusalOf = (statement: Effect.Effect<unknown, never, Alchemy.RuntimeContext>) =>
  statement.pipe(
    Effect.as("it went through"),
    Effect.catchCause((cause) => Effect.succeed(Cause.pretty(cause))),
  );

// The starter Categories are the last statement in 0001_init.sql, and 'other' is its last row.
test.provider("the migration applies through to its last statement", (stack) =>
  Effect.gen(function* () {
    const result = yield* onDatabase(stack, (db) =>
      rows(db, `SELECT name FROM categories WHERE id = 'other'`),
    );
    expect(result).toEqual([{ name: "Other" }]);
  }),
);

// A recursive CTE inside a view is valid SQLite, but nothing said D1 would accept it.
test.provider("item_in_category walks up the Category tree", (stack) =>
  Effect.gen(function* () {
    const result = yield* onDatabase(stack, (db) =>
      Effect.gen(function* () {
        yield* db.batch([
          db.prepare(
            `INSERT INTO items (id, name, category_id) VALUES ('drill', 'Drill', 'power-tools')`,
          ),
          db.prepare(
            `INSERT INTO item_categories (item_id, category_id) VALUES ('drill', 'networking')`,
          ),
        ]);
        return yield* rows(
          db,
          `SELECT category_id FROM item_in_category WHERE item_id = ? ORDER BY category_id`,
          "drill",
        );
      }),
    );
    expect(result).toEqual([
      { category_id: "electronics" },
      { category_id: "networking" },
      { category_id: "power-tools" },
      { category_id: "tools" },
    ]);
  }),
);

// INDEXED BY makes the query fail unless it can be answered from that index.
test.provider("an Item is looked up through a generated column and its index", (stack) =>
  Effect.gen(function* () {
    const result = yield* onDatabase(stack, (db) =>
      Effect.gen(function* () {
        yield* db
          .prepare(`INSERT INTO items (id, name, data) VALUES ('fridge', 'Fridge', ?)`)
          .bind(JSON.stringify({ brand: "Samsung", model: "RF28R7351SR" }))
          .run();
        return yield* rows(
          db,
          `SELECT name, brand FROM items INDEXED BY items_model WHERE model = ?`,
          "RF28R7351SR",
        );
      }),
    );
    expect(result).toEqual([{ name: "Fridge", brand: "Samsung" }]);
  }),
);

test.provider("a json_patch update merges keys and removes a key set to null", (stack) =>
  Effect.gen(function* () {
    const result = yield* onDatabase(stack, (db) =>
      Effect.gen(function* () {
        yield* db
          .prepare(`INSERT INTO items (id, name, data) VALUES ('router', 'Office router', ?)`)
          .bind(JSON.stringify({ brand: "eero", condition: "good" }))
          .run();
        yield* db
          .prepare(`UPDATE items SET data = json_patch(data, ?) WHERE id = 'router'`)
          .bind(JSON.stringify({ model: "Pro 6E", condition: null }))
          .run();
        return yield* rows<{ data: string; model: string }>(
          db,
          `SELECT data, model FROM items WHERE id = 'router'`,
        );
      }),
    );
    expect(result.map((router) => ({ ...router, data: JSON.parse(router.data) }))).toEqual([
      { data: { brand: "eero", model: "Pro 6E" }, model: "Pro 6E" },
    ]);
  }),
);

test.provider("a delete that a foreign key refuses fails and leaves the row", (stack) =>
  Effect.gen(function* () {
    const result = yield* onDatabase(stack, (db) =>
      Effect.gen(function* () {
        yield* db.batch([
          db.prepare(`INSERT INTO vendors (id, name) VALUES ('ace', 'Ace Plumbing')`),
          db.prepare(`INSERT INTO items (id, name, vendor_id) VALUES ('faucet', 'Faucet', 'ace')`),
        ]);
        const refusal = yield* refusalOf(db.prepare(`DELETE FROM vendors WHERE id = 'ace'`).run());
        return { refusal, vendors: yield* rows(db, `SELECT name FROM vendors WHERE id = 'ace'`) };
      }),
    );
    expect(result.refusal).toContain("FOREIGN KEY constraint failed");
    expect(result.vendors).toEqual([{ name: "Ace Plumbing" }]);
  }),
);

// This one pins a rule, not a SQLite feature. It is here because the rule was changed in the
// migration just before the first deploy, and a foreign key can't be changed again without
// rebuilding the table.
test.provider("a Project that still has Quotes refuses deletion", (stack) =>
  Effect.gen(function* () {
    const result = yield* onDatabase(stack, (db) =>
      Effect.gen(function* () {
        yield* db.batch([
          db.prepare(`INSERT INTO properties (id, name) VALUES ('home', 'Maple Street house')`),
          db.prepare(
            `INSERT INTO projects (id, property_id, title) VALUES ('lighting', 'home', 'Outdoor lighting')`,
          ),
          db.prepare(
            `INSERT INTO projects (id, property_id, title) VALUES ('lighting-2', 'home', 'Outdoor lighting, second try')`,
          ),
          db.prepare(`INSERT INTO vendors (id, name) VALUES ('bright', 'Bright Electric')`),
          db.prepare(
            `INSERT INTO quotes (id, project_id, vendor_id, amount_cents) VALUES ('q1', 'lighting', 'bright', 120000)`,
          ),
        ]);
        const refusal = yield* refusalOf(
          db.prepare(`DELETE FROM projects WHERE id = 'lighting'`).run(),
        );
        // Moving the Quote to another Project is what lets the delete through.
        yield* db
          .prepare(`UPDATE quotes SET project_id = 'lighting-2' WHERE project_id = 'lighting'`)
          .run();
        yield* db.prepare(`DELETE FROM projects WHERE id = 'lighting'`).run();
        return {
          refusal,
          projects: yield* rows(db, `SELECT id FROM projects ORDER BY id`),
          quotes: yield* rows(db, `SELECT id, project_id FROM quotes`),
        };
      }),
    );
    expect(result.refusal).toContain("FOREIGN KEY constraint failed");
    expect(result.projects).toEqual([{ id: "lighting-2" }]);
    expect(result.quotes).toEqual([{ id: "q1", project_id: "lighting-2" }]);
  }),
);
