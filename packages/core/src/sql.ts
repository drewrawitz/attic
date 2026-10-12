// D1's limits page allows a function 32 arguments, which is 16 fields. Local D1 took more on
// 2026-10-10, so no test would catch a longer object, and this does.
const MOST_FIELDS = 16;

/** The SQL of one JSON object: each field's name, and the SQL of its value. */
export const jsonObject = (fields: ReadonlyArray<readonly [name: string, value: string]>) => {
  if (fields.length > MOST_FIELDS) {
    throw new Error(`A JSON object has ${fields.length} fields. D1 takes ${MOST_FIELDS}.`);
  }
  return `json_object(${fields.map(([name, value]) => `'${name}', ${value}`).join(", ")})`;
};

/**
 * The SQL of the rows of a SELECT as one JSON list. `entry` is the SQL of what each row is in
 * the list, such as a JSON object of its columns.
 */
export const jsonList = (entry: string, select: string) =>
  `(SELECT json_group_array(${entry}) FROM (${select}))`;

/**
 * The rows of a SELECT as one JSON list of objects. Each has these fields, read from the column
 * of that name.
 */
export const jsonRows = (fields: ReadonlyArray<string>, select: string) =>
  jsonList(jsonObject(fields.map((field) => [field, field])), select);

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
