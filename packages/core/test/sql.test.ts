import { expect, it } from "@effect/vitest";
import { jsonObject } from "../src/sql.ts";

// The arguments of each call to a function in a piece of SQL, by the function's name, in the
// order the calls open. It counts the commas that are not inside a call or a string within it.
const argumentsOfEachCall = (sql: string) => {
  const calls: { name: string; count: number }[] = [];
  const open: number[] = [];
  let quoted = false;
  for (let at = 0; at < sql.length; at++) {
    const char = sql[at];
    if (char === "'") quoted = !quoted;
    if (quoted) continue;
    if (char === "(") {
      const name = /(\w+)$/.exec(sql.slice(0, at))?.[1] ?? "";
      open.push(calls.push({ name, count: 1 }) - 1);
    } else if (char === ")") {
      open.pop();
    } else if (char === "," && open.length > 0) {
      calls[open.at(-1)!]!.count++;
    }
  }
  return calls;
};

// D1 takes 32 arguments to a function, and local D1 takes more, so no test through the Worker
// would see a call with too many (ADR 0006).
it("a JSON object of any number of fields gives no function more than 32 arguments", () => {
  for (const count of [1, 16, 17, 18, 31, 32, 50]) {
    const fields = Array.from({ length: count }, (_, at) => [`f${at}`, `record.c${at}`] as const);
    const calls = argumentsOfEachCall(jsonObject(fields));
    for (const { name, count: given } of calls) {
      expect(given, `${name} in an object of ${count}`).toBeLessThanOrEqual(32);
    }
    // Every field is in it once.
    const names = fields.map(([name]) => name);
    const sql = jsonObject(fields);
    for (const name of names)
      expect(sql.match(new RegExp(`'(\\$\\.)?${name}'`, "g"))).toHaveLength(1);
  }
});
