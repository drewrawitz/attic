import { AtomicBatch, Currency, Ids, SignedAddresses } from "@attic/core";
import { D1Client } from "@effect/sql-d1";
import { DateTime, Effect, Layer } from "effect";
import type { WorkerEnv } from "../../../alchemy.run.ts";

// D1 has no interactive transactions (ADR 0006). Its batch is the atomic write: every
// statement in it happens, or none does.
const D1Batch = Layer.effect(
  AtomicBatch,
  Effect.map(D1Client.D1Client, (d1) =>
    AtomicBatch.of({ run: (statements) => Effect.asVoid(d1.batch(statements)) }),
  ),
);

/**
 * What a tool runs on in the Worker: the D1 database, its batch, ULIDs for new records, the
 * configured timezone, which is where a tool reads today's date, the configured currency,
 * which is how a tool writes an amount out, and addresses signed with the Worker's key at the
 * address it was reached at. Effect keeps each timezone it has made, so only the first call of
 * an isolate pays for making it.
 */
export const toolServices = (env: WorkerEnv, origin: string) =>
  Layer.mergeAll(
    D1Batch,
    Ids.layer,
    DateTime.layerCurrentZoneNamed(env.ATTIC_TIMEZONE),
    Currency.layer(env.ATTIC_CURRENCY),
    SignedAddresses.layer(origin, env.SIGNING_KEY),
  ).pipe(Layer.provideMerge(D1Client.layer({ db: env.DB })));
