import { jsonObject } from "./sql.ts";

/** A set of other records that a record is linked to, kept in a table of its own. */
export interface LinkSet {
  /** What the set is called in a snapshot, such as `extra_categories`. */
  readonly name: string;
  readonly table: string;
  /** The column that holds the id of the record the set belongs to. */
  readonly from: string;
  /** The column that holds the id of each record it is linked to. */
  readonly to: string;
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
}

/**
 * The one place that says what a record of each type is: its table, its columns, and its link
 * sets. A Change's snapshots are built from it, so a record can be put back from one. A type
 * is named the way get_record takes it. A tool that writes a type adds it here first.
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
  },
} as const satisfies Readonly<Record<string, RecordShape>>;

export type RecordType = keyof typeof SHAPES;

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
