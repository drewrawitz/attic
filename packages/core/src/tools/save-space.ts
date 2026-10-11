import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { propertyFor, propertyNamed } from "../property.ts";
import { dataPatch, nameText, runSave, SAVE_ANNOTATIONS, updateRow } from "../save.ts";
import { spaceNamed } from "../space.ts";
import { defineTool, optional, ToolError } from "../tool.ts";
import { readRecord } from "./get-record.ts";

const NO_NAME = "Give a name to create a Space, or the id of the Space to update.";

const DESCRIPTION = `Creates or updates a Space: a room or area of a Property, such as the kitchen, the garage, or the exterior. A Space's size and what is on its surfaces are facts about the Space, kept in \`data\`: its paint, its flooring, its counters. They are not Items.

Give the Space's name, and \`property\` for the Property it is at. With no \`property\` it is the one Current property, and when there is not exactly one, the error lists the Properties to choose from. A Property has one Space for each name, whatever the name's case, which is ignored for the letters a to z. So without an id, the name says which Space it is: if the Property already has one by that name it is updated, and otherwise a new one is created. With an id, the Space with that id is updated, and a name is its new name. So to rename a Space, give its id and the new name. A Space does not move to another Property.

The other save tools create a Space on first use, when they name one that is not there yet. This tool is for a Space's facts, and for renaming one.

\`data\` is a merge patch, so a save adds to what is there. To record the wall paint, send \`{"paint": {"walls": {"brand": "Sherwin-Williams", "color": "Agreeable Gray", "code": "SW 7029", "sheen": "eggshell"}}}\`, and the size and the other surfaces stay as they are. Paint that is the same in every Space, such as the trim, goes on the Property with save_property. A Space shows it as \`from_property\`. A field that is left out, or sent as null, stays as it is.

What comes back is the id of the Change that recorded the save, the Space as created or updated, and the whole record as get_record returns it.`;

// The Space a save gives the id of, as it is now. `taken` is the name another Space at its
// Property already has, when that is the name the save asks for.
interface Existing {
  readonly name: string;
  readonly property_id: string;
  readonly property: string;
  readonly taken: string | null;
}

export const saveSpace = defineTool({
  name: "save_space",
  description: DESCRIPTION,
  input: Schema.Struct({
    id: optional(
      Schema.String.annotate({
        description:
          "The id of the Space to update. Leave it out to create a Space, or to update the one the Property already has by the name.",
      }),
    ),
    name: optional(
      nameText(
        "What the Space is called, such as Kitchen, Garage, or Exterior. A Property has one Space for each name, whatever its case. A new Space needs one.",
      ),
    ),
    property: optional(
      Schema.String.annotate({
        description:
          "The Property the Space is at, by its id or its name. Leave it out for the one Current property.",
      }),
    ),
    data: optional(
      dataPatch(
        "Facts about the Space: its size as sqft, and paint, flooring, and counters. Paint is an object keyed by surface: walls, trim, ceiling.",
      ),
    ),
  }),
  annotations: SAVE_ANNOTATIONS,
  run: ({ id, name, property: given, data }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // Without an id, the name says which Space this is. One the Property already has keeps
      // its name as it was first written, and takes the patch.
      const byName = Effect.gen(function* () {
        if (name === undefined) return yield* new ToolError({ message: NO_NAME });
        const property = yield* propertyFor(given);
        const space = yield* spaceNamed(property.id, name, data);
        const [created] = space.steps;
        return created ?? updateRow(sql, space, {}, data);
      });

      // With an id, a name is the Space's new name.
      const byId = Effect.fnUntraced(function* (id: string) {
        // The database compares the names, so case is ignored the same way it is everywhere else.
        const [space] = yield* sql<Existing>`
          SELECT space.name, space.property_id, property.name AS property,
                 (SELECT other.name FROM spaces AS other
                   WHERE other.property_id = space.property_id
                     AND other.name = ${name ?? null} AND other.id <> space.id) AS taken
            FROM spaces AS space
            JOIN properties AS property ON property.id = space.property_id
           WHERE space.id = ${id}`;
        if (space === undefined) {
          return yield* new ToolError({
            message: `There is no Space with the id "${id}". To save one by its name, leave the id out.`,
          });
        }
        if (given !== undefined) {
          const property = yield* propertyNamed(given);
          if (property.id !== space.property_id) {
            return yield* new ToolError({
              message: `The Space "${space.name}" is at ${space.property}, not at ${property.name}. A Space does not move to another Property.`,
            });
          }
        }
        if (space.taken !== null) {
          return yield* new ToolError({
            message: `Another Space at ${space.property} is already named "${space.taken}". A Property has one Space for each name, whatever its case.`,
          });
        }
        const renamed = { type: "space", id, name: name ?? space.name } as const;
        return updateRow(sql, renamed, name === undefined ? {} : { name }, data);
      });

      const step = yield* id === undefined ? byName : byId(id);
      return { ...(yield* runSave([step])), record: yield* readRecord("space", step.id) };
    }),
});
