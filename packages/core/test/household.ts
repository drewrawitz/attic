import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { load, remove, type Statement } from "../../../household/records.ts";

const run = (statements: ReadonlyArray<Statement>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const statement of statements) yield* sql.unsafe(statement.sql, statement.params);
  });

/**
 * Loads the made-up household into the database the test is running on. A test of a tool that
 * reads loads it first, and then asks the tool about the fridge, the living room, and the rest.
 */
export const loadHousehold = run(load);

/** Takes the made-up household out again. */
export const removeHousehold = run(remove);
