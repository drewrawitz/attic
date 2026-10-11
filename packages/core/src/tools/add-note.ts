import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { newNote, NOTED, type Noted } from "../note.ts";
import { propertyFor, propertyNamed } from "../property.ts";
import { noteText, runSave, SAVE_ANNOTATIONS } from "../save.ts";
import { defineTool, optional, ToolError } from "../tool.ts";
import { noRecord, readRecord, term } from "./get-record.ts";

const DESCRIPTION = `Adds a Note: a dated piece of free text for a fact that fits nowhere else, such as "Breaker 14 is the garage" or "The HOA approved the fence color". First check that the fact has no better home. A model number or a paint color goes in a record's \`data\`, and something that was done is logged as Work.

A Note stands alone at a Property, or is attached to one record: an Item, Work, a Vendor, a Space, or a Project. To attach it, give \`attach_to\` the record's type and id, as search and get_record give them. A Note on a record takes that record's Property, so \`property\` is left out. A Note that stands alone goes to the Property given in \`property\`, or to the one Current property when none is given, and it shows on that Property's record.

Each call adds a new Note, and none replaces an earlier one. What comes back is the id of the Change that recorded it, and the Note as get_record returns it, with what it is attached to.`;

// Where each type of record a Note can be attached to is kept: its table, and the column its
// name or title is in.
const KEPT: Readonly<Record<Noted["type"], { table: string; name: string }>> = {
  item: { table: "items", name: "name" },
  work: { table: "work", name: "title" },
  vendor: { table: "vendors", name: "name" },
  space: { table: "spaces", name: "name" },
  project: { table: "projects", name: "title" },
};

// The record a Note is to be attached to: its name, and the Property it is at, if any.
interface Attached {
  readonly name: string;
  readonly property_id: string | null;
  readonly property: string | null;
}

const attached = ({ type, id }: Noted) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { table, name } = KEPT[type];
    // A Vendor is the one type that is at no Property.
    const at = type === "vendor" ? "NULL" : "record.property_id";
    const [record] = yield* sql.unsafe<Attached>(
      `SELECT record.${name} AS name, ${at} AS property_id, property.name AS property
         FROM ${table} AS record
         LEFT JOIN properties AS property ON property.id = ${at}
        WHERE record.id = ?`,
      [id],
    );
    return record === undefined ? yield* noRecord(type, id) : record;
  });

export const addNote = defineTool({
  name: "add_note",
  description: DESCRIPTION,
  input: Schema.Struct({
    body: noteText("What the Note says."),
    attach_to: optional(
      Schema.Struct({
        type: Schema.Literals(NOTED).annotate({ description: "What kind of record it is." }),
        id: Schema.String.annotate({
          description: "The record's id, as search or get_record gives it.",
        }),
      }).annotate({
        description:
          "The record the Note is about. Leave it out for a Note that stands alone at a Property.",
      }),
    ),
    property: optional(
      Schema.String.annotate({
        description:
          "For a Note that stands alone: the Property it is at, by its id or its name. Leave it out for the one Current property. A Note attached to a record takes that record's Property.",
      }),
    ),
  }),
  annotations: SAVE_ANNOTATIONS,
  run: ({ body, attach_to: on, property: given }) =>
    Effect.gen(function* () {
      // A Note on a record takes that record's Property, so a Property given beside it can
      // only agree.
      const propertyOf = Effect.fnUntraced(function* (on: Noted) {
        const record = yield* attached(on);
        if (given !== undefined && (yield* propertyNamed(given)).id !== record.property_id) {
          return yield* new ToolError({
            message: `A Note on a record takes that record's Property. The ${term(on.type)} "${record.name}" is at ${record.property ?? "no Property"}, so leave \`property\` out.`,
          });
        }
        return record.property_id;
      });

      const propertyId = on === undefined ? (yield* propertyFor(given)).id : yield* propertyOf(on);
      const step = yield* newNote(body, propertyId, on);
      return { ...(yield* runSave([step])), record: yield* readRecord("note", step.id) };
    }),
});
