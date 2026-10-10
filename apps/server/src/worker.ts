import { hello } from "@attic/core";
import { D1Client } from "@effect/sql-d1";
import { Effect } from "effect";
import type { WorkerEnv } from "../../../alchemy.run.ts";

// The hello-world for the scaffold step. It runs a trivial Effect program that makes one D1
// query and one small batch, so the deployed Worker's CPU time and subrequest count can be
// measured before sign-in and tools are built on this stack (ADR 0012). It only reads.
// It goes away when the first real route lands.

// `?batches=n` repeats the batch, to find out how a batch counts against the Free plan's
// 50 subrequests per request. Capped a little above that limit.
const MAX_BATCHES = 60;

const batchCount = (request: Request): number => {
  const requested = Number(new URL(request.url).searchParams.get("batches") ?? 1);
  return Number.isInteger(requested) ? Math.min(Math.max(requested, 0), MAX_BATCHES) : 1;
};

const program = (batches: number) =>
  Effect.gen(function* () {
    const sql = yield* D1Client.D1Client;

    const [categories] = yield* sql<{
      count: number;
    }>`SELECT count(*) AS count FROM categories`;

    const batch = sql.batch([
      sql<{ count: number }>`SELECT count(*) AS count FROM properties`,
      sql<{ count: number }>`SELECT count(*) AS count FROM items`,
      sql<{ count: number }>`SELECT count(*) AS count FROM changes`,
    ]);
    const results = yield* Effect.forEach(Array.from({ length: batches }), () => batch);

    return {
      message: yield* hello,
      categories: categories?.count ?? 0,
      batches: results.length,
      statementsPerBatch: 3,
    };
  });

export default {
  async fetch(request, env): Promise<Response> {
    const result = await Effect.runPromise(
      program(batchCount(request)).pipe(Effect.provide(D1Client.layer({ db: env.DB }))),
    );
    return Response.json(result);
  },
} satisfies ExportedHandler<WorkerEnv>;
