import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { refusal, TestDatabase } from "../TestDatabase.ts";

it.effect("each record in a Change needs a before or an after", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO changes (id, tool) VALUES ('chg1', 'update_item')`;

    yield* sql`INSERT INTO change_records (change_id, entity_type, entity_id, before, after) VALUES
      ('chg1', 'item', 'created', NULL,             '{"name":"Couch"}'),
      ('chg1', 'item', 'updated', '{"name":"Sofa"}', '{"name":"Couch"}'),
      ('chg1', 'item', 'deleted', '{"name":"Couch"}', NULL)`;
    expect(yield* sql`SELECT count(*) AS n FROM change_records`).toEqual([{ n: 3 }]);

    const refused = yield* refusal(
      sql`INSERT INTO change_records (change_id, entity_type, entity_id, before, after)
          VALUES ('chg1', 'item', 'nothing', NULL, NULL)`,
    );
    expect(refused).toBe("CHECK");
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a before and an after in a Change must each be a JSON object", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO changes (id, tool) VALUES ('chg1', 'update_item')`;

    for (const notAnObject of ['["Couch"]', '"Couch"', "Couch"]) {
      const before = yield* refusal(
        sql`INSERT INTO change_records (change_id, entity_type, entity_id, before, after)
            VALUES ('chg1', 'item', 'i1', ${notAnObject}, '{"name":"Couch"}')`,
      );
      expect(before).toBe("CHECK");

      const after = yield* refusal(
        sql`INSERT INTO change_records (change_id, entity_type, entity_id, before, after)
            VALUES ('chg1', 'item', 'i1', '{"name":"Couch"}', ${notAnObject})`,
      );
      expect(after).toBe("CHECK");
    }
  }).pipe(Effect.provide(TestDatabase)),
);
