import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { opening } from "../note.ts";
import {
  RECORD_TYPES,
  SHAPES,
  type LinkSet,
  type RecordShape,
  type RecordType,
} from "../records.ts";
import type { Listed } from "../save.ts";
import { jsonObject } from "../sql.ts";
import { defineTool, ToolError, type ToolAnnotations } from "../tool.ts";
import { Write, type Step } from "../write.ts";
import { term } from "./get-record.ts";

const DESCRIPTION = `Undoes a Change, so that every record the Change touched is as it was before. A Change is one write made through a tool. Every tool that writes returns the id of its Change as \`change_id\`, and get_record lists a record's latest Changes, newest first, each with its id and the record as it was before and after. The rest are in the \`changes\` and \`change_records\` tables, which query reads.

What an undo does to a record depends on what the Change did to it. A record the Change created is taken out. A record it updated is restored: every field as it was, with \`data\` and the sets it holds, such as an Item's extra Categories or the Items and Spaces of Work. A record it deleted is put back under the id it had. A save that made a Space or a Vendor on first use, or wrote a Note, did that in the same Change, so undoing the save takes those out too. A Change is undone whole or not at all.

An undo is refused, and nothing is written, when it would lose something:
- A record the Change touched has been changed again since. The error lists the later Changes, newest first. Undo those first, in that order, and then this one.
- The Change was undone already. The error says which Change undid it.
- A record it would take out is in use, because another record points at it now: an Item bought from a Vendor the Change made, or a Note added to an Item it created. The error names what uses it. Point those records elsewhere first, or undo the Changes that made them use it.
- A record it would bring back pointed at one that is not there now, such as an Item whose Vendor was taken out by another undo. The error says which record is missing and which Change took it out. Undo that Change first.
- A record it would bring back had a name that another record has taken since, where no two can share one: a Property, a Vendor, or a Space at its Property. The error names both. Rename the other record first, or undo the Change that made it.

An undo is a Change too, so it can be undone, and then the records are as the first Change left them. Changes are kept forever, and undoing one does not remove it.

No tool deletes a Property. Undoing the Change that created one takes it out, while nothing is at it.

What comes back is the id of the undo's own Change, and what was \`taken_out\`, \`restored\`, and \`put_back\`, each by type, id, and name.`;

// An undo is not read-only, and it is not marked destructive either: what it takes out is
// there again once the undo is undone. `destructiveHint` is kept for `delete_record`. Both are said out loud
// for the reason `SAVE_ANNOTATIONS` gives.
const ANNOTATIONS: ToolAnnotations = { readOnlyHint: false, destructiveHint: false };

// What undoing a Change does to a record it touched. One the Change created is taken out, one
// it updated is restored, and one it deleted is put back.
type Outcome = "taken_out" | "restored" | "put_back";

// How a Change's two snapshots of a record tell the three apart: `before` is null for a record
// the Change created, and `after` is null for one it deleted. A statement below reads the rows
// the Change to undo has in `change_records` as `touched`.
const OUTCOME_IF: Readonly<Record<Outcome, string>> = {
  taken_out: "touched.before IS NULL",
  restored: "touched.before IS NOT NULL AND touched.after IS NOT NULL",
  put_back: "touched.after IS NULL",
};

const ANY_OUTCOME: ReadonlyArray<Outcome> = ["taken_out", "restored", "put_back"];

// The records an undo brings back: the ones it restores, and the ones it puts back.
const BROUGHT_BACK: ReadonlyArray<Outcome> = ["restored", "put_back"];

// Which rows of `change_records` a statement is about: the records of the Change `?1` of one
// type that an undo does one of these things to.
const matching = (type: RecordType, outcomes: ReadonlyArray<Outcome>) =>
  `touched.change_id = ?1 AND touched.entity_type = '${type}'
   AND (${outcomes.map((outcome) => OUTCOME_IF[outcome]).join(" OR ")})`;

// The same, as the SQL of a list of their ids.
const ids = (type: RecordType, outcomes: ReadonlyArray<Outcome>) =>
  `(SELECT touched.entity_id FROM change_records AS touched WHERE ${matching(type, outcomes)})`;

// A column of a record as it was before the Change. `data` comes out as the text of its
// object, which is what the column holds.
const before = (column: string) => `json_extract(touched.before, '$.${column}')`;

// The rows of a SELECT as one JSON column: a list with an object for each row, which has these
// fields, each read from the column of that name.
const list = (fields: ReadonlyArray<string>, select: string) =>
  `(SELECT json_group_array(${jsonObject(fields.map((field) => [field, field]))})
      FROM (${select}))`;

// One statement of an undo, as SQL. It is about every record of one type that the undo does
// one of these things to, and reads them from the Change itself. So an undo is the same few
// statements however many records the Change touched. A statement that touches several rows is
// also held to the foreign keys only once it is done, so the rows of one type go out and come
// back in no particular order: a Category with the one it is under.
interface Reversal {
  readonly type: RecordType;
  readonly outcomes: ReadonlyArray<Outcome>;
  readonly text: string;
}

// Empties a link set of every record of a type. One that is taken out has no use for it, and
// the others get theirs back from `before`.
const unlinking = (type: RecordType, { table, from }: LinkSet): Reversal => ({
  type,
  outcomes: ANY_OUTCOME,
  text: `DELETE FROM ${table} WHERE ${from} IN ${ids(type, ANY_OUTCOME)}`,
});

// Puts back the row of each record the Change deleted: every column as it was.
const puttingBack = (type: RecordType, { table, columns }: RecordShape): Reversal => ({
  type,
  outcomes: ["put_back"],
  text: `INSERT INTO ${table} (${columns.join(", ")})
         SELECT ${columns.map(before).join(", ")}
           FROM change_records AS touched
          WHERE ${matching(type, ["put_back"])}`,
});

// Restores the row of each record the Change updated: every column as it was.
const restoring = (type: RecordType, { table, columns }: RecordShape): Reversal => ({
  type,
  outcomes: ["restored"],
  text: `UPDATE ${table}
            SET ${columns
              .filter((column) => column !== "id")
              .map((column) => `${column} = ${before(column)}`)
              .join(", ")}
           FROM change_records AS touched
          WHERE ${matching(type, ["restored"])} AND ${table}.id = touched.entity_id`,
});

// Fills a link set of each record the undo brings back, from the list of ids in `before`.
const relinking = (type: RecordType, { name, table, from, to }: LinkSet): Reversal => ({
  type,
  outcomes: BROUGHT_BACK,
  text: `INSERT INTO ${table} (${from}, ${to})
         SELECT touched.entity_id, linked.value
           FROM change_records AS touched, json_each(touched.before, '$.${name}') AS linked
          WHERE ${matching(type, BROUGHT_BACK)}`,
});

// Takes out the row of each record the Change created.
const takingOut = (type: RecordType, { table }: RecordShape): Reversal => ({
  type,
  outcomes: ["taken_out"],
  text: `DELETE FROM ${table} WHERE id IN ${ids(type, ["taken_out"])}`,
});

// Each type with what a record of it is, a type after the types it points at.
const EACH_TYPE = RECORD_TYPES.map((type): [RecordType, RecordShape] => [type, SHAPES[type]]);

// Every statement an undo can have, in the order the foreign keys allow. Rows come back with a
// type after the types it points at, and go out in the other order. A row is restored once the
// rows it pointed at are back, and before the rows it no longer points at go out.
const REVERSALS: ReadonlyArray<Reversal> = [
  ...EACH_TYPE.flatMap(([type, shape]) => shape.links.map((set) => unlinking(type, set))),
  ...EACH_TYPE.map(([type, shape]) => puttingBack(type, shape)),
  ...EACH_TYPE.map(([type, shape]) => restoring(type, shape)),
  ...EACH_TYPE.flatMap(([type, shape]) => shape.links.map((set) => relinking(type, set))),
  ...EACH_TYPE.toReversed().map(([type, shape]) => takingOut(type, shape)),
];

// A record a Change touched, with what undoing the Change does to it.
interface Touched extends Listed {
  readonly outcome: Outcome;
}

// The ones among them of one type that an undo does one of these things to.
const pick = (
  touched: ReadonlyArray<Touched>,
  type: RecordType,
  outcomes: ReadonlyArray<Outcome>,
) => touched.filter((record) => record.type === type && outcomes.includes(record.outcome));

// Where a snapshot has what a record of each type is named by.
const NAMED_AT = `CASE touched.entity_type ${EACH_TYPE.map(([type, { namedBy }]) => `WHEN '${type}' THEN '$.${namedBy}'`).join(" ")} END`;

// The records the Change touched, by type and then by id. A record is named as it is once the
// undo is done, and one that is taken out as it was.
const TOUCHED = `
  SELECT touched.entity_type AS type, touched.entity_id AS id,
         json_extract(coalesce(touched.before, touched.after), ${NAMED_AT}) AS name,
         CASE WHEN ${OUTCOME_IF.taken_out} THEN 'taken_out'
              WHEN ${OUTCOME_IF.put_back} THEN 'put_back'
              ELSE 'restored' END AS outcome
    FROM change_records AS touched
   WHERE touched.change_id = undone.id
   ORDER BY touched.entity_type, touched.entity_id`;

// A Change made after the one to undo, which touched a record that one touched.
interface Later {
  readonly id: string;
  readonly tool: string;
  readonly created_at: string;
  /** The id of the Change it undid, when it is an undo. */
  readonly undoes: string | null;
}

// Every such Change, newest first, in the order get_record lists a record's Changes.
const LATER = `
  SELECT DISTINCT later.id, later.tool, later.created_at, later.undoes
    FROM change_records AS mine
    JOIN change_records AS theirs
      ON theirs.entity_type = mine.entity_type AND theirs.entity_id = mine.entity_id
    JOIN changes AS later ON later.id = theirs.change_id
   WHERE mine.change_id = undone.id
     AND (later.created_at, later.id) > (undone.created_at, undone.id)
   ORDER BY later.created_at DESC, later.id DESC`;

// What an undo reads of the Change `?1` first, in one statement: one row, or none when there
// is no such Change.
const CHANGE = `
  SELECT ${list(["type", "id", "name", "outcome"], TOUCHED)} AS touched,
         ${list(["id", "tool", "created_at", "undoes"], LATER)} AS later
    FROM changes AS undone
   WHERE undone.id = ?1`;

/**
 * The later Changes that still stand between a Change and its undo, newest first. `later` has
 * every later Change that touched its records, newest first. An undo and the Change it undid
 * leave the records as they were before the two, so where both are among these, neither
 * stands. Any other undo stands as any other Change does: the undo of an older Change took a
 * record to an earlier time, and the undo of the very Change to undo means that one is undone
 * already.
 */
const laterStanding = (later: ReadonlyArray<Later>) => {
  const madeLater = new Set(later.map(({ id }) => id));
  const undoneSince = new Set<string>();
  return later.filter(({ id, undoes }) => {
    if (undoneSince.has(id)) return false;
    if (undoes === null || !madeLater.has(undoes)) return true;
    undoneSince.add(undoes);
    return false;
  });
};

// Refuses an undo that would write over what was done since.
const refuseChangedSince = (undone: string, later: ReadonlyArray<Later>) => {
  const [newest, ...older] = laterStanding(later);
  if (newest === undefined) return Effect.void;
  if (newest.undoes === undone && older.length === 0) {
    return Effect.fail(
      new ToolError({
        message: `Nothing was undone, because the Change "${undone}" was undone already, by the Change "${newest.id}". Undoing "${newest.id}" leaves the records as "${undone}" left them.`,
      }),
    );
  }
  const lines = [newest, ...older].map(
    ({ id, tool, created_at, undoes }) =>
      `"${id}", made by ${tool} at ${created_at}${undoes === null ? "" : `, which undid "${undoes}"`}`,
  );
  return Effect.fail(
    new ToolError({
      message: `Nothing was undone, because records the Change "${undone}" touched have been changed again since, and undoing it would write over that. Undo the later Changes first, newest first:\n${lines.join("\n")}`,
    }),
  );
};

// One read an undo makes before it writes: a SELECT as SQL, and the fields of its rows.
interface Read {
  readonly text: string;
  readonly fields: ReadonlyArray<string>;
}

// A record that points at another, as a read finds it, with the type and the id of the one it
// points at.
interface Pointer extends Listed {
  readonly target_type: RecordType;
  readonly target: string;
  /** Of a target that is not there: the id of the Change that took it out, when one did. */
  readonly removed_by: string | null;
}

const POINTER = ["type", "id", "name", "target_type", "target", "removed_by"];

// One way a record of a type can point at a record of another: by a column of its row, by a
// link set, or by being attached to it. An undo must leave none of them pointing at nothing,
// so each comes with a read for each side of that.
interface Way {
  /** The type that points, and the type it points at. */
  readonly type: RecordType;
  readonly targetType: RecordType;
  /**
   * The records that point this way at a record the undo takes out. A record of the Change
   * itself is not one of them: the undo takes it out too, or restores it to a time before
   * there was anything here to point at.
   */
  readonly inUse: Read;
  /**
   * The records the undo brings back that pointed this way at a record that is not there now,
   * and that the undo does not put back either.
   */
  readonly missing: Read;
}

// One way of pointing, as the SQL to read it two times over: among the rows there are now,
// each read as `record`, and among the Change's snapshots of its records as they were.
interface WayInSql {
  /** What a read of the rows selects FROM, and the id a row points at. */
  readonly rowsFrom: string;
  readonly rowTarget: string;
  /** What a read of the snapshots selects FROM, and the id a snapshot pointed at. */
  readonly snapshotsFrom: string;
  readonly snapshotTarget: string;
  /** What else has to hold of a row, and of a snapshot, when not every one points this way. */
  readonly rowIf?: string;
  readonly snapshotIf?: string;
}

const WAYS: ReadonlyArray<Way> = EACH_TYPE.flatMap(([type, shape]) => {
  const { table, namedBy, links, pointsAt, attachedBy } = shape;
  const way = (targetType: RecordType, inSql: WayInSql): Way => {
    const { rowsFrom, rowTarget, snapshotsFrom, snapshotTarget } = inSql;
    const { rowIf = "", snapshotIf = "" } = inSql;
    const inUse = `
      SELECT '${type}' AS type, record.id, record.${namedBy} AS name,
             '${targetType}' AS target_type, ${rowTarget} AS target, NULL AS removed_by
        FROM ${rowsFrom}
       WHERE ${rowIf} ${rowTarget} IN ${ids(targetType, ["taken_out"])}
         AND record.id NOT IN ${ids(type, ANY_OUTCOME)}
       ORDER BY record.id`;
    // An empty pointer is no pointer, and `NOT IN` alone would let one through. Ids sort by
    // when they were made, so the greatest is the latest Change that took the record out.
    const missing = `
      SELECT '${type}' AS type, touched.entity_id AS id, ${before(namedBy)} AS name,
             '${targetType}' AS target_type, ${snapshotTarget} AS target,
             (SELECT max(removed.change_id) FROM change_records AS removed
               WHERE removed.entity_type = '${targetType}'
                 AND removed.entity_id = ${snapshotTarget}
                 AND removed.after IS NULL) AS removed_by
        FROM ${snapshotsFrom}
       WHERE ${matching(type, BROUGHT_BACK)} AND ${snapshotIf} ${snapshotTarget} IS NOT NULL
         AND ${snapshotTarget} NOT IN (SELECT id FROM ${SHAPES[targetType].table})
         AND ${snapshotTarget} NOT IN ${ids(targetType, ["put_back"])}
       ORDER BY touched.entity_id`;
    return {
      type,
      targetType,
      inUse: { text: inUse, fields: POINTER },
      missing: { text: missing, fields: POINTER },
    };
  };
  const rowsFrom = `${table} AS record`;
  const snapshotsFrom = "change_records AS touched";
  return [
    ...Object.entries(pointsAt).map(([column, targetType]) =>
      way(targetType, {
        rowsFrom,
        rowTarget: `record.${column}`,
        snapshotsFrom,
        snapshotTarget: before(column),
      }),
    ),
    ...links.map((set) =>
      way(set.of, {
        rowsFrom: `${rowsFrom} JOIN ${set.table} AS link ON link.${set.from} = record.id`,
        rowTarget: `link.${set.to}`,
        snapshotsFrom: `${snapshotsFrom}, json_each(touched.before, '$.${set.name}') AS linked`,
        snapshotTarget: "linked.value",
      }),
    ),
    // A record that is attached by type and id points at one of each type it can be on.
    ...(attachedBy === undefined
      ? []
      : attachedBy.of.map((targetType) =>
          way(targetType, {
            rowsFrom,
            rowTarget: `record.${attachedBy.idColumn}`,
            rowIf: `record.${attachedBy.typeColumn} = '${targetType}' AND`,
            snapshotsFrom,
            snapshotTarget: before(attachedBy.idColumn),
            snapshotIf: `${before(attachedBy.typeColumn)} = '${targetType}' AND`,
          }),
        )),
  ];
});

// A record the undo brings back under a name that another record of its type has now.
interface Taken extends Listed {
  readonly holder_id: string;
  readonly holder_name: string;
}

// The records of a type the undo brings back whose name was taken since: another row has the
// same values in the columns no two records can share. The database compares them, so case is
// ignored the way it is everywhere else.
const NAMES_TAKEN: ReadonlyArray<Read & { readonly type: RecordType }> = EACH_TYPE.flatMap(
  ([type, { table, namedBy, unique }]) =>
    unique === undefined
      ? []
      : [
          {
            type,
            fields: ["type", "id", "name", "holder_id", "holder_name"],
            text: `
              SELECT '${type}' AS type, touched.entity_id AS id, ${before(namedBy)} AS name,
                     holder.id AS holder_id, holder.${namedBy} AS holder_name
                FROM change_records AS touched
                JOIN ${table} AS holder
                  ON holder.id <> touched.entity_id
                 AND ${unique.map((column) => `holder.${column} = ${before(column)}`).join(" AND ")}
               WHERE ${matching(type, BROUGHT_BACK)}
               ORDER BY touched.entity_id`,
          },
        ],
);

// A record as a reply lists it. A Note has no name, and is named by the start of its body, the
// way the reply of a save names one.
const listed = <Named extends Listed>(record: Named): Named =>
  record.type === "note" ? { ...record, name: opening(record.name) } : record;

// A record as an error names it.
const named = ({ type, id, name }: Listed) => `${term(type)} "${name}" (${id})`;

// The most records an error names as pointing at one record. It counts the rest.
const MOST_NAMED = 5;

const someOf = (pointing: ReadonlyArray<Listed>) => {
  const some = pointing.slice(0, MOST_NAMED).map((each) => `the ${named(each)}`);
  const more = pointing.length > MOST_NAMED ? `, and ${pointing.length - MOST_NAMED} more` : "";
  return `${some.join(", ")}${more}`;
};

/**
 * What blocks an undo that no later Change accounts for, read in one statement before anything
 * is written. Each read is a JSON column of it. There are three kinds: the records that point
 * at one the undo takes out, the records it brings back that pointed at one that is not there,
 * and the records it brings back under a name another has taken. Only the reads that can
 * matter to this Change are made.
 */
const whatBlocks = Effect.fnUntraced(function* (undone: string, touched: ReadonlyArray<Touched>) {
  const any = (type: RecordType, outcomes: ReadonlyArray<Outcome>) =>
    pick(touched, type, outcomes).length > 0;
  const reads = [
    ...WAYS.filter(({ targetType }) => any(targetType, ["taken_out"])).map((way) => ({
      kind: "inUse" as const,
      ...way.inUse,
    })),
    ...WAYS.filter(({ type }) => any(type, BROUGHT_BACK)).map((way) => ({
      kind: "missing" as const,
      ...way.missing,
    })),
    ...NAMES_TAKEN.filter(({ type }) => any(type, BROUGHT_BACK)).map((read) => ({
      kind: "taken" as const,
      ...read,
    })),
  ];
  if (reads.length === 0) return { inUse: [], missing: [], taken: [] };

  const sql = yield* SqlClient.SqlClient;
  const columns = reads.map(({ fields, text }, at) => `${list(fields, text)} AS read_${at}`);
  const [row = {}] = yield* sql.unsafe<Readonly<Record<string, string>>>(
    `SELECT ${columns.join(", ")}`,
    [undone],
  );
  // What every read of one kind found.
  const found = <Row extends Listed>(kind: (typeof reads)[number]["kind"]) =>
    reads.flatMap((read, at) =>
      read.kind === kind ? (JSON.parse(row[`read_${at}`] ?? "[]") as Row[]).map(listed) : [],
    );
  return {
    inUse: found<Pointer>("inUse"),
    missing: found<Pointer>("missing"),
    taken: found<Taken>("taken"),
  };
});

// Refuses an undo that would take out a record others point at. A foreign key would turn some
// of these away. It would let others through, and empty what points at the record or delete
// it, with no Change to say so.
const refuseInUse = (
  undone: string,
  touched: ReadonlyArray<Touched>,
  inUse: ReadonlyArray<Pointer>,
) => {
  const lines = touched.flatMap((record) => {
    const usedBy = inUse.filter(
      (pointer) => pointer.target_type === record.type && pointer.target === record.id,
    );
    return usedBy.length === 0 ? [] : [`The ${named(record)} is used by ${someOf(usedBy)}.`];
  });
  return lines.length === 0
    ? Effect.void
    : Effect.fail(
        new ToolError({
          message: `Nothing was undone, because undoing the Change "${undone}" would take out what other records use now. Point those records elsewhere first, or undo the Changes that made them use it:\n${lines.join("\n")}`,
        }),
      );
};

// Refuses an undo that would bring a record back pointing at one that is not there. A foreign
// key would turn most of these away, with no word on what is missing. Nothing holds what a
// Note is attached to, so that one would go through.
const refuseMissing = (missing: ReadonlyArray<Pointer>) => {
  const byTarget = Map.groupBy(missing, (pointer) => `${pointer.target_type} ${pointer.target}`);
  const lines = [...byTarget.values()].flatMap((pointing) => {
    const [first] = pointing;
    if (first === undefined) return [];
    const { target_type, target, removed_by } = first;
    const tookItOut = removed_by === null ? "" : ` The Change "${removed_by}" took it out.`;
    return [
      `The ${term(target_type)} with the id "${target}" is not there now, and ${someOf(pointing)} would point at it.${tookItOut}`,
    ];
  });
  return lines.length === 0
    ? Effect.void
    : Effect.fail(
        new ToolError({
          message: `Nothing was undone, because a record would come back pointing at one that is not there now. Put that one back first, by undoing the Change that took it out:\n${lines.join("\n")}`,
        }),
      );
};

// Refuses an undo that would give a record back a name another record has now. The unique
// index would turn it away, with no word on which record has the name.
const refuseNameTaken = (taken: ReadonlyArray<Taken>) => {
  const lines = taken.map(
    ({ type, id, name, holder_id, holder_name }) =>
      `The ${named({ type, id, name })} would be called that again, and the ${named({ type, id: holder_id, name: holder_name })} has the name now.`,
  );
  return lines.length === 0
    ? Effect.void
    : Effect.fail(
        new ToolError({
          message: `Nothing was undone, because a record would get back a name that another record has taken since. Rename the other record first, or undo the Change that made it:\n${lines.join("\n")}`,
        }),
      );
};

/**
 * The records a Change touched as the first read found them, each named as a reply lists it.
 * A record of a type that is not in `SHAPES` stops the undo: no statement here is about it, so
 * the rest of the Change would be undone around it. A tool cannot write one, so this is a
 * mistake in the data and not the client's.
 */
const touchedBy = (undone: string, found: ReadonlyArray<Touched>) => {
  const stray = found.find(({ type }) => !Object.hasOwn(SHAPES, type));
  return stray === undefined
    ? Effect.succeed(found.map(listed))
    : Effect.die(
        new Error(
          `The Change "${undone}" touched a "${stray.type}", and there is no type of record called "${stray.type}".`,
        ),
      );
};

const noChange = (id: string) =>
  new ToolError({
    message: `There is no Change with the id "${id}". The id of a Change is in the reply of the tool that made it, and get_record lists the latest Changes of a record.`,
  });

export const undo = defineTool({
  name: "undo",
  description: DESCRIPTION,
  input: Schema.Struct({
    change_id: Schema.String.annotate({
      description:
        "The id of the Change to undo, as the tool that made it returned it in change_id, or as get_record lists it.",
    }),
  }),
  annotations: ANNOTATIONS,
  run: ({ change_id: undone }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const [change] = yield* sql.unsafe<{ touched: string; later: string }>(CHANGE, [undone]);
      if (change === undefined) return yield* noChange(undone);
      const touched = yield* touchedBy(undone, JSON.parse(change.touched));

      // Everything is checked before anything is written.
      yield* refuseChangedSince(undone, JSON.parse(change.later));
      const blocks = yield* whatBlocks(undone, touched);
      yield* refuseInUse(undone, touched, blocks.inUse);
      yield* refuseMissing(blocks.missing);
      yield* refuseNameTaken(blocks.taken);

      // A statement is about several records, and is handed over with each of them. One that
      // is about none of this Change's records is left out.
      const steps = REVERSALS.flatMap(({ type, outcomes, text }) => {
        const about = pick(touched, type, outcomes);
        if (about.length === 0) return [];
        const statement = sql.unsafe(text, [undone]);
        return about.map(({ id }): Step => ({ type, id, statement }));
      });
      const undoing = yield* (yield* Write).run(steps, undone);

      const those = (outcome: Outcome) =>
        touched
          .filter((record) => record.outcome === outcome)
          .map(({ type, id, name }): Listed => ({ type, id, name }));
      return {
        change_id: undoing,
        taken_out: those("taken_out"),
        restored: those("restored"),
        put_back: those("put_back"),
      };
    }),
});
