import { expect, it } from "@effect/vitest";
import { DateTime, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { Currency } from "../../src/money.ts";
import type { Listed } from "../../src/save.ts";
import { getRecord } from "../../src/tools/get-record.ts";
import { saveItem } from "../../src/tools/save-item.ts";
import { saveProperty } from "../../src/tools/save-property.ts";
import { answer, call, callAsClient, todayIs } from "../call.ts";
import { loadHousehold } from "../household.ts";
import { TestDatabase } from "../TestDatabase.ts";

// A save the way a client sends one: checked against the tool's input first.
const saving = (input: unknown) => callAsClient(saveItem, input).pipe(Effect.map(answer));

const getting = (type: string, id: string) =>
  call(getRecord, { type, id }).pipe(Effect.map(answer));

// The made-up household has one Current property on this day: the Maple Street house. The Elm
// Court apartment ended in 2022-05.
const TODAY = "2026-10-11";

// The test database hands out ids in order. A save takes one for each record it creates, in
// the order its batch writes them, and then one for its Change.
it.effect("an Item saved with a Space and a Vendor that are new creates all three", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);

    const saved = yield* saving({
      name: "Chest freezer",
      space: "Basement",
      category: "appliances",
      acquired_on: "2026-08-15",
      price: 649.99,
      bought_from: "Cold Front Appliances",
      data: { brand: "Frigidaire", model: "FFCS0922AW" },
    });

    // The Item as it is stored, which is what its Change holds.
    const stored = {
      id: "id-0003",
      // With no Property given, a new Item is at the one Current property.
      property_id: "seed-property-maple",
      space_id: "id-0001",
      scope: "belonging",
      category_id: "appliances",
      name: "Chest freezer",
      acquired_on: "2026-08-15",
      vendor_id: "id-0002",
      status: "active",
      status_on: null,
      data: { brand: "Frigidaire", model: "FFCS0922AW" },
      created_at: expect.any(String),
      updated_at: expect.any(String),
    };
    const freezer = {
      type: "item",
      ...stored,
      property: "Maple Street house",
      space: "Basement",
      category: "Appliances",
      extra_categories: [],
      price: 649.99,
      bought_from: "Cold Front Appliances",
      proceeds: null,
      schedules: [],
      work: [],
      documents: [],
      notes: [],
      changes: [
        {
          id: "id-0004",
          tool: "save_item",
          created_at: expect.any(String),
          undoes: null,
          before: null,
          after: { ...stored, price: 649.99, proceeds: null, extra_categories: [] },
        },
      ],
    };
    expect(yield* getting("item", "id-0003")).toEqual(freezer);

    // The reply lists all three, in the order the batch wrote them. A call that saves one
    // Item returns it as get_record does.
    expect(saved).toEqual({
      change_id: "id-0004",
      created: [
        { type: "space", id: "id-0001", name: "Basement" },
        { type: "vendor", id: "id-0002", name: "Cold Front Appliances" },
        { type: "item", id: "id-0003", name: "Chest freezer" },
      ],
      updated: [],
      record: freezer,
    });

    // One call is one Change, and the Space and the Vendor it made are in it.
    const made = { id: "id-0004", tool: "save_item", before: null };
    expect(yield* getting("space", "id-0001")).toMatchObject({
      name: "Basement",
      property: "Maple Street house",
      items: [{ id: "id-0003", name: "Chest freezer" }],
      changes: [made],
    });
    expect(yield* getting("vendor", "id-0002")).toMatchObject({
      name: "Cold Front Appliances",
      items: [{ id: "id-0003", name: "Chest freezer" }],
      changes: [made],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// How many of each record a save can write there are, read from the tables.
const counting = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [counts] = yield* sql<Record<string, number>>`
    SELECT (SELECT count(*) FROM items) AS items,
           (SELECT count(*) FROM item_categories) AS extra_categories,
           (SELECT count(*) FROM spaces) AS spaces,
           (SELECT count(*) FROM vendors) AS vendors,
           (SELECT count(*) FROM notes) AS notes,
           (SELECT count(*) FROM changes) AS changes`;
  return counts!;
});

it.effect("a Category that does not exist is refused with the closest matches", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const before = yield* counting;

    // The Space and the Vendor are new, and neither is left behind by the refusal.
    const saved = yield* saving({
      name: "Cordless drill",
      space: "Workshop",
      category: "powertools",
      bought_from: "Tool Shed",
    });
    expect(saved).toEqual({
      refused:
        'There is no Category "powertools". The closest are: power-tools (Power tools). get_schema lists every Category, and save_category adds one.',
    });
    expect(yield* counting).toEqual(before);
  }).pipe(Effect.provide(TestDatabase)),
);

// What the table holds for an Item, which is what `query` returns.
const stored = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<Record<string, unknown>>`SELECT * FROM items WHERE id = ${id}`;
    return row;
  });

it.effect("a price in dollars is stored as cents and read back in dollars", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);

    const saved = yield* saving({ name: "Floor lamp", price: 19.99 });
    expect(saved.record).toMatchObject({ id: "id-0001", price: 19.99 });
    expect(yield* stored("id-0001")).toMatchObject({ price_cents: 1999 });

    // A whole number of dollars, an amount that a float cannot hold exactly, and nothing at all.
    for (const [price, cents] of [
      [1200, 120000],
      [1299.1, 129910],
      [0.07, 7],
      [0, 0],
    ] as const) {
      const { record } = yield* saving({ name: "Floor lamp", price });
      expect(record, String(price)).toMatchObject({ price });
      expect(yield* stored((record as { id: string }).id), String(price)).toMatchObject({
        price_cents: cents,
      });
    }
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("an amount below zero, or with more than two decimal places, is refused", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const before = yield* counting;

    expect(yield* saving({ name: "Floor lamp", price: 19.999 })).toEqual({
      refused: "price: Expected an amount with at most two decimal places, such as 1299.99.",
    });
    expect(yield* saving({ name: "Floor lamp", price: -5 })).toEqual({
      refused: "price: Expected an amount that is not below zero.",
    });
    expect(yield* counting).toEqual(before);
  }).pipe(Effect.provide(TestDatabase)),
);

// The running watch is electronics first, and fitness as an extra Category.
const WATCH = "seed-item-watch";

it.effect("extra_categories replaces the set, and the Change has the set before and after", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);

    const saved = yield* saving({ id: WATCH, extra_categories: ["sports", "seed-cardio"] });
    expect(saved).toMatchObject({
      change_id: "id-0001",
      created: [],
      updated: [{ type: "item", id: WATCH, name: "Running watch" }],
      record: {
        category_id: "electronics",
        // A record lists them by name, and a Change by id.
        extra_categories: [
          { id: "seed-cardio", name: "Cardio" },
          { id: "sports", name: "Sports and recreation" },
        ],
        changes: [
          {
            id: "id-0001",
            tool: "save_item",
            before: { id: WATCH, extra_categories: ["fitness"] },
            after: { id: WATCH, extra_categories: ["seed-cardio", "sports"] },
          },
        ],
      },
    });
    // The Item is listed once, though the save took three statements.
    expect(saved.updated).toHaveLength(1);

    // A save that says nothing of them leaves them as they are.
    const untouched = yield* saving({ id: WATCH, data: { condition: "good" } });
    expect(untouched.record).toMatchObject({
      data: { condition: "good" },
      extra_categories: [{ id: "seed-cardio" }, { id: "sports" }],
    });

    // An empty list takes them all away.
    const none = yield* saving({ id: WATCH, extra_categories: [] });
    expect(none.record).toMatchObject({ category_id: "electronics", extra_categories: [] });

    // A new Item can have them from the start.
    const scale = yield* saving({
      name: "Smart scale",
      category: "electronics",
      extra_categories: ["fitness"],
    });
    expect(scale.record).toMatchObject({
      extra_categories: [{ id: "fitness", name: "Fitness" }],
      changes: [{ before: null, after: { extra_categories: ["fitness"] } }],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("the primary Category is never an extra one as well", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);

    // Given among the extras, the primary Category is left out of them, and so is a repeat.
    const given = yield* saving({
      id: WATCH,
      extra_categories: ["electronics", "sports", "sports"],
    });
    expect(given.record).toMatchObject({
      category_id: "electronics",
      extra_categories: [{ id: "sports" }],
    });

    // A new primary Category that was an extra one stops being an extra.
    const moved = yield* saving({ id: WATCH, category: "sports" });
    expect(moved.record).toMatchObject({
      category_id: "sports",
      extra_categories: [],
      // The newest Change is first, and the one before it is the save above.
      changes: [{ before: { extra_categories: ["sports"] }, after: { extra_categories: [] } }, {}],
    });

    // A new Item is in Other unless it says otherwise, so Other is not an extra of it.
    const lamp = yield* saving({ name: "Floor lamp", extra_categories: ["other", "decor"] });
    expect(lamp.record).toMatchObject({
      category_id: "other",
      extra_categories: [{ id: "decor" }],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("an extra Category that does not exist is refused, and nothing is written", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const before = yield* counting;

    expect(yield* saving({ id: WATCH, extra_categories: ["sports", "wearables"] })).toEqual({
      refused:
        'There is no Category "wearables". None is close to it. The top-level Categories are: appliances (Appliances), clothing (Clothing), decor (Art and decor), electronics (Electronics), fitness (Fitness), furniture (Furniture), instruments (Musical instruments), jewelry (Jewelry and watches), kids (Kids and toys), kitchen (Kitchen), lighting-plumbing (Lighting and plumbing), media (Books and media), office (Office), other (Other), outdoor (Outdoor and yard), sports (Sports and recreation), systems (Home systems), tools (Tools), vehicles (Vehicles). get_schema lists every Category, and save_category adds one.',
    });
    expect(yield* counting).toEqual(before);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("an id that is not there is an error, and so is a new Item with no name", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const before = yield* counting;

    expect(yield* saving({ id: "seed-item-toaster", name: "Toaster" })).toEqual({
      refused:
        'There is no Item with the id "seed-item-toaster". Ids come from search and from the records get_record returns.',
    });
    expect(yield* saving({ price: 40 })).toEqual({
      refused: "Give a name to create an Item, or the id of the Item to update.",
    });
    expect(yield* counting).toEqual(before);
  }).pipe(Effect.provide(TestDatabase)),
);

const COUCH = "seed-item-couch";

it.effect("marking an Item sold writes a Note dated today, with the proceeds", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);

    const saved = yield* saving({ id: COUCH, status: "sold", proceeds: 450 });
    const body = "Marked sold on 2026-10-11 for $450.00.";
    expect(saved).toMatchObject({
      change_id: "id-0002",
      created: [{ type: "note", id: "id-0001", name: body }],
      updated: [{ type: "item", id: COUCH, name: "Sectional couch" }],
      record: {
        status: "sold",
        // With no date given, it is today.
        status_on: "2026-10-11",
        proceeds: 450,
        notes: [{ id: "id-0001", body }],
      },
    });
    expect(yield* stored(COUCH)).toMatchObject({ proceeds_cents: 45000 });

    // The Note is on the Item, at the Item's Property, and in the same Change.
    expect(yield* getting("note", "id-0001")).toMatchObject({
      body,
      property_id: "seed-property-maple",
      attached_to: [{ type: "item", id: COUCH, name: "Sectional couch" }],
      changes: [{ id: "id-0002", tool: "save_item", before: null }],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("with status_on given, the Note and the column have that date", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);

    const saved = yield* saving({
      id: COUCH,
      status: "sold",
      status_on: "2026-09-20",
      proceeds: 1450.5,
    });
    expect(saved.record).toMatchObject({
      status: "sold",
      status_on: "2026-09-20",
      notes: [{ body: "Marked sold on 2026-09-20 for $1,450.50." }],
    });

    // A Partial date is a date too.
    const given = yield* saving({ id: "seed-item-microwave", status: "given", status_on: "2026" });
    expect(given.record).toMatchObject({
      status: "given",
      status_on: "2026",
      // With no proceeds there is no amount.
      notes: [{ body: "Marked given on 2026." }],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// The `status_on` a status change defaults to is the date where the User is.
it.effect("today is the date in the configured timezone, not the UTC date", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    // Half past ten in the evening of the 11th in Los Angeles. In UTC it is already the 12th.
    yield* TestClock.setTime(Date.parse("2026-10-12T05:30:00Z"));
    const inLosAngeles = Layer.orDie(DateTime.layerCurrentZoneNamed("America/Los_Angeles"));

    const there = yield* saving({ id: COUCH, status: "listed" }).pipe(Effect.provide(inLosAngeles));
    expect(there.record).toMatchObject({
      status_on: "2026-10-11",
      notes: [{ body: "Marked listed on 2026-10-11." }],
    });

    // The test database is in UTC.
    const here = yield* saving({ id: "seed-item-microwave", status: "listed" });
    expect(here.record).toMatchObject({
      status_on: "2026-10-12",
      notes: [{ body: "Marked listed on 2026-10-12." }],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("the amount in a Note is written in the configured currency", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);

    const saved = yield* saving({ id: COUCH, status: "sold", proceeds: 1450.5 }).pipe(
      Effect.provide(Currency.layer("EUR")),
    );
    expect(saved.record).toMatchObject({
      proceeds: 1450.5,
      notes: [{ body: "Marked sold on 2026-10-11 for €1,450.50." }],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// The amount is the Item's proceeds, when there are any.
it.effect("the amount in a Note is the Item's proceeds as the save leaves them", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);

    // What came back is written down first, and the couch is marked sold by a later save.
    const priced = yield* saving({ id: COUCH, proceeds: 450 });
    expect(priced).toMatchObject({ created: [], record: { status: "active", proceeds: 450 } });
    const sold = yield* saving({ id: COUCH, status: "sold" });
    expect(sold.record).toMatchObject({
      proceeds: 450,
      notes: [{ body: "Marked sold on 2026-10-11 for $450.00." }],
    });

    // The exercise bike was sold for $300. It turns out it was given away, for nothing.
    const given = yield* saving({
      id: "seed-item-exercise-bike",
      status: "given",
      clear: ["proceeds"],
    });
    expect(given.record).toMatchObject({ status: "given", proceeds: null });
    expect((given.record as { notes: { body: string }[] }).notes[0]).toMatchObject({
      body: "Marked given on 2026-10-11.",
    });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a save that does not change the status writes no Note", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const before = yield* counting;

    // The standing desk has been listed since 2026-09-20. Saying so again changes nothing.
    const same = yield* saving({ id: "seed-item-desk", status: "listed", price: 610 });
    expect(same).toMatchObject({
      created: [],
      updated: [{ type: "item", id: "seed-item-desk" }],
      record: { status: "listed", status_on: "2026-09-20", price: 610 },
    });

    // The insurer pays out for the bike that was stolen. That is no change of status either.
    const paid = yield* saving({ id: "seed-item-ebike", proceeds: 1900 });
    expect(paid).toMatchObject({
      created: [],
      record: { status: "stolen", status_on: "2025-09-02", proceeds: 1900 },
    });

    // A new Item is active, and is not marked so.
    const lamp = yield* saving({ name: "Floor lamp", status: "active" });
    expect(lamp).toMatchObject({
      created: [{ type: "item", name: "Floor lamp" }],
      record: { status: "active", status_on: null, notes: [] },
    });

    expect(yield* counting).toEqual({ ...before, items: before.items + 1, changes: 3 });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a lost Item that turns up goes back to active, and a new Item can be gone", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);

    yield* saving({ id: "seed-item-watch", status: "lost", status_on: "2026-10-02" });
    const found = yield* saving({ id: "seed-item-watch", status: "active" });
    expect(found.record).toMatchObject({
      status: "active",
      status_on: "2026-10-11",
      notes: [{ body: "Marked active on 2026-10-11." }, { body: "Marked lost on 2026-10-02." }],
    });

    // An Item that is first recorded once it is gone: a new Item starts out active, so this is
    // a change of status too.
    const bike = yield* saving({
      name: "Road bike",
      category: "sports",
      price: 900,
      status: "sold",
      status_on: "2026-04",
      proceeds: 400,
    });
    expect(bike.record).toMatchObject({
      status: "sold",
      status_on: "2026-04",
      price: 900,
      proceeds: 400,
      notes: [{ body: "Marked sold on 2026-04 for $400.00." }],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("the optional Note is a second Note on the Item, in the same Change", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);

    const saved = yield* saving({
      id: COUCH,
      status: "given",
      data: { donated_to: "Habitat ReStore" },
      note: " They collected it from the driveway. ",
    });
    const collected = "They collected it from the driveway.";
    expect(saved).toMatchObject({
      change_id: "id-0003",
      created: [
        { type: "note", id: "id-0001", name: "Marked given on 2026-10-11." },
        { type: "note", id: "id-0002", name: collected },
      ],
      updated: [{ type: "item", id: COUCH }],
    });
    expect((saved.record as { notes: unknown[] }).notes).toEqual([
      { id: "id-0002", body: collected, created_at: expect.any(String) },
      { id: "id-0001", body: "Marked given on 2026-10-11.", created_at: expect.any(String) },
    ]);

    // With no change of status, the Note given is the only one.
    const plain = yield* saving({ name: "Floor lamp", note: "A gift from Sam." });
    expect(plain).toMatchObject({
      created: [
        { type: "item", id: "id-0004", name: "Floor lamp" },
        { type: "note", id: "id-0005", name: "A gift from Sam." },
      ],
      record: { notes: [{ id: "id-0005", body: "A gift from Sam." }] },
    });
    expect(yield* getting("note", "id-0005")).toMatchObject({
      property_id: "seed-property-maple",
      attached_to: [{ type: "item", id: "id-0004", name: "Floor lamp" }],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

const NO_PROPERTY =
  "A Fixture stays with its Property, so it has to be at one. Only a Belonging can be at no Property.";

it.effect("a Belonging with property cleared has none, and a Fixture has to have one", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);

    // A new Belonging that is in storage, and so at no Property.
    const tires = yield* saving({
      name: "Snow tires",
      category: "vehicles",
      note: "In unit 14 at the storage place.",
      clear: ["property"],
    });
    expect(tires.record).toMatchObject({
      id: "id-0001",
      scope: "belonging",
      property_id: null,
      property: null,
      space_id: null,
    });
    // A Note on a record takes that record's Property, and this one has none.
    expect(yield* getting("note", "id-0002")).toMatchObject({ property_id: null });

    // One that is in a Space at a Property goes into storage, and is in no Space there.
    const couch = yield* saving({ id: COUCH, clear: ["property"] });
    expect(couch.record).toMatchObject({ property_id: null, space_id: null });

    const before = yield* counting;
    for (const fixture of [
      { name: "Ceiling fan", scope: "fixture", clear: ["property"] },
      { id: "seed-item-fridge", clear: ["property"] },
      // A Belonging at no Property cannot become a Fixture where it is.
      { id: "id-0001", scope: "fixture" },
    ]) {
      expect(yield* saving(fixture), JSON.stringify(fixture)).toEqual({ refused: NO_PROPERTY });
    }
    // An Item at no Property is in no Space.
    expect(yield* saving({ id: "id-0001", space: "Garage" })).toEqual({
      refused:
        'A Space is one at a Property, and "Snow tires" is at none. Give `property` as well, or leave `space` out.',
    });
    expect(yield* counting).toEqual(before);

    // With a Property in the same save, it can be both.
    const mounted = yield* saving({
      id: "id-0001",
      scope: "fixture",
      property: "Maple Street house",
      space: "Garage",
    });
    expect(mounted.record).toMatchObject({
      scope: "fixture",
      property: "Maple Street house",
      space_id: "seed-space-garage",
    });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("an Item moved to another Property loses its Space, unless it is given one there", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);

    // The couch is in the living room of the Maple Street house.
    const moved = yield* saving({ id: COUCH, property: "elm court apartment" });
    const there = { property_id: "seed-property-elm", space_id: null };
    expect(moved).toMatchObject({
      created: [],
      updated: [{ type: "item", id: COUCH }],
      record: {
        ...there,
        property: "Elm Court apartment",
        space: null,
        changes: [
          {
            before: { property_id: "seed-property-maple", space_id: "seed-space-living-room" },
            after: there,
          },
        ],
      },
    });

    // A Space is one at a Property. The apartment has no Garage, so this makes one there, and
    // the Garage at the Maple Street house is another Space.
    const placed = yield* saving({
      id: "seed-item-treadmill",
      property: "seed-property-elm",
      space: "Garage",
    });
    expect(placed).toMatchObject({
      created: [{ type: "space", id: "id-0002", name: "Garage" }],
      record: { property_id: "seed-property-elm", space_id: "id-0002", space: "Garage" },
    });
    // The apartment has a Kitchen already, whatever the case of its name.
    const microwave = yield* saving({
      id: "seed-item-microwave",
      property: "Elm Court apartment",
      space: "KITCHEN",
    });
    expect(microwave).toMatchObject({
      created: [],
      record: { space_id: "seed-space-elm-kitchen", space: "Kitchen" },
    });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("an Item that stays at its Property keeps its Space, or is given or cleared of one", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);

    // Naming the Property an Item is at is no move.
    const stays = yield* saving({ id: "seed-item-fridge", property: "MAPLE street house" });
    expect(stays.record).toMatchObject({
      property_id: "seed-property-maple",
      space_id: "seed-space-kitchen",
    });

    // A Space given alone is one at the Item's own Property.
    const watch = yield* saving({ id: WATCH, space: "living ROOM" });
    expect(watch).toMatchObject({
      created: [],
      record: { space_id: "seed-space-living-room", space: "Living room" },
    });

    const cleared = yield* saving({ id: WATCH, clear: ["space"] });
    expect(cleared.record).toMatchObject({
      property_id: "seed-property-maple",
      space_id: null,
    });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a field is emptied by naming it in clear, and not given a value as well", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);

    // The fridge has all of these, and the exercise bike was sold on a known day for $300.
    const fridge = yield* saving({
      id: "seed-item-fridge",
      clear: ["acquired_on", "price", "bought_from"],
    });
    expect(fridge.record).toMatchObject({
      acquired_on: null,
      price: null,
      vendor_id: null,
      bought_from: null,
      // What the save did not name is as it was.
      space_id: "seed-space-kitchen",
      data: { brand: "Samsung" },
    });
    const bike = yield* saving({
      id: "seed-item-exercise-bike",
      clear: ["status_on", "proceeds"],
    });
    expect(bike.record).toMatchObject({ status: "sold", status_on: null, proceeds: null });

    const before = yield* counting;
    expect(
      yield* saving({ id: COUCH, price: 10, space: "Garage", clear: ["price", "space"] }),
    ).toEqual({
      refused:
        "A field is given a value or cleared, not both in one call. Both were asked for: price, space.",
    });
    // A field that must have a value cannot be cleared.
    expect((yield* saving({ id: COUCH, clear: ["name"] })).refused).toContain("clear");
    expect(yield* counting).toEqual(before);

    // A change of status is dated, so its date cannot be cleared in the same save.
    expect(yield* saving({ id: COUCH, status: "destroyed", clear: ["status_on"] })).toEqual({
      refused:
        "A change of status is dated, so `status_on` cannot be cleared in the save that changes the status. Give `status_on` the date, which may be a Partial date such as 2024, or leave it out for today.",
    });
    expect(yield* counting).toEqual(before);
  }).pipe(Effect.provide(TestDatabase)),
);

// A list of this many made-up Items, each with a price of its own.
const boxes = (count: number): Record<string, unknown>[] =>
  Array.from({ length: count }, (_, at) => ({
    name: `Moving box ${at + 1}`,
    space: "Garage",
    price: at + 0.5,
  }));

it.effect("a list of 50 is saved as one Change", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const before = yield* counting;

    const saved = yield* saving({ items: boxes(50) });
    // Fifty ids for the Items, in the order of the list, and then one for the Change.
    const created = saved.created as Listed[];
    expect(saved).toEqual({ change_id: "id-0051", created: expect.any(Array), updated: [] });
    expect(created).toHaveLength(50);
    expect(created[0]).toEqual({ type: "item", id: "id-0001", name: "Moving box 1" });
    expect(created[49]).toEqual({ type: "item", id: "id-0050", name: "Moving box 50" });
    expect(yield* counting).toEqual({ ...before, items: before.items + 50, changes: 1 });

    expect(yield* getting("item", "id-0050")).toMatchObject({
      name: "Moving box 50",
      price: 49.5,
      property: "Maple Street house",
      space_id: "seed-space-garage",
      changes: [{ id: "id-0051", tool: "save_item", before: null }],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a list of 51 is refused, and so is an empty one", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const before = yield* counting;

    expect(yield* saving({ items: boxes(51) })).toEqual({
      refused: "items: Expected at most 50 Items in one call. Save a longer list in several calls.",
    });
    expect(yield* saving({ items: [] })).toEqual({
      refused: "items: Expected at least one Item in the list.",
    });
    expect(yield* counting).toEqual(before);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a list with one bad entry writes nothing, and the error names the entry", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const before = yield* counting;

    // The entries around the bad one are fine, and one of them names a Space that is new.
    const list = boxes(5);
    list[1] = { ...list[1], space: "Loft" };
    list[3] = { ...list[3], category: "powertools" };
    expect(yield* saving({ items: list })).toEqual({
      refused: `Nothing was saved, because 1 of the 5 entries in \`items\` was refused. Entries are counted from 0.
items.3: There is no Category "powertools". The closest are: power-tools (Power tools). get_schema lists every Category, and save_category adds one.`,
    });
    expect(yield* counting).toEqual(before);

    // Every bad entry is named, and entries refused for the same reason are named together.
    list[0] = { id: "seed-item-toaster", price: 20 };
    list[4] = { ...list[4], category: "powertools" };
    expect(yield* saving({ items: list })).toEqual({
      refused: `Nothing was saved, because 3 of the 5 entries in \`items\` were refused. Entries are counted from 0.
items.0: There is no Item with the id "seed-item-toaster". Ids come from search and from the records get_record returns.
items.3, items.4: There is no Category "powertools". The closest are: power-tools (Power tools). get_schema lists every Category, and save_category adds one.`,
    });
    expect(yield* counting).toEqual(before);

    // A field that does not fit is turned away before the tool runs, with where it is.
    list[0] = { name: "Moving box 1", price: 19.999 };
    expect((yield* saving({ items: list })).refused).toBe(
      "items.0.price: Expected an amount with at most two decimal places, such as 1299.99.",
    );
    expect(yield* counting).toEqual(before);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a Space or a Vendor that several entries name is created once", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);

    const saved = yield* saving({
      items: [
        { name: "Camp stove", space: "Loft", bought_from: "Trailhead Outfitters" },
        // The same Space and the same Vendor, whatever the case of their names.
        { name: "Tent", space: "LOFT", bought_from: "trailhead outfitters" },
        // A Space is one at a Property, so a Loft at the apartment is another Space.
        { name: "Lantern", property: "Elm Court apartment", space: "Loft" },
        { name: "Cooler", space: "loft" },
      ],
    });
    expect(saved).toEqual({
      change_id: "id-0008",
      created: [
        { type: "space", id: "id-0001", name: "Loft" },
        { type: "vendor", id: "id-0002", name: "Trailhead Outfitters" },
        { type: "item", id: "id-0003", name: "Camp stove" },
        { type: "item", id: "id-0004", name: "Tent" },
        { type: "space", id: "id-0005", name: "Loft" },
        { type: "item", id: "id-0006", name: "Lantern" },
        { type: "item", id: "id-0007", name: "Cooler" },
      ],
      updated: [],
    });
    expect(yield* getting("space", "id-0001")).toMatchObject({
      property: "Maple Street house",
      items: [{ name: "Camp stove" }, { name: "Cooler" }, { name: "Tent" }],
    });
    expect(yield* getting("space", "id-0005")).toMatchObject({
      property: "Elm Court apartment",
      items: [{ name: "Lantern" }],
    });
    expect(yield* getting("vendor", "id-0002")).toMatchObject({
      items: [{ name: "Camp stove" }, { name: "Tent" }],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a list can create and update, and a list of one returns the Item", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);

    const saved = yield* saving({
      items: [
        { id: COUCH, status: "sold", proceeds: 450 },
        { name: "Armchair", category: "furniture", space: "Living room" },
      ],
    });
    expect(saved).toEqual({
      change_id: "id-0003",
      created: [
        { type: "note", id: "id-0001", name: "Marked sold on 2026-10-11 for $450.00." },
        { type: "item", id: "id-0002", name: "Armchair" },
      ],
      updated: [{ type: "item", id: COUCH, name: "Sectional couch" }],
    });

    const one = yield* saving({ items: [{ id: "id-0002", price: 320 }] });
    expect(one).toMatchObject({
      updated: [{ type: "item", id: "id-0002", name: "Armchair" }],
      record: { type: "item", id: "id-0002", price: 320 },
    });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a save gives one Item's fields or a list, and a list has each Item once", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const before = yield* counting;

    expect(
      yield* saving({ property: "Elm Court apartment", note: "Moved.", items: [{ id: COUCH }] }),
    ).toEqual({
      refused:
        "Give one Item's fields, or `items` for a list, and not both. Beside `items` there was: property, note. Each entry of a list has fields of its own.",
    });
    expect(
      yield* saving({ items: [{ id: COUCH, price: 10 }, { name: "Armchair" }, { id: COUCH }] }),
    ).toEqual({
      refused: `Nothing was saved, because 1 of the 3 entries in \`items\` was refused. Entries are counted from 0.
items.2: The Item "${COUCH}" is in this list already, at items.0. Give each Item once.`,
    });
    expect(yield* counting).toEqual(before);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("moving day: a list update moves every Belonging and leaves the Fixtures", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    yield* call(saveProperty, { name: "Birch Road house", start_on: "2026-10" });

    // The Belongings the User still has at the Maple Street house, as a client finds them
    // with `query`.
    const sql = yield* SqlClient.SqlClient;
    const belongings = yield* sql<{ id: string }>`
      SELECT id FROM items
       WHERE property_id = 'seed-property-maple' AND scope = 'belonging'
         AND status IN ('active', 'listed')
       ORDER BY name`;
    const moved = yield* saving({
      items: belongings.map(({ id }) => ({ id, property: "Birch Road house" })),
    });
    const names = [
      "Adjustable dumbbells",
      "Microwave",
      "Running watch",
      "Sectional couch",
      "Standing desk",
      "Treadmill",
    ];
    expect((moved.updated as Listed[]).map(({ name }) => name)).toEqual(names);
    expect(moved.created).toEqual([]);

    // Every one of them is at the new Property, and in no Space there.
    const birch = yield* getting("property", "Birch Road house");
    expect((birch.items as { name: string }[]).map(({ name }) => name)).toEqual(names);
    const spaces = yield* sql<{ spaces: number }>`
      SELECT count(space_id) AS spaces FROM items WHERE property_id = ${birch.id as string}`;
    expect(spaces).toEqual([{ spaces: 0 }]);

    // The Fixtures are where they were.
    const maple = yield* getting("property", "Maple Street house");
    expect(maple.items).toMatchObject([
      { name: "Fridge", scope: "fixture" },
      { name: "Water heater", scope: "fixture" },
    ]);
    expect(yield* getting("space", "seed-space-garage")).toMatchObject({
      items: [{ name: "Water heater" }],
    });
    expect(yield* getting("space", "seed-space-kitchen")).toMatchObject({
      items: [{ name: "Fridge" }],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// A list that is edited one entry at a time is kept by slug, because a merge patch replaces
// a list whole.
it.effect("data merges, so Parts keyed by slug can be added one at a time", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);

    const filter = { name: "Water filter", part_number: "DA97-17376B" };
    const bulb = { name: "Interior bulb", part_number: "DA34-00006C" };
    const saved = yield* saving({
      id: "seed-item-fridge",
      data: { parts: { "interior-bulb": bulb }, serial: null },
    });
    const data = {
      brand: "Samsung",
      model: "RF28R7351SR",
      warranty_until: "2027-06",
      parts: { "water-filter": filter, "interior-bulb": bulb },
    };
    expect(saved.record).toMatchObject({
      changes: [
        {
          before: {
            data: {
              ...data,
              serial: "SEED-FRIDGE-0001",
              parts: { "water-filter": filter },
            },
          },
          after: { data },
        },
      ],
    });
    // The serial was sent as null, so it is gone, and nothing else is.
    expect((saved.record as { data: unknown }).data).toEqual(data);

    // One Part is changed, and one is taken away, each by its slug.
    const again = yield* saving({
      id: "seed-item-fridge",
      data: { parts: { "water-filter": { part_number: "DA97-17376C" }, "interior-bulb": null } },
    });
    expect((again.record as { data: unknown }).data).toEqual({
      ...data,
      parts: { "water-filter": { name: "Water filter", part_number: "DA97-17376C" } },
    });

    // Money inside `data` is stored as written, in cents, and read back in dollars under the
    // name without _cents.
    const listed = yield* saving({
      id: COUCH,
      status: "listed",
      data: { listing: { where: "Craigslist", asking_cents: 90000 } },
    });
    expect(listed.record).toMatchObject({
      data: { listing: { where: "Craigslist", asking: 900 } },
    });
    expect(JSON.parse((yield* stored(COUCH))!.data as string)).toMatchObject({
      listing: { asking_cents: 90000 },
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// A list of fifty Items with no Property to be at is refused for one reason, and says it once.
it.effect("entries refused for the same reason are named together", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    yield* call(saveProperty, { name: "Birch Road house", start_on: "2026-10" });
    const before = yield* counting;

    const list = [...boxes(3), { id: COUCH, price: 2600 }];
    expect(yield* saving({ items: list })).toEqual({
      refused: `Nothing was saved, because 3 of the 4 entries in \`items\` were refused. Entries are counted from 0.
items.0, items.1, items.2: 2 Properties are current: Birch Road house, Maple Street house. Say which one this is for: give \`property\` its id or its name.`,
    });
    expect(yield* counting).toEqual(before);

    // One Item given by its fields is refused in the words of the refusal alone.
    expect(yield* saving({ name: "Moving box" })).toEqual({
      refused:
        "2 Properties are current: Birch Road house, Maple Street house. Say which one this is for: give `property` its id or its name.",
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// There is no field for what an Item is worth, and a model number goes inside `data`. Each of
// these would once have been dropped, and the save gone through as if it had been taken.
it.effect("a field save_item does not have is turned away by name, in a list as well", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const before = yield* counting;

    const fields =
      "There is no field with this name. The fields are: id, name, property, space, scope, category, extra_categories, acquired_on, price, bought_from, status, status_on, proceeds, data, note, clear";
    const goesInData = "A fact with no field of its own goes inside data.";
    for (const field of ["model", "appraisal", "value", "quantity"]) {
      expect(yield* saving({ name: "Dining chairs", [field]: 6 }), field).toEqual({
        refused: `${field}: ${fields}, items. ${goesInData}`,
      });
    }
    // An entry of a list has every field but `items`.
    expect(
      yield* saving({ items: [{ name: "Dining chairs" }, { name: "Dining table", model: "Oak" }] }),
    ).toEqual({ refused: `items.1.model: ${fields}. ${goesInData}` });
    expect(yield* counting).toEqual(before);

    const chairs = yield* saving({ name: "Dining chairs", price: 1200, data: { quantity: 6 } });
    expect(chairs.record).toMatchObject({ price: 1200, data: { quantity: 6 } });
  }).pipe(Effect.provide(TestDatabase)),
);
