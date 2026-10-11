import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { partialDate } from "../dates.ts";
import { everyProperty, propertiesThere } from "../property.ts";
import {
  columnsToSet,
  dataPatch,
  insertRow,
  nameText,
  runSave,
  SAVE_ANNOTATIONS,
  updateRow,
  type SaveStep,
} from "../save.ts";
import { defineTool, optional, ToolError } from "../tool.ts";
import { Ids } from "../write.ts";
import { readRecord } from "./get-record.ts";

const NO_NAME = "Give a name to create a Property, or the id of the Property to update.";

const DESCRIPTION = `Creates or updates a Property: a place the User lives or has lived, owned or rented. Give its name, and any of tenure, address, start_on, end_on, and \`data\`.

With an id, the Property with that id is updated, and a name is its new name. Without an id, the name says which Property it is: if one already has that name, whatever its case, it is updated, and otherwise a new one is created. So to rename a Property, give its id and the new name.

A field that is left out, or sent as null, stays as it is. To empty a field, name it in \`clear\`.

\`end_on\` is the day the place stops being the User's: the sale or the move-out. A Property with no end_on, or one that has not passed, is a Current property. A lease running out is not an end date. It goes in \`data.lease_until\`. A Property is never deleted.

What comes back is the id of the Change that recorded the save, the Property as created or updated, and the whole record as get_record returns it.`;

export const saveProperty = defineTool({
  name: "save_property",
  description: DESCRIPTION,
  input: Schema.Struct({
    id: optional(
      Schema.String.annotate({
        description:
          "The id of the Property to update. Leave it out to create a Property, or to update the one that already has the name.",
      }),
    ),
    name: optional(
      nameText(
        "What the Property is called, such as Maple Street house. No two Properties can have the same name, whatever its case. A new Property needs one.",
      ),
    ),
    tenure: optional(
      Schema.Literals(["own", "rent", "other"]).annotate({
        description: "Whether the User owns the place or rents it. A new Property is own.",
      }),
    ),
    address: optional(Schema.String.annotate({ description: "Where the place is." })),
    start_on: optional(partialDate("The purchase, the move-in, or the start of the lease.")),
    end_on: optional(
      partialDate(
        "The day the place stops being the User's: the sale or the move-out. Not when a lease runs out, which goes in data.lease_until.",
      ),
    ),
    data: optional(
      dataPatch(
        "Facts about the whole place, such as lease_until and the paint that is the same in every Space.",
      ),
    ),
    clear: optional(
      Schema.Array(Schema.Literals(["address", "start_on", "end_on"])).annotate({
        description:
          "Fields to empty. A field cannot be given a value and cleared in the same call. A Property always has a name and a tenure, so those cannot be cleared.",
      }),
    ),
  }),
  annotations: SAVE_ANNOTATIONS,
  run: ({ id, data, clear, ...given }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const ids = yield* Ids;
      const columns = yield* columnsToSet(given, clear);

      const properties = yield* everyProperty(given.name);
      const byName = properties.find((property) => property.named);
      const existing =
        id === undefined ? byName : properties.find((property) => property.id === id);

      // Runs the one step of the save, and replies with what it saved and the whole record.
      const save = Effect.fnUntraced(function* (step: SaveStep) {
        return { ...(yield* runSave([step])), record: yield* readRecord("property", step.id) };
      });

      if (existing === undefined) {
        if (id !== undefined) {
          return yield* new ToolError({
            message: `There is no Property with the id "${id}". To save one by its name, leave the id out. ${propertiesThere(properties)}`,
          });
        }
        if (given.name === undefined) return yield* new ToolError({ message: NO_NAME });
        const property = { type: "property", id: yield* ids.next, name: given.name } as const;
        return yield* save(insertRow(sql, property, columns, data));
      }

      if (byName !== undefined && byName.id !== existing.id) {
        return yield* new ToolError({
          message: `Another Property is already named "${byName.name}". No two Properties can have the same name, whatever its case.`,
        });
      }

      // With an id, a name is the Property's new name. Without one, the name said which
      // Property this is, and it stays as it was first written.
      const newName = id === undefined ? undefined : given.name;
      const { name: _, ...others } = columns;
      const sets = newName === undefined ? others : columns;
      const property = {
        type: "property",
        id: existing.id,
        name: newName ?? existing.name,
      } as const;
      return yield* save(updateRow(sql, property, sets, data));
    }),
});
