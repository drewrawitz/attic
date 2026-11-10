import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { DOCUMENT_STATUSES } from "../src/document.ts";
import { ITEM_STATUSES, notGone } from "../src/item.ts";
import { PROJECT_STATUSES } from "../src/project.ts";
import { checkList, TestDatabase } from "./TestDatabase.ts";

// The statuses of each kind of record are one list in code, beside the record, and the tools read
// it. So it has to be the list its table allows: a status the table has and the list lacks could
// not be saved, and one the list has and the table lacks would fail the write.
it.effect("each list of statuses is the CHECK list of its table, in its order", () =>
  Effect.gen(function* () {
    expect(ITEM_STATUSES).toEqual(yield* checkList("items", "status"));
    expect(PROJECT_STATUSES).toEqual(yield* checkList("projects", "status"));
    expect(DOCUMENT_STATUSES).toEqual(yield* checkList("documents", "status"));
  }).pipe(Effect.provide(TestDatabase)),
);

// The tools leave a Gone Item out through notGone. The inventory view is SQL a migration wrote,
// and cannot ask it, so this holds the two together by what each returns: a status that is added
// takes a migration that writes the view again.
it.effect("notGone and the inventory view keep the Items the User still has, and no others", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Each is a Belonging at no Property, so its status is all the view goes by.
    for (const status of ITEM_STATUSES) {
      yield* sql`INSERT INTO items (id, name, status) VALUES (${status}, 'Couch', ${status})`;
    }
    const statuses = (rows: ReadonlyArray<{ status: string }>) => rows.map(({ status }) => status);

    const held = yield* sql.unsafe<{ status: string }>(
      `SELECT status FROM items AS item WHERE ${notGone("item.status")} ORDER BY status`,
    );
    const inInventory = yield* sql<{ status: string }>`
      SELECT status FROM inventory ORDER BY status`;

    expect(statuses(held)).toEqual(["active", "listed"]);
    expect(statuses(inInventory)).toEqual(statuses(held));
  }).pipe(Effect.provide(TestDatabase)),
);
