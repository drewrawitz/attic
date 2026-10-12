import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { today } from "./dates.ts";
import { term } from "./records.ts";
import { askedOnce, nameKey } from "./save.ts";
import { ToolError } from "./tool.ts";

/** The Properties there are, by name, for an error about one that is not among them. */
export const propertiesThere = (properties: ReadonlyArray<{ readonly name: string }>) =>
  properties.length === 0
    ? "There are no Properties yet."
    : `The Properties are: ${properties.map(({ name }) => name).join(", ")}.`;

/** A Property as a tool finds it. */
export interface Property {
  readonly id: string;
  readonly name: string;
  readonly end_on: string | null;
  /** Whether its name is the one `everyProperty` was asked to look for, whatever the case. */
  readonly hasName: boolean;
}

/**
 * Every Property, by name. A caller that is looking for one by its name gives the name, and
 * each Property says whether it has it. The database compares the name, so case is ignored the
 * same way it is everywhere else.
 */
export const everyProperty = Effect.fnUntraced(function* (name?: string) {
  const sql = yield* SqlClient.SqlClient;
  const properties = yield* sql<{
    readonly id: string;
    readonly name: string;
    readonly end_on: string | null;
    readonly has_name: number | null;
  }>`SELECT id, name, end_on, (name = ${name ?? null}) AS has_name FROM properties ORDER BY name`;
  return properties.map(({ has_name, ...property }): Property => ({
    ...property,
    hasName: has_name === 1,
  }));
});

/**
 * The Property a caller named, by its id or by its name. One that is not there is an error
 * that lists the ones that are.
 */
export const propertyNamed = Effect.fnUntraced(function* (given: string) {
  const properties = yield* everyProperty(given);
  const property = properties.find(({ id, hasName }) => id === given || hasName);
  if (property !== undefined) return { id: property.id, name: property.name };

  return yield* new ToolError({
    message: `There is no Property "${given}". ${propertiesThere(properties)}`,
  });
});

/**
 * Refuses a save that names another Property for a record that does not move to one: a Space,
 * or a Project. `given` is the Property the save named, if it named one, and naming the one the
 * record is at is no move. `record` says what the record is and where it is.
 */
export const refuseAnotherProperty = Effect.fnUntraced(function* (
  given: string | undefined,
  record: {
    readonly type: "space" | "project";
    readonly name: string;
    readonly property_id: string;
    /** The name of the Property it is at. */
    readonly property: string;
  },
) {
  if (given === undefined) return;
  const named = yield* propertyNamed(given);
  if (named.id === record.property_id) return;
  const typeTerm = term(record.type);
  return yield* new ToolError({
    message: `The ${typeTerm} "${record.name}" is at ${record.property}, not at ${named.name}. A ${typeTerm} does not move to another Property.`,
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

/**
 * `propertyFor` for a call that takes a list: each Property its entries name is read once,
 * however many of them name it and whatever the case of the name, and so is the Current
 * property for the ones that name none.
 */
export const propertyForOnce = () =>
  askedOnce(propertyFor, (given) => (given === undefined ? undefined : nameKey(given)));
