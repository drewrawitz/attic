import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { today } from "./dates.ts";
import { ToolError } from "./tool.ts";

/** The Properties there are, by name, for an error about one that is not among them. */
export const propertiesThere = (properties: ReadonlyArray<{ readonly name: string }>) =>
  properties.length === 0
    ? "There are no Properties yet."
    : `The Properties are: ${properties.map(({ name }) => name).join(", ")}.`;

/** A Property as a tool finds it, with what `everyProperty` was asked about it. */
export interface Property {
  readonly id: string;
  readonly name: string;
  readonly end_on: string | null;
  /** 1 on the Property that has the id that was asked about. */
  readonly has_id: number | null;
  /** 1 on the Property that has the name that was asked about, whatever its case. */
  readonly has_name: number | null;
}

/**
 * Every Property, by name. A caller that is looking for one gives its id, its name, or both,
 * and each Property says whether it is the one. The database compares the name, so case is
 * ignored the same way it is everywhere else.
 */
export const everyProperty = Effect.fnUntraced(function* (
  asked: { readonly id?: string | undefined; readonly name?: string | undefined } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<Property>`
    SELECT id, name, end_on,
           (id = ${asked.id ?? null}) AS has_id, (name = ${asked.name ?? null}) AS has_name
      FROM properties ORDER BY name`;
});

/**
 * The Property a caller named, by its id or by its name. One that is not there is an error
 * that lists the ones that are.
 */
export const propertyNamed = Effect.fnUntraced(function* (given: string) {
  const properties = yield* everyProperty({ id: given, name: given });
  const property = properties.find(({ has_id, has_name }) => has_id === 1 || has_name === 1);
  if (property !== undefined) return { id: property.id, name: property.name };

  return yield* new ToolError({
    message: `There is no Property "${given}". ${propertiesThere(properties)}`,
  });
});

/**
 * The one Current property: the Property that is still the User's today, because it has no end
 * date or its end date has not passed. Today is the date in the configured timezone. With no
 * Current property, or with several, it is an error that lists them and says to name one.
 */
export const currentProperty = Effect.gen(function* () {
  const day = yield* today;
  const properties = yield* everyProperty();

  // A Partial date counts through the whole period it names. So an end date is held against
  // as much of today as it has itself: 2026 against the year, 2026-10 against the month.
  const current = properties.filter(
    ({ end_on }) => end_on === null || end_on >= day.slice(0, end_on.length),
  );
  const [only, ...others] = current;
  if (only !== undefined && others.length === 0) return { id: only.id, name: only.name };

  if (properties.length === 0) {
    return yield* new ToolError({
      message: "There are no Properties yet. Save one with save_property first.",
    });
  }
  const names = current.map(({ name }) => name).join(", ");
  const which =
    only === undefined
      ? `No Property is current: each one has an end date that has passed. ${propertiesThere(properties)}`
      : `${current.length} Properties are current: ${names}.`;
  return yield* new ToolError({
    message: `${which} Say which one this is for: give \`property\` its id or its name.`,
  });
});

/**
 * The Property a tool works at: the one the caller named, by its id or its name, or the one
 * Current property when the caller named none.
 */
export const propertyFor = (given: string | undefined) =>
  given === undefined ? currentProperty : propertyNamed(given);
