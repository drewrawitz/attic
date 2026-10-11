import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { insertRow, nameKey, referredOnce, type Referred } from "./save.ts";
import { Ids } from "./write.ts";

/**
 * The Space with a name at a Property, whatever the name's case, created on first use. `data`
 * is what a new Space starts with.
 */
export const spaceOrNew = Effect.fnUntraced(function* (
  propertyId: string,
  name: string,
  data?: object,
) {
  const sql = yield* SqlClient.SqlClient;
  // The database compares the name, so case is ignored the same way it is everywhere else.
  const [found] = yield* sql<{ id: string; name: string }>`
    SELECT id, name FROM spaces WHERE property_id = ${propertyId} AND name = ${name}`;
  if (found !== undefined) {
    return { type: "space", id: found.id, name: found.name, steps: [] } satisfies Referred;
  }

  const space = { type: "space", id: yield* (yield* Ids).next, name } as const;
  const created = insertRow(sql, space, { property_id: propertyId, name }, data);
  return { ...space, steps: [created] } satisfies Referred;
});

/**
 * `spaceOrNew` for a call that takes a list: a Space several entries name is read once, and
 * one that is new is created once, by the first entry that names it.
 */
export const spaceOrNewOnce = () =>
  referredOnce(
    (propertyId: string, name: string) => spaceOrNew(propertyId, name),
    (propertyId, name) => `${propertyId} ${nameKey(name)}`,
  );
