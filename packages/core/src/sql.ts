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
