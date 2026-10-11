import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { test } from "./support/harness.ts";
import { calling, householdClient } from "./support/household.ts";
import { mcp } from "./support/mcp-client.ts";

// What `search` matches is tested on Node SQLite, in packages/core. D1 is not the same build
// (ADR 0006), and it has limits of its own that Node SQLite does not: at most five SELECTs in
// one UNION, and at most 50 bytes in a LIKE pattern. So these go through the real Worker on
// local D1, with the made-up household loaded.

// What `search` sends back: the records it found, and a note when there were more.
interface Found {
  readonly results: ReadonlyArray<Record<string, unknown>>;
  readonly note: string;
}

// A test body that searches, as a signed-in client.
const asking = calling<Found>("search");

test(
  "a signed-in client is told what search takes, and that it only reads",
  Effect.gen(function* () {
    const { url, token } = yield* householdClient;
    const { message } = yield* Effect.promise(() => mcp(url, { method: "tools/list" }, token));
    const { result } = message as { result: { tools: { name: string }[] } };

    // An optional field takes null or nothing, and says what it is for beside its type.
    const optional = (field: Record<string, unknown>) => ({
      anyOf: [{ ...field, description: expect.any(String) }, { type: "null" }],
    });
    expect(result.tools.find(({ name }) => name === "search")).toEqual(
      expect.objectContaining({
        description: expect.stringContaining("Every word must be somewhere in the record"),
        inputSchema: expect.objectContaining({
          type: "object",
          properties: {
            words: { type: "string", description: expect.any(String) },
            types: optional({
              type: "array",
              items: {
                type: "string",
                enum: ["item", "work", "project", "vendor", "space", "note", "document"],
              },
            }),
            property: optional({ type: "string" }),
            include_gone: optional({ type: "boolean" }),
          },
          required: ["words"],
        }),
        annotations: { readOnlyHint: true },
      }),
    );
  }),
);

// Every option is given, so every value the statement binds reaches D1.
test(
  "search finds a record on D1 by words that are in different places of it",
  asking(async (search) => {
    expect(
      await search({
        words: "samsung kitchen",
        types: ["document", "item"],
        property: "maple street HOUSE",
        include_gone: true,
      }),
    ).toEqual({
      results: [
        {
          type: "item",
          id: "seed-item-fridge",
          name: "Fridge",
          property: "Maple Street house",
          status: "active",
          matched: {
            data: {
              brand: "Samsung",
              model: "RF28R7351SR",
              serial: "SEED-FRIDGE-0001",
              warranty_until: "2027-06",
              parts: { "water-filter": { name: "Water filter", part_number: "DA97-17376B" } },
            },
            spaces: ["Kitchen"],
            documents: [
              {
                id: "seed-doc-fridge-receipt",
                title: "Appliance Barn receipt",
                text: "Appliance Barn. Samsung RF28R7351SR french door refrigerator. Delivered and installed. Total $2,199.00.",
              },
            ],
          },
        },
      ],
    });
  }),
);

// The two questions from AGENTS.md that one search answers.
test(
  "one search answers who did the plumbing last time, and one what fitness Items there are",
  asking(async (search) => {
    // Work comes latest first, and says which Vendor it matched on.
    const plumbing = await search({ words: "plumbing", types: ["work"] });
    expect(plumbing.results![0]).toMatchObject({
      type: "work",
      title: "Replaced the kitchen faucet cartridge",
      date: "2023-06-12",
      matched: { vendors: ["Pipewise Plumbing"] },
    });

    // The treadmill is under Cardio, a child of Fitness, and the exercise bike was sold.
    const fitness = await search({ words: "fitness" });
    expect(fitness.results!.map(({ type, name }) => `${String(type)} ${String(name)}`)).toEqual([
      "item Adjustable dumbbells",
      "item Running watch",
      "item Treadmill",
    ]);
  }),
);

test(
  "D1 takes the longest word search lets through, and search refuses a longer one itself",
  asking(async (search) => {
    expect(await search({ words: "a".repeat(48) })).toEqual({ results: [] });
    // Each % is escaped, so this pattern is 50 bytes too.
    expect(await search({ words: "%".repeat(24) })).toEqual({ results: [] });

    const { refused } = await search({ words: "a".repeat(49) });
    expect(refused).toContain("too long to search for");
  }),
);

test(
  "a Property that does not exist, and a type that does not, are refused",
  asking(async (search) => {
    expect(await search({ words: "kitchen", property: "Oak Lane" })).toEqual({
      refused:
        'There is no Property "Oak Lane". The Properties are: Elm Court apartment, Maple Street house.',
    });

    const { refused } = await search({ words: "kitchen", types: ["quote"] });
    expect(refused).toContain("Input validation error");
  }),
);
