import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { storedObject, type JsonObject } from "../output.ts";
import { propertyFor } from "../property.ts";
import { nameText } from "../save.ts";
import { compact, jsonList, jsonRows, rowsIn } from "../sql.ts";
import { defineTool, noRecord, optional, ToolError } from "../tool.ts";
import { fromProperty, NOT_GONE } from "./get-record.ts";
import type { DATA_KEYS } from "./get-schema.ts";

// The most Items a reply shows, and the most pieces of Work. A Property can have hundreds of
// each with something missing, and a client's context is not the place for all of them. The
// counts are of every one, shown or not. The Spaces are not cut: a Property has few.
const MOST_SHOWN = 50;

// The characters that are nothing in a text: a space, a tab, and the two that break a line. An
// Item's keys are checked in SQL and a Space's in code, and both go by this one list. The
// statement is handed it as a value, because `compact` would make one space of it.
const BLANKS = " \t\n\r";

// A character of a text that is not one of them.
const NOT_BLANK = new RegExp(`[^${BLANKS}]`);

// Whether there is something under a key of an Item's `data`, where `own` is the key's row of
// `json_each`. A key can be there with nothing under it: a null, text that is all blanks, or an
// object or a list with nothing in it, which is what a merge patch leaves behind when it takes
// out a list's last entry. A zero and a false are facts. `somethingIn` below is the same rule
// for a Space, whose `data` is read in code.
const KEY_HAS_SOMETHING = `CASE own.type
                             WHEN 'null' THEN 0
                             WHEN 'text' THEN trim(own.value, ?3) <> ''
                             WHEN 'object' THEN own.value <> '{}'
                             WHEN 'array' THEN own.value <> '[]'
                             ELSE 1
                           END`;

// DIY Work often cost nothing, so only Work that someone was paid for is missing its Cost.
const NO_COST = `(work.diy = 0 AND work.cost_cents IS NULL)`;

// A date that is a year and nothing more. A year and a month is close enough to leave alone.
const DATE_YEAR_ONLY = `coalesce(length(work.date) = 4, 0)`;

// One statement reads everything that is missing at a Property. So a call is two reads, the
// one that finds the Property and this one, however many Items there are. It is given the
// Property's id, the name of the one Space to keep to, or null for every Space, and BLANKS.
//
//   space     the Spaces at the Property, each with its `data`, and whether it has the name
//             that was given. The database compares the name, so case is ignored the same way
//             it is everywhere else
//   held      the Items at the Property that the User still has, in the Space with that name
//             when one was given. Nothing is asked about a Gone Item
//   key_gap   for each of those Items, the `data` keys it has nothing under that one of its
//             Categories expects. `item_in_category` walks the Category tree, so the keys are
//             those of the Item's primary Category, its extra ones, and all their parents.
//             save_category takes a list of names for `expects` and nothing else, and anything
//             else that got there expects nothing
//   item_gap  the Items with something missing. The ones in no Space come first, because no
//             Space can be asked for to see them. The rest go by Space and then by name
//   work_gap  the Work at the Property with something missing, or dated only to the year, newest
//             first by its date as text, with the Work that has no date last. Each has the names
//             of the Spaces it names. When a Space was given, it is the Work that names it
//
// What comes back is one row. It has a JSON column for each list: every Space, with how many of
// its Items have something missing, and the first Items and the first Work, up to the most a
// reply shows. It also has how many there are of each in all.
const GAPS = compact(`
WITH
  space (id, name, data, has_name) AS (
    SELECT id, name, data, coalesce(name = ?2, 0) FROM spaces WHERE property_id = ?1
  ),
  held (id, name, space_id, price_cents, acquired_on, data) AS (
    SELECT item.id, item.name, item.space_id, item.price_cents, item.acquired_on, item.data
      FROM items AS item
     WHERE item.property_id = ?1 AND ${NOT_GONE}
       AND (?2 IS NULL OR item.space_id IN (SELECT id FROM space WHERE has_name))
  ),
  key_gap (item_id, keys) AS (
    SELECT item_id, json_group_array(key)
      FROM (SELECT DISTINCT held.id AS item_id, expected.value AS key
              FROM held
              JOIN item_in_category AS under ON under.item_id = held.id
              JOIN categories AS category ON category.id = under.category_id
              JOIN json_each(category.data, '$.expects') AS expected
             WHERE json_type(category.data, '$.expects') = 'array' AND expected.type = 'text'
               AND NOT EXISTS (SELECT 1 FROM json_each(held.data) AS own
                                WHERE own.key = expected.value AND ${KEY_HAS_SOMETHING}))
     GROUP BY item_id
  ),
  item_gap (id, name, space_id, no_price, no_acquired_on, missing_keys, position) AS (
    SELECT held.id, held.name, space.id,
           held.price_cents IS NULL, held.acquired_on IS NULL, coalesce(key_gap.keys, '[]'),
           row_number() OVER (
             ORDER BY space.id IS NOT NULL, space.name COLLATE NOCASE, space.id,
                      held.name COLLATE NOCASE, held.id
           )
      FROM held
      LEFT JOIN key_gap ON key_gap.item_id = held.id
      LEFT JOIN space ON space.id = held.space_id
     WHERE held.price_cents IS NULL OR held.acquired_on IS NULL OR key_gap.item_id IS NOT NULL
  ),
  work_gap (id, name, no_cost, no_date, date_year_only, spaces, position) AS (
    SELECT work.id, work.title, ${NO_COST}, work.date IS NULL, ${DATE_YEAR_ONLY},
           ${jsonList(
             "name",
             `SELECT space.name FROM work_spaces AS done_in
                JOIN space ON space.id = done_in.space_id
               WHERE done_in.work_id = work.id
               ORDER BY space.name COLLATE NOCASE, space.id`,
           )},
           row_number() OVER (ORDER BY work.date DESC, work.id DESC)
      FROM work
     WHERE work.property_id = ?1 AND (${NO_COST} OR work.date IS NULL OR ${DATE_YEAR_ONLY})
       AND (?2 IS NULL
            OR work.id IN (SELECT work_id FROM work_spaces
                            WHERE space_id IN (SELECT id FROM space WHERE has_name)))
  )
SELECT property.data AS property_data,
       ${jsonRows(
         ["id", "name", "data", "has_name", "item_count"],
         `SELECT space.*,
                 (SELECT count(*) FROM item_gap WHERE item_gap.space_id = space.id) AS item_count
            FROM space ORDER BY space.name COLLATE NOCASE, space.id`,
         ["data"],
       )} AS every_space,
       (SELECT count(*) FROM item_gap) AS item_count,
       ${jsonRows(
         ["id", "name", "space_id", "no_price", "no_acquired_on", "missing_keys"],
         `SELECT * FROM item_gap WHERE position <= ${MOST_SHOWN} ORDER BY position`,
         ["missing_keys"],
       )} AS items,
       (SELECT count(*) FROM work_gap) AS work_count,
       ${jsonRows(
         ["id", "name", "no_cost", "no_date", "date_year_only", "spaces"],
         `SELECT * FROM work_gap WHERE position <= ${MOST_SHOWN} ORDER BY position`,
         ["spaces"],
       )} AS work
  FROM properties AS property
 WHERE property.id = ?1`);

// The one row GAPS returns: each list as JSON text, and how many Items and how many pieces of
// Work there are in all.
interface Row {
  readonly property_data: string;
  readonly every_space: string;
  readonly item_count: number;
  readonly items: string;
  readonly work_count: number;
  readonly work: string;
}

// A Space at the Property, as GAPS reads it.
interface SpaceRow {
  readonly id: string;
  readonly name: string;
  readonly data: JsonObject;
  /** Whether its name is the one that was given, whatever the case. 1 or 0. */
  readonly has_name: number;
  /** How many of the Items in it have something missing, shown or not. */
  readonly item_count: number;
}

// An Item with something missing. Each `no_` is 1 or 0.
interface ItemRow {
  readonly id: string;
  readonly name: string;
  /** The Space it is in, when that is a Space at the Property. */
  readonly space_id: string | null;
  readonly no_price: number;
  readonly no_acquired_on: number;
  readonly missing_keys: ReadonlyArray<string>;
}

// A piece of Work with something missing, or dated only to the year. Each flag is 1 or 0.
interface WorkRow {
  readonly id: string;
  readonly name: string;
  readonly no_cost: number;
  readonly no_date: number;
  readonly date_year_only: number;
  /** The names of the Spaces it names. */
  readonly spaces: ReadonlyArray<string>;
}

// The two facts a Space is asked for: its size and its paint. Each is one of the well-known
// keys of a Space's `data`, which the type holds them to.
type SpaceKey = keyof typeof DATA_KEYS.space;
const SIZE = "sqft" satisfies SpaceKey;
const PAINT = "paint" satisfies SpaceKey;

// Whether there is something under a key of a Space's `data`, by the rule KEY_HAS_SOMETHING
// holds an Item's keys to.
const somethingIn = (value: unknown) => {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return NOT_BLANK.test(value);
  return typeof value !== "object" || Object.keys(value).length > 0;
};

// The fields a Space has nothing in, as save_space takes them. It has paint when get_record
// would show some: its own, or what its Property has for every Space (ADR 0015). Its size is
// its own alone, since a Property's size is the size of no Space.
const missingFromSpace = (own: JsonObject, propertyData: JsonObject) => [
  ...(somethingIn(own[SIZE]) ? [] : [`data.${SIZE}`]),
  ...(somethingIn(own[PAINT]) || somethingIn(fromProperty(own, propertyData)[PAINT])
    ? []
    : [`data.${PAINT}`]),
];

// An Item as the reply shows it: what it is, and the fields it has nothing in, as save_item
// takes them. Its own fields come first, and then the keys of its `data` by name.
const itemEntry = ({ id, name, no_price, no_acquired_on, missing_keys }: ItemRow) => ({
  type: "item",
  id,
  name,
  missing: [
    ...(no_price === 1 ? ["price"] : []),
    ...(no_acquired_on === 1 ? ["acquired_on"] : []),
    ...missing_keys.toSorted().map((key) => `data.${key}`),
  ],
});

// The Items of one Space, or of none, as the reply shows them: the ones that are among the
// first, and a count of the rest when there are more. It is given the first Items of the whole
// reply, and how many this Space has.
const itemsOf = (first: ReadonlyArray<ItemRow>, spaceId: string | null, count: number) => {
  const items = first.filter((item) => item.space_id === spaceId).map(itemEntry);
  return { items, ...(count > items.length ? { more_items: count - items.length } : {}) };
};

// A piece of Work as the reply shows it, with the names of the Spaces it names and the fields it
// has nothing in, as log_work takes them. A date that is only a year is there, so it is not
// missing: it is under `year_only`.
const workEntry = ({ id, name, no_cost, no_date, date_year_only, spaces }: WorkRow) => ({
  type: "work",
  id,
  name,
  spaces,
  missing: [...(no_cost === 1 ? ["cost"] : []), ...(no_date === 1 ? ["date"] : [])],
  ...(date_year_only === 1 ? { year_only: ["date"] } : {}),
});

// The error for a Space that was asked for by a name no Space at the Property has. It lists
// the ones that are there.
const noSuchSpace = (name: string, propertyName: string, everySpace: ReadonlyArray<SpaceRow>) =>
  new ToolError({
    message: `There is no Space "${name}" at ${propertyName}. ${
      everySpace.length === 0
        ? "It has no Spaces yet."
        : `Its Spaces are: ${everySpace.map((space) => space.name).join(", ")}.`
    }`,
  });

const onlyTheFirst = (count: number, what: string) =>
  `Only the first ${MOST_SHOWN} of the ${count} ${what} are here.`;

// How to see the rest of what was cut. Asking for one Space shows what is in it and no more:
// not an Item in no Space, and not Work that names none. A call that asked for one has that
// already. Filling in what is here always works, since a record with nothing missing is left
// out the next time.
const FILL_THESE_IN =
  "fill these in and ask again: a record with nothing missing is left out, so the next ones come up.";
const theRest = (oneSpace: boolean) =>
  oneSpace
    ? `To see the rest, ${FILL_THESE_IN}`
    : `Give \`space\` the name of a Space to see the Items in it and the Work that names it. For anything else, ${FILL_THESE_IN}`;

const DESCRIPTION = `Says what is missing at a Property, grouped by Space, so that the User can be asked about it and the answers saved. walk_the_house is the script that uses it: an interview that goes through a Property one Space at a time.

Give \`property\` its id or its name, or leave it out for the one Current property. \`space\` narrows the reply to one Space, by its name: what the Space is missing itself, the Items in it, and the Work that names it.

What counts as missing:
- An Item with nothing under a \`data\` key that one of its Categories expects. An Item is expected to have the keys of every Category it sits under: its primary Category, its extra ones, and all their parents. get_schema shows what each Category expects.
- An Item with no Price, or with no \`acquired_on\`.
- Work that is not DIY and has no Cost, and Work with no date, DIY or not.
- A Space with no size, which is \`${SIZE}\` in its \`data\`, or with no paint. Paint that its Property has for every Space counts as the Space's.

Work dated only to the year comes back too. A year is a date, so it is not in \`missing\`: the piece has \`year_only\`, which names \`date\`. Ask for the month. Only the Items the User still has are looked at, so a Gone Item is left out.

The reply starts with \`counts\`: how many Items, pieces of Work, and Spaces have something to fill in themselves, whether or not the reply shows them. \`spaces\` has each Space that is missing something or has such an Item in it, by name, with the Space's own \`missing\` and its \`items\`. \`no_space\` has the Items in no Space. \`work\` is a list of its own, newest first, and each piece has the names of the \`spaces\` it names. Every entry has the record's type, id, and name. \`missing\` has the fields to fill in, as the save tools take them: \`price\` and \`acquired_on\` for save_item, \`cost\` and \`date\` for log_work, and a key of \`data\` as \`data.model\` or \`data.${SIZE}\`.

At most ${MOST_SHOWN} Items and ${MOST_SHOWN} pieces of Work come back. The Items in no Space come first, because no Space can be asked for to see them, and the rest go by Space and then by name. \`more_items\` counts the rest of a Space's, \`more_work\` the rest of the Work, and \`note\` says how to see them.`;

export const gaps = defineTool({
  name: "gaps",
  description: DESCRIPTION,
  input: Schema.Struct({
    property: optional(
      nameText(
        "The Property to look at, by its id or its name. Leave it out for the one Current property.",
      ),
    ),
    space: optional(
      nameText(
        "Only this Space, by its name: what it is missing itself, the Items in it, and the Work that names it. Leave it out for the whole Property.",
      ),
    ),
  }),
  annotations: { readOnlyHint: true },
  run: ({ property: given, space: spaceName }) =>
    Effect.gen(function* () {
      const property = yield* propertyFor(given);
      const sql = yield* SqlClient.SqlClient;
      const [row] = yield* sql.unsafe<Row>(GAPS, [property.id, spaceName ?? null, BLANKS]);
      // The Property was found a moment ago, and no tool deletes one.
      if (row === undefined) return yield* noRecord("property", property.id);

      const oneSpace = spaceName !== undefined;
      const everySpace = rowsIn<SpaceRow>(row.every_space);
      const lookedAt = oneSpace ? everySpace.filter((space) => space.has_name === 1) : everySpace;
      if (oneSpace && lookedAt.length === 0) {
        return yield* noSuchSpace(spaceName, property.name, everySpace);
      }
      const items = rowsIn<ItemRow>(row.items);
      const work = rowsIn<WorkRow>(row.work);

      // A Space comes back when it is missing something itself, or an Item in it is.
      const propertyData = storedObject(row.property_data);
      const spaces = lookedAt.flatMap((space) => {
        const missing = missingFromSpace(space.data, propertyData);
        if (missing.length === 0 && space.item_count === 0) return [];
        const shown = itemsOf(items, space.id, space.item_count);
        return [{ type: "space", id: space.id, name: space.name, missing, ...shown }];
      });
      // The Items in no Space are the ones that are in none of the Spaces.
      const inSpaces = everySpace.reduce((sum, space) => sum + space.item_count, 0);

      const moreWork = row.work_count - work.length;
      const remarks = [
        ...(row.item_count > items.length ? [onlyTheFirst(row.item_count, "Items")] : []),
        ...(moreWork > 0 ? [onlyTheFirst(row.work_count, "pieces of Work")] : []),
      ];
      return {
        counts: {
          items: row.item_count,
          work: row.work_count,
          spaces: spaces.filter((space) => space.missing.length > 0).length,
        },
        property: property.name,
        spaces,
        // The Items in no Space are part of the whole Property, and of no one Space.
        ...(oneSpace ? {} : { no_space: itemsOf(items, null, row.item_count - inSpaces) }),
        work: work.map(workEntry),
        ...(moreWork > 0 ? { more_work: moreWork } : {}),
        ...(remarks.length > 0 ? { note: [...remarks, theRest(oneSpace)].join(" ") } : {}),
      };
    }),
});
