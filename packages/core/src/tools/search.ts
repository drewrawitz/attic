import { Array as Arr, Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { formatRow } from "../output.ts";
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

// The records that are searched, with what a result says about each one: the column that says
// what the record is, which the result shows under the column's own name, then its Property, an
// Item's status, and the date of Work.
const RECORDS = [
  `SELECT 'item', id, 'name', name, property_id, status, NULL FROM items`,
  `SELECT 'work', id, 'title', title, property_id, NULL, date FROM work`,
  `SELECT 'project', id, 'title', title, property_id, NULL, NULL FROM projects`,
  `SELECT 'vendor', id, 'name', name, NULL, NULL, NULL FROM vendors`,
  `SELECT 'space', id, 'name', name, property_id, NULL, NULL FROM spaces`,
  `SELECT 'note', id, 'body', body, property_id, NULL, NULL FROM notes`,
  `SELECT 'document', id, 'title', title, property_id, NULL, NULL FROM documents`,
];

// Every piece of text a record can be found by, one row for each: the record, the field the
// text is in, and for text that belongs to another record, which one. The field is the name the
// text goes under in a result's `matched`.
const PIECES = [
  `SELECT 'item', id, 'name', NULL, name FROM items`,
  `SELECT 'item', id, 'data', NULL, data FROM items`,
  // Every Category an Item sits under, parents included.
  `SELECT 'item', under.item_id, 'categories', categories.id, categories.name
     FROM item_in_category AS under JOIN categories ON categories.id = under.category_id`,
  `SELECT 'item', items.id, 'spaces', spaces.id, spaces.name
     FROM items JOIN spaces ON spaces.id = items.space_id`,
  `SELECT 'item', items.id, 'vendors', vendors.id, vendors.name
     FROM items JOIN vendors ON vendors.id = items.vendor_id`,
  `SELECT 'work', id, 'title', NULL, title FROM work`,
  `SELECT 'work', id, 'description', NULL, description FROM work`,
  `SELECT 'work', id, 'data', NULL, data FROM work`,
  `SELECT 'work', done_in.work_id, 'spaces', spaces.id, spaces.name
     FROM work_spaces AS done_in JOIN spaces ON spaces.id = done_in.space_id`,
  `SELECT 'work', work.id, 'vendors', vendors.id, vendors.name
     FROM work JOIN vendors ON vendors.id = work.vendor_id`,
  `SELECT 'project', id, 'title', NULL, title FROM projects`,
  `SELECT 'project', id, 'data', NULL, data FROM projects`,
  `SELECT 'project', covers.project_id, 'spaces', spaces.id, spaces.name
     FROM project_spaces AS covers JOIN spaces ON spaces.id = covers.space_id`,
  // A Project's Vendors are the ones on its Quotes.
  `SELECT 'project', quotes.project_id, 'vendors', vendors.id, vendors.name
     FROM quotes JOIN vendors ON vendors.id = quotes.vendor_id`,
  `SELECT 'vendor', id, 'name', NULL, name FROM vendors`,
  `SELECT 'vendor', id, 'role', NULL, role FROM vendors`,
  `SELECT 'vendor', id, 'data', NULL, data FROM vendors`,
  `SELECT 'space', id, 'name', NULL, name FROM spaces`,
  `SELECT 'space', id, 'data', NULL, data FROM spaces`,
  `SELECT 'note', id, 'body', NULL, body FROM notes`,
  `SELECT 'note', id, 'data', NULL, data FROM notes`,
  `SELECT 'document', id, 'title', NULL, title FROM documents`,
  `SELECT 'document', id, 'text', NULL, text FROM documents`,
  `SELECT 'document', id, 'data', NULL, data FROM documents`,
  `SELECT 'document', documents.id, 'vendors', vendors.id, vendors.name
     FROM documents JOIN vendors ON vendors.id = documents.vendor_id`,
  // The text of a record's Documents, whatever the record is.
  `SELECT link.entity_type, link.entity_id, 'documents', documents.id, documents.text
     FROM document_links AS link JOIN documents ON documents.id = link.document_id`,
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
//   word    the words, each with the LIKE pattern that finds it, in plain text and in `data`
//   piece   every piece of text of every record
//   hit     a piece, once for each word it holds
//   found   the records whose pieces hold every word between them
//   page    the found records that pass the filters, in order, and one more than a call returns
//   shown   each piece that holds a word, once, with where its excerpt starts
//
// What comes back is a row for each piece shown of each record on the page. Work is ordered by
// its date as text, which puts a Partial date after the full dates inside it. LIKE and lower()
// both ignore case for ASCII letters only, so they agree on where a word is.
const SEARCH = `
WITH
  word (lowered, pattern, in_data) AS (
    SELECT lower(value ->> 'word'), value ->> 'pattern', value ->> 'in_data' FROM json_each(?1)
  ),
  record (type, id, called, title, property_id, status, date) AS (${union(RECORDS)}),
  piece (type, id, field, ref, text) AS (${union(PIECES)}),
  hit AS (
    SELECT piece.*, word.lowered AS word
      FROM piece
      JOIN word ON piece.text LIKE iif(piece.field = 'data', word.in_data, word.pattern) ESCAPE '\\'
  ),
  found AS (
    SELECT type, id FROM hit GROUP BY type, id
    HAVING count(DISTINCT word) = (SELECT count(DISTINCT lowered) FROM word)
  ),
  page AS (
    SELECT record.*, property.name AS property,
           row_number() OVER (
             ORDER BY wanted.key, record.date DESC, record.title COLLATE NOCASE, record.id
           ) AS position
      FROM found
      JOIN record ON record.type = found.type AND record.id = found.id
      JOIN json_each(?2) AS wanted ON wanted.value = record.type
      LEFT JOIN properties AS property ON property.id = record.property_id
     WHERE (?3 OR record.status IS NULL OR record.status IN ('active', 'listed'))
       AND (?4 IS NULL OR record.property_id = ?4)
     ORDER BY position
     LIMIT ${MOST_RESULTS + 1}
  ),
  shown AS (
    SELECT type, id, field, ref, text,
           max(1, min(instr(lower(text), word)) - ${LEAD}) AS start
      FROM hit GROUP BY type, id, field, ref
  )
SELECT page.position, page.type, page.id, page.called, page.property, page.status, page.date,
       iif(length(page.title) > ${EXCERPT},
           substr(page.title, 1, ${EXCERPT}) || '…', page.title) AS title,
       shown.field, shown.ref, document.title AS document,
       CASE WHEN shown.field = 'data' OR length(shown.text) <= ${EXCERPT} THEN shown.text
            ELSE iif(shown.start > 1, '…', '')
                 || substr(shown.text, shown.start, ${EXCERPT})
                 || iif(shown.start + ${EXCERPT} <= length(shown.text), '…', '')
       END AS text
  FROM page
  JOIN shown ON shown.type = page.type AND shown.id = page.id
  LEFT JOIN documents AS document ON shown.field = 'documents' AND document.id = shown.ref
 ORDER BY page.position, shown.field, shown.ref`;

// One row of what SEARCH returns: a record that was found, and one piece of it that holds a word.
interface Row {
  readonly position: number;
  readonly type: string;
  readonly id: string;
  readonly called: string;
  readonly title: string | null;
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
    // What the result already shows of the record is not said twice.
    if (row.field === row.called && row.text === row.title) continue;
    if (row.ref === null) {
      own[row.field] = row.field === "data" ? formatRow({ data: row.text }).data : row.text;
    } else {
      (others[row.field] ??= []).push(
        row.field === "documents" ? { id: row.ref, title: row.document, text: row.text } : row.text,
      );
    }
  }
  return { ...own, ...others };
};

// One result, from the rows of one record.
const result = (rows: Arr.NonEmptyReadonlyArray<Row>) => {
  const [record] = rows;
  const matched = matchedIn(rows);
  return {
    type: record.type,
    id: record.id,
    [record.called]: record.title,
    property: record.property,
    ...(record.status === null ? {} : { status: record.status }),
    ...(record.date === null ? {} : { date: record.date }),
    ...(Object.keys(matched).length === 0 ? {} : { matched }),
  };
};

export const search = defineTool({
  name: "search",
  description: `Finds records by words: Items, Work, Projects, Vendors, Spaces, Notes, and Documents. Every word must be somewhere in the record, and the words can be in different places of it: its name or title, its description, its \`data\`, the text of its Documents, or the name of its Category, Space, or Vendor. So \`samsung kitchen\` finds the Samsung fridge in the Kitchen. An Item is found by every Category it sits under, parents included. \`data\` is searched as text, keys included, so \`paint\` finds every Space with paint on record. A word matches anywhere in a text, so \`plumb\` finds both plumber and plumbing, and case is ignored for the letters a to z. Give a few words, not a sentence. With no property, every Property is searched, former ones included. Each result has the record's type, id, name or title, and Property. A Note has its body, an Item its status, and Work its date. Work comes newest first by that date as text, so Work dated only 2023 comes after Work dated 2023-06-12. \`matched\` shows where else the words were found. A long text is cut to the part around the first word found in it. Pass a result's type and id to get_record for the whole record. At most ${MOST_RESULTS} records come back, with a note when there were more.`,
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
          "Only records at this Property, given by its id or its name. Leave it out to search every Property. A Vendor has no Property, so this leaves Vendors out.",
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
        in_data: pattern(asJsonWritesIt(word)),
      }));
      if (words.length === 0) return yield* new ToolError({ message: NO_WORDS });
      // The pattern for `data` is the longer of the two whenever they differ.
      const long = words.find((each) => encoder.encode(each.in_data).length > LONGEST_PATTERN);
      if (long !== undefined) return yield* new ToolError({ message: tooLong(long.word) });

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
