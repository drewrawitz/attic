// D1's limits page allows a function 32 arguments. Local D1 took more on 2026-10-10, so no test
// would catch a call with more, and `jsonObject` never makes one.
const MOST_ARGUMENTS = 32;

// A field is two arguments: its name, and its value. So `json_object` takes 16, and
// `json_set`, whose first argument is the object it adds to, takes 15 more at a time.
const FIELDS_IN_OBJECT = MOST_ARGUMENTS / 2;
const FIELDS_SET_AT_ONCE = Math.floor((MOST_ARGUMENTS - 1) / 2);

/**
 * The SQL of one JSON object: each field's name, and the SQL of its value. Past 16 fields the
 * rest are added with `json_set`, which keeps a field whose value is null, as `json_object`
 * does, and takes a value that is JSON as JSON.
 */
export const jsonObject = (fields: ReadonlyArray<readonly [name: string, value: string]>) => {
  const first = fields.slice(0, FIELDS_IN_OBJECT);
  let object = `json_object(${first.map(([name, value]) => `'${name}', ${value}`).join(", ")})`;
  for (let at = FIELDS_IN_OBJECT; at < fields.length; at += FIELDS_SET_AT_ONCE) {
    const more = fields.slice(at, at + FIELDS_SET_AT_ONCE);
    object = `json_set(${object}, ${more.map(([name, value]) => `'$.${name}', ${value}`).join(", ")})`;
  }
  return object;
};

/**
 * The SQL of the rows of a SELECT as one JSON list. `entry` is the SQL of what each row is in
 * the list, such as a JSON object of its columns.
 */
export const jsonList = (entry: string, select: string) =>
  `(SELECT json_group_array(${entry}) FROM (${select}))`;

/**
 * The rows of a SELECT as one JSON list of objects. Each has these fields, read from the column
 * of that name. A field named in `holdingJson` holds JSON text, and goes in as the JSON it is:
 * a JSON value that passes through a subquery comes out as plain text.
 */
export const jsonRows = (
  fields: ReadonlyArray<string>,
  select: string,
  holdingJson: ReadonlyArray<string> = [],
) =>
  jsonList(
    jsonObject(
      fields.map((field) => [field, holdingJson.includes(field) ? `json(${field})` : field]),
    ),
    select,
  );

/**
 * The rows in a JSON list that `jsonRows` built, as a statement returned it. A column that is
 * not there, or is null, has none.
 */
export const rowsIn = <Row>(list: string | null | undefined) => JSON.parse(list ?? "[]") as Row[];

// D1's limits page allows a statement 100,000 bytes, and each statement of a batch the same
// (read on 2026-10-12). Nothing was sent to local D1 to find out whether it holds to that, so
// no test would catch a longer one, and this does.
const MOST_BYTES = 100_000;

/**
 * A statement that is built from pieces, as it is sent: each run of spaces and line breaks is
 * one space, so the way the pieces were laid out to be read costs nothing. One that is longer
 * than D1 takes stops here.
 */
export const compact = (statement: string) => {
  const sent = statement.replace(/\s+/g, " ").trim();
  const bytes = new TextEncoder().encode(sent).length;
  if (bytes > MOST_BYTES) {
    throw new Error(`A statement is ${bytes} bytes. D1 takes ${MOST_BYTES}.`);
  }
  return sent;
};
