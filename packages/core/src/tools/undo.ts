import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import {
  listedName,
  nameInTable,
  recordName,
  RECORD_TYPES,
  SHAPES,
  term,
  type LinkSet,
  type RecordShape,
  type RecordType,
} from "../records.ts";
import type { Listed } from "../save.ts";
import { compact, jsonList, jsonObject } from "../sql.ts";
import { defineTool, ToolError, type ToolAnnotations } from "../tool.ts";
import { Write, type Step } from "../write.ts";

const DESCRIPTION = `Undoes a Change, so that every record the Change touched is as it was before. A Change is one write made through a tool. Every tool that writes returns the id of its Change as \`change_id\`, and get_record lists a record's latest Changes, newest first, each with its id and the record as it was before and after. The rest are in the \`changes\` and \`change_records\` tables, which query reads.

What an undo does to a record depends on what the Change did to it. A record the Change created is taken out. A record it updated is restored: every field as it was, with \`data\` and the sets it holds, such as an Item's extra Categories or the Items and Spaces of Work. A record it deleted is put back under the id it had. A save that made a Space or a Vendor on first use, or wrote a Note, did that in the same Change, so undoing the save takes those out too. A Change is undone whole or not at all.

An undo is refused, and nothing is written, when it would lose something, or leave records as no save would:
- A record the Change touched has been changed again since. The error lists the later Changes, newest first. Undo those first, in that order, and then this one.
- The Change was undone already. The error says which Change undid it.
- A record it would take out is in use, because another record points at it now: an Item bought from a Vendor the Change made, or a Note added to an Item it created. The error names what uses it. Point those records elsewhere first, or undo the Changes that made them use it.
- A record it would bring back pointed at one that is not there now, such as an Item whose Vendor was taken out by another undo. The error says which record is missing and which Change took it out. Undo that Change first.
- A record it would bring back had a name that another record has now, where no two can share one: a Property, a Vendor, a Space at its Property, or a Quote, of which a Project has one from each Vendor. The error names both. Rename the other record first, or undo the Change that made it.
- A Category it would bring back would be under one that is under it, however far down, which is a loop: its parent was cleared, that parent was put under it, and the clearing is being undone. The error names every Category in the loop. Take one of the others out from under its parent first, with save_category, or undo the Change that put it there.
- A record it would move back to another Property has had a Note added to it since. A save that moves a record moves its Notes, and an undo would leave this one where it is. The error names the Note and the Change that added it. Undo that Change first, and then this one.
- A Note it would bring back is on a record that is elsewhere now, so the Note would come back at a Property its record is not at. The error names both, and the Change that moved the record, when one did. Undo that Change first, or move the record back.

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
// type that an undo does one of these things to. Every record has one of the three outcomes,
// so asking for all three asks nothing more.
const matching = (type: RecordType, outcomes: ReadonlyArray<Outcome>) =>
  [
    `touched.change_id = ?1 AND touched.entity_type = '${type}'`,
    ...(outcomes.length === ANY_OUTCOME.length
      ? []
      : [`(${outcomes.map((outcome) => OUTCOME_IF[outcome]).join(" OR ")})`]),
  ].join(" AND ");

// The same, as the SQL of a list of their ids.
const ids = (type: RecordType, outcomes: ReadonlyArray<Outcome>) =>
  `(SELECT touched.entity_id FROM change_records AS touched WHERE ${matching(type, outcomes)})`;

// A column of a record as it was before the Change. `data` comes out as the text of its
// object, which is what the column holds.
const before = (column: string) => `json_extract(touched.before, '$.${column}')`;

// A column of a record as it is once the undo is done, read from the row of `change_records`
// a statement has under this alias: as it was before the Change, and for a record the undo
// takes out, as the Change left it.
const snapshotOnceUndone = (alias: string) => (column: string) =>
  `json_extract(coalesce(${alias}.before, ${alias}.after), '$.${column}')`;

// The name of a record that another is named by. One that the Change touched has the name the
// Change's own snapshot gives it: the undo brings it back under that name, and until it does
// the record is not there to ask. Any other has the name in its table. A statement that reads
// this is given the Change as `?1`.
const nameInChangeOrTable = (type: RecordType, id: string) => `coalesce(
  (SELECT ${recordName(SHAPES[type], snapshotOnceUndone("also"))}
     FROM change_records AS also
    WHERE also.change_id = ?1 AND also.entity_type = '${type}' AND also.entity_id = ${id}),
  ${nameInTable(type, id)})`;

// What a record the undo brings back is named by, read from what it was before the Change.
const nameFromBefore = (shape: RecordShape) => recordName(shape, before, nameInChangeOrTable);

// What a row there is now is named by, read under this alias.
const nameOfRow = (shape: RecordShape, alias: string) =>
  recordName(shape, (column) => `${alias}.${column}`);

// The rows of a SELECT as one JSON column: a list with an object for each row, which has these
// fields, each read from the column of that name.
const list = (fields: ReadonlyArray<string>, select: string) =>
  jsonList(jsonObject(fields.map((field) => [field, field])), select);

// One statement of an undo, as SQL on one line. It is about every record of one type that the
// undo does one of these things to, and reads them from the Change itself. So an undo is the same few
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
  text: compact(`DELETE FROM ${table} WHERE ${from} IN ${ids(type, ANY_OUTCOME)}`),
});

// Puts back the row of each record the Change deleted: every column as it was.
const puttingBack = (type: RecordType, { table, columns }: RecordShape): Reversal => ({
  type,
  outcomes: ["put_back"],
  text: compact(`
    INSERT INTO ${table} (${columns.join(", ")})
    SELECT ${columns.map(before).join(", ")}
      FROM change_records AS touched
     WHERE ${matching(type, ["put_back"])}`),
});

// Restores the row of each record the Change updated: every column as it was.
const restoring = (type: RecordType, { table, columns }: RecordShape): Reversal => ({
  type,
  outcomes: ["restored"],
  text: compact(`
    UPDATE ${table}
       SET ${columns
         .filter((column) => column !== "id")
         .map((column) => `${column} = ${before(column)}`)
         .join(", ")}
      FROM change_records AS touched
     WHERE ${matching(type, ["restored"])} AND ${table}.id = touched.entity_id`),
});

// Fills a link set of each record the undo brings back, from the list of ids in `before`.
const relinking = (type: RecordType, { name, table, from, to }: LinkSet): Reversal => ({
  type,
  outcomes: BROUGHT_BACK,
  text: compact(`
    INSERT INTO ${table} (${from}, ${to})
    SELECT touched.entity_id, linked.value
      FROM change_records AS touched, json_each(touched.before, '$.${name}') AS linked
     WHERE ${matching(type, BROUGHT_BACK)}`),
});

// Takes out the row of each record the Change created.
const takingOut = (type: RecordType, { table }: RecordShape): Reversal => ({
  type,
  outcomes: ["taken_out"],
  text: compact(`DELETE FROM ${table} WHERE id IN ${ids(type, ["taken_out"])}`),
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

// What a record of each type is named by once the undo is done.
const NAME_ONCE_UNDONE = `CASE touched.entity_type ${EACH_TYPE.map(([type, shape]) => `WHEN '${type}' THEN ${recordName(shape, snapshotOnceUndone("touched"), nameInChangeOrTable)}`).join(" ")} END`;

// The records the Change touched, by type and then by id, each named as it is once the undo is
// done.
const TOUCHED = `
  SELECT touched.entity_type AS type, touched.entity_id AS id,
         ${NAME_ONCE_UNDONE} AS name,
         CASE WHEN ${OUTCOME_IF.taken_out} THEN 'taken_out'
              WHEN ${OUTCOME_IF.put_back} THEN 'put_back'
              ELSE 'restored' END AS outcome
    FROM change_records AS touched
   WHERE touched.change_id = to_undo.id
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
   WHERE mine.change_id = to_undo.id
     AND (later.created_at, later.id) > (to_undo.created_at, to_undo.id)
   ORDER BY later.created_at DESC, later.id DESC`;

// What an undo reads of the Change `?1` first, in one statement: one row, or none when there
// is no such Change.
const CHANGE = compact(`
  SELECT ${list(["type", "id", "name", "outcome"], TOUCHED)} AS touched,
         ${list(["id", "tool", "created_at", "undoes"], LATER)} AS later
    FROM changes AS to_undo
   WHERE to_undo.id = ?1`);

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

// Refuses an undo for what stands in its way, a line for each thing, under what the lines
// have in common. With nothing in the way, the undo goes on.
const refuseFor = (lines: ReadonlyArray<string>, because: string) =>
  lines.length === 0
    ? Effect.void
    : Effect.fail(
        new ToolError({ message: `Nothing was undone, because ${because}\n${lines.join("\n")}` }),
      );

// Refuses an undo that would write over what was done since.
const refuseChangedSince = (toUndo: string, later: ReadonlyArray<Later>) => {
  const standing = laterStanding(later);
  const [newest, ...older] = standing;
  if (newest !== undefined && newest.undoes === toUndo && older.length === 0) {
    return Effect.fail(
      new ToolError({
        message: `Nothing was undone, because the Change "${toUndo}" was undone already, by the Change "${newest.id}". Undoing "${newest.id}" leaves the records as "${toUndo}" left them.`,
      }),
    );
  }
  return refuseFor(
    standing.map(
      ({ id, tool, created_at, undoes }) =>
        `"${id}", made by ${tool} at ${created_at}${undoes === null ? "" : `, which undid "${undoes}"`}`,
    ),
    `records the Change "${toUndo}" touched have been changed again since, and undoing it would write over that. Undo the later Changes first, newest first:`,
  );
};

// One read an undo makes before it writes: a SELECT as SQL on one line, and the fields of
// its rows.
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
interface WayOfPointing {
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

const WAYS_OF_POINTING: ReadonlyArray<WayOfPointing> = EACH_TYPE.flatMap(([type, shape]) => {
  const { table, links, pointerColumns, attachedBy } = shape;
  const way = (targetType: RecordType, inSql: WayInSql): WayOfPointing => {
    const { rowsFrom, rowTarget, snapshotsFrom, snapshotTarget } = inSql;
    const { rowIf = "", snapshotIf = "" } = inSql;
    const inUse = `
      SELECT '${type}' AS type, record.id, ${nameOfRow(shape, "record")} AS name,
             '${targetType}' AS target_type, ${rowTarget} AS target, NULL AS removed_by
        FROM ${rowsFrom}
       WHERE ${rowIf} ${rowTarget} IN ${ids(targetType, ["taken_out"])}
         AND record.id NOT IN ${ids(type, ANY_OUTCOME)}
       ORDER BY record.id`;
    // An empty pointer is no pointer, and `NOT IN` alone would let one through. Ids sort by
    // when they were made, so the greatest is the latest Change that took the record out.
    const missing = `
      SELECT '${type}' AS type, touched.entity_id AS id, ${nameFromBefore(shape)} AS name,
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
      inUse: { text: compact(inUse), fields: POINTER },
      missing: { text: compact(missing), fields: POINTER },
    };
  };
  const rowsFrom = `${table} AS record`;
  const snapshotsFrom = "change_records AS touched";
  return [
    ...Object.entries(pointerColumns).map(([column, targetType]) =>
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

// A record the undo brings back under a name that another record of its type has now, with
// the record that has it. `same_change` is 1 when that one is a record of the Change too.
interface NameHeld extends Listed {
  readonly holder_id: string;
  readonly holder_name: string;
  readonly same_change: number;
}

// The records of a type the undo brings back whose name another row has now: the same values
// in the columns no two records can share. The database compares them, so case is ignored the
// way it is everywhere else.
const NAMES_HELD: ReadonlyArray<Read & { readonly type: RecordType }> = EACH_TYPE.flatMap(
  ([type, shape]) => {
    const { table, unique } = shape;
    return unique === undefined
      ? []
      : [
          {
            type,
            fields: ["type", "id", "name", "holder_id", "holder_name", "same_change"],
            text: compact(`
              SELECT '${type}' AS type, touched.entity_id AS id, ${nameFromBefore(shape)} AS name,
                     holder.id AS holder_id, ${nameOfRow(shape, "holder")} AS holder_name,
                     holder.id IN ${ids(type, ANY_OUTCOME)} AS same_change
                FROM change_records AS touched
                JOIN ${table} AS holder
                  ON holder.id <> touched.entity_id
                 AND ${unique.map((column) => `holder.${column} = ${before(column)}`).join(" AND ")}
               WHERE ${matching(type, BROUGHT_BACK)}
               ORDER BY touched.entity_id`),
          },
        ];
  },
);

// One record on the way up from a record the undo brings back, in a walk that comes round to
// where it began. `began` is the id of the record the walk began at, and `far` is how many
// records up from it this one is. A walk ends at the record it began at.
interface Looped extends Listed {
  readonly began: string;
  readonly far: number;
}

// A type can have a column that points at a record of its own type: a Category has the
// Category it is under. A save refuses a parent that would make a loop, and nothing in the
// database does. So the tree is walked as it would be once the undo is done: a record the
// undo brings back is under what it was under before, and every other record is under what
// it is under now. A walk up from a record the undo brings back that comes round to it is a
// loop, and the read has every record on the way round, in order. A walk is no longer than
// there are records, so one that runs into a loop its first record is not in stops too.
const LOOPS: ReadonlyArray<Read & { readonly type: RecordType }> = EACH_TYPE.flatMap(
  ([type, shape]) =>
    Object.entries(shape.pointerColumns)
      .filter(([, targetType]) => targetType === type)
      .map(([column]) => ({
        type,
        fields: ["type", "id", "name", "began", "far"],
        text: compact(`
          WITH RECURSIVE
            tree (id, name, above) AS (
              SELECT touched.entity_id, ${nameFromBefore(shape)}, ${before(column)}
                FROM change_records AS touched
               WHERE ${matching(type, BROUGHT_BACK)}
              UNION ALL
              SELECT record.id, ${nameOfRow(shape, "record")}, record.${column}
                FROM ${shape.table} AS record
               WHERE record.id NOT IN ${ids(type, ANY_OUTCOME)}
            ),
            walk (began, reached, far) AS (
              SELECT tree.id, tree.above, 1
                FROM tree
               WHERE tree.id IN ${ids(type, BROUGHT_BACK)} AND tree.above IS NOT NULL
              UNION ALL
              SELECT walk.began, tree.above, walk.far + 1
                FROM walk JOIN tree ON tree.id = walk.reached
               WHERE walk.reached <> walk.began AND tree.above IS NOT NULL
                 AND walk.far < (SELECT count(*) FROM tree)
            )
          SELECT '${type}' AS type, tree.id, tree.name, walk.began, walk.far
            FROM walk JOIN tree ON tree.id = walk.reached
           WHERE walk.began IN
                 (SELECT closed.began FROM walk AS closed WHERE closed.reached = closed.began)
           ORDER BY walk.began, walk.far`),
      })),
);

// A record that is attached to one the undo would move, and is not a record of the Change, so
// it would stay where it is. `added_by` is the id of the Change that added it, when one did.
interface LeftBehind extends Listed {
  readonly target_type: RecordType;
  readonly target: string;
  readonly added_by: string | null;
}

// A record the undo brings back, attached to one that is not a record of the Change and is
// elsewhere now, with that one. `target_moved_by` is the id of the Change that moved that
// one, when one did.
interface Stranded extends Listed {
  readonly target_type: RecordType;
  readonly target: string;
  readonly target_name: string;
  readonly target_moved_by: string | null;
}

// One type of record that another can be attached to and follow in a column: a Note is at
// the Property of the Item it is on. A save that moves the Item moves the Note in the same
// Change, and nothing in the database holds the two together. An undo must not part them, so
// each way comes with a read for each side of that.
interface WayOfFollowing {
  /** The type that is attached, and the type it is attached to. */
  readonly type: RecordType;
  readonly targetType: RecordType;
  /**
   * The records attached this way to one the undo restores with another value in the column.
   * A record of the Change itself is not one of them: it moved in the Change, and goes back
   * with the record it is on. One that was added since is in no snapshot, and would stay.
   */
  readonly leftBehind: Read;
  /**
   * The records the undo brings back that were attached this way to one which is not a
   * record of the Change, and has another value in the column now than they come back with.
   */
  readonly stranded: Read;
}

// Ids sort by when they were made, so the greatest is the latest Change that added a record,
// or that gave one another value in the column.
const WAYS_OF_FOLLOWING: ReadonlyArray<WayOfFollowing> = EACH_TYPE.flatMap(([type, shape]) => {
  const { table, attachedBy } = shape;
  const follows = attachedBy?.follows;
  if (attachedBy === undefined || follows === undefined) return [];
  const { typeColumn, idColumn, of } = attachedBy;
  // A type with no such column has nothing to follow.
  return EACH_TYPE.filter(
    ([targetType, { columns }]) => of.includes(targetType) && columns.includes(follows),
  ).map(([targetType, targetShape]) => {
    const targetTable = targetShape.table;
    const leftBehind = `
        SELECT '${type}' AS type, record.id, ${nameOfRow(shape, "record")} AS name,
               '${targetType}' AS target_type, touched.entity_id AS target,
               (SELECT max(added.change_id) FROM change_records AS added
                 WHERE added.entity_type = '${type}' AND added.entity_id = record.id
                   AND added.before IS NULL) AS added_by
          FROM change_records AS touched
          JOIN ${targetTable} AS now ON now.id = touched.entity_id
          JOIN ${table} AS record
            ON record.${typeColumn} = '${targetType}' AND record.${idColumn} = touched.entity_id
         WHERE ${matching(targetType, ["restored"])}
           AND ${before(follows)} IS NOT now.${follows}
           AND record.id NOT IN ${ids(type, ANY_OUTCOME)}
         ORDER BY touched.entity_id, record.id`;
    const stranded = `
        SELECT '${type}' AS type, touched.entity_id AS id, ${nameFromBefore(shape)} AS name,
               '${targetType}' AS target_type, now.id AS target,
               ${nameOfRow(targetShape, "now")} AS target_name,
               (SELECT max(mover.change_id) FROM change_records AS mover
                 WHERE mover.entity_type = '${targetType}' AND mover.entity_id = now.id
                   AND mover.before IS NOT NULL AND mover.after IS NOT NULL
                   AND json_extract(mover.before, '$.${follows}')
                       IS NOT json_extract(mover.after, '$.${follows}')) AS target_moved_by
          FROM change_records AS touched
          JOIN ${targetTable} AS now ON now.id = ${before(idColumn)}
         WHERE ${matching(type, BROUGHT_BACK)}
           AND ${before(typeColumn)} = '${targetType}'
           AND ${before(follows)} IS NOT now.${follows}
           AND now.id NOT IN ${ids(targetType, ANY_OUTCOME)}
         ORDER BY touched.entity_id`;
    return {
      type,
      targetType,
      leftBehind: {
        text: compact(leftBehind),
        fields: ["type", "id", "name", "target_type", "target", "added_by"],
      },
      stranded: {
        text: compact(stranded),
        fields: ["type", "id", "name", "target_type", "target", "target_name", "target_moved_by"],
      },
    };
  });
});

// A record as a reply lists it: named the way the reply of a save names one, which is by the
// start of a name that runs long.
const listed = <Row extends Listed>(record: Row): Row => ({
  ...record,
  name: listedName(record.type, record.name),
});

// A record as an error names it.
const named = ({ type, id, name }: Listed) => `${term(type)} "${name}" (${id})`;

// The most records an error names as pointing at one record. It counts the rest.
const MOST_NAMED = 5;

const someOf = (pointing: ReadonlyArray<Listed>) => {
  const some = pointing.slice(0, MOST_NAMED).map((each) => `the ${named(each)}`);
  const more = pointing.length > MOST_NAMED ? `, and ${pointing.length - MOST_NAMED} more` : "";
  return `${some.join(", ")}${more}`;
};

// The one statement that makes several reads: each is a JSON column of it.
const together = (reads: ReadonlyArray<Read>) =>
  `SELECT ${reads.map(({ fields, text }, at) => `${list(fields, text)} AS read_${at}`).join(", ")}`;

// The kinds of read there are. Each has rows of its own, and a refusal of its own.
type Kind = "inUse" | "missing" | "held" | "looped" | "leftBehind" | "stranded";

// A read with its kind, and the records of the Change it is about: it can find something
// only when the undo does one of these things to a record of this type.
interface ReadAbout extends Read {
  readonly kind: Kind;
  readonly type: RecordType;
  readonly outcomes: ReadonlyArray<Outcome>;
}

// Every read an undo can make before it writes.
const EVERY_READ: ReadonlyArray<ReadAbout> = [
  ...WAYS_OF_POINTING.map(({ targetType, inUse }): ReadAbout => ({
    ...inUse,
    kind: "inUse",
    type: targetType,
    outcomes: ["taken_out"],
  })),
  ...WAYS_OF_POINTING.map(({ type, missing }): ReadAbout => ({
    ...missing,
    kind: "missing",
    type,
    outcomes: BROUGHT_BACK,
  })),
  ...NAMES_HELD.map((read): ReadAbout => ({ ...read, kind: "held", outcomes: BROUGHT_BACK })),
  ...LOOPS.map((read): ReadAbout => ({ ...read, kind: "looped", outcomes: BROUGHT_BACK })),
  ...WAYS_OF_FOLLOWING.map(({ targetType, leftBehind }): ReadAbout => ({
    ...leftBehind,
    kind: "leftBehind",
    type: targetType,
    outcomes: ["restored"],
  })),
  ...WAYS_OF_FOLLOWING.map(({ type, stranded }): ReadAbout => ({
    ...stranded,
    kind: "stranded",
    type,
    outcomes: BROUGHT_BACK,
  })),
];

// The statement is at its longest with every read in it. It is built here, once, so that a
// type too many stops the module from loading, and not the undo of a Change that touched
// everything.
compact(together(EVERY_READ));

/**
 * What blocks an undo that no later Change accounts for, read in one statement before anything
 * is written. Only the reads that can matter to this Change are made.
 */
const whatBlocks = Effect.fnUntraced(function* (toUndo: string, touched: ReadonlyArray<Touched>) {
  const reads = EVERY_READ.filter(({ type, outcomes }) => pick(touched, type, outcomes).length > 0);
  const sql = yield* SqlClient.SqlClient;
  // With no read to make there is no statement to send.
  const [row = {}] =
    reads.length === 0
      ? []
      : yield* sql.unsafe<Readonly<Record<string, string>>>(together(reads), [toUndo]);
  // What every read of one kind found.
  const found = <Row extends Listed>(kind: Kind) =>
    reads.flatMap((read, at) =>
      read.kind === kind ? (JSON.parse(row[`read_${at}`] ?? "[]") as Row[]).map(listed) : [],
    );
  return {
    inUse: found<Pointer>("inUse"),
    missing: found<Pointer>("missing"),
    held: found<NameHeld>("held"),
    looped: found<Looped>("looped"),
    leftBehind: found<LeftBehind>("leftBehind"),
    stranded: found<Stranded>("stranded"),
  };
});

// Refuses an undo that would take out a record others point at. A foreign key would turn some
// of these away. It would let others through, and empty what points at the record or delete
// it, with no Change to say so.
const refuseInUse = (
  toUndo: string,
  touched: ReadonlyArray<Touched>,
  inUse: ReadonlyArray<Pointer>,
) =>
  refuseFor(
    touched.flatMap((record) => {
      const usedBy = inUse.filter(
        (pointer) => pointer.target_type === record.type && pointer.target === record.id,
      );
      return usedBy.length === 0 ? [] : [`The ${named(record)} is used by ${someOf(usedBy)}.`];
    }),
    `undoing the Change "${toUndo}" would take out what other records use now. Point those records elsewhere first, or undo the Changes that made them use it:`,
  );

// Refuses an undo that would bring a record back pointing at one that is not there. A foreign
// key would turn most of these away, with no word on what is missing. Nothing holds what a
// Note is attached to, so that one would go through.
const refuseMissing = (missing: ReadonlyArray<Pointer>) => {
  const byTarget = Map.groupBy(missing, (pointer) => `${pointer.target_type} ${pointer.target}`);
  return refuseFor(
    [...byTarget.values()].flatMap((pointing) => {
      const [first] = pointing;
      if (first === undefined) return [];
      const { target_type, target, removed_by } = first;
      const tookItOut = removed_by === null ? "" : ` The Change "${removed_by}" took it out.`;
      return [
        `The ${term(target_type)} with the id "${target}" is not there now, and ${someOf(pointing)} would point at it.${tookItOut}`,
      ];
    }),
    "a record would come back pointing at one that is not there now. Put that one back first, by undoing the Change that took it out:",
  );
};

// Refuses an undo that would give a record back a name another record has now. The unique
// index would turn it away, with no word on which record has the name.
const refuseNameHeld = Effect.fnUntraced(function* (toUndo: string, held: ReadonlyArray<NameHeld>) {
  const holder = ({ type, holder_id, holder_name }: NameHeld) =>
    named({ type, id: holder_id, name: holder_name });
  // The record that has the name can be one this Change wrote: the Change took the name from
  // one record and gave it to another. Rows come back before rows go out, so the name cannot
  // go back, and there is no Change to undo first: it is this one.
  yield* refuseFor(
    held
      .filter(({ same_change }) => same_change === 1)
      .map(
        (record) =>
          `The ${named(record)} would be called that again, and the ${holder(record)}, which the same Change wrote, has the name.`,
      ),
    `the Change "${toUndo}" gave one record a name it took from another, and an undo cannot give the name back while the other record still has it. This Change cannot be undone. Put the records right with the other tools instead:`,
  );
  yield* refuseFor(
    held.map(
      (record) =>
        `The ${named(record)} would be called that again, and the ${holder(record)} has the name now.`,
    ),
    "a record would get back a name that another record has now. Rename the other record first, or undo the Change that made it:",
  );
});

// Refuses an undo that would leave a record under itself, by way of the records above it.
// Nothing in the database would turn it away.
const refuseLoops = (touched: ReadonlyArray<Touched>, looped: ReadonlyArray<Looped>) => {
  const key = ({ type, id }: Pick<Listed, "type" | "id">) => `${type} ${id}`;
  const broughtBack = new Set(
    touched.filter(({ outcome }) => BROUGHT_BACK.includes(outcome)).map(key),
  );
  // What a record is to the one above it: one the undo brings back as it was before, and
  // any other as it is now.
  const under = (record: Listed) =>
    broughtBack.has(key(record)) ? "would be back under" : "is under";
  // A loop is walked from each record in it that the undo brings back, and said once.
  const said = new Set<string>();
  const walks = Map.groupBy(looped, ({ type, began }) => key({ type, id: began }));
  return refuseFor(
    [...walks.values()].flatMap((walk) => {
      // A walk ends at the record it began at.
      const last = walk.at(-1);
      if (last === undefined || said.has(key(last))) return [];
      for (const each of walk) said.add(key(each));
      const round = [
        `${named(last)} ${under(last)}`,
        ...walk.slice(0, -1).map((each) => `${named(each)}, which ${under(each)}`),
        named(last),
      ];
      return [`The ${round.join(" the ")}.`];
    }),
    "a record would be back under one that is under it already, which is a loop. One of the others in the loop has to come out from under its parent first, by a save of it or by undoing the Change that put it there:",
  );
};

// Refuses an undo that would move a record and leave behind what was attached to it since.
// Nothing in the database would turn it away.
const refuseLeftBehind = (
  toUndo: string,
  touched: ReadonlyArray<Touched>,
  leftBehind: ReadonlyArray<LeftBehind>,
) =>
  refuseFor(
    touched.flatMap((record) =>
      leftBehind
        .filter((attached) => attached.target_type === record.type && attached.target === record.id)
        .map((attached) => {
          const addedBy =
            attached.added_by === null
              ? ""
              : ` The Change "${attached.added_by}" added the ${term(attached.type)}.`;
          return `The ${named(record)} would go back to where it was, and the ${named(attached)} on it would stay.${addedBy}`;
        }),
    ),
    `undoing the Change "${toUndo}" would move a record, and what was added to it since would stay behind. Undo the Change that added that first, and then this one:`,
  );

// Refuses an undo that would bring a record back apart from the one it is attached to, which
// is elsewhere now. Nothing in the database would turn it away.
const refuseStranded = (stranded: ReadonlyArray<Stranded>) =>
  refuseFor(
    stranded.map((attached) => {
      const { target_type, target, target_name, target_moved_by } = attached;
      const attachedTo = named({ type: target_type, id: target, name: target_name });
      const movedBy =
        target_moved_by === null
          ? ""
          : ` The Change "${target_moved_by}" moved the ${term(target_type)}.`;
      return `The ${named(attached)} would come back on the ${attachedTo}, which is elsewhere now.${movedBy}`;
    }),
    "a record would come back apart from the one it is on, which is elsewhere now. Undo the Change that moved that one first, or move it back:",
  );

/**
 * The records a Change touched as the first read found them, each named as a reply lists it.
 * A record of a type that is not in `SHAPES` stops the undo: no statement here is about it, so
 * the rest of the Change would be undone around it. A tool cannot write one, so this is a
 * mistake in the data and not the client's.
 */
const touchedBy = (toUndo: string, found: ReadonlyArray<Touched>) => {
  const stray = found.find(({ type }) => !Object.hasOwn(SHAPES, type));
  return stray === undefined
    ? Effect.succeed(found.map(listed))
    : Effect.die(
        new Error(
          `The Change "${toUndo}" touched a "${stray.type}", and there is no type of record called "${stray.type}".`,
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
  run: ({ change_id: toUndo }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const [change] = yield* sql.unsafe<{ touched: string; later: string }>(CHANGE, [toUndo]);
      if (change === undefined) return yield* noChange(toUndo);
      const touched = yield* touchedBy(toUndo, JSON.parse(change.touched));

      // Everything is checked before anything is written.
      yield* refuseChangedSince(toUndo, JSON.parse(change.later));
      const blocks = yield* whatBlocks(toUndo, touched);
      yield* refuseInUse(toUndo, touched, blocks.inUse);
      yield* refuseMissing(blocks.missing);
      yield* refuseNameHeld(toUndo, blocks.held);
      yield* refuseLoops(touched, blocks.looped);
      yield* refuseLeftBehind(toUndo, touched, blocks.leftBehind);
      yield* refuseStranded(blocks.stranded);

      // A statement is about several records, and is handed over with each of them. One that
      // is about none of this Change's records is left out.
      const steps = REVERSALS.flatMap(({ type, outcomes, text }) => {
        const about = pick(touched, type, outcomes);
        if (about.length === 0) return [];
        const statement = sql.unsafe(text, [toUndo]);
        return about.map(({ id }): Step => ({ type, id, statement }));
      });
      const theUndo = yield* (yield* Write).run(steps, toUndo);

      const those = (outcome: Outcome) =>
        touched
          .filter((record) => record.outcome === outcome)
          .map(({ type, id, name }): Listed => ({ type, id, name }));
      return {
        change_id: theUndo,
        taken_out: those("taken_out"),
        restored: those("restored"),
        put_back: those("put_back"),
      };
    }),
});
