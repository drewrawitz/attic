import { Effect, Schema, SchemaTransformation } from "effect";
import type { SqlClient } from "effect/sql";
import { SHAPES, type RecordShape, type RecordType } from "./records.ts";
import { ToolError, type ToolAnnotations } from "./tool.ts";
import { Write, type Step } from "./write.ts";

// The rules every tool that saves a record follows.

/**
 * A save is not read-only, and it is not destructive either. MCP has a client assume a tool
 * may destroy things unless it says otherwise, so a save says so, and is not taken for a delete.
 */
export const SAVE_ANNOTATIONS: ToolAnnotations = { readOnlyHint: false, destructiveHint: false };

// Text with something in it, once the spaces around it are dropped.
const filled = (description: string, whenEmpty: string) =>
  Schema.String.annotate({ description }).pipe(
    Schema.decodeTo(
      Schema.String.check(Schema.isNonEmpty({ message: whenEmpty })),
      SchemaTransformation.trim(),
    ),
  );

/**
 * A name or a title in a tool's input: text with something in it. The spaces around it are
 * dropped, so "Kitchen " is never a second Kitchen. It is given what the name is of.
 */
export const nameText = (description: string) =>
  filled(description, "Expected a name with something in it.");

/** The body of a Note in a tool's input: text with something in it. */
export const noteText = (description: string) =>
  filled(description, "Expected a Note with something in it.");

/**
 * A record's `data` in a tool's input: a JSON merge patch on what is stored. It is applied with
 * `json_patch`, and nothing in it is converted on the way in. It is given what the `data` of
 * this kind of record holds, and adds how a patch is applied.
 */
export const dataPatch = (description: string) =>
  Schema.Record(Schema.String, Schema.Unknown).annotate({
    description: `${description} It is a JSON merge patch on what is stored: keys merge, a key sent as null is removed, and a list is replaced whole. It is stored as written, so money inside it is integer cents under a key ending in _cents. Use the well-known keys that get_schema lists.`,
  });

/**
 * The columns a save sets: each field that was given, and null for each field named in
 * `clear`. A field that was left out is in neither, so it is left alone. A field cannot be in
 * both.
 */
export const columnsToSet = (
  given: Readonly<Record<string, unknown>>,
  clear: ReadonlyArray<string> = [],
): Effect.Effect<Readonly<Record<string, unknown>>, ToolError> => {
  const both = clear.filter((field) => Object.hasOwn(given, field));
  if (both.length > 0) {
    return Effect.fail(
      new ToolError({
        message: `A field is given a value or cleared, not both in one call. Both were asked for: ${both.join(", ")}.`,
      }),
    );
  }
  return Effect.succeed({ ...given, ...Object.fromEntries(clear.map((field) => [field, null])) });
};

// The columns the statements below write themselves, which a save never sets by name.
const WRITTEN_HERE = new Set(["id", "data", "created_at", "updated_at"]);

// The names of the columns a statement sets, which go into its SQL as they are. One that is
// not a column a save can set stops here. The MCP layer hands a tool only the fields its input
// declares, so a name that gets this far is a mistake in a tool, and never text from a client.
const namesOf = (shape: RecordShape, columns: Readonly<Record<string, unknown>>) => {
  const names = Object.keys(columns);
  const unknown = names.filter((name) => !shape.columns.includes(name) || WRITTEN_HERE.has(name));
  if (unknown.length > 0) {
    throw new Error(`${shape.table} has no column to set named ${unknown.join(" or ")}.`);
  }
  return names;
};

/** A record as a save's reply names it. */
export interface Named {
  readonly type: RecordType;
  readonly id: string;
  /** Its name, or what stands for one: the title of Work, the body of a Note. */
  readonly name: string;
}

/**
 * One step of a save: a statement, and the record it creates or updates, as the reply names
 * it. A save hands one list of these to its write and to its reply. So a record the call wrote
 * is in its Change and in what comes back, and never in only one of them.
 */
export interface SaveStep extends Step, Named {
  readonly created: boolean;
}

/**
 * A record a save names, which is created on first use when it is not there yet: a Space or a
 * Vendor. `steps` is what creates it, and is empty when it was there already. The caller puts
 * them in its batch, which puts the new record in the caller's Change and in its reply. A
 * misspelled name makes a new record, and the reply is where a client sees that it did. A
 * caller that names the same record more than once in a call asks for it once: every ask that
 * finds none hands back an INSERT, and the database takes only one.
 */
export interface Referred extends Named {
  readonly steps: ReadonlyArray<SaveStep>;
}

/**
 * The step that creates a record's row: its id, the columns that were given, and `data`. A
 * column that was not given gets the table's own default. `data` goes in as a merge patch on
 * an empty object, so a key sent as null is left out the same way it is on an update.
 */
export const insertRow = (
  sql: SqlClient.SqlClient,
  record: Named,
  columns: Readonly<Record<string, unknown>>,
  data: object = {},
): SaveStep => {
  const shape: RecordShape = SHAPES[record.type];
  const names = ["id", ...namesOf(shape, columns)];
  const statement = sql.unsafe(
    `INSERT INTO ${shape.table} (${names.join(", ")}, data)
     VALUES (${names.map(() => "?").join(", ")}, json_patch('{}', ?))`,
    [record.id, ...Object.values(columns), JSON.stringify(data)],
  );
  return { ...record, created: true, statement };
};

// The time now, the way every timestamp is stored.
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/**
 * The step that updates a record's row: the columns that were given, and `data` with the merge
 * patch applied. A column that is not among them is left alone. A table that keeps
 * `updated_at` gets the time now.
 */
export const updateRow = (
  sql: SqlClient.SqlClient,
  record: Named,
  columns: Readonly<Record<string, unknown>>,
  data: object = {},
): SaveStep => {
  const shape: RecordShape = SHAPES[record.type];
  const sets = [
    ...namesOf(shape, columns).map((column) => `${column} = ?`),
    "data = json_patch(data, ?)",
    ...(shape.columns.includes("updated_at") ? [`updated_at = ${NOW}`] : []),
  ];
  const statement = sql.unsafe(`UPDATE ${shape.table} SET ${sets.join(", ")} WHERE id = ?`, [
    ...Object.values(columns),
    JSON.stringify(data),
    record.id,
  ]);
  return { ...record, created: false, statement };
};

/**
 * Runs the steps of a save as the one write of its call. Returns what every save sends back:
 * the id of its Change, and every record it created or updated, by type, id, and name. A call
 * that saves one record adds that record to this, as get_record returns it.
 */
export const runSave = Effect.fnUntraced(function* (steps: ReadonlyArray<SaveStep>) {
  const write = yield* Write;
  const change = yield* write.run(steps);
  const those = (created: boolean) =>
    steps
      .filter((step) => step.created === created)
      .map(({ type, id, name }) => ({ type, id, name }));
  return { change_id: change, created: those(true), updated: those(false) };
});
