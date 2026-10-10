// The columns that hold JSON text: `data` on every record, a Change's `before` and `after`,
// and the lists the views build. A tool that builds a JSON column of its own adds its name.
const JSON_COLUMNS = new Set([
  "data",
  "before",
  "after",
  "items",
  "spaces",
  "documents",
  "categories",
]);

// A JSON column always holds an object or a list. Text that parses to anything else, or does
// not parse, was not one and stays as it is.
const parsed = (text: string): unknown => {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? value : text;
  } catch {
    return text;
  }
};

const CENTS = "_cents";

// Money is stored as integer cents and shown in dollars. This walks into objects and lists,
// so a key inside `data` is treated the same as a column. Where the name without `_cents` is
// already taken, the value stays as stored, so neither of the two is lost.
const recordInDollars = (record: object): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(record).map(([key, value]) => {
      const plain = key.slice(0, -CENTS.length);
      return key.endsWith(CENTS) &&
        plain !== "" &&
        !Object.hasOwn(record, plain) &&
        (typeof value === "number" || value === null)
        ? [plain, value === null ? null : value / 100]
        : [key, inDollars(value)];
    }),
  );

const inDollars = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(inDollars);
  return typeof value === "object" && value !== null ? recordInDollars(value) : value;
};

/**
 * How a curated tool shows a row it read. JSON columns come out parsed. A `_cents` column, or
 * a `data` key ending in `_cents`, comes out as an amount in dollars under the same name
 * without `_cents`. `query` returns raw rows and does not use this.
 */
export const formatRow = (row: object): Record<string, unknown> =>
  recordInDollars(
    Object.fromEntries(
      Object.entries(row).map(([column, value]) => [
        column,
        JSON_COLUMNS.has(column) && typeof value === "string" ? parsed(value) : value,
      ]),
    ),
  );
