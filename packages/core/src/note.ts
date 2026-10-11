import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { insertRow, updateRow, type SaveStep } from "./save.ts";
import { Ids } from "./write.ts";

/** The types of record a Note can be attached to. */
export const NOTED = ["item", "work", "vendor", "space", "project"] as const;

/** A record a Note is attached to. */
export interface Noted {
  readonly type: (typeof NOTED)[number];
  readonly id: string;
}

// A Note has no name. A reply names it by its body, and by only the start of a long one.
const NAMED_BY = 80;
const opening = (body: string) => (body.length > NAMED_BY ? `${body.slice(0, NAMED_BY)}…` : body);

/**
 * The step that writes a Note, under an id of its own. `on` is the record it is attached to,
 * and a Note with none stands alone. `propertyId` is the Property the Note is at, if any.
 */
export const newNote = Effect.fnUntraced(function* (
  body: string,
  propertyId: string | null,
  on?: Noted,
) {
  const sql = yield* SqlClient.SqlClient;
  const note = { type: "note", id: yield* (yield* Ids).next, name: opening(body) } as const;
  return insertRow(sql, note, {
    property_id: propertyId,
    entity_type: on?.type ?? null,
    entity_id: on?.id ?? null,
    body,
  });
});

/**
 * The steps that take a record's Notes to the Property the record has moved to. A Note on a
 * record takes that record's Property, so a save that moves a record moves its Notes in the
 * same Change. `propertyId` is null for a record that is now at no Property.
 */
export const notesMovedTo = (
  sql: SqlClient.SqlClient,
  notes: ReadonlyArray<{ readonly id: string; readonly body: string }>,
  propertyId: string | null,
): ReadonlyArray<SaveStep> =>
  notes.map(({ id, body }) =>
    updateRow(sql, { type: "note", id, name: opening(body) }, { property_id: propertyId }),
  );

/**
 * The optional Note of a save: a Note attached to the record that was saved, written in the
 * same batch and so in the same Change. `propertyId` is that record's Property, which the Note
 * takes. Returns the step that writes it, or none when no Note was given.
 */
export const noteOn = (
  body: string | undefined,
  propertyId: string | null,
  on: Noted,
): Effect.Effect<ReadonlyArray<SaveStep>, never, SqlClient.SqlClient | Ids> =>
  body === undefined
    ? Effect.succeed([])
    : Effect.map(newNote(body, propertyId, on), (step) => [step]);
