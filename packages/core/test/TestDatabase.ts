import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const migrationsDir = new URL("../../../migrations/", import.meta.url);

// Every migration file, in the order a deploy applies them.
const migrations = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => readFileSync(new URL(name, migrationsDir), "utf8"));

/**
 * A fresh in-memory SQLite database with every migration applied as written and foreign
 * keys on. Provide it once per test, and each test gets a database of its own.
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

    return Layer.effectDiscard(migrate).pipe(Layer.provideMerge(SqliteClient.layer({ filename })));
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
