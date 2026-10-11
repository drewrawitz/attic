import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { test } from "./support/harness.ts";
import { calling, householdClient, type Answer } from "./support/household.ts";
import { mcp } from "./support/mcp-client.ts";

// What `get_record` returns is tested on Node SQLite, in packages/core. D1 is not the same build
// (ADR 0006), and each type of record is read by a statement of its own, with lists built by
// subqueries inside subqueries. So these go through the real Worker on local D1, with the
// made-up household loaded.

type Fields = Record<string, unknown>;

// A test body that gets records, as a signed-in client.
const asking = (
  body: (get: (type: string, id: string) => Promise<Answer<Fields>>) => Promise<void>,
) => calling<Fields>("get_record")((call) => body((type, id) => call({ type, id })));

const TYPES = [
  "property",
  "space",
  "item",
  "work",
  "project",
  "vendor",
  "document",
  "schedule",
  "note",
];

test(
  "a signed-in client is told what get_record takes, and that it only reads",
  Effect.gen(function* () {
    const { url, token } = yield* householdClient;
    const { message } = yield* Effect.promise(() => mcp(url, { method: "tools/list" }, token));
    const { result } = message as { result: { tools: { name: string }[] } };

    expect(result.tools.find(({ name }) => name === "get_record")).toEqual(
      expect.objectContaining({
        description: expect.stringContaining("what hangs off it"),
        inputSchema: expect.objectContaining({
          type: "object",
          properties: {
            type: { type: "string", enum: TYPES, description: expect.any(String) },
            id: { type: "string", description: expect.any(String) },
          },
          required: ["type", "id"],
        }),
        annotations: { readOnlyHint: true },
      }),
    );
  }),
);

// "Order a new water filter for the fridge." The part number, the cadence, and where the Part
// was bought last each come from a different place, and this is all three in one call.
test(
  "get_record returns the fridge on D1 with its Part, its Schedule, and the Vendor on the last Work for it",
  asking(async (get) => {
    const filterChange = {
      id: "seed-work-filter-2026",
      kind: "maintenance",
      title: "Replaced the fridge water filter",
      date: "2026-06-20",
      cost: 49.99,
      diy: 1,
      property: "Maple Street house",
      vendor: "Filter Depot",
      vendor_id: "seed-vendor-filter-depot",
    };
    expect(await get("item", "seed-item-fridge")).toEqual({
      type: "item",
      id: "seed-item-fridge",
      name: "Fridge",
      scope: "fixture",
      status: "active",
      status_on: null,
      property_id: "seed-property-maple",
      property: "Maple Street house",
      space_id: "seed-space-kitchen",
      space: "Kitchen",
      category_id: "appliances",
      category: "Appliances",
      extra_categories: [],
      acquired_on: "2022-06-03",
      price: 2199,
      vendor_id: "seed-vendor-appliance-barn",
      bought_from: "Appliance Barn",
      proceeds: null,
      data: {
        brand: "Samsung",
        model: "RF28R7351SR",
        serial: "SEED-FRIDGE-0001",
        warranty_until: "2027-06",
        parts: { "water-filter": { name: "Water filter", part_number: "DA97-17376B" } },
      },
      schedules: [
        {
          id: "seed-schedule-fridge-filter",
          title: "Replace fridge water filter",
          interval_days: 180,
          last_done_on: "2026-06-20",
          next_due_on: "2026-12-17",
          active: 1,
          data: {},
          last_work: filterChange,
        },
      ],
      work: [filterChange, expect.objectContaining({ id: "seed-work-filter-2025" })],
      documents: [
        expect.objectContaining({ id: "seed-doc-filter-receipt", total: 49.99 }),
        expect.objectContaining({ id: "seed-doc-fridge-receipt", total: 2199 }),
        expect.objectContaining({ id: "seed-doc-fridge-photo", kind: "photo" }),
        expect.objectContaining({ id: "seed-doc-fridge-manual", kind: "manual" }),
      ],
      notes: [],
      changes: [],
      created_at: expect.any(String),
      updated_at: expect.any(String),
    });
  }),
);

// One record of each type, with the part of it that its own statement builds.
test(
  "get_record reads a record of every type on D1",
  asking(async (get) => {
    const trim = {
      brand: "Sherwin-Williams",
      color: "Pure White",
      code: "SW 7005",
      sheen: "semi-gloss",
    };
    const records: ReadonlyArray<readonly [type: string, id: string, has: Fields]> = [
      // By its name, whatever its case.
      [
        "property",
        "maple street HOUSE",
        {
          id: "seed-property-maple",
          data: { paint: { trim } },
          schedules: [
            {
              id: "seed-schedule-furnace",
              last_work: { id: "seed-work-furnace", vendor: "Hearth Heating and Air" },
            },
          ],
          notes: [{ id: "seed-note-breaker" }],
        },
      ],
      // "What paint is in the living room?" Its trim is the Property's.
      [
        "space",
        "seed-space-living-room",
        {
          data: { paint: { walls: { color: "Agreeable Gray", code: "SW 7029" } } },
          from_property: { paint: { trim } },
          items: [{ id: "seed-item-couch" }],
          work: [{ id: "seed-work-thermostat" }],
        },
      ],
      // "Something's wrong with the microwave."
      ["item", "seed-item-microwave", { data: { brand: "Panasonic", model: "NN-SN686S" } }],
      [
        "work",
        "seed-work-water-heater",
        {
          vendor: "Pipewise Plumbing",
          items: [{ id: "seed-item-water-heater" }],
          spaces: [{ id: "seed-space-garage", name: "Garage" }],
          documents: [{ id: "seed-doc-water-heater-receipt" }],
        },
      ],
      // "Who quoted the outdoor lighting, and for how much?"
      [
        "project",
        "seed-project-outdoor-lighting",
        {
          quotes: [
            { vendor: "Glow Landscape Lighting", amount: 3650 },
            { vendor: "Brightside Electric", amount: 4200 },
          ],
          total_cost: 830,
          notes: [{ id: "seed-note-lighting" }],
        },
      ],
      [
        "vendor",
        "seed-vendor-brightside",
        {
          work: [{ id: "seed-work-lighting-transformer" }],
          quotes: [{ project: "Outdoor lighting", amount: 4200 }],
        },
      ],
      [
        "document",
        "seed-doc-filter-receipt",
        {
          total: 49.99,
          attached_to: [
            { type: "item", id: "seed-item-fridge", name: "Fridge" },
            { type: "work", id: "seed-work-filter-2026", name: "Replaced the fridge water filter" },
          ],
        },
      ],
      [
        "schedule",
        "seed-schedule-fridge-filter",
        {
          item: "Fridge",
          work: [{ id: "seed-work-filter-2026" }, { id: "seed-work-filter-2025" }],
        },
      ],
      [
        "note",
        "seed-note-pipewise",
        {
          attached_to: [{ type: "vendor", id: "seed-vendor-pipewise", name: "Pipewise Plumbing" }],
        },
      ],
    ];
    expect(records.map(([type]) => type)).toEqual(TYPES);

    for (const [type, id, has] of records) {
      expect(await get(type, id), type).toMatchObject({ type, changes: [], ...has });
    }
  }),
);

test(
  "a record that does not exist, and a type that does not, are refused",
  asking(async (get) => {
    expect(await get("item", "seed-item-toaster")).toEqual({
      refused:
        'There is no Item with the id "seed-item-toaster". Ids come from search and from the records get_record returns.',
    });
    expect(await get("property", "Oak Lane")).toEqual({
      refused:
        'There is no Property "Oak Lane". The Properties are: Elm Court apartment, Maple Street house.',
    });

    // A Quote is not a type. It comes back with its Project.
    const { refused } = await get("quote", "seed-quote-glow");
    expect(refused).toContain("Input validation error");
    for (const type of TYPES) expect(refused).toContain(`"${type}"`);
  }),
);
