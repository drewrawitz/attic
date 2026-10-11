import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { insertRow, type Referred } from "./save.ts";
import { Ids } from "./write.ts";

/**
 * The Vendor with a name, whatever the name's case, created on first use. `columns` and `data`
 * are what a new Vendor starts with beside its name.
 */
export const vendorNamed = Effect.fnUntraced(function* (
  name: string,
  columns: Readonly<Record<string, unknown>> = {},
  data?: object,
) {
  const sql = yield* SqlClient.SqlClient;
  // The database compares the name, so case is ignored the same way it is everywhere else.
  const [found] = yield* sql<{ id: string; name: string }>`
    SELECT id, name FROM vendors WHERE name = ${name}`;
  if (found !== undefined) {
    return { type: "vendor", id: found.id, name: found.name, steps: [] } satisfies Referred;
  }

  const vendor = { type: "vendor", id: yield* (yield* Ids).next, name } as const;
  return {
    ...vendor,
    steps: [insertRow(sql, vendor, { ...columns, name }, data)],
  } satisfies Referred;
});
