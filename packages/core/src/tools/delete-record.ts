import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { categoryAmong, DEFAULT_CATEGORY, everyCategory, isUnder } from "../category.ts";
import {
  asListed,
  distinctRecords,
  EACH_TYPE,
  named,
  nameInTable,
  nameOfRow,
  pointingRows,
  recordKey,
  recordName,
  RECORD_TYPES,
  SHAPES,
  someOf,
  term,
  WAYS_OF_POINTING,
  type LinkSet,
  type Listed,
  type RecordShape,
  type RecordType,
  type WayOfPointing,
} from "../records.ts";
import { updatedNow } from "../save.ts";
import { compact, jsonRows, rowsIn } from "../sql.ts";
import { defineTool, noRecord, optional, ToolError, type ToolAnnotations } from "../tool.ts";
import { stepsAbout, Write, type Step } from "../write.ts";

const DESCRIPTION = `Deletes one record, by its type and its id: an Item, Work, a Vendor, a Note, a Category, a Space, a Project, or a Quote. Deleting is an ordinary part of keeping the record right. Every delete is a Change, and undo puts back what a Change took out, so a delete made by mistake is undone with the \`change_id\` this returns.

Delete a record that should not be there: one made by mistake, a duplicate, or an Item that was returned or thrown away. An Item that was sold, given away, lost, stolen, or destroyed is not deleted. It is kept for its money trail, so give it that \`status\` with save_item instead. An Item that was replaced, such as the old dishwasher, is deleted, and the Work done on it stays as the history of the Property.

A record's Notes go with it. A deleted Item comes off every piece of Work that named it, and that Work stays. Work needs a Property or at least one Item, so Work at no Property that named only that Item is deleted with it, and so are the Notes on that Work.

A Vendor, a Space, a Category, or a Project that other records use is refused, and the error lists what uses it. Its own Notes do not count. To delete it all the same, give \`replacement\` the id of another record of the same type. Everything that used the one is then pointed at the other, its Notes are put on the other too, and then it is deleted, all in one Change. That is how two records of one Vendor, or of one Space, are merged: delete the duplicate, with the one to keep as its \`replacement\`. Nothing the deleted record held itself is copied to the other: not its \`data\`, not a Vendor's role, and not a Project's Spaces. So save what is worth keeping onto the other first. A replacement for a Space or a Project is one at the same Property. A replacement for a Category is not one under it. An Item that would then have a Category twice keeps it once. A merge that would leave a Project with two Quotes from one Vendor is refused, and the error names both: delete one of the two first.

A Property is never deleted. One that is no longer the User's gets an end date with save_property. The Category \`other\` is never deleted either: an Item is in it when a save names no Category. \`replacement\` is only for a Vendor, a Space, a Category, or a Project. A record with a Schedule or a Document on it cannot be deleted yet.

What comes back is the id of the Change, what was \`removed\`, and what was \`updated\`, each by type, id, and name. \`removed\` has the record first, and then what went with it. \`updated\` has every record that was pointed at the replacement, or that lost the record, such as Work that named a deleted Item.`;

// The one tool that is marked as one that may destroy. What it takes out can be put back with
// undo, and a client is told all the same, so that it can ask first.
const ANNOTATIONS: ToolAnnotations = { readOnlyHint: false, destructiveHint: true };

// A Property is never deleted. Every other type of record is one this tool takes.
type Deletable = Exclude<RecordType, "property">;

const isDeletable = (type: RecordType): type is Deletable => type !== "property";

const NEVER_A_PROPERTY =
  "A Property is never deleted. One that is no longer the User's gets an end date instead: save it with save_property and give `end_on` the day it stopped being theirs. Its records stay as they are.";

const NEVER_THE_DEFAULT_CATEGORY = `The Category "${DEFAULT_CATEGORY}" is never deleted: an Item is in it when a save names no Category. To call it something else, save it with save_category and a new name.`;

// The types whose delete takes a replacement. Other records point at one of these in a way
// the database holds them to, so one that is in use cannot go until they point elsewhere, and
// the replacement is where.
const REPLACEABLE = ["vendor", "space", "category", "project"] as const;

type Replaceable = (typeof REPLACEABLE)[number];

const takesReplacement = (type: RecordType): type is Replaceable =>
  REPLACEABLE.some((replaceable) => replaceable === type);

const NO_REPLACEMENT =
  "`replacement` is only for a Vendor, a Space, a Category, or a Project: it is the record that what uses the deleted one is pointed at instead. Leave it out for a record of any other type.";

// The error for a delete that is refused. It says first that nothing was deleted.
const notDeleted = (because: string) =>
  new ToolError({ message: `Nothing was deleted, because ${because}` });

// One way a record is used: a record of another type points at it by a column of its row, or
// by a link set. A Note is attached to a record, which is the third way of pointing, and is
// no use of it: it goes with its record.
type WayOfUsing = Exclude<WayOfPointing, { readonly by: "attachment" }>;

const waysOfUsing = (used: RecordType) =>
  WAYS_OF_POINTING.filter(
    (way): way is WayOfUsing => way.targetType === used && way.by !== "attachment",
  );

// What a read finds of a record: its type, its id, and its name.
const LISTED_FIELDS = ["type", "id", "name"];

// The records that use the record `?1` in one way, by id. `nameOf` is the SQL of what each is
// named by.
const usedIn = (way: WayOfUsing, nameOf: string) => {
  const { from, target } = pointingRows(way);
  return `SELECT '${way.type}' AS type, record.id, ${nameOf} AS name
            FROM ${from}
           WHERE ${target} = ?1
           ORDER BY record.id`;
};

// What a record that uses the record `?1` is named by once it is pointed at the replacement
// `?2`. Most are named by a column of their row, which a merge leaves alone. A Quote is named
// by its Vendor and its Project, so it is named by the one it is pointed at.
const nameOnceMerged = ({ shape, targetType }: WayOfUsing) =>
  recordName(
    shape,
    (column) => `record.${column}`,
    (type, id) =>
      nameInTable(type, type === targetType ? `CASE WHEN ${id} = ?1 THEN ?2 ELSE ${id} END` : id),
  );

// A record that uses the record to delete, and would be one and the same as another once it
// is pointed at the replacement: the two would have the same values in the columns no two
// records of their type can share. The other is the holder of those values now.
interface Collision extends Listed {
  readonly holder_id: string;
  readonly holder_name: string;
}

const COLLISION_FIELDS = [...LISTED_FIELDS, "holder_id", "holder_name"];

// The records that use the record `?1` in one way and would collide with one that uses the
// replacement `?2`, each with that one, as they are named now. Only a column that no two
// records can share can make two collide. A link set keeps a record once on its own.
const collidingIn = (way: WayOfUsing) => {
  const { table, unique = [] } = way.shape;
  if (way.by !== "column" || !unique.includes(way.column)) return undefined;
  const alike = unique
    .filter((column) => column !== way.column)
    .map((column) => `AND holder.${column} = mine.${column}`);
  return `SELECT '${way.type}' AS type, mine.id, ${nameOfRow(way.shape, "mine")} AS name,
                 holder.id AS holder_id, ${nameOfRow(way.shape, "holder")} AS holder_name
            FROM ${table} AS mine
            JOIN ${table} AS holder ON holder.${way.column} = ?2 ${alike.join(" ")}
           WHERE mine.${way.column} = ?1
           ORDER BY mine.id`;
};

// What the columns no two records of a type can share are called, as an error says them: a
// Project and a Vendor, for a Quote.
const sharedByNone = ({ unique = [], pointerColumns }: RecordShape) =>
  new Intl.ListFormat("en", { type: "conjunction" }).format(
    unique.map((column) => {
      const pointedAt = pointerColumns[column];
      return pointedAt === undefined ? column : term(pointedAt);
    }),
  );

// The column a record that is at a Property has it in. What uses a Space or a Project is at
// that one's Property, so a replacement for either is at the same Property.
const AT_PROPERTY = "property_id";

const isAtProperty = ({ pointerColumns }: RecordShape) =>
  Object.hasOwn(pointerColumns, AT_PROPERTY);

// The SELECT of what else goes when a record of a type does: the type, the id, and the name
// of each. Work needs a Property or at least one Item, which code keeps because the Items are
// in a table of their own. So Work at no Property that named only the Item `?1` would be left
// with neither, and goes with the Item.
const SELECT_GOING_TOO: Readonly<Partial<Record<Deletable, string>>> = {
  item: `SELECT 'work' AS type, work.id, ${nameOfRow(SHAPES.work, "work")} AS name
           FROM work
          WHERE work.property_id IS NULL
            AND work.id IN (SELECT work_id FROM work_items WHERE item_id = ?1)
            AND NOT EXISTS (SELECT 1 FROM work_items AS other
                             WHERE other.work_id = work.id AND other.item_id <> ?1)`,
};

// How a Note is on a record: by the record's type and its id, in these two columns.
const NOTE_ON = SHAPES.note.attachedBy;

// The Notes on the records that go, by id. A statement that reads this names those records
// `going`: the record itself, and what goes with it.
const NOTES_ON_GOING = `
  SELECT 'note' AS type, record.id, ${nameOfRow(SHAPES.note, "record")} AS name
    FROM ${SHAPES.note.table} AS record
    JOIN going ON going.type = record.${NOTE_ON.typeColumn}
              AND going.id = record.${NOTE_ON.idColumn}
   ORDER BY record.id`;

// A record that goes, with how many Schedules and Documents are on it.
interface WithScheduleOrDocument extends Listed {
  readonly schedules: number;
  readonly documents: number;
}

// The records that go with a Schedule or a Document on them. Those are types no tool writes
// yet, so no Change has one. An Item's Schedules would be deleted with it by a foreign key. A
// Document is attached by type and id, with no key at all, and would stay attached to nothing.
// And a Vendor that a Document names in a column of its own could not go at all, or would
// have to be pointed at a replacement. So a delete of any of these is refused, until the tools
// that write a Schedule and a Document are here.
const SCHEDULES_AND_DOCUMENTS_ON_GOING = `
  SELECT * FROM (
    SELECT going.type, going.id, going.name,
           (SELECT count(*) FROM schedules AS schedule
             WHERE going.type = 'item' AND schedule.item_id = going.id) AS schedules,
           (SELECT count(*) FROM documents AS document
             WHERE (going.type = 'vendor' AND document.vendor_id = going.id)
                OR document.id IN (SELECT link.document_id FROM document_links AS link
                                    WHERE link.entity_type = going.type
                                      AND link.entity_id = going.id)) AS documents
      FROM going)
   WHERE schedules > 0 OR documents > 0
   ORDER BY type, id`;

// One statement of a delete, as SQL on one line.
type StatementText = string;

// The one read a delete makes of the record `?1` of a type: one row, or none when there is no
// such record. Every delete reads the record's name, the records that go, the Notes on any of
// those, and the ones among them with a Schedule or a Document on them, each list as a JSON
// column. `used` has a column for each way the record is used, with the records that use it
// that way. `more` is what a merge reads beside those, and the join it reads it from.
const readOf = (
  type: Deletable,
  shape: RecordShape,
  used: ReadonlyArray<string>,
  more: { readonly columns: ReadonlyArray<string>; readonly join: string } = {
    columns: [],
    join: "",
  },
): StatementText => {
  const itself = `SELECT '${type}' AS type, record.id, ${nameOfRow(shape, "record")} AS name
                    FROM ${shape.table} AS record
                   WHERE record.id = ?1`;
  const selectGoingToo = SELECT_GOING_TOO[type];
  const columns = [
    `${nameOfRow(shape, "record")} AS name`,
    `${jsonRows(LISTED_FIELDS, "SELECT type, id, name FROM going ORDER BY type, id")} AS going`,
    `${jsonRows(LISTED_FIELDS, NOTES_ON_GOING)} AS notes`,
    `${jsonRows(
      [...LISTED_FIELDS, "schedules", "documents"],
      SCHEDULES_AND_DOCUMENTS_ON_GOING,
    )} AS schedules_and_documents`,
    ...used,
    ...more.columns,
  ];
  return compact(`
    WITH going (type, id, name) AS (
      ${itself} ${selectGoingToo === undefined ? "" : `UNION ALL ${selectGoingToo}`}
    )
    SELECT ${columns.join(", ")}
      FROM ${shape.table} AS record ${more.join}
     WHERE record.id = ?1`);
};

// The column of a read that has the records that use the record in one way: the way at this
// place among the ways.
const usedColumn = (way: WayOfUsing, at: number, nameOf: string) =>
  `${jsonRows(LISTED_FIELDS, usedIn(way, nameOf))} AS used_${at}`;

// The statement that marks the records that have the record `?1` in a link set as changed now,
// in a table that keeps `updated_at`. It runs while they still have it.
const markingChanged = (
  shape: RecordShape,
  { table, from, to }: LinkSet,
): ReadonlyArray<StatementText> => {
  const stamped = updatedNow(shape);
  return stamped.length === 0
    ? []
    : [
        `UPDATE ${shape.table} SET ${stamped.join(", ")}
          WHERE id IN (SELECT ${from} FROM ${table} WHERE ${to} = ?1)`,
      ];
};

// The statements by which the record `?1` comes off the records that have it in a link set:
// the links go. A foreign key would drop them on its own when the record went, with no Change
// to say that those records lost it. So these run first, each as a step about those records.
// Nothing here says what a column holds once the record it points at is deleted. So a type
// that joins `records.ts` with a column that points at a record of a type that takes no
// replacement stops the module from loading, until this does.
const comingOffTexts = (way: WayOfUsing): ReadonlyArray<StatementText> => {
  if (way.by === "column") {
    throw new Error(
      `${way.shape.table} points at a record in ${way.column}, and nothing says what it holds once that record is deleted.`,
    );
  }
  const { table, to } = way.set;
  return [...markingChanged(way.shape, way.set), `DELETE FROM ${table} WHERE ${to} = ?1`].map(
    compact,
  );
};

// The statements that point the records that use the record `?1` in one way at the
// replacement `?2` instead. A record keeps the replacement once, however many times it would
// then have it. One that has both in a link set keeps its link to the replacement, and the
// other link goes. And a record that has one in a column of its row never has the same one
// in a link set as well: an Item's primary Category is never an extra one. So where the
// column and a link would come to say the same, the link goes first.
const repointingTexts = (way: WayOfUsing): ReadonlyArray<StatementText> => {
  const { table, pointerColumns, links } = way.shape;
  if (way.by === "column") {
    const { column } = way;
    return [
      ...links
        .filter((set) => set.of === way.targetType)
        .map(
          (set) => `DELETE FROM ${set.table} WHERE ${set.to} = ?2
                       AND ${set.from} IN (SELECT id FROM ${table} WHERE ${column} = ?1)`,
        ),
      `UPDATE ${table} SET ${[`${column} = ?2`, ...updatedNow(way.shape)].join(", ")}
        WHERE ${column} = ?1`,
    ].map(compact);
  }
  const { set } = way;
  return [
    ...markingChanged(way.shape, set),
    ...Object.entries(pointerColumns)
      .filter(([, pointedAt]) => pointedAt === way.targetType)
      .map(
        ([column]) => `DELETE FROM ${set.table} WHERE ${set.to} = ?1
                          AND ${set.from} IN (SELECT id FROM ${table} WHERE ${column} = ?2)`,
      ),
    `UPDATE OR IGNORE ${set.table} SET ${set.to} = ?2 WHERE ${set.to} = ?1`,
    `DELETE FROM ${set.table} WHERE ${set.to} = ?1`,
  ].map(compact);
};

// The statement that puts the Notes on the record `?1` of a type on the replacement `?2`. A
// Note is at the Property of the record it is on. A replacement is at the same Property as
// the record it stands in for, or both are at none, so a Note is where it should be already.
const reattachingNotesText = (type: Replaceable): StatementText =>
  compact(`
    UPDATE ${SHAPES.note.table} SET ${NOTE_ON.idColumn} = ?2
     WHERE ${NOTE_ON.typeColumn} = '${type}' AND ${NOTE_ON.idColumn} = ?1`);

// The statements that remove the rows of the records of a type whose ids are in the JSON list
// `?1`: what each has in its link sets, and then its own row. A foreign key would empty the
// sets on its own. A delete leans on no key that acts.
const removingRows = ({ table, links }: RecordShape): ReadonlyArray<StatementText> =>
  [
    ...links.map(
      (set) => `DELETE FROM ${set.table} WHERE ${set.from} IN (SELECT value FROM json_each(?1))`,
    ),
    `DELETE FROM ${table} WHERE id IN (SELECT value FROM json_each(?1))`,
  ].map(compact);

const REMOVING_ROWS = Object.fromEntries(
  EACH_TYPE.map(([type, shape]) => [type, removingRows(shape)]),
) as Readonly<Record<RecordType, ReadonlyArray<StatementText>>>;

// What a delete with no replacement is made of, for a record of one type, built once.
interface Deletion {
  /** Every way a record of the type is used. */
  readonly ways: ReadonlyArray<WayOfUsing>;
  /** The one read it makes of the record `?1`, as `readOf` builds it. */
  readonly read: StatementText;
  /**
   * For each way, the statements by which the record comes off what uses it. There are none
   * for a type that takes a replacement: one of those that is in use is refused.
   */
  readonly comingOff: ReadonlyArray<ReadonlyArray<StatementText>>;
}

const deletionOf = (type: Deletable, shape: RecordShape): Deletion => {
  const ways = waysOfUsing(type);
  return {
    ways,
    read: readOf(
      type,
      shape,
      ways.map((way, at) => usedColumn(way, at, nameOfRow(way.shape, "record"))),
    ),
    comingOff: takesReplacement(type) ? [] : ways.map(comingOffTexts),
  };
};

const DELETIONS = Object.fromEntries(
  EACH_TYPE.flatMap(([type, shape]) =>
    isDeletable(type) ? [[type, deletionOf(type, shape)]] : [],
  ),
) as Readonly<Record<Deletable, Deletion>>;

// What a delete with a replacement is made of, for a record of one type that takes one.
interface Merge {
  /** Every way a record of the type is used. */
  readonly ways: ReadonlyArray<WayOfUsing>;
  /**
   * The one read it makes of the record `?1` and the replacement `?2`. Beside what every
   * delete reads, it has the name of the replacement, which is null when there is no such
   * record, the Property each of the two is at, for a type that is at one, and for each way
   * the records that would collide once they are pointed at the replacement. What uses the
   * record is named as it is once the merge is done.
   */
  readonly read: StatementText;
  /** For each way, the statements that point what uses the record at the replacement. */
  readonly repointing: ReadonlyArray<ReadonlyArray<StatementText>>;
  /** The statement that puts the record's Notes on the replacement. */
  readonly reattachingNotes: StatementText;
}

const mergeOf = (type: Replaceable, shape: RecordShape): Merge => {
  const ways = waysOfUsing(type);
  const atProperties = isAtProperty(shape)
    ? [
        `record.${AT_PROPERTY} AS property_id`,
        `${nameInTable("property", `record.${AT_PROPERTY}`)} AS property`,
        `replacement.${AT_PROPERTY} AS replacement_property_id`,
        `${nameInTable("property", `replacement.${AT_PROPERTY}`)} AS replacement_property`,
      ]
    : [];
  const colliding = ways.flatMap((way, at) => {
    const select = collidingIn(way);
    return select === undefined ? [] : [`${jsonRows(COLLISION_FIELDS, select)} AS colliding_${at}`];
  });
  return {
    ways,
    read: readOf(
      type,
      shape,
      ways.map((way, at) => usedColumn(way, at, nameOnceMerged(way))),
      {
        columns: [
          `${nameOfRow(shape, "replacement")} AS replacement_name`,
          ...atProperties,
          ...colliding,
        ],
        join: `LEFT JOIN ${shape.table} AS replacement ON replacement.id = ?2`,
      },
    ),
    repointing: ways.map(repointingTexts),
    reattachingNotes: reattachingNotesText(type),
  };
};

const MERGES = Object.fromEntries(
  REPLACEABLE.map((type) => [type, mergeOf(type, SHAPES[type])]),
) as Readonly<Record<Replaceable, Merge>>;

// The row a delete's read finds: each column is text, or null.
type Found = Readonly<Record<string, string | null>>;

// A list of records a read found, each named as a reply lists it.
const listedIn = (list: string | null | undefined) => rowsIn<Listed>(list).map(asListed);

// What either read found of the record: the record itself, what goes with it, the Notes on
// any of those, and the records that use it, for each way and all together.
const whatWasFound = (
  type: Deletable,
  id: string,
  found: Found,
  ways: ReadonlyArray<WayOfUsing>,
) => {
  const record = asListed({ type, id, name: found.name ?? "" });
  const usedPerWay = ways.map((_, at) => listedIn(found[`used_${at}`]));
  return {
    record,
    // The record itself is among the records that go. These are the others.
    goesToo: listedIn(found.going).filter((each) => recordKey(each) !== recordKey(record)),
    notes: listedIn(found.notes),
    usedPerWay,
    usedBy: distinctRecords(usedPerWay.flat()),
  };
};

// How many there are of something, as an error says it: 1 Schedule, 2 Documents.
const counted = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

// What only a delete of a Category is refused for, before anything else is read of it. The
// Category an Item is in by default stays. A Category has to be there, and one that is not
// is an error that lists the closest, as it is for a save. And what is under a Category goes
// under its replacement, so a replacement that is under it, however far down, would end up
// under itself.
const refuseCategory = Effect.fnUntraced(function* (id: string, replacement?: string) {
  if (id === DEFAULT_CATEGORY) {
    return yield* new ToolError({ message: NEVER_THE_DEFAULT_CATEGORY });
  }
  const categories = yield* everyCategory;
  const category = yield* categoryAmong(id, categories);
  if (replacement === undefined) return;
  const other = yield* categoryAmong(replacement, categories);
  if (!isUnder(other.id, category.id, categories)) return;
  return yield* notDeleted(
    `the ${named({ type: "category", ...other })} is under the ${named({ type: "category", ...category })}. What is under a Category goes under its replacement, so that one would be under itself. Give a replacement that is not under it.`,
  );
});

// Refuses a delete that would take out a record with a Schedule or a Document on it.
const refuseScheduleOrDocument = (found: Found) => {
  const having = rowsIn<WithScheduleOrDocument>(found.schedules_and_documents);
  if (having.length === 0) return Effect.void;
  const lines = having.map(({ schedules, documents, ...record }) => {
    const has = [
      ...(schedules > 0 ? [counted(schedules, term("schedule"))] : []),
      ...(documents > 0 ? [counted(documents, term("document"))] : []),
    ];
    return `The ${named(record)} has ${has.join(" and ")}.`;
  });
  return Effect.fail(
    notDeleted(
      `a record with a Schedule or a Document on it cannot be deleted yet. No tool writes those yet, so no Change would say what became of them:\n${lines.join("\n")}`,
    ),
  );
};

// Refuses a delete of a record while others use it, when it names no replacement for them to
// use instead. A foreign key would turn it away with no word on what is in the way.
const refuseWhileUsed = (record: Listed, usedBy: ReadonlyArray<Listed>) =>
  usedBy.length === 0
    ? Effect.void
    : Effect.fail(
        notDeleted(
          `the ${named(record)} is used by ${someOf(usedBy)}. To delete it all the same, give \`replacement\` the id of the ${term(record.type)} they should use instead. They are then pointed at that one, and this one is deleted, in one Change.`,
        ),
      );

// Refuses a replacement that is at another Property than the record it would stand in for.
// Nothing in the database would turn it away.
const refuseElsewhere = (record: Listed, replacement: Listed, found: Found) =>
  found.property_id === found.replacement_property_id
    ? Effect.void
    : Effect.fail(
        notDeleted(
          `the ${named(record)} is at ${found.property}, and the ${named(replacement)} is at ${found.replacement_property}. A replacement for a ${term(record.type)} is a ${term(record.type)} at the same Property.`,
        ),
      );

// Refuses a merge that would point two records at the replacement where there can be one. A
// unique index would turn it away with no word on which two.
const refuseCollisions = (record: Listed, ways: ReadonlyArray<WayOfUsing>, found: Found) => {
  const collisions = ways.flatMap((way, at) =>
    rowsIn<Collision>(found[`colliding_${at}`]).map(({ holder_id, holder_name, ...mine }) => ({
      way,
      mine,
      holder: { type: mine.type, id: holder_id, name: holder_name },
    })),
  );
  if (collisions.length === 0) return Effect.void;
  const rules = new Set(
    collisions.map(
      ({ way }) =>
        `A ${term(way.type)} cannot have the same ${sharedByNone(way.shape)} as another.`,
    ),
  );
  const pairs = collisions.map(
    ({ mine, holder }) => `The ${named(mine)} and the ${named(holder)}.`,
  );
  return Effect.fail(
    notDeleted(
      `two records would then be one and the same. ${[...rules].join(" ")}\n${pairs.join("\n")}\nDelete one of the two first, or point it elsewhere, and then delete the ${named(record)}.`,
    ),
  );
};

// What a delete is about to write, and what its reply says of it.
interface Removal {
  readonly steps: ReadonlyArray<Step>;
  readonly removed: ReadonlyArray<Listed>;
  readonly updated: ReadonlyArray<Listed>;
}

// Statements as steps: each handed over with each record it is about, so that every row that
// goes or changes is in the Change. A statement is given as many of the values, from the
// first, as it has numbered parameters.
const stepsAboutEach = (
  sql: SqlClient.SqlClient,
  records: ReadonlyArray<Listed>,
  texts: ReadonlyArray<StatementText>,
  values: ReadonlyArray<unknown>,
) =>
  texts.flatMap((text) => {
    const most = values.findLastIndex((_, at) => text.includes(`?${at + 1}`)) + 1;
    return stepsAbout(records, sql.unsafe(text, values.slice(0, most)));
  });

// The steps that remove these records. Rows go out with a type before the types it points at.
const stepsRemoving = (sql: SqlClient.SqlClient, removed: ReadonlyArray<Listed>) =>
  EACH_TYPE.toReversed().flatMap(([type]) => {
    const ofType = removed.filter((each) => each.type === type);
    const theirIds = JSON.stringify(ofType.map((each) => each.id));
    return stepsAboutEach(sql, ofType, REMOVING_ROWS[type], [theirIds]);
  });

// A delete with no replacement. The record comes off what uses it, and goes with its Notes
// and with what cannot stay without it. Everything is checked before anything is written.
const deletingAlone = Effect.fnUntraced(function* (type: Deletable, id: string) {
  const sql = yield* SqlClient.SqlClient;
  const { ways, read, comingOff } = DELETIONS[type];
  const [found] = yield* sql.unsafe<Found>(read, [id]);
  if (found === undefined) return yield* noRecord(type, id);
  const { record, goesToo, notes, usedPerWay, usedBy } = whatWasFound(type, id, found, ways);

  yield* refuseScheduleOrDocument(found);
  if (takesReplacement(type)) yield* refuseWhileUsed(record, usedBy);

  const removed = [record, ...goesToo, ...notes];
  const removedKeys = new Set(removed.map(recordKey));
  return {
    steps: [
      ...comingOff.flatMap((texts, at) => stepsAboutEach(sql, usedPerWay[at] ?? [], texts, [id])),
      ...stepsRemoving(sql, removed),
    ],
    removed,
    // Work that goes with its Item lost the Item first. It is listed once, as removed.
    updated: usedBy.filter((each) => !removedKeys.has(recordKey(each))),
  } satisfies Removal;
});

// A delete with a replacement, which is a merge. What uses the record is pointed at the
// replacement, the record's Notes are put on it, and then the record goes. Nothing the record
// held itself is copied, and no row of the replacement is written.
const mergingInto = Effect.fnUntraced(function* (
  type: Replaceable,
  id: string,
  replacement: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const { ways, read, repointing, reattachingNotes } = MERGES[type];
  const both = [id, replacement];
  const [found] = yield* sql.unsafe<Found>(read, both);
  if (found === undefined) return yield* noRecord(type, id);
  const { record, notes, usedPerWay, usedBy } = whatWasFound(type, id, found, ways);

  yield* refuseScheduleOrDocument(found);
  if (found.replacement_name == null) return yield* noRecord(type, replacement);
  const other: Listed = { type, id: replacement, name: found.replacement_name };
  yield* refuseElsewhere(record, other, found);
  yield* refuseCollisions(record, ways, found);

  return {
    steps: [
      ...repointing.flatMap((texts, at) => stepsAboutEach(sql, usedPerWay[at] ?? [], texts, both)),
      ...stepsAboutEach(sql, notes, [reattachingNotes], both),
      ...stepsRemoving(sql, [record]),
    ],
    removed: [record],
    updated: [...usedBy, ...notes],
  } satisfies Removal;
});

export const deleteRecord = defineTool({
  name: "delete_record",
  description: DESCRIPTION,
  input: Schema.Struct({
    type: Schema.Literals(RECORD_TYPES).annotate({
      description: "What kind of record it is. A Property is never deleted.",
    }),
    id: Schema.String.annotate({
      description:
        "The record's id, as search or get_record gives it. A Category's id is its slug, which get_schema lists. A Quote's id is in the record of its Project.",
    }),
    replacement: optional(
      Schema.String.annotate({
        description:
          "The id of another record of the same type, which everything that uses this one is pointed at instead. Only a Vendor, a Space, a Category, or a Project takes one. Leave it out to delete a record that nothing uses.",
      }),
    ),
  }),
  annotations: ANNOTATIONS,
  run: ({ type, id, replacement }) =>
    Effect.gen(function* () {
      if (!isDeletable(type)) return yield* new ToolError({ message: NEVER_A_PROPERTY });

      const removal = Effect.gen(function* () {
        if (replacement === undefined) {
          if (type === "category") yield* refuseCategory(id);
          return yield* deletingAlone(type, id);
        }
        if (!takesReplacement(type)) return yield* new ToolError({ message: NO_REPLACEMENT });
        if (replacement === id) {
          return yield* new ToolError({
            message: `A ${term(type)} cannot be its own replacement. Give \`replacement\` the id of another ${term(type)}, or leave it out.`,
          });
        }
        if (type === "category") yield* refuseCategory(id, replacement);
        return yield* mergingInto(type, id, replacement);
      });

      const { steps, removed, updated } = yield* removal;
      const change = yield* (yield* Write).run(steps);
      return { change_id: change, removed, updated };
    }),
});
