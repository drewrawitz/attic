import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { partialDate, today } from "../dates.ts";
import { noteOn } from "../note.ts";
import { PROJECT_STATUSES, projectWith, type ProjectStatus } from "../project.ts";
import { propertyFor, refuseAnotherProperty } from "../property.ts";
import {
  dataPatch,
  definedColumns,
  insertRow,
  nameText,
  noteText,
  refuseGivenAndCleared,
  replaceLinks,
  runSave,
  SAVE_ANNOTATIONS,
  updateRow,
  valueOrCleared,
} from "../save.ts";
import { spaceOrNewOnce } from "../space.ts";
import { defineTool, optional, ToolError } from "../tool.ts";
import { Ids } from "../write.ts";
import { readRecord } from "./get-record.ts";

const NO_TITLE = "Give a title to create a Project, or the id of the Project to update.";

const DESCRIPTION = `Creates or updates a Project: a folder for an effort on a Property that is still being planned, or that takes more than one piece of Work, such as outdoor lighting or a kitchen remodel. It gathers the Quotes, the Notes, and the Documents of the effort, and stays as the story behind the Work once it is done or dropped.

A Project is not Work. Work is something already done, and is logged with log_work, which takes the id of the Project it is part of. What a Vendor said the Project would cost is a Quote, saved with save_quote.

With an id, the Project with that id is updated. Without one, a new Project is created, which needs a title. Two Projects can have the same title, so a title never says which one a save is about: find the Project with search first, and update it by its id. A field that is left out, or sent as null, stays as it is. To empty a field, name it in \`clear\`.

With no \`property\`, a new Project is at the one Current property, and when there is not exactly one, the error lists the Properties to choose from. A Project is at one Property and does not move to another. Its Work and its Spaces are there.

\`spaces\` are the names of the Spaces the Project covers. The list replaces the whole set, and an empty list empties it. Each is a Space at the Project's Property, matched whatever its case, and one that is not there yet is created, and listed in the reply. So check the reply for a Space you did not mean to make.

\`status\` is open, done, or dropped. A new Project is open. Closing a Project is a save that takes it from open to done or dropped, and its \`end_on\` is then today, unless the save gives one. So give \`end_on\` for a Project that was finished or dropped on an earlier day. Nothing moves or is copied: the Quotes, the Notes, and the Work stay on the Project, and a dropped Project keeps its Quotes for next time. To open a Project again, give \`status\` as open and name end_on in \`clear\`.

\`data\` is a merge patch, so a save adds to what is there. What the Project is for goes in \`data.goal\`.

\`note\` adds a Note to the Project in the same Change. Each one given is a new Note, and none replaces an earlier one.

What comes back is the id of the Change that recorded the save, and every record it created or updated: the Project, any Space made on first use, and the Note. It also has the whole Project as get_record returns it.`;

// The status a new Project has unless the save gives one, which is the table's own default.
const OPEN: ProjectStatus = "open";

// The fields a save can empty. A Project always has a Property, a title, and a status. Its
// Spaces are a set, and a set is emptied with an empty list.
const CLEARABLE = ["start_on", "end_on"] as const;

export const saveProject = defineTool({
  name: "save_project",
  description: DESCRIPTION,
  input: Schema.Struct({
    id: optional(
      Schema.String.annotate({
        description:
          "The id of the Project to update, as search or get_record gives it. Leave it out to create a Project.",
      }),
    ),
    title: optional(
      nameText(
        "What the Project is called, such as Outdoor lighting or Kitchen remodel. A new Project needs one. Two Projects can have the same title.",
      ),
    ),
    property: optional(
      nameText(
        "The Property the Project is at, by its id or its name. Left out, a new Project is at the one Current property. A Project does not move to another Property.",
      ),
    ),
    status: optional(
      Schema.Literals(PROJECT_STATUSES).annotate({
        description:
          "open for a Project that is still being planned or worked on, done for one that is finished, and dropped for one that was given up. A new Project is open.",
      }),
    ),
    start_on: optional(partialDate("When the Project began.")),
    end_on: optional(
      partialDate(
        "When the Project was finished or dropped. Left out on the save that closes the Project, it is today.",
      ),
    ),
    spaces: optional(
      Schema.Array(nameText("The name of one Space, such as Kitchen.")).annotate({
        description:
          "The Spaces the Project covers, by name. Each is a Space at the Project's Property, and is created there if it is not there yet. The list replaces the whole set, and an empty list removes them all.",
      }),
    ),
    data: optional(dataPatch("Facts about the Project, such as goal.")),
    note: optional(noteText("A Note to add to the Project. It is a new Note each time.")),
    clear: optional(
      Schema.Array(Schema.Literals(CLEARABLE)).annotate({
        description:
          "Fields to empty. A field cannot be given a value and cleared in the same call. A Project always has a Property, a title, and a status, so those cannot be cleared. spaces is emptied with an empty list.",
      }),
    ),
  }),
  annotations: SAVE_ANNOTATIONS,
  run: (given) =>
    Effect.gen(function* () {
      const { id, title, status, data, note, clear = [] } = given;
      const sql = yield* SqlClient.SqlClient;
      yield* refuseGivenAndCleared(given, clear);
      const wanted = valueOrCleared(clear);

      const was = id === undefined ? undefined : yield* projectWith(id);
      const called = title ?? was?.title;
      if (called === undefined) return yield* new ToolError({ message: NO_TITLE });

      // A new Project is at the Property the save names, or at the one Current property. One
      // that is there already stays where it is, so a Property given beside it can only agree.
      const property =
        was === undefined
          ? yield* propertyFor(given.property)
          : { id: was.property_id, name: was.property };
      if (was !== undefined) {
        yield* refuseAnotherProperty(given.property, { type: "project", name: was.title, ...was });
      }

      // A Space is one at a Property, so the Spaces a save names are ones at the Project's. A
      // Space that is named twice, in whatever case, is asked for once.
      const spaceOnce = spaceOrNewOnce();
      const spaces =
        given.spaces === undefined
          ? undefined
          : yield* Effect.forEach(given.spaces, (name) => spaceOnce(property.id, name));

      // Closing a Project takes it from open to done or dropped. A new Project starts out open,
      // so one that is saved as done has been closed. Its end is the day the save gives, or
      // today. A Project that is closed already keeps the end it has.
      const closing = status !== undefined && status !== OPEN && (was?.status ?? OPEN) === OPEN;
      const endOn = wanted("end_on", given.end_on ?? (closing ? yield* today : undefined));

      const project = {
        type: "project",
        id: id ?? (yield* (yield* Ids).next),
        name: called,
      } as const;
      const columns = definedColumns({
        property_id: was === undefined ? property.id : undefined,
        title,
        status,
        start_on: wanted("start_on", given.start_on),
        end_on: endOn,
      });
      const row =
        was === undefined
          ? insertRow(sql, project, columns, data)
          : updateRow(sql, project, columns, data);
      // The list replaces the whole set. One that is left out leaves the set as it is.
      const links =
        spaces === undefined
          ? []
          : replaceLinks(sql, row, "spaces", [...new Set(spaces.map((each) => each.id))]);

      const steps = [
        ...(spaces ?? []).flatMap((each) => each.steps),
        row,
        ...links,
        // A Note on a record takes that record's Property.
        ...(yield* noteOn(note, property.id, project)),
      ];
      return { ...(yield* runSave(steps)), record: yield* readRecord("project", project.id) };
    }),
});
