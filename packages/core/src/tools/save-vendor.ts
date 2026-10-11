import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { noteOn } from "../note.ts";
import {
  columnsToSet,
  dataPatch,
  nameText,
  noteText,
  runSave,
  SAVE_ANNOTATIONS,
  updateRow,
} from "../save.ts";
import { defineTool, optional, ToolError } from "../tool.ts";
import { vendorNamed } from "../vendor.ts";
import { readRecord } from "./get-record.ts";

const NO_NAME = "Give a name to create a Vendor, or the id of the Vendor to update.";

const DESCRIPTION = `Creates or updates a Vendor: any business or person the User pays, buys from, or gets a Quote from, such as a contractor, a store, a landlord, an HOA, or an insurer. Someone the User sells or gives things to is not a Vendor.

There is one Vendor for each name, whatever the name's case, which is ignored for the letters a to z. So without an id, the name says which Vendor it is: if one already has that name it is updated, and otherwise a new one is created. With an id, the Vendor with that id is updated, and a name is its new name. So to rename a Vendor, give its id and the new name.

The other save tools create a Vendor on first use, when they name one that is not there yet. This tool is for a Vendor's role and facts, and for renaming one.

\`role\` is free text for what the Vendor does: plumber, electrician, retailer, landlord. search finds a Vendor by it, so "who did we use for plumbing" is answered by the role. A field that is left out, or sent as null, stays as it is. To empty the role, name it in \`clear\`.

\`note\` adds a Note to the Vendor in the same Change, such as how they like to be reached. Each one given is a new Note, and none replaces an earlier one.

What comes back is the id of the Change that recorded the save, the Vendor and the Note as created or updated, and the whole Vendor as get_record returns it.`;

export const saveVendor = defineTool({
  name: "save_vendor",
  description: DESCRIPTION,
  input: Schema.Struct({
    id: optional(
      Schema.String.annotate({
        description:
          "The id of the Vendor to update. Leave it out to create a Vendor, or to update the one that already has the name.",
      }),
    ),
    name: optional(
      nameText(
        "What the Vendor is called, such as Pipewise Plumbing. No two Vendors can have the same name, whatever its case. A new Vendor needs one.",
      ),
    ),
    role: optional(
      Schema.String.annotate({
        description: "What the Vendor does, in a word or two: plumber, hvac, retailer, landlord.",
      }),
    ),
    data: optional(
      dataPatch("Facts about the Vendor, such as phone, email, and url.", { keyList: false }),
    ),
    note: optional(noteText("A Note to add to the Vendor. It is a new Note each time.")),
    clear: optional(
      Schema.Array(Schema.Literal("role")).annotate({
        description:
          "Fields to empty. A field cannot be given a value and cleared in the same call. A Vendor always has a name, so it cannot be cleared.",
      }),
    ),
  }),
  annotations: SAVE_ANNOTATIONS,
  run: ({ id, name, data, note, clear, ...given }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const columns = yield* columnsToSet(given, clear);

      // Without an id, the name says which Vendor this is. One that is there already keeps
      // its name as it was first written, and takes what was given.
      const byName = Effect.gen(function* () {
        if (name === undefined) return yield* new ToolError({ message: NO_NAME });
        const vendor = yield* vendorNamed(name, columns, data);
        const [created] = vendor.steps;
        return created ?? updateRow(sql, vendor, columns, data);
      });

      // With an id, a name is the Vendor's new name.
      const byId = Effect.fnUntraced(function* (id: string) {
        // The database compares the names, so case is ignored the same way it is everywhere else.
        const [vendor] = yield* sql<{ name: string; taken: string | null }>`
          SELECT vendor.name,
                 (SELECT other.name FROM vendors AS other
                   WHERE other.name = ${name ?? null} AND other.id <> vendor.id) AS taken
            FROM vendors AS vendor
           WHERE vendor.id = ${id}`;
        if (vendor === undefined) {
          return yield* new ToolError({
            message: `There is no Vendor with the id "${id}". To save one by its name, leave the id out.`,
          });
        }
        if (vendor.taken !== null) {
          return yield* new ToolError({
            message: `Another Vendor is already named "${vendor.taken}". There is one Vendor for each name, whatever its case.`,
          });
        }
        const renamed = { type: "vendor", id, name: name ?? vendor.name } as const;
        return updateRow(sql, renamed, name === undefined ? columns : { ...columns, name }, data);
      });

      const step = yield* id === undefined ? byName : byId(id);
      // A Vendor has no Property, so a Note on one has none.
      const steps = [step, ...(yield* noteOn(note, null, { type: "vendor", id: step.id }))];
      return { ...(yield* runSave(steps)), record: yield* readRecord("vendor", step.id) };
    }),
});
