import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { test } from "./support/harness.ts";
import { calling, householdClient } from "./support/household.ts";
import { mcp } from "./support/mcp-client.ts";

// What `gaps` counts as missing is tested on Node SQLite, in packages/core. D1 is not the same
// build (ADR 0006), and the whole reply is one statement: it joins the view that walks the
// Category tree to `json_each`, numbers its rows with a window function, and builds each list
// in a subquery. So these go through the real Worker on local D1, with the made-up household
// loaded. Its Maple Street house is the one Current property.

// One entry of what `gaps` sends back: a record, and the fields it has nothing in.
interface Entry {
  readonly type: string;
  readonly id: string;
  readonly name: string;
  readonly missing: ReadonlyArray<string>;
}

// What `gaps` sends back.
interface Gaps {
  readonly counts: { readonly items: number; readonly work: number; readonly spaces: number };
  readonly property: string;
  readonly spaces: ReadonlyArray<Entry & { readonly items: ReadonlyArray<Entry> }>;
  readonly no_space: { readonly items: ReadonlyArray<Entry> };
  readonly work: ReadonlyArray<Entry & { readonly spaces: ReadonlyArray<string> }>;
}

// A test body that asks what is missing, as a signed-in client.
const asking = calling<Gaps>("gaps");

test(
  "a signed-in client is told what gaps takes, and that it only reads",
  Effect.gen(function* () {
    const { url, token } = yield* householdClient;
    const { message } = yield* Effect.promise(() => mcp(url, { method: "tools/list" }, token));
    const { result } = message as { result: { tools: { name: string }[] } };

    // An optional field takes null or nothing, and says what it is for beside its type.
    const optional = {
      anyOf: [{ type: "string", description: expect.any(String) }, { type: "null" }],
    };
    expect(result.tools.find(({ name }) => name === "gaps")).toEqual(
      expect.objectContaining({
        description: expect.stringContaining("what is missing at a Property, grouped by Space"),
        inputSchema: expect.objectContaining({
          type: "object",
          properties: { property: optional, space: optional },
          additionalProperties: false,
        }),
        annotations: { readOnlyHint: true },
      }),
    );
  }),
);

const WATER_HEATER = {
  type: "item",
  id: "seed-item-water-heater",
  name: "Water heater",
  missing: ["price"],
};
// It is dated only 2023, because the date on its Receipt cannot be read.
const WATER_HEATER_WORK = {
  type: "work",
  id: "seed-work-water-heater",
  name: "Replaced the water heater",
  spaces: ["Garage"],
  missing: [],
  year_only: ["date"],
};
const noSize = (id: string, name: string, ...items: ReadonlyArray<Entry>) => ({
  type: "space",
  id,
  name,
  missing: ["data.sqft"],
  items,
});

// The router is filed under Networking, which expects nothing. The serial it lacks is expected
// by Electronics, the Category above it, so finding it means the Category tree was walked. The
// exercise bike has no serial either, and it was sold. The living room has a size and wall
// paint, and the other three Spaces have only the Property's trim for paint.
test(
  "the gaps of the made-up household come back on D1, with an Item missing a key only a parent Category expects",
  asking(async (gaps) => {
    expect(await gaps({})).toEqual({
      counts: { items: 2, work: 1, spaces: 3 },
      property: "Maple Street house",
      spaces: [
        noSize("seed-space-exterior", "Exterior"),
        noSize("seed-space-garage", "Garage", WATER_HEATER),
        noSize("seed-space-kitchen", "Kitchen"),
      ],
      no_space: {
        items: [
          { type: "item", id: "seed-item-router", name: "Office router", missing: ["data.serial"] },
        ],
      },
      work: [WATER_HEATER_WORK],
    });
  }),
);

// Both options are given, so every value the statement binds reaches D1.
test(
  "gaps keeps to one Space on D1, whatever the case of its name",
  asking(async (gaps) => {
    expect(await gaps({ property: "maple street HOUSE", space: "GARAGE" })).toEqual({
      counts: { items: 1, work: 1, spaces: 1 },
      property: "Maple Street house",
      spaces: [noSize("seed-space-garage", "Garage", WATER_HEATER)],
      work: [WATER_HEATER_WORK],
    });

    // The former Property has no paint for its Spaces, and the landlord's dishwasher was left
    // there with no Price, no date, and no serial.
    expect(await gaps({ property: "Elm Court apartment" })).toEqual({
      counts: { items: 1, work: 0, spaces: 1 },
      property: "Elm Court apartment",
      spaces: [
        {
          type: "space",
          id: "seed-space-elm-kitchen",
          name: "Kitchen",
          missing: ["data.sqft", "data.paint"],
          items: [
            {
              type: "item",
              id: "seed-item-elm-dishwasher",
              name: "Dishwasher",
              missing: ["price", "acquired_on", "data.serial"],
            },
          ],
        },
      ],
      no_space: { items: [] },
      work: [],
    });
  }),
);

test(
  "a Space that is not at the Property, a Property that does not exist, and a field that does not, are refused",
  asking(async (gaps) => {
    expect(await gaps({ space: "Attic" })).toEqual({
      refused:
        'There is no Space "Attic" at Maple Street house. Its Spaces are: Exterior, Garage, Kitchen, Living room.',
    });
    expect(await gaps({ property: "Oak Lane" })).toEqual({
      refused:
        'There is no Property "Oak Lane". The Properties are: Elm Court apartment, Maple Street house.',
    });

    // search takes this one, and gaps always leaves a Gone Item out.
    const { refused } = await gaps({ include_gone: true });
    expect(refused).toContain("Input validation error");
    expect(refused).toContain("The fields are: property, space.");
  }),
);
