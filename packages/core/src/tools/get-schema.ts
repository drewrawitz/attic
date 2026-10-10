import { Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { formatRow } from "../output.ts";
import { defineTool, NoInput } from "../tool.ts";

// The conventions the data follows: the header of migrations/0001_init.sql without its first
// line, which names the file. SQLite does not keep a comment that sits outside a statement, so
// this copy is how the header reaches a client. A test holds the two together.
const CONVENTIONS = `Vocabulary: see GLOSSARY.md. Property, Space, Item, Fixture, Belonging, Work, Project,
Quote, Vendor, Schedule, Document, Note, and Change mean what it says there.

Shape: a thin typed spine plus a \`data\` JSON object on every record (ADR 0002).
  * Typed columns are only for things code joins, filters, sums, or branches on:
    ids, links between records, kind/status, dates, money.
  * Everything descriptive goes in \`data\`, in whatever shape fits the thing.
    A water heater, a room, and a lease don't need the same fields.
  * When a tool starts to branch on a \`data\` key, promote it with a generated column:
      ALTER TABLE items ADD COLUMN filter_part AS (json_extract(data, '$.filter_part'));
    No data migration, and it can be indexed. brand, model, serial, and warranty_until
    below are examples.

Conventions:
  ids are TEXT (ULIDs, so they sort by creation time)
  money is INTEGER cents, in the one currency the deployment is configured for
  dates are ISO text and may be partial: '2023', '2023-06', or '2023-06-12'.
    A partial date stands for the whole period it names. Text comparison sorts them,
    but '2023' < '2023-03-01', so a plain "date >= '2023-03'" misses year-only rows.
  timestamps are full UTC ISO strings
  names that tools look records up by (properties, spaces, vendors) ignore case
  CHECK lists exist only where code branches on the value; everything else is free text.

Conventions inside \`data\`:
  writes are JSON merge patches (json_patch): keys merge, null removes a key, and an
    array is replaced whole. So a list that gets edited one entry at a time is an
    object keyed by a slug, not an array.
  money is integer cents under a key ending in _cents
  dates follow the same partial ISO rule
  key names come from the well-known list that the get_schema tool publishes

Deleting: a row that other rows point at can't be deleted until they are re-pointed.
That is why references to vendors, spaces, categories, and projects have no
ON DELETE action. Properties are never deleted.

No FTS5 table on purpose (ADR 0003): D1 can't export a database with virtual tables,
and a household's data is small enough that LIKE over text + data is instant.`;

const PARTIAL_DATES =
  "Comparing dates as plain text misses Partial dates. A Partial date stands for the whole period it names, but `date >= '2023-03'` skips a row dated '2023'. To catch it, add `OR date = '2023'`.";

// The well-known `data` keys for each kind of record, with what each one holds. `data` takes
// any key. Reaching for these first is what keeps one fact from ending up under three names.
const DATA_KEYS = {
  item: {
    brand: "Who makes it.",
    model: "The exact model, as the maker writes it.",
    serial: "The serial number.",
    warranty_until: "When the warranty runs out. May be a Partial date.",
    parts: "The Item's Parts, as an object keyed by slug. Each Part has `name` and `part_number`.",
    quantity: "How many pieces a matching set has. The set is one Item, priced as a whole.",
    condition: "The state it is in, such as good.",
    listing: "Where it is for sale, as an object with `where`, `asking_cents`, and `url`.",
    sold_to: "Who bought it.",
    donated_to: "Who it was given to.",
    claim_number: "The insurance claim number, for an Item that was lost, stolen, or destroyed.",
  },
  space: {
    sqft: "Its size in square feet.",
    paint:
      "An object keyed by surface: `walls`, `trim`, `ceiling`. Each surface has `brand`, `color`, `code`, and `sheen`.",
    flooring: "What the floor is, such as its type and when it was installed.",
    counters: "What the counters are.",
  },
  property: {
    lease_until:
      "When the lease runs out. May be a Partial date. It is not the Property's end date.",
    paint:
      "Paint for the whole Property, in the same shape as a Space's. A Space's own entry wins.",
  },
  work: {
    permit: "The permit number.",
    payments: "The payments made for the Work.",
    replaced: "What was replaced.",
  },
};

// A row of sqlite_master: a table or view, and the statement that created it.
interface Definition {
  readonly type: "table" | "view";
  readonly name: string;
  readonly sql: string;
}

interface CategoryRow {
  readonly id: string;
  readonly name: string;
  readonly parent_id: string | null;
  readonly data: string;
}

interface Category {
  readonly id: string;
  readonly name: string;
  readonly expects: ReadonlyArray<string>;
  readonly children: ReadonlyArray<Category>;
}

// The `data` keys a Category says its Items should have. Nothing checks what is stored under
// `expects`, so anything but a list of names counts as none.
const decodeExpectations = Schema.decodeUnknownOption(
  Schema.Struct({ expects: Schema.Array(Schema.String) }),
);
const expectsOf = (data: unknown) =>
  Option.match(decodeExpectations(data), { onNone: () => [], onSome: ({ expects }) => expects });

// Nests each Category under its parent. Nothing in the schema stops parents from forming a
// loop, and a Category in one hangs under no top-level Category. So whatever the walk down
// from the top has not placed starts a branch of its own, and every Category comes out once.
const categoryTree = (rows: ReadonlyArray<CategoryRow>): ReadonlyArray<Category> => {
  const placed = new Set<string>();
  const branch = (row: CategoryRow): Category => {
    placed.add(row.id);
    return {
      id: row.id,
      name: row.name,
      expects: expectsOf(formatRow(row).data),
      children: rows
        .filter((child) => child.parent_id === row.id && !placed.has(child.id))
        .map(branch),
    };
  };
  const tree = rows.filter((row) => row.parent_id === null).map(branch);
  for (const row of rows) if (!placed.has(row.id)) tree.push(branch(row));
  return tree;
};

export const getSchema = defineTool({
  name: "get_schema",
  description:
    "Returns how Attic stores its records: the definition of every table and view, the conventions the data follows, the Category tree with the `data` keys each Category expects, the well-known `data` keys for each kind of record, and a warning about comparing Partial dates. An Item is expected to have the keys of every Category it sits under, parents included. Call it before writing SQL or saving records. It takes no input.",
  input: NoInput,
  annotations: { readOnlyHint: true },
  run: () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // D1 and Alchemy keep tables of their own in the same database. Theirs start with an
      // underscore and SQLite's start with sqlite_. None of Attic's do.
      const definitions = yield* sql<Definition>`
        SELECT type, name, sql FROM sqlite_master
         WHERE type IN ('table', 'view') AND name NOT GLOB '_*' AND name NOT GLOB 'sqlite_*'
         ORDER BY rowid`;
      const defined = (type: Definition["type"]) =>
        definitions
          .filter((each) => each.type === type)
          .map((each) => ({ name: each.name, sql: each.sql }));

      const categories = yield* sql<CategoryRow>`
        SELECT id, name, parent_id, data FROM categories ORDER BY name COLLATE NOCASE, id`;

      return {
        conventions: CONVENTIONS,
        partial_dates: PARTIAL_DATES,
        tables: defined("table"),
        views: defined("view"),
        categories: categoryTree(categories),
        data_keys: DATA_KEYS,
      };
    }),
});
