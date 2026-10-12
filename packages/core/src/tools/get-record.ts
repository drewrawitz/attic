import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { formatRow, storedJson } from "../output.ts";
import { propertyNamed } from "../property.ts";
import type { RecordType } from "../records.ts";
import { jsonList, jsonObject } from "../sql.ts";
import { defineTool, ToolError } from "../tool.ts";
import { FROM_PROPERTY_KEYS } from "./get-schema.ts";

// The types of record there are to get. A Quote is not one: it comes back with its Project.
const TYPES = [
  "property",
  "space",
  "item",
  "work",
  "project",
  "vendor",
  "document",
  "schedule",
  "note",
] as const;
type Type = (typeof TYPES)[number];

// The most entries a list on a record has. Each list is read for one more, which is how a list
// that was cut is told from one that just fits.
const MOST_ENTRIES = 50;

// Changes are kept forever, so a record comes back with only its latest few. The rest of the log
// is there for `query`.
const RECENT_CHANGES = 5;

// One statement reads a record with everything that hangs off it, so a call is one D1 query.
// Each list is a JSON column that a subquery builds, and the pieces below are those subqueries.
// Every statement names the record it reads `record`, and a list picks its rows by `record.id`.

// The fields that hold JSON text. In a list they go in as JSON, not as a string of it.
const JSON_FIELDS = new Set(["data", "last_work", "before", "after"]);

// One entry of a list: an object with these fields, each read from the column of that name.
const entry = (fields: ReadonlyArray<string>) =>
  jsonObject(fields.map((field) => [field, JSON_FIELDS.has(field) ? `json(${field})` : field]));

// A list that hangs off the record, as one JSON column: an entry for each of the first rows of
// `rows`, in the order `rows` puts them. The entries are built outside `rows`, because a JSON
// value that passes through a subquery comes out as plain text.
const list = (name: string, fields: ReadonlyArray<string>, rows: string, most = MOST_ENTRIES + 1) =>
  `${jsonList(entry(fields), `${rows} LIMIT ${most}`)} AS ${name}`;

// Picks the rows attached to the record in a table that points at a record by its type and id:
// Notes, the links of Documents, and the records of Changes.
const onRecord = (type: Type) => `entity_type = '${type}' AND entity_id = record.id`;

// Work as a list shows it, newest first by its date as text. It says which Property it was at,
// because a Vendor may have been used at a former one, and a Belonging moves with the User.
const WORK_FIELDS = [
  "id",
  "kind",
  "title",
  "date",
  "cost_cents",
  "diy",
  "property",
  "vendor",
  "vendor_id",
];
const workRows = (where: string) => `
  SELECT work.id, work.kind, work.title, work.date, work.cost_cents, work.diy,
         property.name AS property, vendor.name AS vendor, work.vendor_id
    FROM work
    LEFT JOIN properties AS property ON property.id = work.property_id
    LEFT JOIN vendors AS vendor ON vendor.id = work.vendor_id
   WHERE ${where}
   ORDER BY work.date DESC, work.id DESC`;
const work = (where: string) => list("work", WORK_FIELDS, workRows(where));

// Schedules, the one due soonest first. Each comes with the last Work logged against it. The
// Vendor on that Work is where a Part was bought last.
const schedules = (where: string) =>
  list(
    "schedules",
    ["id", "title", "interval_days", "last_done_on", "next_due_on", "active", "data", "last_work"],
    `SELECT schedule.*,
            (SELECT ${entry(WORK_FIELDS)}
               FROM (${workRows("work.schedule_id = schedule.id")} LIMIT 1)) AS last_work
       FROM schedules AS schedule
      WHERE ${where}
      ORDER BY schedule.next_due_on, schedule.title COLLATE NOCASE, schedule.id`,
  );

// Items as a list shows them, by name.
const items = (where: string) =>
  list(
    "items",
    ["id", "name", "scope", "status", "category"],
    `SELECT item.id, item.name, item.scope, item.status, category.name AS category
       FROM items AS item
       JOIN categories AS category ON category.id = item.category_id
      WHERE ${where}
      ORDER BY item.name COLLATE NOCASE, item.id`,
  );

// A Gone Item keeps its row for the money trail. It is no longer in a Space or at a Property.
const NOT_GONE = `item.status IN ('active', 'listed')`;

// Spaces as a list shows them, by name.
const spaces = (where: string) =>
  list(
    "spaces",
    ["id", "name"],
    `SELECT space.id, space.name FROM spaces AS space
      WHERE ${where}
      ORDER BY space.name COLLATE NOCASE, space.id`,
  );

// Projects as a list shows them. The ones with a start date come first, newest first.
const projects = (where: string) =>
  list(
    "projects",
    ["id", "title", "status", "start_on", "end_on"],
    `SELECT project.id, project.title, project.status, project.start_on, project.end_on
       FROM projects AS project
      WHERE ${where}
      ORDER BY project.start_on DESC, project.title COLLATE NOCASE, project.id`,
  );

// Quotes, newest first. A Project's Quotes each name their Vendor, and a Vendor's Quotes each
// name their Project.
const quotes = (where: string, names: "vendor" | "project") =>
  list(
    "quotes",
    ["id", names, `${names}_id`, "amount_cents", "quoted_on", "data"],
    `SELECT quote.id, quote.project_id, project.title AS project,
            quote.vendor_id, vendor.name AS vendor, quote.amount_cents, quote.quoted_on, quote.data
       FROM quotes AS quote
       JOIN projects AS project ON project.id = quote.project_id
       JOIN vendors AS vendor ON vendor.id = quote.vendor_id
      WHERE ${where}
      ORDER BY quote.quoted_on DESC, vendor.name COLLATE NOCASE, quote.id`,
  );

// The Documents attached to the record, without their text. The dated ones come first, newest
// first.
const documents = (type: Type) =>
  list(
    "documents",
    ["id", "kind", "title", "doc_date", "total_cents", "vendor"],
    `SELECT document.id, document.kind, document.title, document.doc_date, document.total_cents,
            vendor.name AS vendor
       FROM document_links AS link
       JOIN documents AS document ON document.id = link.document_id
       LEFT JOIN vendors AS vendor ON vendor.id = document.vendor_id
      WHERE ${onRecord(type)}
      ORDER BY document.doc_date DESC, document.title COLLATE NOCASE, document.id`,
  );

// Notes, newest first.
const notes = (where: string) =>
  list(
    "notes",
    ["id", "body", "created_at"],
    `SELECT id, body, created_at FROM notes
      WHERE ${where}
      ORDER BY created_at DESC, id DESC`,
  );

// The Changes that touched the record, newest first, each with the record as it was before and
// after.
const changes = (type: Type) =>
  list(
    "changes",
    ["id", "tool", "created_at", "undoes", "before", "after"],
    `SELECT change.id, change.tool, change.created_at, change.undoes, touched.before, touched.after
       FROM change_records AS touched
       JOIN changes AS change ON change.id = touched.change_id
      WHERE ${onRecord(type)}
      ORDER BY change.created_at DESC, change.id DESC`,
    RECENT_CHANGES,
  );

// What a Note or a Document is attached to: the type and id of each record, and its name or
// title. `links` is a SELECT of the type and the id.
const attachedTo = (links: string) =>
  list(
    "attached_to",
    ["type", "id", "name"],
    `SELECT type, id,
            CASE type
              WHEN 'item' THEN (SELECT name FROM items WHERE items.id = link.id)
              WHEN 'work' THEN (SELECT title FROM work WHERE work.id = link.id)
              WHEN 'vendor' THEN (SELECT name FROM vendors WHERE vendors.id = link.id)
              WHEN 'property' THEN (SELECT name FROM properties WHERE properties.id = link.id)
              WHEN 'space' THEN (SELECT name FROM spaces WHERE spaces.id = link.id)
              WHEN 'project' THEN (SELECT title FROM projects WHERE projects.id = link.id)
            END AS name
       FROM (${links}) AS link
      ORDER BY type, id`,
  );

// What builds the statement that reads a record of each type. Each is handed its own type, so
// the lists that point at a record by type and id cannot be given another record's. A column that
// points at another record has that record's name or title beside it.
const STATEMENTS: Readonly<Record<Type, (type: Type) => string>> = {
  // A Property is found by its id or by its name. Its Notes are the ones that stand alone at
  // it: a Note cannot be attached to a Property.
  property: (type) => `
    SELECT record.id, record.name, record.tenure, record.address,
           record.start_on, record.end_on, record.data,
           ${spaces("space.property_id = record.id")},
           ${projects("project.property_id = record.id")},
           ${schedules("schedule.property_id = record.id")},
           ${items(`item.property_id = record.id AND ${NOT_GONE}`)},
           ${work("work.property_id = record.id")},
           ${documents(type)},
           ${notes("property_id = record.id AND entity_type IS NULL")},
           ${changes(type)},
           record.created_at, record.updated_at
      FROM properties AS record
     WHERE record.id = ?1 OR record.name = ?1`,

  // `from_property` is read as the whole of the Property's `data`. `showingFromProperty` below
  // keeps the part of it that is the same in every Space and that the Space has no entry of its
  // own for.
  space: (type) => `
    SELECT record.id, record.name, record.property_id, property.name AS property,
           record.data, property.data AS from_property,
           ${items(`item.space_id = record.id AND ${NOT_GONE}`)},
           ${work("work.id IN (SELECT work_id FROM work_spaces WHERE space_id = record.id)")},
           ${projects("project.id IN (SELECT project_id FROM project_spaces WHERE space_id = record.id)")},
           ${documents(type)},
           ${notes(onRecord(type))},
           ${changes(type)}
      FROM spaces AS record
      JOIN properties AS property ON property.id = record.property_id
     WHERE record.id = ?1`,

  // An Item's Parts are in its `data`. A Schedule on the Item says when a Part was last changed
  // and where it was bought. Work logged against one of its Schedules is Work on the Item,
  // whether or not it names the Item as well.
  item: (type) => `
    SELECT record.id, record.name, record.scope, record.status, record.status_on,
           record.property_id, property.name AS property,
           record.space_id, space.name AS space,
           record.category_id, category.name AS category,
           ${list(
             "extra_categories",
             ["id", "name"],
             `SELECT category.id, category.name
                FROM item_categories AS extra
                JOIN categories AS category ON category.id = extra.category_id
               WHERE extra.item_id = record.id
               ORDER BY category.name COLLATE NOCASE, category.id`,
           )},
           record.acquired_on, record.price_cents,
           record.vendor_id, vendor.name AS bought_from,
           record.proceeds_cents, record.data,
           ${schedules("schedule.item_id = record.id")},
           ${work(`work.id IN (SELECT work_id FROM work_items WHERE item_id = record.id)
                   OR work.schedule_id IN (SELECT id FROM schedules WHERE item_id = record.id)`)},
           ${documents(type)},
           ${notes(onRecord(type))},
           ${changes(type)},
           record.created_at, record.updated_at
      FROM items AS record
      JOIN categories AS category ON category.id = record.category_id
      LEFT JOIN properties AS property ON property.id = record.property_id
      LEFT JOIN spaces AS space ON space.id = record.space_id
      LEFT JOIN vendors AS vendor ON vendor.id = record.vendor_id
     WHERE record.id = ?1`,

  work: (type) => `
    SELECT record.id, record.kind, record.title, record.description, record.date,
           record.cost_cents, record.diy,
           record.property_id, property.name AS property,
           record.project_id, project.title AS project,
           record.vendor_id, vendor.name AS vendor,
           record.schedule_id, schedule.title AS schedule,
           record.data,
           ${items("item.id IN (SELECT item_id FROM work_items WHERE work_id = record.id)")},
           ${spaces("space.id IN (SELECT space_id FROM work_spaces WHERE work_id = record.id)")},
           ${documents(type)},
           ${notes(onRecord(type))},
           ${changes(type)},
           record.created_at, record.updated_at
      FROM work AS record
      LEFT JOIN properties AS property ON property.id = record.property_id
      LEFT JOIN projects AS project ON project.id = record.project_id
      LEFT JOIN vendors AS vendor ON vendor.id = record.vendor_id
      LEFT JOIN schedules AS schedule ON schedule.id = record.schedule_id
     WHERE record.id = ?1`,

  // A Project's total is the sum of the Costs of its Work, and null while none has a Cost: 0
  // would say the Work cost nothing. Its Quotes are not part of it.
  project: (type) => `
    SELECT record.id, record.title, record.status, record.start_on, record.end_on,
           record.property_id, property.name AS property, record.data,
           ${spaces("space.id IN (SELECT space_id FROM project_spaces WHERE project_id = record.id)")},
           ${quotes("quote.project_id = record.id", "vendor")},
           (SELECT sum(cost_cents) FROM work WHERE project_id = record.id) AS total_cost_cents,
           ${work("work.project_id = record.id")},
           ${documents(type)},
           ${notes(onRecord(type))},
           ${changes(type)},
           record.created_at, record.updated_at
      FROM projects AS record
      JOIN properties AS property ON property.id = record.property_id
     WHERE record.id = ?1`,

  // The Items are the ones bought from the Vendor, Gone Items included.
  vendor: (type) => `
    SELECT record.id, record.name, record.role, record.data,
           ${work("work.vendor_id = record.id")},
           ${quotes("quote.vendor_id = record.id", "project")},
           ${items("item.vendor_id = record.id")},
           ${documents(type)},
           ${notes(onRecord(type))},
           ${changes(type)},
           record.created_at, record.updated_at
      FROM vendors AS record
     WHERE record.id = ?1`,

  // The file itself stays where it is. What comes back is the Document's index card and its
  // text.
  document: (type) => `
    SELECT record.id, record.kind, record.status, record.title, record.doc_date,
           record.total_cents,
           record.property_id, property.name AS property,
           record.vendor_id, vendor.name AS vendor,
           record.source, record.mime_type, record.size_bytes, record.text, record.data,
           ${attachedTo(`SELECT entity_type AS type, entity_id AS id
                           FROM document_links WHERE document_id = record.id`)},
           ${changes(type)},
           record.received_at, record.updated_at
      FROM documents AS record
      LEFT JOIN properties AS property ON property.id = record.property_id
      LEFT JOIN vendors AS vendor ON vendor.id = record.vendor_id
     WHERE record.id = ?1`,

  // A Schedule is on a Property or on an Item, never both.
  schedule: (type) => `
    SELECT record.id, record.title, record.interval_days, record.last_done_on,
           record.next_due_on, record.active,
           record.property_id, property.name AS property,
           record.item_id, item.name AS item,
           record.data,
           ${work("work.schedule_id = record.id")},
           ${changes(type)}
      FROM schedules AS record
      LEFT JOIN properties AS property ON property.id = record.property_id
      LEFT JOIN items AS item ON item.id = record.item_id
     WHERE record.id = ?1`,

  // A Note is attached to one record or to none.
  note: (type) => `
    SELECT record.id, record.body,
           record.property_id, property.name AS property, record.data,
           ${attachedTo(`SELECT record.entity_type AS type, record.entity_id AS id
                          WHERE record.entity_type IS NOT NULL`)},
           ${changes(type)},
           record.created_at
      FROM notes AS record
      LEFT JOIN properties AS property ON property.id = record.property_id
     WHERE record.id = ?1`,
};

// The statement that reads a record of each type, built once. Each is given the record's id and
// returns one row, or none when there is no such record.
const RECORDS = Object.fromEntries(TYPES.map((type) => [type, STATEMENTS[type](type)])) as Readonly<
  Record<Type, string>
>;

type JsonObject = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// What a Space shows of its Property's `data`: only the keys that are marked as the same in
// every Space. Every other key stays on the Property, whose size is not the size of any Space
// (ADR 0015). Under a marked key, a Space with no entry of its own shows all of the Property's.
// Where both have an entry and both entries are objects, the Space shows the objects
// inside the Property's that it has none of its own for. A list kept by slug is an object of
// objects (ADR 0002), such as paint by surface, so a Space with wall paint of its own still shows
// the Property's trim. Anything else inside an entry is the Space's own to say: its flooring is
// never topped up from the Property's.
const fromProperty = (own: JsonObject, propertyData: JsonObject): JsonObject =>
  Object.fromEntries(
    FROM_PROPERTY_KEYS.flatMap((key): [string, unknown][] => {
      if (!Object.hasOwn(propertyData, key)) return [];
      const theirs = propertyData[key];
      if (!Object.hasOwn(own, key)) return [[key, theirs]];
      const mine = own[key];
      if (!isObject(mine) || !isObject(theirs)) return [];
      const lacking = Object.entries(theirs).filter(
        ([inner, entry]) => isObject(entry) && !Object.hasOwn(mine, inner),
      );
      return lacking.length === 0 ? [] : [[key, Object.fromEntries(lacking)]];
    }),
  );

// A Space's row as its statement reads it: its own `data` and the whole of its Property's, each
// the JSON text of an object.
interface SpaceRow {
  readonly data: string;
  readonly from_property: string;
}

// A `data` column as it is stored. The schema checks that each one holds an object.
const storedObject = (text: string): JsonObject => {
  const value = storedJson(text);
  return isObject(value) ? value : {};
};

// A Space's row, with what the Space shows of its Property's `data` in place of the whole of it.
// That is worked out from both as they are stored. `formatRow` shows a key ending in `_cents`
// under the name without it, so worked out after, a Property's `flooring_cents` would pass for
// its `flooring`, and a Space's `paint_cents` for paint of its own.
const showingFromProperty = (row: SpaceRow) => ({
  ...row,
  from_property: fromProperty(storedObject(row.data), storedObject(row.from_property)),
});

// Cuts each list that has more entries than a list may, and says which ones were cut. The other
// read tools call such a remark `note`. A record has Notes of its own, so here it is `lists_cut`.
const cut = (record: JsonObject): JsonObject => {
  const long = Object.entries(record).filter(
    (pair): pair is [string, unknown[]] => Array.isArray(pair[1]) && pair[1].length > MOST_ENTRIES,
  );
  if (long.length === 0) return record;
  return {
    ...record,
    ...Object.fromEntries(long.map(([name, entries]) => [name, entries.slice(0, MOST_ENTRIES)])),
    lists_cut: `Each of these lists has more than ${MOST_ENTRIES} entries, and only the first ${MOST_ENTRIES} are here: ${long.map(([name]) => name).join(", ")}. Read the rest with query.`,
  };
};

/** A type as the glossary writes it: Item, Space. */
export const term = (type: Type | RecordType) => `${type.charAt(0).toUpperCase()}${type.slice(1)}`;

/** The error for a record that is not there, which names its type and the id that was given. */
export const noRecord = (type: Type, id: string) =>
  new ToolError({
    message: `There is no ${term(type)} with the id "${id}". Ids come from search and from the records get_record returns.`,
  });

// The keys a Space shows, as a sentence names them: `paint` and `flooring`.
const FROM_PROPERTY_KEYS_AS_TEXT = new Intl.ListFormat("en", { type: "conjunction" }).format(
  FROM_PROPERTY_KEYS.map((key) => `\`${key}\``),
);

const DESCRIPTION = `Returns one record with what hangs off it. Give the record's type and its id, as search or another record gives them. A Property can be given by its name instead. A Quote is not a type of its own: it comes back with its Project.

Every record comes back with its own fields, with \`data\` as an object and money in dollars. Where it points at another record, that record's name or title is beside its id. It also has its ${RECENT_CHANGES} most recent Changes, each with the record as it was before and after. What else hangs off it depends on its type:
- An Item has its extra Categories, its Schedules, the Work done on it, its Documents, and its Notes. Its Parts are in \`data.parts\`, with their part numbers. Each Schedule has \`last_work\`, the newest Work logged against it, and the Vendor on that Work is where the Part was bought last.
- A Space has the Items in it now, the Work and the Projects that named it, its Documents, and its Notes. \`from_property\` holds the facts that are the same in every Space: what its Property's \`data\` has under ${FROM_PROPERTY_KEYS_AS_TEXT}, where the Space has no entry of its own. Paint goes by surface, so a Space with wall paint of its own still shows the Property's trim. No other key of the Property's \`data\` is in it. The Property's size and its lease, \`sqft\` and \`lease_until\`, are read from the Property.
- A Project has its Spaces, its Quotes with their Vendors and amounts, its Work, its Documents, and its Notes. \`total_cost\` is the sum of the Costs of its Work, and null while none has a Cost.
- A Vendor has the Work it did, the Quotes it gave, the Items bought from it, its Documents, and its Notes.
- Work has its Items, its Spaces, its Documents, and its Notes.
- A Property has its Spaces, its Projects, its own Schedules, the Items at it now, the Work done at it, its Documents, and the Notes that stand alone at it.
- A Schedule has the Work logged against it.
- A Document has its text and what it is attached to. A Note has what it is attached to.

A list with dates comes newest first. Newest is by the date as text, so Work dated only 2023 comes after Work dated 2023-06-12, and Work with no date comes last. A list has at most ${MOST_ENTRIES} entries, and \`lists_cut\` names the ones that were cut. A Document in a list comes without its text. \`diy\` and \`active\` are 1 or 0. Pass the type and id of anything in a list back to get_record for the whole of it.`;

/**
 * Reads one record with what hangs off it, the way get_record returns it. A tool that saves a
 * record sends it back through this, so the two never differ.
 */
export const readRecord = Effect.fnUntraced(function* (type: Type, id: string) {
  const sql = yield* SqlClient.SqlClient;
  const [found] = yield* sql.unsafe<object>(RECORDS[type], [id]);
  if (found === undefined) {
    // A Property that is not there is an error that lists the ones that are.
    if (type === "property") yield* propertyNamed(id);
    return yield* noRecord(type, id);
  }

  const row = type === "space" ? showingFromProperty(found as SpaceRow) : found;
  return cut(formatRow({ type, ...row }));
});

export const getRecord = defineTool({
  name: "get_record",
  description: DESCRIPTION,
  input: Schema.Struct({
    type: Schema.Literals(TYPES).annotate({ description: "What kind of record it is." }),
    id: Schema.String.annotate({
      description:
        "The record's id, as search or another record gives it. A Property can be given by its name instead.",
    }),
  }),
  annotations: { readOnlyHint: true },
  run: ({ type, id }) => readRecord(type, id),
});
