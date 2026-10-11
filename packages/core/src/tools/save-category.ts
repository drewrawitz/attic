import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { categoryAmong, closestTo, everyCategory, isUnder } from "../category.ts";
import { formatRow } from "../output.ts";
import {
  columnsToSet,
  dataPatch,
  insertRow,
  nameText,
  runSave,
  SAVE_ANNOTATIONS,
  updateRow,
} from "../save.ts";
import { defineTool, optional, ToolError } from "../tool.ts";

const DESCRIPTION = `Creates or updates a Category: a named group of Items, from one shared list that nests, such as power-tools under tools. Every Item has one primary Category and may have extra ones. A Category must exist before an Item is filed under it, and this is the only tool that makes one. Reuse the list before adding to it: call get_schema to see it. That is what keeps fitness from splitting into fitness, gym, and exercise.

A Category's id is a slug the caller chooses, such as \`power-tools\`, and it never changes. A save under an id that exists updates that Category, and otherwise a new one is created, which needs a name.

\`parent\` is the id of the Category this one sits under. One that is not there is an error that lists the closest matches. A parent that would make a loop is refused. To move a Category to the top level, name \`parent\` in \`clear\`.

\`data.expects\` is the list of \`data\` keys an Item in this Category should have, such as ["brand", "model", "serial"]. An Item is expected to have the keys of every Category it sits under, parents included, so a child only lists what it adds. The list is replaced whole by a save that gives it.

A field that is left out, or sent as null, stays as it is. What comes back is the id of the Change that recorded the save, and the Category as created or updated, with its parent. get_schema shows where it sits in the whole tree.`;

// The `data` keys a Category expects are names. Nothing else checks what is stored under
// `expects`, and get_schema reads anything but a list of names as no list at all.
const isListOfNames = (data: Readonly<Record<string, unknown>>) => {
  const { expects } = data;
  return (
    expects === undefined ||
    expects === null ||
    (Array.isArray(expects) && expects.every((key) => typeof key === "string" && key.trim() !== ""))
  );
};

// The Category a save wrote, as the reply shows it, with its parent's name.
interface Row {
  readonly id: string;
  readonly name: string;
  readonly parent_id: string | null;
  readonly parent: string | null;
  readonly data: string;
}

export const saveCategory = defineTool({
  name: "save_category",
  description: DESCRIPTION,
  input: Schema.Struct({
    id: Schema.String.annotate({
      description:
        "The Category's id: a slug of lowercase letters, digits, and hyphens, such as power-tools. A save under an id that exists updates that Category.",
    }).check(
      Schema.isPattern(/^[a-z0-9-]+$/, {
        message:
          "Expected a slug for the id: lowercase letters, digits, and hyphens, such as power-tools.",
      }),
    ),
    name: optional(
      nameText("What the Category is called, such as Power tools. A new Category needs one."),
    ),
    parent: optional(
      Schema.String.annotate({
        description:
          "The id of the Category this one sits under, such as tools. Leave it out for a new top-level Category.",
      }),
    ),
    data: optional(
      dataPatch(
        "Facts about the Category. `expects` is the list of `data` keys an Item in it should have.",
        { keyList: false },
      ).check(
        Schema.makeFilter(isListOfNames, {
          message:
            'Expected that data.expects is a list of `data` key names, such as ["brand", "model"], or null to remove it.',
        }),
      ),
    ),
    clear: optional(
      Schema.Array(Schema.Literal("parent")).annotate({
        description:
          "Fields to empty. Clearing the parent moves the Category to the top level. A field cannot be given a value and cleared in the same call. A Category always has a name, so it cannot be cleared.",
      }),
    ),
  }),
  annotations: SAVE_ANNOTATIONS,
  run: ({ id, data, clear, ...given }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { parent, ...others } = yield* columnsToSet(given, clear);
      // The parent is given by the name the tool has for it, and stored under the column's.
      const columns = parent === undefined ? others : { ...others, parent_id: parent };

      const categories = yield* everyCategory;
      const existing = categories.find((category) => category.id === id);

      if (typeof parent === "string") {
        if (parent === id) {
          return yield* new ToolError({ message: `A Category cannot be its own parent: "${id}".` });
        }
        yield* categoryAmong(parent, categories);
        if (isUnder(parent, id, categories)) {
          return yield* new ToolError({
            message: `"${parent}" is under "${id}" already, so "${id}" cannot go under it. That would make a loop.`,
          });
        }
      }

      const name = given.name ?? existing?.name;
      if (name === undefined) {
        return yield* new ToolError({
          message: `There is no Category "${id}" to update, and a new Category needs a name. ${closestTo(id, categories)}`,
        });
      }
      const category = { type: "category", id, name } as const;
      const step =
        existing === undefined
          ? insertRow(sql, category, columns, data)
          : updateRow(sql, category, columns, data);
      const reply = yield* runSave([step]);

      // A Category is not a type get_record takes, so the reply shows it as it was stored.
      const [row] = yield* sql<Row>`
        SELECT category.id, category.name, category.parent_id, parent.name AS parent, category.data
          FROM categories AS category
          LEFT JOIN categories AS parent ON parent.id = category.parent_id
         WHERE category.id = ${id}`;
      return { ...reply, record: formatRow({ type: "category", ...row }) };
    }),
});
