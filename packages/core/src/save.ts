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

/**
 * A name as the database compares it: the letters A to Z in lowercase, and every other
 * character as it is. Two names with the same key are one name to a column that ignores case.
 */
export const nameKey = (name: string) => name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

/** The body of a Note in a tool's input: text with something in it. */
export const noteText = (description: string) =>
  filled(description, "Expected a Note with something in it.");

/**
 * A record's `data` in a tool's input: a JSON merge patch on what is stored. It is applied with
 * `json_patch`, and nothing in it is converted on the way in. It is given what the `data` of
 * this kind of record holds, and adds how a patch is applied. It points at the well-known keys
 * get_schema lists, so a tool that takes `data` for a kind of record adds a list for it there.
 */
export const dataPatch = (description: string) =>
  Schema.Record(Schema.String, Schema.Unknown).annotate({
    description: `${description} It is a JSON merge patch on what is stored: keys merge, a key sent as null is removed, and a list is replaced whole. It is stored as written, so money inside it is integer cents under a key ending in _cents. Use the well-known keys that get_schema lists.`,
  });

/**
 * Refuses a save that gives a field a value and names it in `clear` as well. `given` has a key
 * for each field that was given, and none for one that was left out.
 */
export const givenOrCleared = (
  given: Readonly<Record<string, unknown>>,
  clear: ReadonlyArray<string> = [],
): Effect.Effect<void, ToolError> => {
  const both = clear.filter((field) => Object.hasOwn(given, field));
  return both.length === 0
    ? Effect.void
    : Effect.fail(
        new ToolError({
          message: `A field is given a value or cleared, not both in one call. Both were asked for: ${both.join(", ")}.`,
        }),
      );
};

/**
 * The columns a save sets: each field that was given, and null for each field named in
 * `clear`. A field that was left out is in neither, so it is left alone. A field cannot be in
 * both.
 */
export const columnsToSet = (
  given: Readonly<Record<string, unknown>>,
  clear: ReadonlyArray<string> = [],
): Effect.Effect<Readonly<Record<string, unknown>>, ToolError> =>
  Effect.as(givenOrCleared(given, clear), {
    ...given,
    ...Object.fromEntries(clear.map((field) => [field, null])),
  });

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

/** A record as a save's reply lists it: by its type, its id, and its name. */
export interface Listed {
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
export interface SaveStep extends Step, Listed {
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
export interface Referred extends Listed {
  readonly steps: ReadonlyArray<SaveStep>;
}

/**
 * Asks for each thing once in a call, however many entries of a list ask for it. `keyOf` says
 * what an ask is for, and two asks with the same key get the one answer. A refusal is an
 * answer too, and comes back to every entry that asks.
 */
export const askedOnce = <Asked extends ReadonlyArray<unknown>, Answer, Refusal, Needs>(
  ask: (...asked: Asked) => Effect.Effect<Answer, Refusal, Needs>,
  keyOf: (...asked: Asked) => string,
) => {
  const answers = new Map<string, Effect.Effect<Answer, Refusal, Needs>>();
  return Effect.fnUntraced(function* (...asked: Asked) {
    const key = keyOf(...asked);
    let answer = answers.get(key);
    if (answer === undefined) {
      answer = yield* Effect.cached(ask(...asked));
      answers.set(key, answer);
    }
    return yield* answer;
  });
};

/**
 * The same for a record that is created on first use. The steps that create it go to the first
 * entry that names it, and each later one gets the record with no steps. So a list that names
 * a new Space in every entry has one INSERT for it in its batch.
 */
export const referredOnce = <Asked extends ReadonlyArray<unknown>, Refusal, Needs>(
  refer: (...asked: Asked) => Effect.Effect<Referred, Refusal, Needs>,
  keyOf: (...asked: Asked) => string,
) => {
  const once = askedOnce(refer, keyOf);
  const handedOver = new Set<string>();
  return (...asked: Asked) =>
    Effect.map(once(...asked), (referred): Referred => {
      const key = keyOf(...asked);
      if (handedOver.has(key)) return { ...referred, steps: [] };
      handedOver.add(key);
      return referred;
    });
};

/**
 * The step that creates a record's row: its id, the columns that were given, and `data`. A
 * column that was not given gets the table's own default. `data` goes in as a merge patch on
 * an empty object, so a key sent as null is left out the same way it is on an update.
 */
export const insertRow = (
  sql: SqlClient.SqlClient,
  record: Listed,
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
  record: Listed,
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
 * The steps that replace one of a record's link sets with the ids given: the set is emptied,
 * and then filled. `step` is the step that writes the record's own row, and these go after it
 * in the batch. They are about the same record, so its Change has the set before and after. A
 * record the step creates has no set to empty yet.
 */
export const replaceLinks = (
  sql: SqlClient.SqlClient,
  step: SaveStep,
  name: string,
  ids: ReadonlyArray<string>,
): ReadonlyArray<SaveStep> => {
  const shape: RecordShape = SHAPES[step.type];
  const set = shape.links.find((link) => link.name === name);
  if (set === undefined) throw new Error(`${shape.table} has no link set named ${name}.`);

  const emptying = sql.unsafe(`DELETE FROM ${set.table} WHERE ${set.from} = ?`, [step.id]);
  const filling = sql.unsafe(
    `INSERT INTO ${set.table} (${set.from}, ${set.to}) SELECT ?, value FROM json_each(?)`,
    [step.id, JSON.stringify(ids)],
  );
  return [...(step.created ? [] : [emptying]), ...(ids.length === 0 ? [] : [filling])].map(
    (statement) => ({ ...step, statement }),
  );
};

/**
 * Runs the steps of a save as the one write of its call. Returns what every save sends back:
 * the id of its Change, and every record it created or updated, by type, id, and name. A
 * record that took several steps is listed once. A call that saves one record adds that
 * record to this, as get_record returns it.
 */
export const runSave = Effect.fnUntraced(function* (steps: ReadonlyArray<SaveStep>) {
  const write = yield* Write;
  const change = yield* write.run(steps);
  const seen = new Set<string>();
  const records = steps.filter(({ type, id }) => {
    const record = `${type} ${id}`;
    return !seen.has(record) && seen.add(record) !== undefined;
  });
  const those = (created: boolean) =>
    records
      .filter((step) => step.created === created)
      .map(({ type, id, name }) => ({ type, id, name }));
  return { change_id: change, created: those(true), updated: those(false) };
});
