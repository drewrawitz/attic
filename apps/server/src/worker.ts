import { hello } from "@attic/core";
import { D1Client } from "@effect/sql-d1";
import { Effect } from "effect";
import type { WorkerEnv } from "../../../alchemy.run.ts";

// The hello-world for the scaffold step. It runs a trivial Effect program that makes one D1
// query and one small batch, which is the request the CPU numbers in ADR 0012 were measured
// on. It only reads. It goes away when the first real route lands.
const program = Effect.gen(function* () {
  const sql = yield* D1Client.D1Client;

  const [categories] = yield* sql<{
    count: number;
  }>`SELECT count(*) AS count FROM categories`;

  const batch = yield* sql.batch([
    sql`SELECT count(*) AS count FROM properties`,
    sql`SELECT count(*) AS count FROM items`,
    sql`SELECT count(*) AS count FROM changes`,
  ]);

  return {
    message: yield* hello,
    categories: categories?.count ?? 0,
    batchStatements: batch.length,
  };
});

export default {
  async fetch(_request, env): Promise<Response> {
    const result = await Effect.runPromise(
      program.pipe(Effect.provide(D1Client.layer({ db: env.DB }))),
    );
    return Response.json(result);
  },
} satisfies ExportedHandler<WorkerEnv>;
