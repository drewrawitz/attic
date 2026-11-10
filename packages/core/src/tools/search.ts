import { Array as Arr, Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { notGone } from "../item.ts";
import { formatJson } from "../output.ts";
import { propertyNamed } from "../property.ts";
import { defineTool, optional, ToolError } from "../tool.ts";

// The types of record that are searched, in the order their results come back.
const TYPES = ["item", "work", "project", "vendor", "space", "note", "document"] as const;

// D1 takes at most five SELECTs in one UNION. Its limits page does not say so: a sixth was turned
// down on local D1 on 2026-10-10. Node SQLite takes hundreds, so only the test through the Worker
// catches one. A longer list goes in as groups of five, each a subquery of its own, and the
// groups are joined the same way.
const MOST_IN_A_UNION = 5;

const union = (selects: ReadonlyArray<string>): string => {
  if (selects.length <= MOST_IN_A_UNION) return selects.join("\nUNION ALL ");
  const groups: string[] = [];
  for (let from = 0; from < selects.length; from += MOST_IN_A_UNION) {
    groups.push(`SELECT * FROM (${union(selects.slice(from, from + MOST_IN_A_UNION))})`);
  }
  return union(groups);
};

// The records that are searched, with what a result says about each one. First the field a
// result shows the record's name under, and the name itself: an Item's name, the title of Work,
// the body of a Note. Then its Property, an Item's status, and the date of Work.
const RECORDS = [
  `SELECT 'item', id, 'name', name, property_id, status, NULL FROM items`,
  `SELECT 'work', id, 'title', title, property_id, NULL, date FROM work`,
  `SELECT 'project', id, 'title', title, property_id, NULL, NULL FROM projects`,
  `SELECT 'vendor', id, 'name', name, NULL, NULL, NULL FROM vendors`,
  `SELECT 'space', id, 'name', name, property_id, NULL, NULL FROM spaces`,
  `SELECT 'note', id, 'body', body, property_id, NULL, NULL FROM notes`,
  `SELECT 'document', id, 'title', title, property_id, NULL, NULL FROM documents`,
];

// A Vendor as another record shows it: its name, and its role when it has one.
const NAMED_VENDOR = `vendor.name || coalesce(' (' || nullif(vendor.role, '') || ')', '')`;

// The text a record holds itself, a row for each field: one read of the table, with the fields
// laid out by json_each. JSON keeps a text as it is, `data` included, so the value that comes
// out is the text that went in. A field with nothing in it comes out as null.
const ownFields = (type: string, table: string, fields: ReadonlyArray<string>) =>
  `SELECT '${type}', ${table}.id, field.key, NULL, field.value
     FROM ${table}, json_each(json_object(${fields.map((name) => `'${name}', ${name}`).join(", ")})) AS field`;

// Every piece of text a record can be found by, one row for each: the record, the field the
// text is in, and for text that belongs to another record, which one. The field is the name the
// text goes under in a result's `matched`. `attached` is part of SEARCH.
const PIECES = [
  ownFields("item", "items", ["name", "data"]),
  // Every Category an Item sits under, parents included.
  `SELECT 'item', under.item_id, 'categories', categories.id, categories.name
     FROM item_in_category AS under JOIN categories ON categories.id = under.category_id`,
  `SELECT 'item', items.id, 'spaces', spaces.id, spaces.name
     FROM items JOIN spaces ON spaces.id = items.space_id`,
  `SELECT 'item', items.id, 'vendors', vendor.id, ${NAMED_VENDOR}
     FROM items JOIN vendors AS vendor ON vendor.id = items.vendor_id`,
  ownFields("work", "work", ["title", "description", "data"]),
  `SELECT 'work', done_in.work_id, 'spaces', spaces.id, spaces.name
     FROM work_spaces AS done_in JOIN spaces ON spaces.id = done_in.space_id`,
  `SELECT 'work', work.id, 'vendors', vendor.id, ${NAMED_VENDOR}
     FROM work JOIN vendors AS vendor ON vendor.id = work.vendor_id`,
  ownFields("project", "projects", ["title", "data"]),
  `SELECT 'project', covers.project_id, 'spaces', spaces.id, spaces.name
     FROM project_spaces AS covers JOIN spaces ON spaces.id = covers.space_id`,
  // A Project's Vendors are the ones on its Quotes.
  `SELECT 'project', quotes.project_id, 'vendors', vendor.id, ${NAMED_VENDOR}
     FROM quotes JOIN vendors AS vendor ON vendor.id = quotes.vendor_id`,
  ownFields("vendor", "vendors", ["name", "role", "data"]),
  ownFields("space", "spaces", ["name", "data"]),
  ownFields("note", "notes", ["body", "data"]),
  ownFields("document", "documents", ["title", "text", "data"]),
  `SELECT 'document', documents.id, 'vendors', vendor.id, ${NAMED_VENDOR}
     FROM documents JOIN vendors AS vendor ON vendor.id = documents.vendor_id`,
  // The text of a record's Documents, whatever the record is.
  `SELECT link.entity_type, link.entity_id, 'documents', documents.id, documents.text
     FROM document_links AS link JOIN documents ON documents.id = link.document_id`,
  // The name of what a Note or a Document is attached to. A result names it whether or not it
  // holds a word, by the type and the id in its `ref`.
  `SELECT type, id, 'attached_to', json_object('type', to_type, 'id', to_id), name FROM attached`,
];

// The most records one call returns. The statement asks for one more, which is how a result
// that was cut is told from one that just fits.
const MOST_RESULTS = 50;

const CUT = `Only the first ${MOST_RESULTS} records are here, and more were found. Add a word, or narrow the search with types or property.`;

// A text longer than this is cut to this many characters, starting a little before the first
// word found in it. A manual's text can run to many pages, and none of them should leave the
// database for the sake of one line. `data` is JSON, so it is never cut.
const EXCERPT = 300;
const LEAD = 100;

// One statement finds the records and says why. It is given the words, the types to keep,
// whether to keep Gone Items, and the Property to keep to, if any.
//
//   word      the words, each with the LIKE pattern that finds it, in text and in `data`
//   record    every record that is searched, with what a result says about it. Only an Item
//             has a status in it, so only an Item can be a Gone Item
//   attached  what each Note and each Document is attached to
//   piece     every piece of text of every record
//   hit       a piece, once for each word it holds, with the word's place among the words its
//             record holds. What a Note or a Document is attached to is kept with no word too.
//   shown     each piece of `hit`, once, with where its excerpt starts and how many of the
//             words its record holds
//   page      the pieces of the records that hold every word and pass the filters, with each
//             record's place in the order
//
// What comes back is a row for each piece shown of each record on the page, which is one record
// more than a call returns. Work is ordered by its date as text, which puts a Partial date after
// the full dates inside it. LIKE and lower() both ignore case for ASCII letters only, so they
// agree on where a word is.
//
// SQLite copies a CTE into each place that names it, and D1 refuses to read a CTE once the
// statement holds 100 tables, counting every copy. That is SQLite 3.54.1 holding the tables to
// SQLITE_LIMIT_EXPR_DEPTH, which workerd sets to 100. So every step is named once, but `record`,
// which `attached` and `page` both read. Only the test through the Worker catches a statement
// that holds too many.
const SEARCH = `
WITH
  word (lowered, pattern, data_pattern) AS (
    SELECT lower(value ->> 'word'), value ->> 'pattern', value ->> 'data_pattern'
      FROM json_each(?1)
  ),
  record (type, id, name_field, name, property_id, status, date) AS (${union(RECORDS)}),
  attached (type, id, to_type, to_id, name) AS (
    SELECT link.type, link.id, record.type, record.id, record.name
      FROM (SELECT 'note' AS type, id, entity_type, entity_id FROM notes
            UNION ALL
            SELECT 'document', document_id, entity_type, entity_id FROM document_links) AS link
      JOIN record ON record.type = link.entity_type AND record.id = link.entity_id
  ),
  piece (type, id, field, ref, text) AS (${union(PIECES)}),
  hit AS (
    SELECT piece.*, word.lowered AS word,
           iif(word.lowered IS NULL, 0,
               dense_rank() OVER (PARTITION BY piece.type, piece.id, word.lowered IS NULL
                                  ORDER BY word.lowered)) AS nth_word
      FROM piece
      LEFT JOIN word
        ON piece.text LIKE iif(piece.field = 'data', word.data_pattern, word.pattern) ESCAPE '\\'
     WHERE word.lowered IS NOT NULL OR piece.field = 'attached_to'
  ),
  shown AS (
    SELECT type, id, field, ref, text,
           max(1, min(instr(lower(text), word)) - ${LEAD}) AS start,
           max(max(nth_word)) OVER (PARTITION BY type, id) AS words
      FROM hit GROUP BY type, id, field, ref
  ),
  page AS (
    SELECT shown.*, record.name_field, record.name, record.status, record.date,
           property.name AS property,
           dense_rank() OVER (
             ORDER BY wanted.key, record.date DESC, record.name COLLATE NOCASE, record.id
           ) AS position
      FROM shown
      JOIN record ON record.type = shown.type AND record.id = shown.id
      JOIN json_each(?2) AS wanted ON wanted.value = record.type
      LEFT JOIN properties AS property ON property.id = record.property_id
     WHERE shown.words = (SELECT count(DISTINCT lower(value ->> 'word')) FROM json_each(?1))
       AND (?3 OR record.status IS NULL OR ${notGone("record.status")})
       AND (?4 IS NULL OR record.property_id = ?4)
  )
SELECT page.position, page.type, page.id, page.name_field, page.property, page.status, page.date,
       iif(length(page.name) > ${EXCERPT},
           substr(page.name, 1, ${EXCERPT}) || '…', page.name) AS name,
       page.field, page.ref, document.title AS document,
       CASE WHEN page.field IN ('data', 'attached_to') OR length(page.text) <= ${EXCERPT}
            THEN page.text
            ELSE iif(page.start > 1, '…', '')
                 || substr(page.text, page.start, ${EXCERPT})
                 || iif(page.start + ${EXCERPT} <= length(page.text), '…', '')
       END AS text
  FROM page
  LEFT JOIN documents AS document ON page.field = 'documents' AND document.id = page.ref
 WHERE page.position <= ${MOST_RESULTS + 1}
 ORDER BY page.position, page.field, page.ref`;

// One row of what SEARCH returns: a record that was found, and one piece of it that holds a
// word, or that names what the record is attached to.
interface Row {
  readonly position: number;
  readonly type: string;
  readonly id: string;
  readonly name_field: string;
  readonly name: string | null;
  readonly property: string | null;
  readonly status: string | null;
  readonly date: string | null;
  readonly field: string;
  readonly ref: string | null;
  readonly document: string | null;
  readonly text: string;
}

// A word as LIKE finds it anywhere in a text. LIKE reads % and _ as wildcards, so in a word they
// are escaped, and so is the backslash that escapes them.
const pattern = (word: string) => `%${word.replace(/[\\%_]/g, "\\$&")}%`;

// `data` is searched as the JSON text it is stored as, keys included. JSON writes a quote or a
// backslash inside a value with a backslash before it, so that is how a word is looked for there.
const asJsonWritesIt = (word: string) => JSON.stringify(word).slice(1, -1);

// D1 turns down a LIKE pattern of more than 50 bytes, which is the word and a % at each end. That
// is on D1's limits page, and local D1 held to it on 2026-10-10.
const LONGEST_PATTERN = 50;
const encoder = new TextEncoder();

const NO_WORDS =
  "search needs at least one word. Give the words that must all be in a record, such as `fridge filter`.";

const tooLong = (word: string) =>
  `The word "${word}" is too long to search for. A word can be up to ${LONGEST_PATTERN - 2} bytes, and fewer when it has a %, a _, a quote, or a backslash in it. Search for a shorter part of it.`;

// Where the words were found in one record. Text that belongs to another record goes in a list,
// because a record can have several Categories, Spaces, Vendors, or Documents.
const matchedIn = (rows: ReadonlyArray<Row>) => {
  const own: Record<string, unknown> = {};
  const others: Record<string, unknown[]> = {};
  for (const row of rows) {
    // What the result already shows of the record is not said twice: its name, as long as that
    // was not cut, and what it is attached to.
    if (row.field === row.name_field && row.text === row.name) continue;
    if (row.field === "attached_to") continue;
    if (row.ref === null) {
      own[row.field] = row.field === "data" ? formatJson(row.text) : row.text;
    } else {
      (others[row.field] ??= []).push(
        row.field === "documents" ? { id: row.ref, title: row.document, text: row.text } : row.text,
      );
    }
  }
  return { ...own, ...others };
};

// What a Note or a Document is attached to, by type, id, and name, from the rows of the record.
// Each row has the type and the id as JSON in its `ref`, and the name as its text.
const attachedTo = (rows: ReadonlyArray<Row>) =>
  rows.flatMap((row) =>
    row.field === "attached_to" && row.ref !== null
      ? [{ ...(JSON.parse(row.ref) as { type: string; id: string }), name: row.text }]
      : [],
  );

// One result, from the rows of one record.
const result = (rows: Arr.NonEmptyReadonlyArray<Row>) => {
  const [record] = rows;
  const attached = attachedTo(rows);
  const matched = matchedIn(rows);
  return {
    type: record.type,
    id: record.id,
    [record.name_field]: record.name,
    property: record.property,
    ...(record.status === null ? {} : { status: record.status }),
    ...(record.date === null ? {} : { date: record.date }),
    ...(attached.length > 0 ? { attached_to: attached } : {}),
    ...(Object.keys(matched).length === 0 ? {} : { matched }),
  };
};

export const search = defineTool({
  name: "search",
  description: `Finds records by words: Items, Work, Projects, Vendors, Spaces, Notes, and Documents. Every word must be somewhere in the record, and the words can be in different places of it: its name or title, its description, its \`data\`, the text of its Documents, or the name of its Category, Space, or Vendor. So \`samsung kitchen\` finds the Samsung fridge in the Kitchen. An Item is found by every Category it sits under, parents included. A Vendor's role counts with its name, so \`plumber\` finds the Work a plumber did. A Note or a Document is also found by the name of what it is attached to. \`data\` is searched as text, keys included, so \`paint\` finds every Space with paint on record. A word matches anywhere in a text, so \`plumb\` finds both plumber and plumbing, and case is ignored for the letters a to z. Give a few words, not a sentence. With no property, every Property is searched, former ones included. Each result has the record's type, id, name or title, and Property. A Note has its body, an Item its status, and Work its date. Work comes newest first by that date as text, so Work dated only 2023 comes after Work dated 2023-06-12. A Note or a Document says what it is attached to. \`matched\` shows where else the words were found. A long text is cut to the part around the first word found in it. Pass a result's type and id to get_record for the whole record. At most ${MOST_RESULTS} records come back, with a note when there were more.`,
  input: Schema.Struct({
    words: Schema.String.annotate({
      description: "The words to look for, with spaces between them. Every one must be found.",
    }),
    types: optional(
      Schema.Array(Schema.Literals(TYPES)).annotate({
        description: "Only these types of record. Leave it out to search every type.",
      }),
    ),
    property: optional(
      Schema.String.annotate({
        description:
          "Only records at this Property, given by its id or its name. Leave it out to search every Property. A record with no Property of its own is left out, and no Vendor has one.",
      }),
    ),
    include_gone: optional(
      Schema.Boolean.annotate({
        description:
          "true also finds Gone Items: the ones that were sold, given away, lost, stolen, or destroyed. They are left out otherwise.",
      }),
    ),
  }),
  annotations: { readOnlyHint: true },
  run: (input) =>
    Effect.gen(function* () {
      const words = (input.words.match(/\S+/g) ?? []).map((word) => ({
        word,
        pattern: pattern(word),
        data_pattern: pattern(asJsonWritesIt(word)),
      }));
      if (words.length === 0) return yield* new ToolError({ message: NO_WORDS });
      // The pattern for `data` is the longer of the two whenever they differ.
      const overlong = words.find(
        (each) => encoder.encode(each.data_pattern).length > LONGEST_PATTERN,
      );
      if (overlong !== undefined) return yield* new ToolError({ message: tooLong(overlong.word) });

      // A list that names no type is the same as no list.
      const asked = input.types ?? [];
      const types = asked.length === 0 ? TYPES : TYPES.filter((type) => asked.includes(type));
      const property =
        input.property === undefined ? undefined : yield* propertyNamed(input.property);

      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql.unsafe<Row>(SEARCH, [
        JSON.stringify(words),
        JSON.stringify(types),
        input.include_gone === true ? 1 : 0,
        property?.id ?? null,
      ]);

      // The rows of one record come one after another.
      const records = Arr.isReadonlyArrayNonEmpty(rows)
        ? Arr.groupWith(rows, (one, next) => one.position === next.position)
        : [];
      return {
        results: records.slice(0, MOST_RESULTS).map(result),
        ...(records.length > MOST_RESULTS ? { note: CUT } : {}),
      };
    }),
});
