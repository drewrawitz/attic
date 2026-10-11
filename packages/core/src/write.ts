import { Context, Crypto, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import type { Statement } from "effect/sql/Statement";
import { SHAPES, snapshot, type RecordShape, type RecordType } from "./records.ts";

/**
 * Runs statements as one atomic batch: every one of them happens, or none does. D1 has no
 * interactive transactions (ADR 0006), so there are two of these: D1's own batch in the Worker,
 * and a transaction on the Node SQLite the tests run on. No tool is handed this. A tool writes
 * through `Write`, which adds the Change to the batch.
 */
export class AtomicBatch extends Context.Service<
  AtomicBatch,
  {
    readonly run: (statements: ReadonlyArray<Statement<unknown>>) => Effect.Effect<void, SqlError>;
  }
>()("@attic/core/AtomicBatch") {}

// Effect makes a ULID from the clock and ten random bytes, and wants a whole Crypto service to
// do it. Web Crypto has the bytes, in a Worker and in Node alike. Attic takes no digests.
const { randomULID } = Crypto.make({
  randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
  digest: () => Effect.die("This Crypto only makes ids."),
});

/**
 * Makes ids: one for each record a tool creates, and one for each Change. A write cannot read
 * back its own statements (ADR 0006), so every id is made in code before the batch runs. A
 * test puts ids it knows in place of these.
 */
export class Ids extends Context.Service<Ids, { readonly next: Effect.Effect<string> }>()(
  "@attic/core/Ids",
) {
  /** ULIDs, which sort by when they were made. */
  static readonly layer = Layer.succeed(Ids, Ids.of({ next: Effect.orDie(randomULID) }));
}

/**
 * One statement of a write, with the record it is about: the one it creates, changes, or
 * deletes. A statement cannot be handed over without one, so no record a write touches is
 * left out of its Change.
 */
export interface Step {
  readonly type: RecordType;
  readonly id: string;
  readonly statement: Statement<unknown>;
}

// The statement that writes down, in a Change, how the records of one type are at that point of
// the batch. It runs twice: before the tool's statements for `before`, and after them for
// `after`. A record that is not there at that point gets nothing, which leaves `before` null
// for a create and `after` null for a delete. It is given the Change, the type, and the ids as
// a JSON list.
const recording = (shape: RecordShape, column: "before" | "after") => `
  INSERT INTO change_records (change_id, entity_type, entity_id, ${column})
  SELECT ?1, ?2, record.id, ${snapshot(shape)}
    FROM ${shape.table} AS record
   WHERE record.id IN (SELECT value FROM json_each(?3))
  ON CONFLICT (change_id, entity_type, entity_id) DO UPDATE SET ${column} = excluded.${column}`;

// Both statements for each type, built once. A type with more columns than a snapshot can
// hold fails here, when the module loads, and not at the first write of that type.
const RECORDING = Object.fromEntries(
  Object.entries<RecordShape>(SHAPES).map(([type, shape]) => [
    type,
    { before: recording(shape, "before"), after: recording(shape, "after") },
  ]),
) as Readonly<Record<RecordType, Readonly<Record<"before" | "after", string>>>>;

/**
 * The one write a tool's call makes. A tool does its reads, builds every statement, and hands
 * them over. They run as one atomic batch together with the Change that records them
 * (ADR 0011), so the batch of a tool never runs without one.
 */
export class Write extends Context.Service<
  Write,
  {
    /** Runs the statements and records the Change. Returns the id of the Change. */
    readonly run: (steps: ReadonlyArray<Step>) => Effect.Effect<string, SqlError>;
  }
>()("@attic/core/Write") {
  /** The write of one call of the tool with this name. */
  static readonly layer = (tool: string) =>
    Layer.effect(
      Write,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const batch = yield* AtomicBatch;
        const ids = yield* Ids;
        let written = false;

        return Write.of({
          run: Effect.fnUntraced(function* (steps) {
            // One call is one Change. Two writes would be two batches, and the first would
            // stand if the second failed.
            if (written) {
              return yield* Effect.die(
                new Error(`${tool} asked for a second write in one call. One call is one Change.`),
              );
            }
            written = true;

            const change = yield* ids.next;
            const types = [...new Set(steps.map(({ type }) => type))];
            // The snapshots are the database's own account of each record, read inside the
            // batch, so they hold what was stored and not what a tool meant to store.
            const recorded = (column: "before" | "after") =>
              types.map((type) => {
                const ofType = steps.filter((step) => step.type === type).map(({ id }) => id);
                return sql.unsafe(RECORDING[type][column], [
                  change,
                  type,
                  JSON.stringify([...new Set(ofType)]),
                ]);
              });

            yield* batch.run([
              sql`INSERT INTO changes (id, tool) VALUES (${change}, ${tool})`,
              ...recorded("before"),
              ...steps.map(({ statement }) => statement),
              ...recorded("after"),
            ]);
            return change;
          }),
        });
      }),
    );
}
