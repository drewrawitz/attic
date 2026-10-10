import { hello } from "@attic/core";
import { D1Client } from "@effect/sql-d1";
import { Cause, Effect } from "effect";
import type { WorkerEnv } from "../../../alchemy.run.ts";

// The hello-world for the scaffold step. It runs a trivial Effect program that makes one D1
// query and one small batch, so the deployed Worker's CPU time and subrequest count can be
// measured before sign-in and tools are built on this stack (ADR 0012). It only reads.
// It goes away when the first real route lands.

// `?batches=n&statements=m` runs n batches of m statements each, to find where the plan's
// subrequest limit sits and whether a batch counts once or once per statement. The caps
// keep the work one request can ask for small, since this address is public.
const MAX_BATCHES = 1100;
const MAX_STATEMENTS = 100;
const MAX_TOTAL_STATEMENTS = 1200;

const param = (url: URL, name: string, fallback: number, min: number, max: number): number => {
  const requested = Number(url.searchParams.get(name) ?? fallback);
  return Number.isInteger(requested) ? Math.min(Math.max(requested, min), max) : fallback;
};

const probe = (request: Request) => {
  const url = new URL(request.url);
  const statements = param(url, "statements", 3, 1, MAX_STATEMENTS);
  const batches = Math.min(
    param(url, "batches", 1, 0, MAX_BATCHES),
    Math.floor(MAX_TOTAL_STATEMENTS / statements),
  );
  return { batches, statements };
};

// The D1 client wraps the binding's own error, so the useful message is further down the chain.
const messages = (error: unknown): string => {
  const chain: string[] = [];
  for (let at = error; at instanceof Error && chain.length < 4; at = at.cause) {
    chain.push(at.message);
  }
  return chain.length > 0 ? chain.join(" <- ") : String(error);
};

const program = ({ batches, statements }: ReturnType<typeof probe>) =>
  Effect.gen(function* () {
    const sql = yield* D1Client.D1Client;

    const [categories] = yield* sql<{
      count: number;
    }>`SELECT count(*) AS count FROM categories`;

    const counts = [
      sql`SELECT count(*) AS count FROM properties`,
      sql`SELECT count(*) AS count FROM items`,
      sql`SELECT count(*) AS count FROM changes`,
    ];
    const batch = sql.batch(Array.from({ length: statements }, (_, i) => counts[i % 3]!));

    // A batch that fails ends the run, and the response says how far it got and why.
    let completed = 0;
    const stoppedBy = yield* Effect.forEach(
      Array.from({ length: batches }),
      () => Effect.tap(batch, () => Effect.sync(() => (completed += 1))),
      { discard: true },
    ).pipe(
      Effect.as(null),
      Effect.catchCause((cause) => Effect.succeed(messages(Cause.squash(cause)))),
    );

    return {
      message: yield* hello,
      categories: categories?.count ?? 0,
      batches: completed,
      statementsPerBatch: statements,
      ...(stoppedBy === null ? {} : { stoppedBy }),
    };
  });

export default {
  async fetch(request, env): Promise<Response> {
    const result = await Effect.runPromise(
      program(probe(request)).pipe(Effect.provide(D1Client.layer({ db: env.DB }))),
    );
    return Response.json(result);
  },
} satisfies ExportedHandler<WorkerEnv>;
