import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { checkList, refusal, TestDatabase } from "../TestDatabase.ts";

it.effect("a Document's kind is photo, receipt, quote, manual, warranty, or other", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const kinds = ["photo", "receipt", "quote", "manual", "warranty", "other"];
    expect(yield* checkList("documents", "kind")).toEqual(kinds);
    for (const kind of kinds) {
      yield* sql`INSERT INTO documents (id, kind, r2_key, mime_type, sha256)
                 VALUES (${kind}, ${kind}, ${`files/${kind}`}, 'application/pdf', ${`hash-${kind}`})`;
    }
    expect(yield* sql`SELECT count(*) AS n FROM documents`).toEqual([{ n: 6 }]);

    // An invoice is a Receipt, not a kind of its own.
    const refused = yield* refusal(
      sql`INSERT INTO documents (id, kind, r2_key, mime_type, sha256)
          VALUES ('d7', 'invoice', 'files/d7', 'application/pdf', 'hash-d7')`,
    );
    expect(refused).toBe("CHECK");
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("two Documents cannot share a file hash", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO documents (id, r2_key, mime_type, sha256)
               VALUES ('d1', 'files/d1', 'image/jpeg', 'hash-1')`;

    const refused = yield* refusal(
      sql`INSERT INTO documents (id, r2_key, mime_type, sha256)
          VALUES ('d2', 'files/d2', 'image/jpeg', 'hash-1')`,
    );
    expect(refused).toBe("UNIQUE");
  }).pipe(Effect.provide(TestDatabase)),
);
