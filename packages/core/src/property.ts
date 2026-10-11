import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { ToolError } from "./tool.ts";

/**
 * The Property a caller named, by its id or by its name. One that is not there is an error
 * that lists the ones that are.
 */
export const propertyNamed = (given: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // The database compares the name, so case is ignored the same way it is everywhere else.
    const properties = yield* sql<{ id: string; name: string; named: number }>`
      SELECT id, name, (id = ${given} OR name = ${given}) AS named FROM properties ORDER BY name`;

    const property = properties.find(({ named }) => named === 1);
    if (property !== undefined) return { id: property.id, name: property.name };

    const there =
      properties.length === 0
        ? "There are no Properties yet."
        : `The Properties are: ${properties.map(({ name }) => name).join(", ")}.`;
    return yield* new ToolError({ message: `There is no Property "${given}". ${there}` });
  });
