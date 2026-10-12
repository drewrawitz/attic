import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { Listed } from "../../src/save.ts";
import { getRecord } from "../../src/tools/get-record.ts";
import { logWork } from "../../src/tools/log-work.ts";
import { saveProperty } from "../../src/tools/save-property.ts";
import { saveSpace } from "../../src/tools/save-space.ts";
import { search } from "../../src/tools/search.ts";
import { answer, call, callAsClient, todayIs, type Answer } from "../call.ts";
import { loadHousehold } from "../household.ts";
import { TestDatabase } from "../TestDatabase.ts";

// Work logged the way a client logs it: checked against the tool's input first.
const logging = (input: unknown) => callAsClient(logWork, input).pipe(Effect.map(answer));

const getting = (type: string, id: string) =>
  call(getRecord, { type, id }).pipe(Effect.map(answer));

// The made-up household has one Current property on this day: the Maple Street house. The Elm
// Court apartment ended in 2022-05.
const TODAY = "2026-10-11";

const FRIDGE = "seed-item-fridge";

// What the `work_log` view has for a piece of Work, which is what `query` returns.
const inWorkLog = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<Record<string, unknown>>`SELECT * FROM work_log WHERE id = ${id}`;
    return row;
  });

// The test database hands out ids in order. A save takes one for each record it creates, in
// the order its batch writes them, and then one for its Change.
it.effect("Work logged with a Vendor, a Space, and an Item shows on each of the three", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);

    const logged = yield* logging({
      kind: "repair",
      title: "Replaced the fridge door gasket",
      description: "The seal had split along the hinge side.",
      vendor: "Cold Seal Repair",
      item_ids: [FRIDGE],
      spaces: ["Pantry"],
    });

    // The Work as it is stored, which is what its Change holds.
    const stored = {
      id: "id-0003",
      // With no Property given, Work is at the one Current property.
      property_id: "seed-property-maple",
      project_id: null,
      kind: "repair",
      title: "Replaced the fridge door gasket",
      description: "The seal had split along the hinge side.",
      date: null,
      diy: 0,
      vendor_id: "id-0002",
      schedule_id: null,
      data: {},
      created_at: expect.any(String),
      updated_at: expect.any(String),
    };
    const gasket = {
      type: "work",
      ...stored,
      cost: null,
      property: "Maple Street house",
      project: null,
      vendor: "Cold Seal Repair",
      schedule: null,
      items: [
        { id: FRIDGE, name: "Fridge", scope: "fixture", status: "active", category: "Appliances" },
      ],
      spaces: [{ id: "id-0001", name: "Pantry" }],
      documents: [],
      notes: [],
      changes: [
        {
          id: "id-0004",
          tool: "log_work",
          created_at: expect.any(String),
          undoes: null,
          before: null,
          // A record lists its Items and its Spaces by name, and a Change by id.
          after: { ...stored, cost: null, items: [FRIDGE], spaces: ["id-0001"] },
        },
      ],
    };
    expect(yield* getting("work", "id-0003")).toEqual(gasket);

    // The reply lists what the call created, in the order the batch wrote it. The Item was
    // there already, and the save did not write to it. A call that logs one piece of Work
    // returns it as get_record does.
    expect(logged).toEqual({
      change_id: "id-0004",
      created: [
        { type: "space", id: "id-0001", name: "Pantry" },
        { type: "vendor", id: "id-0002", name: "Cold Seal Repair" },
        { type: "work", id: "id-0003", name: "Replaced the fridge door gasket" },
      ],
      updated: [],
      record: gasket,
    });

    // The Work shows on the Vendor, on the Space, and on the Item. The Space and the Vendor
    // are in the one Change with it.
    const shown = { id: "id-0003", kind: "repair", title: "Replaced the fridge door gasket" };
    const made = { id: "id-0004", tool: "log_work", before: null };
    expect(yield* getting("vendor", "id-0002")).toMatchObject({
      name: "Cold Seal Repair",
      work: [shown],
      changes: [made],
    });
    expect(yield* getting("space", "id-0001")).toMatchObject({
      name: "Pantry",
      property: "Maple Street house",
      work: [shown],
      changes: [made],
    });
    // The fridge has two filter changes already. Work with no date comes after them.
    expect(yield* getting("item", FRIDGE)).toMatchObject({
      work: [{ id: "seed-work-filter-2026" }, { id: "seed-work-filter-2025" }, shown],
    });

    // The view names the Property, the Vendor, the Items, and the Spaces.
    expect(yield* inWorkLog("id-0003")).toMatchObject({
      property: "Maple Street house",
      kind: "repair",
      title: "Replaced the fridge door gasket",
      vendor: "Cold Seal Repair",
      items: '["Fridge"]',
      spaces: '["Pantry"]',
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// What the table holds for a piece of Work, which is what `query` returns.
const inTable = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<Record<string, unknown>>`SELECT * FROM work WHERE id = ${id}`;
    return row;
  });

it.effect("a cost in dollars is stored as cents, and a Partial date as given", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);

    const logged = yield* logging({
      kind: "improvement",
      title: "Replaced the attic insulation",
      date: "2023",
      cost: 1850.5,
    });
    expect(logged.record).toMatchObject({ id: "id-0001", date: "2023", cost: 1850.5 });
    expect(yield* inTable("id-0001")).toMatchObject({ date: "2023", cost_cents: 185050 });
    expect(yield* inWorkLog("id-0001")).toMatchObject({ date: "2023", cost_cents: 185050 });

    // A year and a month, a full date, and an amount that a float cannot hold exactly.
    for (const [date, cost, cents] of [
      ["2023-06", 1299.1, 129910],
      ["2023-06-12", 0.07, 7],
      ["2024-02-29", 0, 0],
    ] as const) {
      const { record } = yield* logging({ kind: "repair", title: "Patched the roof", date, cost });
      expect(record, date).toMatchObject({ date, cost });
      expect(yield* inTable((record as { id: string }).id), date).toMatchObject({
        date,
        cost_cents: cents,
      });
    }

    // With neither given, the Work has no date and no cost. The date is not taken to be today.
    const bare = yield* logging({ kind: "inspection", title: "Looked over the roof" });
    expect(bare.record).toMatchObject({ date: null, cost: null });
  }).pipe(Effect.provide(TestDatabase)),
);

// How many of each record a save can write there are, read from the tables.
const counting = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [counts] = yield* sql<Record<string, number>>`
    SELECT (SELECT count(*) FROM work) AS work,
           (SELECT count(*) FROM work_items) AS work_items,
           (SELECT count(*) FROM work_spaces) AS work_spaces,
           (SELECT count(*) FROM spaces) AS spaces,
           (SELECT count(*) FROM vendors) AS vendors,
           (SELECT count(*) FROM notes) AS notes,
           (SELECT count(*) FROM changes) AS changes`;
  return counts!;
});

it.effect("a cost below zero, or a date that does not exist, is refused", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const before = yield* counting;
    const roof = { kind: "repair", title: "Patched the roof" };

    expect(yield* logging({ ...roof, cost: 19.999 })).toEqual({
      refused: "cost: Expected an amount with at most two decimal places, such as 1299.99.",
    });
    expect(yield* logging({ ...roof, cost: -5 })).toEqual({
      refused: "cost: Expected an amount that is not below zero.",
    });
    expect(yield* logging({ ...roof, date: "2023-13" })).toEqual({
      refused:
        "date: Expected a date that exists, written as 2023, 2023-06, or 2023-06-12. A date can be a Partial date: a year, or a year and a month.",
    });
    expect((yield* logging({ ...roof, kind: "upgrade" })).refused).toContain("kind");
    expect(yield* counting).toEqual(before);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("diy given as true is stored as 1, and Work is not DIY unless it says so", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);

    // On DIY Work the Vendor is where the materials came from.
    const diy = yield* logging({
      kind: "maintenance",
      title: "Replaced the furnace filter",
      diy: true,
      vendor: "Filter Depot",
    });
    // A record shows it as it is stored.
    expect(diy.record).toMatchObject({ id: "id-0001", diy: 1, vendor: "Filter Depot" });
    expect(yield* inTable("id-0001")).toMatchObject({ diy: 1 });
    expect(yield* inWorkLog("id-0001")).toMatchObject({ diy: 1, vendor: "Filter Depot" });

    const hired = yield* logging({ kind: "maintenance", title: "Swept the chimney", diy: false });
    expect(hired.record).toMatchObject({ diy: 0 });
    const unsaid = yield* logging({ kind: "maintenance", title: "Cleaned the gutters" });
    expect(unsaid.record).toMatchObject({ diy: 0 });

    // It is true or false, and nothing else.
    expect(
      (yield* logging({ kind: "repair", title: "Patched the roof", diy: 1 })).refused,
    ).toContain("diy");
  }).pipe(Effect.provide(TestDatabase)),
);

const TREADMILL = "seed-item-treadmill";

it.effect("Work is at the Property it names, and its Spaces are Spaces there", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);

    // The apartment is a former Property. It has a Kitchen, which is not the one at the Maple
    // Street house, and no Hallway yet.
    const drain = { kind: "repair", title: "Cleared the kitchen drain again" };
    const logged = yield* logging({
      ...drain,
      property: "elm court apartment",
      spaces: ["Hallway", "KITCHEN"],
    });
    expect(logged).toMatchObject({
      created: [
        { type: "space", id: "id-0001", name: "Hallway" },
        { type: "work", id: "id-0002" },
      ],
      record: {
        property_id: "seed-property-elm",
        property: "Elm Court apartment",
        spaces: [
          { id: "id-0001", name: "Hallway" },
          { id: "seed-space-elm-kitchen", name: "Kitchen" },
        ],
      },
    });
    expect(yield* getting("space", "id-0001")).toMatchObject({ property: "Elm Court apartment" });

    // A Property is given by its id as well.
    const byId = yield* logging({ ...drain, property: "seed-property-elm" });
    expect(byId.record).toMatchObject({ property: "Elm Court apartment", spaces: [] });

    const before = yield* counting;
    expect(yield* logging({ ...drain, property: "Oak Avenue", spaces: ["Porch"] })).toEqual({
      refused:
        'There is no Property "Oak Avenue". The Properties are: Elm Court apartment, Maple Street house.',
    });
    expect(yield* counting).toEqual(before);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect(
  "with two Current properties, Work on an Item has no Property, and Work on nothing is refused",
  () =>
    Effect.gen(function* () {
      yield* loadHousehold;
      yield* todayIs(TODAY);
      yield* call(saveProperty, { name: "Birch Road house", start_on: "2026-10" });
      const before = yield* counting;
      const belt = { kind: "maintenance", title: "Lubricated the treadmill belt" };
      const which =
        "2 Properties are current: Birch Road house, Maple Street house. Say which one this is for: give `property` its id or its name.";

      // Work needs a Property or at least one Item, and this has neither.
      expect(yield* logging(belt)).toEqual({ refused: which });
      expect(yield* logging({ ...belt, item_ids: [] })).toEqual({ refused: which });
      // A Space is one at a Property, so Work that names one has to say which Property.
      expect(yield* logging({ ...belt, item_ids: [TREADMILL], spaces: ["Garage"] })).toEqual({
        refused: which,
      });
      expect(yield* counting).toEqual(before);

      const onItem = yield* logging({ ...belt, item_ids: [TREADMILL] });
      expect(onItem.record).toMatchObject({
        property_id: null,
        property: null,
        items: [{ id: TREADMILL, name: "Treadmill" }],
        spaces: [],
      });
      expect(yield* getting("item", TREADMILL)).toMatchObject({
        work: [{ title: "Lubricated the treadmill belt", property: null }],
      });

      // With the Property named, it is there, and so are its Spaces.
      const there = yield* logging({
        ...belt,
        property: "Maple Street house",
        item_ids: [TREADMILL],
        spaces: ["Garage"],
      });
      expect(there.record).toMatchObject({
        property_id: "seed-property-maple",
        spaces: [{ id: "seed-space-garage" }],
      });
    }).pipe(Effect.provide(TestDatabase)),
);

it.effect("with no Current property, Work on an Item has no Property either", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    // The User has moved out of the Maple Street house, and has not saved the next place yet.
    yield* call(saveProperty, { id: "seed-property-maple", end_on: "2026-09" });
    const belt = { kind: "maintenance", title: "Lubricated the treadmill belt" };

    expect(yield* logging(belt)).toEqual({
      refused:
        "No Property is current: each one has an end date that has passed. The Properties are: Elm Court apartment, Maple Street house. Say which one this is for: give `property` its id or its name.",
    });
    const onItem = yield* logging({ ...belt, item_ids: [TREADMILL] });
    expect(onItem.record).toMatchObject({ property_id: null, items: [{ id: TREADMILL }] });
  }).pipe(Effect.provide(TestDatabase)),
);

// Pipewise replaced the water heater in 2023, for $1,850. The Work names the water heater and
// the Garage.
const HEATER = "seed-work-water-heater";
const MICROWAVE = "seed-item-microwave";

it.effect("item_ids and spaces replace their sets, and the Change has both before and after", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);

    const saved = yield* logging({
      id: HEATER,
      item_ids: [MICROWAVE, FRIDGE],
      spaces: ["Utility closet", "kitchen"],
    });
    expect(saved).toMatchObject({
      change_id: "id-0002",
      created: [{ type: "space", id: "id-0001", name: "Utility closet" }],
      updated: [{ type: "work", id: HEATER, name: "Replaced the water heater" }],
      record: {
        // What the save did not name is as it was.
        kind: "improvement",
        date: "2023",
        cost: 1850,
        vendor: "Pipewise Plumbing",
        property_id: "seed-property-maple",
        data: { permit: "SEED-PERMIT-0417" },
        // A record lists them by name, and a Change by id.
        items: [
          { id: FRIDGE, name: "Fridge" },
          { id: MICROWAVE, name: "Microwave" },
        ],
        spaces: [
          { id: "seed-space-kitchen", name: "Kitchen" },
          { id: "id-0001", name: "Utility closet" },
        ],
        changes: [
          {
            id: "id-0002",
            tool: "log_work",
            before: {
              id: HEATER,
              items: ["seed-item-water-heater"],
              spaces: ["seed-space-garage"],
            },
            after: {
              id: HEATER,
              items: [FRIDGE, MICROWAVE],
              spaces: ["id-0001", "seed-space-kitchen"],
            },
          },
        ],
      },
    });
    // The Work is listed once, though the save took five statements.
    expect(saved.updated).toHaveLength(1);
    // It no longer shows on the Item and the Space it named before.
    expect(yield* getting("item", "seed-item-water-heater")).toMatchObject({ work: [] });
    expect((yield* getting("space", "seed-space-garage")).work).toEqual([]);

    // A save that says nothing of them leaves them as they are.
    const untouched = yield* logging({ id: HEATER, cost: 1900, data: { replaced: null } });
    expect(untouched).toMatchObject({
      created: [],
      record: {
        cost: 1900,
        data: { permit: "SEED-PERMIT-0417" },
        items: [{ id: FRIDGE }, { id: MICROWAVE }],
        spaces: [{ id: "seed-space-kitchen" }, { id: "id-0001" }],
      },
    });
    expect((untouched.record as { data: object }).data).not.toHaveProperty("replaced");

    // An Item or a Space named twice is in the set once, whatever the case of the name.
    const twice = yield* logging({
      id: HEATER,
      item_ids: [FRIDGE, FRIDGE],
      spaces: ["Garage", "GARAGE"],
    });
    expect(twice.record).toMatchObject({
      items: [{ id: FRIDGE }],
      spaces: [{ id: "seed-space-garage" }],
    });
    expect((twice.record as { items: unknown[]; spaces: unknown[] }).items).toHaveLength(1);
    expect((twice.record as { items: unknown[]; spaces: unknown[] }).spaces).toHaveLength(1);

    // An empty list takes them all away. The Work is at a Property, so it needs no Item.
    const none = yield* logging({ id: HEATER, item_ids: [], spaces: [] });
    expect(none.record).toMatchObject({ items: [], spaces: [] });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("with an id, a save changes the fields it gives and leaves the rest", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);

    // The trench for the path lights was dug by the User, and belongs to a Project.
    const TRENCH = "seed-work-lighting-trench";
    const saved = yield* logging({
      id: TRENCH,
      kind: "other",
      title: "Trenched for the path lights",
      description: "Forty feet, six inches deep.",
      date: "2026-06",
      cost: 475.25,
      diy: false,
      vendor: "Brightside Electric",
    });
    expect(saved).toMatchObject({
      created: [],
      updated: [{ type: "work", id: TRENCH, name: "Trenched for the path lights" }],
      record: {
        kind: "other",
        title: "Trenched for the path lights",
        description: "Forty feet, six inches deep.",
        date: "2026-06",
        cost: 475.25,
        diy: 0,
        vendor_id: "seed-vendor-brightside",
        // The save has no say over these.
        property_id: "seed-property-maple",
        project_id: "seed-project-outdoor-lighting",
        spaces: [{ id: "seed-space-exterior" }],
      },
    });

    // A field sent as null is left alone, as one that is left out is.
    const same = yield* logging({ id: TRENCH, title: null, cost: null, diy: null, spaces: null });
    expect(same.record).toMatchObject({
      title: "Trenched for the path lights",
      cost: 475.25,
      diy: 0,
      spaces: [{ id: "seed-space-exterior" }],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("an id that is not there is an error, and so is new Work with no kind or no title", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const before = yield* counting;

    expect(yield* logging({ id: "seed-work-roof", title: "Patched the roof" })).toEqual({
      refused:
        'There is no Work with the id "seed-work-roof". Ids come from search and from the records get_record returns.',
    });
    const needs = "Give a kind and a title to log Work, or the id of the Work to update.";
    expect(yield* logging({ title: "Patched the roof", spaces: ["Attic"] })).toEqual({
      refused: needs,
    });
    expect(yield* logging({ kind: "repair", vendor: "Ridgeline Roofing" })).toEqual({
      refused: needs,
    });
    expect(yield* counting).toEqual(before);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("an Item that is not there refuses the call, and nothing is written", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const before = yield* counting;
    const noToaster =
      'There is no Item with the id "seed-item-toaster". Ids come from search and from the records get_record returns.';

    // The Space and the Vendor are new, and neither is left behind by the refusal.
    expect(
      yield* logging({
        kind: "repair",
        title: "Rewired the toaster",
        vendor: "Spark Repairs",
        spaces: ["Workshop"],
        item_ids: [FRIDGE, "seed-item-toaster"],
      }),
    ).toEqual({ refused: noToaster });
    expect(yield* counting).toEqual(before);

    // An update is refused the same way, and the Work keeps the Items it had.
    expect(yield* logging({ id: HEATER, cost: 5, item_ids: ["seed-item-toaster"] })).toEqual({
      refused: noToaster,
    });
    expect(yield* counting).toEqual(before);
    expect(yield* getting("work", HEATER)).toMatchObject({
      cost: 1850,
      items: [{ id: "seed-item-water-heater" }],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("the optional Note is attached to the Work, in the same Change", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);

    const logged = yield* logging({
      kind: "repair",
      title: "Replaced the garage door spring",
      spaces: ["Garage"],
      note: " The left spring is from 2019 and will go next. ",
    });
    const body = "The left spring is from 2019 and will go next.";
    expect(logged).toMatchObject({
      change_id: "id-0003",
      created: [
        { type: "work", id: "id-0001", name: "Replaced the garage door spring" },
        { type: "note", id: "id-0002", name: body },
      ],
      updated: [],
      record: { notes: [{ id: "id-0002", body }] },
    });
    // The Note is on the Work, at the Work's Property, and in the same Change.
    expect(yield* getting("note", "id-0002")).toMatchObject({
      body,
      property_id: "seed-property-maple",
      attached_to: [{ type: "work", id: "id-0001", name: "Replaced the garage door spring" }],
      changes: [{ id: "id-0003", tool: "log_work", before: null }],
    });

    // It is a new Note each time, on an update as well.
    const again = yield* logging({ id: "id-0001", note: "The right one went in 2027." });
    expect(again).toMatchObject({
      created: [{ type: "note", id: "id-0004", name: "The right one went in 2027." }],
      updated: [{ type: "work", id: "id-0001" }],
    });
    expect((again.record as { notes: unknown[] }).notes).toHaveLength(2);

    // A Note on a record takes that record's Property, and Work on an Item may have none.
    yield* call(saveProperty, { name: "Birch Road house", start_on: "2026-10" });
    const nowhere = yield* logging({
      kind: "maintenance",
      title: "Lubricated the treadmill belt",
      item_ids: [TREADMILL],
      note: "Silicone, not WD-40.",
    });
    const [note] = (nowhere.record as { notes: { id: string }[] }).notes;
    expect(yield* getting("note", note!.id)).toMatchObject({
      property_id: null,
      attached_to: [{ type: "work", name: "Lubricated the treadmill belt" }],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// Pipewise replaced the kitchen faucet cartridge on 2023-06-12, for $285.
const FAUCET = "seed-work-faucet";

it.effect("a field is emptied by naming it in clear, and not given a value as well", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);

    const cleared = yield* logging({
      id: FAUCET,
      clear: ["description", "date", "cost", "vendor"],
    });
    expect(cleared.record).toMatchObject({
      description: null,
      date: null,
      cost: null,
      vendor_id: null,
      vendor: null,
      // What the save did not name is as it was.
      kind: "repair",
      title: "Replaced the kitchen faucet cartridge",
      property_id: "seed-property-maple",
      spaces: [{ id: "seed-space-kitchen" }],
    });

    const before = yield* counting;
    expect(
      yield* logging({ id: FAUCET, cost: 10, vendor: "Drip Stop", clear: ["cost", "vendor"] }),
    ).toEqual({
      refused:
        "A field is given a value or cleared, not both in one call. Both were asked for: cost, vendor.",
    });
    // Work always has a kind and a title, and is DIY or is not. Its sets are emptied with an
    // empty list.
    for (const field of ["kind", "title", "diy", "item_ids", "spaces"]) {
      expect((yield* logging({ id: FAUCET, clear: [field] })).refused, field).toContain("clear");
    }
    expect(yield* counting).toEqual(before);
  }).pipe(Effect.provide(TestDatabase)),
);

const EBIKE = "seed-item-ebike";

it.effect("Work needs a Property or at least one Item, and at no Property it is in no Space", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);

    // The bike was serviced at the shop, which is no Property of the User's.
    const tuned = yield* logging({
      kind: "maintenance",
      title: "Tuned the electric bike",
      vendor: "Spoke Shop",
      item_ids: [EBIKE],
      clear: ["property"],
    });
    expect(tuned.record).toMatchObject({
      id: "id-0002",
      property_id: null,
      property: null,
      items: [{ id: EBIKE }],
      spaces: [],
    });

    const before = yield* counting;
    const neither = (title: string) => ({
      refused: `Work needs a Property or at least one Item, and "${title}" would have neither. Give \`property\`, or the Items it was done to in \`item_ids\`.`,
    });
    expect(
      yield* logging({ kind: "other", title: "Sharpened the knives", clear: ["property"] }),
    ).toEqual(neither("Sharpened the knives"));
    // The one Item it names cannot be taken away, and the faucet names none to begin with.
    expect(yield* logging({ id: "id-0002", item_ids: [] })).toEqual(
      neither("Tuned the electric bike"),
    );
    expect(yield* logging({ id: FAUCET, clear: ["property"] })).toEqual(
      neither("Replaced the kitchen faucet cartridge"),
    );

    const noSpace = (title: string) => ({
      refused: `A Space is one at a Property, and "${title}" is at none. Give \`property\` as well, or leave \`spaces\` out.`,
    });
    expect(yield* logging({ id: "id-0002", spaces: ["Garage"] })).toEqual(
      noSpace("Tuned the electric bike"),
    );
    expect(
      yield* logging({
        kind: "other",
        title: "Sharpened the knives",
        item_ids: [MICROWAVE],
        spaces: ["Kitchen"],
        clear: ["property"],
      }),
    ).toEqual(noSpace("Sharpened the knives"));
    expect(yield* counting).toEqual(before);

    // Work that names an Item already can go to no Property without naming it again. The
    // water heater's Work is at the Maple Street house, in the Garage.
    const taken = yield* logging({ id: HEATER, clear: ["property"] });
    expect(taken.record).toMatchObject({
      property_id: null,
      items: [{ id: "seed-item-water-heater" }],
      spaces: [],
    });

    // It can name other Items, and an empty list of Spaces says what is so already.
    const swapped = yield* logging({ id: "id-0002", item_ids: [TREADMILL], spaces: [] });
    expect(swapped.record).toMatchObject({
      property_id: null,
      items: [{ id: TREADMILL }],
      spaces: [],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// Old Town Plumbing cleared the kitchen drain at the Elm Court apartment in 2021.
const DRAIN = "seed-work-elm-drain";

it.effect("Work that moves to another Property loses its Spaces, and its Notes move with it", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const elm = { property_id: "seed-property-elm" };
    const maple = { property_id: "seed-property-maple" };
    yield* logging({ id: DRAIN, note: "Hair, mostly." });
    expect(yield* getting("note", "id-0001")).toMatchObject(elm);

    // It was logged at the wrong place.
    const moved = yield* logging({ id: DRAIN, property: "Maple Street house" });
    expect(moved).toMatchObject({
      change_id: "id-0003",
      created: [],
      updated: [
        { type: "work", id: DRAIN, name: "Cleared the kitchen drain" },
        { type: "note", id: "id-0001", name: "Hair, mostly." },
      ],
      record: {
        ...maple,
        property: "Maple Street house",
        // A Space is one at a Property, so the Kitchen at the apartment is left behind.
        spaces: [],
        changes: [
          {
            before: { ...elm, spaces: ["seed-space-elm-kitchen"] },
            after: { ...maple, spaces: [] },
          },
          {},
        ],
      },
    });
    // The Change has the Note as it was, so undoing the move puts it back.
    expect(yield* getting("note", "id-0001")).toMatchObject({
      ...maple,
      changes: [{ id: "id-0003", tool: "log_work", before: elm, after: maple }, {}],
    });

    // With Spaces given, they are Spaces at the Property it moves to.
    const back = yield* logging({
      id: DRAIN,
      property: "Elm Court apartment",
      spaces: ["kitchen"],
    });
    expect(back.record).toMatchObject({ ...elm, spaces: [{ id: "seed-space-elm-kitchen" }] });

    // Naming the Property it is at is no move.
    const stays = yield* logging({ id: DRAIN, property: "ELM court apartment" });
    expect(stays).toMatchObject({
      updated: [{ type: "work", id: DRAIN }],
      record: { ...elm, spaces: [{ id: "seed-space-elm-kitchen" }] },
    });
    expect(stays.updated).toHaveLength(1);

    // Work that goes to no Property is in no Space, and takes its Notes there too.
    const nowhere = yield* logging({ id: DRAIN, item_ids: [MICROWAVE], clear: ["property"] });
    expect(nowhere).toMatchObject({
      updated: [
        { type: "work", id: DRAIN },
        { type: "note", id: "id-0001" },
      ],
      record: { property_id: null, property: null, spaces: [], items: [{ id: MICROWAVE }] },
    });
    expect(yield* getting("note", "id-0001")).toMatchObject({ property_id: null });
  }).pipe(Effect.provide(TestDatabase)),
);

// A list of this many made-up pieces of Work, each with a cost of its own, on the fridge and
// in the Kitchen.
const filterChanges = (count: number): Record<string, unknown>[] =>
  Array.from({ length: count }, (_, at) => ({
    kind: "maintenance",
    title: `Changed the fridge filter ${at + 1}`,
    cost: at + 0.5,
    diy: true,
    item_ids: [FRIDGE],
    spaces: ["Kitchen"],
  }));

it.effect("a list of 50 is saved as one Change", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const before = yield* counting;

    const logged = yield* logging({ work: filterChanges(50) });
    // Fifty ids for the Work, in the order of the list, and then one for the Change.
    const created = logged.created as Listed[];
    expect(logged).toEqual({ change_id: "id-0051", created: expect.any(Array), updated: [] });
    expect(created).toHaveLength(50);
    expect(created[0]).toEqual({
      type: "work",
      id: "id-0001",
      name: "Changed the fridge filter 1",
    });
    expect(created[49]).toEqual({
      type: "work",
      id: "id-0050",
      name: "Changed the fridge filter 50",
    });
    expect(yield* counting).toEqual({
      ...before,
      work: before.work + 50,
      work_items: before.work_items + 50,
      work_spaces: before.work_spaces + 50,
      changes: 1,
    });

    expect(yield* getting("work", "id-0050")).toMatchObject({
      title: "Changed the fridge filter 50",
      cost: 49.5,
      diy: 1,
      property: "Maple Street house",
      items: [{ id: FRIDGE }],
      spaces: [{ id: "seed-space-kitchen" }],
      changes: [{ id: "id-0051", tool: "log_work", before: null }],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a list of 51 is refused, and so is an empty one", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const before = yield* counting;

    expect(yield* logging({ work: filterChanges(51) })).toEqual({
      refused:
        "work: Expected at most 50 pieces of Work in one call. Save a longer list in several calls.",
    });
    expect(yield* logging({ work: [] })).toEqual({
      refused: "work: Expected at least one piece of Work in the list.",
    });
    expect(yield* counting).toEqual(before);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a list with one bad entry writes nothing, and the error names the entry", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const before = yield* counting;
    const noToaster =
      'There is no Item with the id "seed-item-toaster". Ids come from search and from the records get_record returns.';

    // The entries around the bad one are fine, and one of them names a Space and a Vendor
    // that are new.
    const list = filterChanges(5);
    list[1] = { ...list[1], spaces: ["Pantry"], vendor: "Filter Shack" };
    list[3] = { ...list[3], item_ids: [FRIDGE, "seed-item-toaster"] };
    expect(yield* logging({ work: list })).toEqual({
      refused: `Nothing was saved, because 1 of the 5 entries in \`work\` was refused. Entries are counted from 0.
work.3: ${noToaster}`,
    });
    expect(yield* counting).toEqual(before);

    // Every bad entry is named, and entries refused for the same reason are named together.
    list[0] = { id: "seed-work-roof", cost: 20 };
    list[4] = { ...list[4], item_ids: ["seed-item-toaster"] };
    expect(yield* logging({ work: list })).toEqual({
      refused: `Nothing was saved, because 3 of the 5 entries in \`work\` were refused. Entries are counted from 0.
work.0: There is no Work with the id "seed-work-roof". Ids come from search and from the records get_record returns.
work.3, work.4: ${noToaster}`,
    });
    expect(yield* counting).toEqual(before);

    // A field that does not fit is turned away before the tool runs, with where it is.
    list[0] = { kind: "repair", title: "Patched the roof", cost: 19.999 };
    expect((yield* logging({ work: list })).refused).toBe(
      "work.0.cost: Expected an amount with at most two decimal places, such as 1299.99.",
    );
    expect(yield* counting).toEqual(before);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a Space or a Vendor that several entries name is created once", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const painted = (where: string) => ({ kind: "improvement", title: `Painted the ${where}` });

    const logged = yield* logging({
      work: [
        { ...painted("loft"), spaces: ["Loft"], vendor: "Even Coat Painters" },
        // The same Space and the same Vendor, whatever the case of their names.
        { ...painted("loft ceiling"), spaces: ["LOFT", "Stairwell"], vendor: "even coat painters" },
        // A Space is one at a Property, so a Loft at the apartment is another Space.
        { ...painted("apartment loft"), property: "Elm Court apartment", spaces: ["Loft"] },
        { ...painted("stairwell"), spaces: ["stairwell", "loft"] },
      ],
    });
    expect(logged).toEqual({
      change_id: "id-0009",
      created: [
        { type: "space", id: "id-0001", name: "Loft" },
        { type: "vendor", id: "id-0002", name: "Even Coat Painters" },
        { type: "work", id: "id-0003", name: "Painted the loft" },
        { type: "space", id: "id-0004", name: "Stairwell" },
        { type: "work", id: "id-0005", name: "Painted the loft ceiling" },
        { type: "space", id: "id-0006", name: "Loft" },
        { type: "work", id: "id-0007", name: "Painted the apartment loft" },
        { type: "work", id: "id-0008", name: "Painted the stairwell" },
      ],
      updated: [],
    });
    const titles = (record: Answer) =>
      (record.work as { title: string }[]).map(({ title }) => title).sort();
    expect(yield* getting("space", "id-0001")).toMatchObject({ property: "Maple Street house" });
    expect(titles(yield* getting("space", "id-0001"))).toEqual([
      "Painted the loft",
      "Painted the loft ceiling",
      "Painted the stairwell",
    ]);
    expect(yield* getting("space", "id-0006")).toMatchObject({
      property: "Elm Court apartment",
      work: [{ title: "Painted the apartment loft" }],
    });
    expect(titles(yield* getting("vendor", "id-0002"))).toEqual([
      "Painted the loft",
      "Painted the loft ceiling",
    ]);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a list can log and update, and a list of one returns the Work", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);

    const logged = yield* logging({
      work: [
        { id: FAUCET, cost: 310, note: "The invoice was corrected." },
        { kind: "inspection", title: "Had the chimney inspected", date: "2026-09" },
      ],
    });
    expect(logged).toEqual({
      change_id: "id-0003",
      created: [
        { type: "note", id: "id-0001", name: "The invoice was corrected." },
        { type: "work", id: "id-0002", name: "Had the chimney inspected" },
      ],
      updated: [{ type: "work", id: FAUCET, name: "Replaced the kitchen faucet cartridge" }],
    });

    const one = yield* logging({ work: [{ id: "id-0002", cost: 150 }] });
    expect(one).toMatchObject({
      updated: [{ type: "work", id: "id-0002", name: "Had the chimney inspected" }],
      record: { type: "work", id: "id-0002", cost: 150, date: "2026-09" },
    });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a call gives one piece of Work's fields or a list, and a list has each one once", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const before = yield* counting;

    expect(
      yield* logging({ property: "Elm Court apartment", note: "Moved.", work: [{ id: FAUCET }] }),
    ).toEqual({
      refused:
        "Give one piece of Work's fields, or `work` for a list, and not both. Beside `work` there was: property, note. Each entry of a list has fields of its own.",
    });
    expect(
      yield* logging({
        work: [{ id: FAUCET, cost: 10 }, { kind: "other", title: "Swept up" }, { id: FAUCET }],
      }),
    ).toEqual({
      refused: `Nothing was saved, because 1 of the 3 entries in \`work\` was refused. Entries are counted from 0.
work.2: The piece of Work "${FAUCET}" is in this list already, at work.0. Give each piece of Work once.`,
    });
    expect(yield* counting).toEqual(before);
  }).pipe(Effect.provide(TestDatabase)),
);

// The Property each entry is at is settled entry by entry, from one read of the Properties.
it.effect("with two Current properties, a list is refused for the entries on no Item", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    yield* call(saveProperty, { name: "Birch Road house", start_on: "2026-10" });
    const before = yield* counting;
    const swept = (where: string) => ({ kind: "maintenance", title: `Swept the ${where}` });
    const belt = { kind: "maintenance", title: "Lubricated the treadmill belt" };

    const list = [swept("garage"), { ...belt, item_ids: [TREADMILL] }, swept("porch")];
    expect(yield* logging({ work: list })).toEqual({
      refused: `Nothing was saved, because 2 of the 3 entries in \`work\` were refused. Entries are counted from 0.
work.0, work.2: 2 Properties are current: Birch Road house, Maple Street house. Say which one this is for: give \`property\` its id or its name.`,
    });
    expect(yield* counting).toEqual(before);

    // With a Property on the ones that need it, the list is saved, and the Work on the
    // treadmill is at no Property.
    const logged = yield* logging({
      work: list.map((entry) =>
        "item_ids" in entry ? entry : { ...entry, property: "Birch Road house" },
      ),
    });
    const [garage, treadmill, porch] = logged.created as [Listed, Listed, Listed];
    expect(logged.created).toHaveLength(3);
    expect(yield* getting("work", treadmill.id)).toMatchObject({ property: null });
    for (const swept of [garage, porch]) {
      expect(yield* getting("work", swept.id)).toMatchObject({ property: "Birch Road house" });
    }
  }).pipe(Effect.provide(TestDatabase)),
);

// The wall color a Space had before goes on the Work, and the new one on the Space.
it.effect("repainting is Work that names the Space, with the old color in data.replaced", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const gray = {
      brand: "Sherwin-Williams",
      color: "Agreeable Gray",
      code: "SW 7029",
      sheen: "eggshell",
    };
    const white = { brand: "Benjamin Moore", color: "Simply White", code: "OC-117" };

    const painted = yield* logging({
      kind: "improvement",
      title: "Repainted the living room",
      date: "2026-10",
      cost: 180,
      diy: true,
      vendor: "Corner Paint Supply",
      spaces: ["Living room"],
      // Money inside `data` is stored as written, in cents, and read back in dollars.
      data: { replaced: { paint: { walls: gray } }, payments: [{ amount_cents: 18000 }] },
    });
    expect(painted.record).toMatchObject({
      spaces: [{ id: "seed-space-living-room" }],
      data: { replaced: { paint: { walls: gray } }, payments: [{ amount: 180 }] },
    });
    const { id } = painted.record as { id: string };
    expect(JSON.parse((yield* inTable(id))!.data as string)).toMatchObject({
      payments: [{ amount_cents: 18000 }],
    });

    // The client saves the new color on the Space, which is a second call and a second Change.
    yield* call(saveSpace, { id: "seed-space-living-room", data: { paint: { walls: white } } });
    expect(yield* getting("space", "seed-space-living-room")).toMatchObject({
      data: { paint: { walls: { color: "Simply White" } } },
      work: [{ id, title: "Repainted the living room" }, { id: "seed-work-thermostat" }],
    });

    // `data` is a merge patch, so a later save adds to what is there.
    const permitted = yield* logging({ id, data: { permit: "SEED-PERMIT-2201" } });
    expect((permitted.record as { data: unknown }).data).toEqual({
      replaced: { paint: { walls: gray } },
      payments: [{ amount: 180 }],
      permit: "SEED-PERMIT-2201",
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// `project` and `schedule_id` are columns of Work that this tool does not take yet. Each of
// these would once have been dropped, and the save gone through as if it had been taken.
it.effect("a field log_work does not have is turned away by name, in a list as well", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const before = yield* counting;
    const roof = { kind: "repair", title: "Patched the roof" };

    const fields =
      "There is no field with this name. The fields are: id, kind, title, description, date, cost, diy, vendor, property, item_ids, spaces, data, note, clear";
    const goesInData = "A fact with no field of its own goes inside data.";
    for (const field of ["project", "schedule_id", "permit", "price", "items"]) {
      expect(yield* logging({ ...roof, [field]: "A-1" }), field).toEqual({
        refused: `${field}: ${fields}, work. ${goesInData}`,
      });
    }
    // An entry of a list has every field but `work`.
    expect(yield* logging({ work: [roof, { ...roof, permit: "A-1" }] })).toEqual({
      refused: `work.1.permit: ${fields}. ${goesInData}`,
    });
    expect(yield* counting).toEqual(before);

    const permitted = yield* logging({ ...roof, data: { permit: "A-1" } });
    expect(permitted.record).toMatchObject({ data: { permit: "A-1" } });
  }).pipe(Effect.provide(TestDatabase)),
);

// Two of the questions Attic has to answer, asked of a database that has only what the tools
// wrote: one Property, and Work logged as a list.
it.effect(
  "repairs and improvements since March 2023, and the plumber used last, are answered",
  () =>
    Effect.gen(function* () {
      yield* todayIs(TODAY);
      yield* call(saveProperty, { name: "Maple Street house", start_on: "2022-05-20" });
      const logged = yield* logging({
        work: [
          // In January, before March.
          { kind: "repair", title: "Reattached a loose gutter", date: "2023-01-28", cost: 42 },
          {
            kind: "repair",
            title: "Replaced the kitchen faucet cartridge",
            date: "2023-06-12",
            cost: 285,
            vendor: "Pipewise Plumbing",
            spaces: ["Kitchen"],
          },
          // Dated only to the year, which stands for the whole of it.
          {
            kind: "improvement",
            title: "Replaced the water heater",
            date: "2023",
            cost: 1850,
            vendor: "Pipewise Plumbing",
            spaces: ["Garage"],
          },
          {
            kind: "improvement",
            title: "Fitted a smart thermostat",
            date: "2024-03-09",
            diy: true,
          },
          // Neither a repair nor an improvement.
          { kind: "maintenance", title: "Serviced the furnace", date: "2025-09-08", cost: 189 },
          {
            kind: "repair",
            title: "Cleared the main drain",
            date: "2022-11-03",
            cost: 120,
            vendor: "Old Town Plumbing",
          },
        ],
      });
      expect(logged.refused).toBeUndefined();

      // "List every repair and improvement since March 2023", with the SQL the schema's own
      // comment gives for the view, and the row dated only 2023 caught as get_schema says to.
      const sql = yield* SqlClient.SqlClient;
      const since = yield* sql`
      SELECT date, kind, title, cost_cents, vendor, spaces FROM work_log
       WHERE kind IN ('repair', 'improvement') AND (date >= '2023-03' OR date = '2023')
       ORDER BY date`;
      expect(since).toEqual([
        {
          date: "2023",
          kind: "improvement",
          title: "Replaced the water heater",
          cost_cents: 185000,
          vendor: "Pipewise Plumbing",
          spaces: '["Garage"]',
        },
        {
          date: "2023-06-12",
          kind: "repair",
          title: "Replaced the kitchen faucet cartridge",
          cost_cents: 28500,
          vendor: "Pipewise Plumbing",
          spaces: '["Kitchen"]',
        },
        {
          date: "2024-03-09",
          kind: "improvement",
          title: "Fitted a smart thermostat",
          cost_cents: null,
          vendor: null,
          spaces: "[]",
        },
      ]);

      // "Who did we use for plumbing last time?" The Work a plumber did comes latest first.
      const found = yield* call(search, { words: "plumbing", types: ["work"] }).pipe(
        Effect.map(answer),
      );
      expect(found.results).toMatchObject([
        {
          title: "Replaced the kitchen faucet cartridge",
          date: "2023-06-12",
          matched: { vendors: ["Pipewise Plumbing"] },
        },
        {
          title: "Replaced the water heater",
          date: "2023",
          matched: { vendors: ["Pipewise Plumbing"] },
        },
        {
          title: "Cleared the main drain",
          date: "2022-11-03",
          matched: { vendors: ["Old Town Plumbing"] },
        },
      ]);
    }).pipe(Effect.provide(TestDatabase)),
);

// A Project is at one Property, and so is a Schedule that is not an Item's.
it.effect("Work in a Project, or logged against a Property's Schedule, stays at its Property", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const before = yield* counting;
    const TRENCH = "seed-work-lighting-trench";

    expect(yield* logging({ id: TRENCH, property: "Elm Court apartment" })).toEqual({
      refused:
        '"Trenched and laid cable for the path lights" stays at its Property, because it is in the Project "Outdoor lighting", and a Project is at one Property. Leave `property` as it is.',
    });
    // Going to no Property is a move too.
    expect(
      yield* logging({ id: "seed-work-furnace", item_ids: [FRIDGE], clear: ["property"] }),
    ).toEqual({
      refused:
        '"Annual furnace service" stays at its Property, because it was logged against "Service the furnace", a Schedule on that Property. Leave `property` as it is.',
    });
    expect(yield* counting).toEqual(before);

    // Naming the Property it is at is no move, so the rest of the save goes through.
    const same = yield* logging({ id: TRENCH, property: "Maple Street house", cost: 460 });
    expect(same.record).toMatchObject({
      cost: 460,
      property: "Maple Street house",
      project: "Outdoor lighting",
    });

    // The fridge filter's Schedule is the fridge's, and an Item moves with the User. So Work
    // logged against it can be put right.
    const filter = yield* logging({ id: "seed-work-filter-2026", property: "Elm Court apartment" });
    expect(filter.record).toMatchObject({
      property: "Elm Court apartment",
      schedule: "Replace fridge water filter",
    });
  }).pipe(Effect.provide(TestDatabase)),
);
