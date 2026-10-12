import { jsonObject } from "./sql.ts";

/**
 * The types of record a tool writes. Each is named the way get_record names its types, and a
 * Category and a Quote, which get_record does not take, the same way. A type comes after the
 * types it points at, so rows can go in in this order and come out in the other.
 */
export const RECORD_TYPES = [
  "property",
  "space",
  "vendor",
  "category",
  "item",
  "project",
  "quote",
  "work",
  "note",
] as const;

export type RecordType = (typeof RECORD_TYPES)[number];

/** A set of other records that a record is linked to, kept in a table of its own. */
export interface LinkSet {
  /** What the set is called in a snapshot, such as `extra_categories`. */
  readonly name: string;
  readonly table: string;
  /** The column that holds the id of the record the set belongs to. */
  readonly from: string;
  /** The column that holds the id of each record it is linked to. */
  readonly to: string;
  /** The type of the records it is linked to. */
  readonly of: RecordType;
}

/**
 * How a record is named when no column of its row names it: by the records it points at in
 * these pointer columns, in this order, with this text between their names. A Quote is named
 * by its Vendor and its Project, as in "Brightside Electric for Outdoor lighting".
 */
export interface NamedByOthers {
  readonly columns: ReadonlyArray<string>;
  readonly between: string;
}

/** What a record of one type is. */
export interface RecordShape {
  readonly table: string;
  /**
   * Every column of the row that can be written, the id first. A generated column is not one:
   * it follows from `data`.
   */
  readonly columns: ReadonlyArray<string>;
  readonly links: ReadonlyArray<LinkSet>;
  /**
   * What a reply and an error name the record by. For most types it is a column of the row:
   * its name, the title of Work, the body of a Note. A Quote has no such column, and is named
   * by the records it points at. `recordName` reads either.
   */
  readonly namedBy: string | NamedByOthers;
  /**
   * The most of that name a reply shows, where it can run long. A Note has no name, and a
   * reply names it by its body, and by only the start of a long one.
   */
  readonly longestName?: number;
  /**
   * The columns of its row that hold the id of another record, each with the type of record
   * that is. A column for a type no tool writes yet is left out until that type is here. A
   * record points at others by its link sets too, and by what it is attached to.
   */
  readonly pointerColumns: Readonly<Record<string, RecordType>>;
  /**
   * How the record is attached to one of several types: the column with that record's type,
   * the column with its id, and the types it can be. A Note is attached this way. No foreign
   * key holds the two columns. A type no tool writes yet is left out until it is here.
   */
  readonly attachedBy?: {
    readonly typeColumn: string;
    readonly idColumn: string;
    readonly of: ReadonlyArray<RecordType>;
    /**
     * The pointer column in which it follows the record it is attached to, where that record
     * has the column too: a Note is at the Property of the record it is on. Nothing in the
     * database holds the two together. A save that moves the record moves what is attached
     * to it, in the same Change.
     */
    readonly follows?: string;
  };
  /**
   * The columns no two records of the type can have the same values in: the name of a
   * Property or a Vendor, the Property and the name of a Space, and the Project and the Vendor
   * of a Quote. The database ignores case in a name.
   */
  readonly unique?: ReadonlyArray<string>;
}

/**
 * The one place that says what a record of each type is: its table, its columns, its link
 * sets, and what it points at. A Change's snapshots are built from it, and `undo` goes by it to
 * make a record what a snapshot says it was. A tool that writes a type adds it here first.
 */
export const SHAPES = {
  property: {
    table: "properties",
    columns: [
      "id",
      "name",
      "tenure",
      "address",
      "start_on",
      "end_on",
      "data",
      "created_at",
      "updated_at",
    ],
    links: [],
    namedBy: "name",
    pointerColumns: {},
    unique: ["name"],
  },
  space: {
    table: "spaces",
    columns: ["id", "property_id", "name", "data"],
    links: [],
    namedBy: "name",
    pointerColumns: { property_id: "property" },
    unique: ["property_id", "name"],
  },
  vendor: {
    table: "vendors",
    columns: ["id", "name", "role", "data", "created_at", "updated_at"],
    links: [],
    namedBy: "name",
    pointerColumns: {},
    unique: ["name"],
  },
  category: {
    table: "categories",
    columns: ["id", "name", "parent_id", "data"],
    links: [],
    namedBy: "name",
    pointerColumns: { parent_id: "category" },
  },
  item: {
    table: "items",
    columns: [
      "id",
      "property_id",
      "space_id",
      "scope",
      "category_id",
      "name",
      "acquired_on",
      "price_cents",
      "vendor_id",
      "status",
      "status_on",
      "proceeds_cents",
      "data",
      "created_at",
      "updated_at",
    ],
    // The Categories it is in beside its primary one. With the 15 columns this makes a snapshot
    // of 16 fields, which is the most D1 takes in one JSON object (see `jsonObject`).
    links: [
      {
        name: "extra_categories",
        table: "item_categories",
        from: "item_id",
        to: "category_id",
        of: "category",
      },
    ],
    namedBy: "name",
    pointerColumns: {
      property_id: "property",
      space_id: "space",
      category_id: "category",
      vendor_id: "vendor",
    },
  },
  project: {
    table: "projects",
    columns: [
      "id",
      "property_id",
      "title",
      "status",
      "start_on",
      "end_on",
      "data",
      "created_at",
      "updated_at",
    ],
    // The Spaces it covers.
    links: [
      { name: "spaces", table: "project_spaces", from: "project_id", to: "space_id", of: "space" },
    ],
    namedBy: "title",
    pointerColumns: { property_id: "property" },
  },
  quote: {
    table: "quotes",
    columns: [
      "id",
      "project_id",
      "vendor_id",
      "amount_cents",
      "quoted_on",
      "data",
      "created_at",
      "updated_at",
    ],
    links: [],
    // What one Vendor said a Project would cost, so the two of them are what it is called.
    namedBy: { columns: ["vendor_id", "project_id"], between: " for " },
    pointerColumns: { project_id: "project", vendor_id: "vendor" },
    // A Project has one Quote from each Vendor.
    unique: ["project_id", "vendor_id"],
  },
  work: {
    table: "work",
    columns: [
      "id",
      "property_id",
      "project_id",
      "kind",
      "title",
      "description",
      "date",
      "cost_cents",
      "diy",
      "vendor_id",
      "schedule_id",
      "data",
      "created_at",
      "updated_at",
    ],
    // The Items it was done to, and the Spaces it was done in. With the 14 columns these make
    // a snapshot of 16 fields, which is the most D1 takes in one JSON object, as an Item's is.
    links: [
      { name: "items", table: "work_items", from: "work_id", to: "item_id", of: "item" },
      { name: "spaces", table: "work_spaces", from: "work_id", to: "space_id", of: "space" },
    ],
    namedBy: "title",
    // Its Schedule is a type no tool writes yet.
    pointerColumns: { property_id: "property", project_id: "project", vendor_id: "vendor" },
  },
  note: {
    table: "notes",
    columns: ["id", "property_id", "entity_type", "entity_id", "body", "data", "created_at"],
    links: [],
    namedBy: "body",
    longestName: 80,
    pointerColumns: { property_id: "property" },
    attachedBy: {
      typeColumn: "entity_type",
      idColumn: "entity_id",
      of: ["space", "vendor", "item", "project", "work"],
      // A Vendor is at no Property, and neither is a Note on one.
      follows: "property_id",
    },
  },
} as const satisfies Readonly<Record<RecordType, RecordShape>>;

// The column a record of a type is named by, for a type that has one. A record that is named by
// the records it points at points at ones with a column of their own, so a name is never more
// than one step away.
const nameColumn = (type: RecordType) => {
  const { table, namedBy }: RecordShape = SHAPES[type];
  if (typeof namedBy !== "string") {
    throw new Error(`${table} has no column to be named by, so nothing is named by a row of it.`);
  }
  return namedBy;
};

/**
 * The SQL of what the record of a type with an id is called now: the name in its row, or null
 * when it is not there. `id` is the SQL of the id.
 */
export const calledNow = (type: RecordType, id: string) =>
  `(SELECT pointed_at.${nameColumn(type)} FROM ${SHAPES[type].table} AS pointed_at
     WHERE pointed_at.id = ${id})`;

/**
 * The SQL of what a record is named by. `read` gives the SQL of one column of the record, so
 * a name is read the same way from a row and from a snapshot of one. A record that is named by
 * the records it points at is named by what `called` says each of them is called, which is
 * what it is called now unless the caller knows of another time to ask about. One that has no
 * name to give, because it is not there, stands in the name as the id the record had for it.
 */
export const recordName = (
  { table, namedBy, pointerColumns }: RecordShape,
  read: (column: string) => string,
  called: (type: RecordType, id: string) => string = calledNow,
): string => {
  if (typeof namedBy === "string") return read(namedBy);
  return namedBy.columns
    .map((column) => {
      const type = pointerColumns[column];
      if (type === undefined) {
        throw new Error(`${table} has no pointer column named ${column} to be named by.`);
      }
      const pointer = read(column);
      return `coalesce(${called(type, pointer)}, ${pointer})`;
    })
    .join(` || '${namedBy.between}' || `);
};

/**
 * The same name in code, for a save that knows what the records it points at are called.
 * `called` has each of those names under the pointer column it goes with.
 */
export const nameByOthers = <Column extends string>(
  { columns, between }: { readonly columns: ReadonlyArray<Column>; readonly between: string },
  called: Readonly<Record<Column, string>>,
) => columns.map((column) => called[column]).join(between);

/**
 * What a reply names a record by, given the text its type is named by: the text, or the start
 * of one that is longer than a name of that type gets.
 */
export const listedName = (type: RecordType, text: string) => {
  const { longestName }: RecordShape = SHAPES[type];
  return longestName === undefined || text.length <= longestName
    ? text
    : `${text.slice(0, longestName)}…`;
};

/**
 * Every type a record of this shape can point at, whichever way it does: by a column of its
 * row, by a link set, or by what it is attached to.
 */
export const typesPointedAt = ({ pointerColumns, links, attachedBy }: RecordShape) => [
  ...new Set([
    ...Object.values(pointerColumns),
    ...links.map((set) => set.of),
    ...(attachedBy?.of ?? []),
  ]),
];

// The ids of one link set, as a JSON list in a fixed order. The list is read as JSON again on
// its way out, because a JSON value that passes through a subquery comes out as plain text.
const linked = ({ table, from, to }: LinkSet) =>
  `json((SELECT json_group_array(${to})
           FROM (SELECT ${to} FROM ${table} WHERE ${from} = record.id ORDER BY ${to})))`;

/**
 * The SQL of a snapshot: the whole record as one JSON object, with every column of its row
 * that can be written, `data` as an object, and each link set as a list of ids. It reads the
 * row a statement names `record`.
 */
export const snapshot = ({ columns, links }: RecordShape) =>
  jsonObject([
    ...columns.map(
      (column) => [column, column === "data" ? "json(record.data)" : `record.${column}`] as const,
    ),
    ...links.map((link) => [link.name, linked(link)] as const),
  ]);
