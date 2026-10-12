import { jsonObject } from "./sql.ts";

/**
 * The types of record a tool writes. Each is named the way get_record names its types, and a
 * Category, which get_record does not take, the same way. A type comes after the types it
 * points at, so rows can go in in this order and come out in the other.
 */
export const RECORD_TYPES = [
  "property",
  "space",
  "vendor",
  "category",
  "item",
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

/** What a record of one type is. */
export interface RecordShape {
  readonly table: string;
  /**
   * Every column of the row that can be written, the id first. A generated column is not one:
   * it follows from `data`.
   */
  readonly columns: ReadonlyArray<string>;
  readonly links: ReadonlyArray<LinkSet>;
  /** The column a reply names the record by: its name, the title of Work, the body of a Note. */
  readonly namedBy: string;
  /**
   * The columns that hold the id of another record, each with the type of record it points at.
   * A column that points at a type no tool writes yet is left out until that type is here.
   */
  readonly pointsAt: Readonly<Record<string, RecordType>>;
  /**
   * How the record is attached to one of several types: the column with that record's type,
   * the column with its id, and the types it can be. A Note is attached this way. No foreign
   * key holds the two columns. A type no tool writes yet is left out until it is here.
   */
  readonly attachedBy?: {
    readonly typeColumn: string;
    readonly idColumn: string;
    readonly of: ReadonlyArray<RecordType>;
  };
  /**
   * The columns no two records of the type can have the same values in: the name of a
   * Property or a Vendor, and the Property and the name of a Space. The database ignores case
   * in a name.
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
    pointsAt: {},
    unique: ["name"],
  },
  space: {
    table: "spaces",
    columns: ["id", "property_id", "name", "data"],
    links: [],
    namedBy: "name",
    pointsAt: { property_id: "property" },
    unique: ["property_id", "name"],
  },
  vendor: {
    table: "vendors",
    columns: ["id", "name", "role", "data", "created_at", "updated_at"],
    links: [],
    namedBy: "name",
    pointsAt: {},
    unique: ["name"],
  },
  category: {
    table: "categories",
    columns: ["id", "name", "parent_id", "data"],
    links: [],
    namedBy: "name",
    pointsAt: { parent_id: "category" },
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
    pointsAt: {
      property_id: "property",
      space_id: "space",
      category_id: "category",
      vendor_id: "vendor",
    },
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
    // Its Project and its Schedule are types no tool writes yet.
    pointsAt: { property_id: "property", vendor_id: "vendor" },
  },
  note: {
    table: "notes",
    columns: ["id", "property_id", "entity_type", "entity_id", "body", "data", "created_at"],
    links: [],
    namedBy: "body",
    pointsAt: { property_id: "property" },
    // A Note can be on a Project too, which is a type no tool writes yet.
    attachedBy: {
      typeColumn: "entity_type",
      idColumn: "entity_id",
      of: ["space", "vendor", "item", "work"],
    },
  },
} as const satisfies Readonly<Record<RecordType, RecordShape>>;

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
