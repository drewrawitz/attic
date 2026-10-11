import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { AtomicBatch, Ids } from "../src/write.ts";

const migrationsDir = new URL("../../../migrations/", import.meta.url);

/** Every migration file, in the order a deploy applies them. */
export const migrations = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => readFileSync(new URL(name, migrationsDir), "utf8"));

// On Node SQLite an atomic batch is an ordinary transaction (ADR 0006). D1 has none, which is
// why this lives with the tests and not in src.
const InOneTransaction = Layer.effect(
  AtomicBatch,
  Effect.map(SqlClient.SqlClient, (sql) =>
    AtomicBatch.of({
      run: (statements) =>
        sql.withTransaction(
          Effect.forEach(statements, (statement) => statement, { discard: true }),
        ),
    }),
  ),
);

// Ids a test knows before it asks: id-0001, id-0002, and so on, in the order they are made.
const KnownIds = Layer.sync(Ids, () => {
  let made = 0;
  return Ids.of({ next: Effect.sync(() => `id-${String(++made).padStart(4, "0")}`) });
});

/**
 * A fresh in-memory SQLite database with every migration applied as written and foreign
 * keys on, and with it what a tool that writes needs: an atomic batch, and ids that start
 * over at id-0001. Provide it once per test, and each test gets a database of its own.
 */
export const TestDatabase = Layer.unwrap(
  Effect.sync(() => {
    // The database is named so that a second connection can open it. It lives for as long
    // as the client's connection does.
    const filename = `file:${randomUUID()}?mode=memory&cache=shared`;

    // The client prepares one statement at a time, and node:sqlite silently drops whatever
    // follows the first statement in a string. `exec` runs a whole file, so the migrations
    // go in through a connection of their own.
    const migrate = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const db = new DatabaseSync(filename);
      try {
        for (const migration of migrations) db.exec(migration);
      } finally {
        db.close();
      }
      yield* sql`PRAGMA foreign_keys = ON`;
    });

    return Layer.mergeAll(Layer.effectDiscard(migrate), InOneTransaction, KnownIds).pipe(
      Layer.provideMerge(SqliteClient.layer({ filename })),
    );
  }),
);

/**
 * Runs a statement the schema is meant to refuse and returns which kind of constraint
 * refused it, in SQLite's words: `UNIQUE`, `CHECK`, `FOREIGN KEY`, or `NOT NULL`. Any other
 * failure comes back as its whole message, so a typo in a test cannot pass as a refusal.
 */
export const refusal = <A, R>(statement: Effect.Effect<A, SqlError, R>) =>
  Effect.flip(statement).pipe(
    Effect.mapError(() => new Error("the database accepted a statement it should refuse")),
    Effect.map(({ reason: { cause } }) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      return /^(UNIQUE|CHECK|FOREIGN KEY|NOT NULL) constraint failed/.exec(message)?.[1] ?? message;
    }),
  );

/**
 * The values a column's CHECK list allows, in the order the table's definition gives them.
 * SQLite has no way to ask for the list, and trying values only shows that the ones tried
 * are refused, so this reads the definition. It is what catches a value being added.
 */
export const checkList = (table: string, column: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [definition] = yield* sql<{ sql: string }>`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${table}`;
    const list = new RegExp(`CHECK \\(${column} IN\\s*\\(([^)]*)\\)`).exec(definition?.sql ?? "");
    return [...(list?.[1] ?? "").matchAll(/'([^']*)'/g)].map((value) => value[1]);
  });
