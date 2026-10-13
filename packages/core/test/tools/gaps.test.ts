import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { gaps } from "../../src/tools/gaps.ts";
import { answer, call, callAsClient, todayIs } from "../call.ts";
import { loadHousehold } from "../household.ts";
import { TestDatabase } from "../TestDatabase.ts";

// One entry of what `gaps` sends back: a record, and the fields it has nothing in.
interface Entry {
  readonly type: string;
  readonly id: string;
  readonly name: string;
  readonly missing: ReadonlyArray<string>;
}

// The Items of one Space, or of none: the ones that are shown, and a count of the rest.
interface Shown {
  readonly items: ReadonlyArray<Entry>;
  readonly more_items?: number;
}

// What `gaps` sends back. A refusal is its text.
interface Gaps {
  readonly counts: { readonly items: number; readonly work: number; readonly spaces: number };
  readonly property: string;
  readonly spaces: ReadonlyArray<Entry & Shown>;
  readonly no_space?: Shown;
  readonly work: ReadonlyArray<
    Entry & { readonly spaces: ReadonlyArray<string>; readonly year_only?: ReadonlyArray<string> }
  >;
  readonly more_work?: number;
  readonly note?: string;
}

// A call the way a client sends one: checked against the tool's input first.
const asking = (input: unknown = {}) =>
  callAsClient(gaps, input).pipe(Effect.map((sent) => answer<Gaps>(sent)));

// The day the tests are on. A Property that ended before it is a former one. The made-up
// household has one Current property on it: the Maple Street house.
const TODAY = "2026-10-12";

// A Property of the test's own, with one Space that has nothing missing: the Den has a size and
// paint. So what a test finds missing is what the test itself put there.
const oakLane = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO properties (id, name) VALUES ('p-oak', 'Oak Lane house')`;
  yield* sql`
    INSERT INTO spaces (id, property_id, name, data)
    VALUES ('s-den', 'p-oak', 'Den', '{"sqft":180,"paint":{"walls":{"color":"Alabaster"}}}')`;
});

// The Den, as `gaps` shows it for the Items in it.
const den = (...items: ReadonlyArray<Entry>) => ({
  type: "space",
  id: "s-den",
  name: "Den",
  missing: [],
  items,
});

it.effect("an Item with nothing under a key its Category expects is missing that key", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* oakLane;
    yield* sql`
      INSERT INTO categories (id, name, data)
      VALUES ('small-appliances', 'Small appliances', '{"expects":["brand","model"]}')`;
    yield* sql`
      INSERT INTO items (id, property_id, space_id, category_id, name, acquired_on, price_cents, data)
      VALUES ('i-blender', 'p-oak', 's-den', 'small-appliances', 'Blender', '2024-03', 8900,
              '{"brand":"Vitamix"}')`;

    const whole = yield* asking();
    expect(whole).toEqual({
      counts: { items: 1, work: 0, spaces: 0 },
      property: "Oak Lane house",
      spaces: [den({ type: "item", id: "i-blender", name: "Blender", missing: ["data.model"] })],
      no_space: { items: [] },
      work: [],
    });
    // The reply leads with its counts, so they are read before any list.
    expect(Object.keys(whole)[0]).toBe("counts");
  }).pipe(Effect.provide(TestDatabase)),
);

// An Item is expected to have the keys of every Category it sits under. `networking` sits under
// `electronics`, which expects a brand, a model, and a serial, and expects nothing itself.
it.effect("a key that only a parent Category expects counts, and so does one of an extra one", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* oakLane;
    yield* sql`
      INSERT INTO categories (id, name, data)
      VALUES ('smart-devices', 'Smart devices', '{"expects":["hub"]}')`;
    yield* sql`
      INSERT INTO items (id, property_id, space_id, category_id, name, acquired_on, price_cents, data)
      VALUES
        ('i-router', 'p-oak', 's-den', 'networking', 'Router', '2024-03', 19900,
         '{"brand":"eero","model":"Pro 6E"}'),
        ('i-lamp', 'p-oak', 's-den', 'furniture', 'Smart lamp', '2025', 6000, '{}')`;
    yield* sql`INSERT INTO item_categories (item_id, category_id) VALUES ('i-lamp', 'smart-devices')`;

    const { counts, spaces } = yield* asking();
    expect(counts).toEqual({ items: 2, work: 0, spaces: 0 });
    expect(spaces).toEqual([
      den(
        { type: "item", id: "i-router", name: "Router", missing: ["data.serial"] },
        { type: "item", id: "i-lamp", name: "Smart lamp", missing: ["data.hub"] },
      ),
    ]);
  }).pipe(Effect.provide(TestDatabase)),
);

// A key is there in name only when what is under it is null, text with nothing in it, or an
// object or a list with nothing in it. A merge patch that takes out a list's last entry leaves
// the empty object behind. A zero and a false are facts.
it.effect("a key with nothing under it is missing, and a zero or a false is not", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* oakLane;
    yield* sql`
      INSERT INTO categories (id, name, data)
      VALUES ('gadgets', 'Gadgets',
              '{"expects":["brand","model","serial","parts","colors","quantity","original_box"]}')`;
    yield* sql`
      INSERT INTO items (id, property_id, space_id, category_id, name, acquired_on, price_cents, data)
      VALUES ('i-gadget', 'p-oak', 's-den', 'gadgets', 'Gadget', '2024', 100,
              '{"brand":null,"model":"","serial":"  ","parts":{},"colors":[],"quantity":0,"original_box":false}')`;

    const { spaces } = yield* asking();
    expect(spaces![0]!.items[0]!.missing).toEqual([
      "data.brand",
      "data.colors",
      "data.model",
      "data.parts",
      "data.serial",
    ]);
  }).pipe(Effect.provide(TestDatabase)),
);

// Nothing checks what a Category stores under `expects` but save_category, which takes a list of
// names and nothing else. Anything else that got there expects nothing: a value that is not a
// list, and an entry of a list that is not a name.
it.effect("a Category whose expects is not a list of names expects nothing", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* oakLane;
    yield* sql`
      INSERT INTO categories (id, name, data) VALUES
        ('odd-text', 'Odd text', '{"expects":"brand"}'),
        ('odd-list', 'Odd list', '{"expects":[7,{"key":"brand"}]}')`;
    yield* sql`
      INSERT INTO items (id, property_id, space_id, category_id, name, acquired_on, price_cents)
      VALUES ('i-one', 'p-oak', 's-den', 'odd-text', 'One', '2024', 100),
             ('i-two', 'p-oak', 's-den', 'odd-list', 'Two', '2024', 100)`;

    expect(yield* asking()).toMatchObject({ counts: { items: 0 }, spaces: [] });
  }).pipe(Effect.provide(TestDatabase)),
);

// A sofa has no Category that expects anything of it. What it paid and when it came are fields
// of its own, and the reply names them as save_item takes them.
it.effect("an Item with no Price, or with no date it was acquired on, is missing that field", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* oakLane;
    yield* sql`
      INSERT INTO categories (id, name, data)
      VALUES ('small-appliances', 'Small appliances', '{"expects":["brand","model"]}')`;
    yield* sql`
      INSERT INTO items (id, property_id, space_id, category_id, name, acquired_on, price_cents, data)
      VALUES
        ('i-sofa', 'p-oak', 's-den', 'furniture', 'Sofa', NULL, 120000, '{}'),
        ('i-rug', 'p-oak', 's-den', 'furniture', 'Rug', '2021', NULL, '{}'),
        ('i-kettle', 'p-oak', 's-den', 'small-appliances', 'Kettle', NULL, NULL, '{}'),
        -- A gift cost nothing, and nothing is a Price.
        ('i-vase', 'p-oak', 's-den', 'decor', 'Vase', '2020-12-25', 0, '{}')`;

    const { counts, spaces } = yield* asking();
    expect(counts).toEqual({ items: 3, work: 0, spaces: 0 });
    expect(spaces).toEqual([
      den(
        {
          type: "item",
          id: "i-kettle",
          name: "Kettle",
          missing: ["price", "acquired_on", "data.brand", "data.model"],
        },
        { type: "item", id: "i-rug", name: "Rug", missing: ["price"] },
        { type: "item", id: "i-sofa", name: "Sofa", missing: ["acquired_on"] },
      ),
    ]);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("an Item with every expected key, a Price, and a date is left out", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* oakLane;
    // `appliances` expects a brand, a model, and a serial.
    yield* sql`
      INSERT INTO items (id, property_id, space_id, category_id, name, acquired_on, price_cents, data)
      VALUES ('i-fridge', 'p-oak', 's-den', 'appliances', 'Fridge', '2022-06-03', 219900,
              '{"brand":"Samsung","model":"RF28R7351SR","serial":"OAK-0001"}')`;

    expect(yield* asking()).toEqual({
      counts: { items: 0, work: 0, spaces: 0 },
      property: "Oak Lane house",
      spaces: [],
      no_space: { items: [] },
      work: [],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// A Gone Item keeps its row for the money trail. There is nothing left to go and look at.
it.effect("a Gone Item is left out, whatever it is missing", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* oakLane;
    yield* sql`
      INSERT INTO items (id, property_id, space_id, category_id, name, status)
      VALUES
        ('i-sold', 'p-oak', 's-den', 'appliances', 'Old toaster', 'sold'),
        ('i-given', 'p-oak', 's-den', 'appliances', 'Old mixer', 'given'),
        ('i-lost', 'p-oak', NULL, 'appliances', 'Old phone', 'lost'),
        ('i-stolen', 'p-oak', NULL, 'appliances', 'Old bike', 'stolen'),
        ('i-destroyed', 'p-oak', NULL, 'appliances', 'Old lamp', 'destroyed'),
        -- One that is up for sale is still the User's.
        ('i-listed', 'p-oak', 's-den', 'furniture', 'Old desk', 'listed')`;

    const { counts, spaces, no_space } = yield* asking();
    expect(counts).toEqual({ items: 1, work: 0, spaces: 0 });
    expect(spaces).toEqual([
      den({ type: "item", id: "i-listed", name: "Old desk", missing: ["price", "acquired_on"] }),
    ]);
    expect(no_space).toEqual({ items: [] });
  }).pipe(Effect.provide(TestDatabase)),
);

// An Item at another Property is that Property's to ask about.
it.effect("Items in no Space come back as a group of their own", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* oakLane;
    yield* todayIs(TODAY);
    yield* sql`INSERT INTO properties (id, name, end_on) VALUES ('p-old', 'Old flat', '2020')`;
    yield* sql`
      INSERT INTO items (id, property_id, space_id, category_id, name, acquired_on, price_cents)
      VALUES
        ('i-watch', 'p-oak', NULL, 'jewelry', 'Watch', '2023-05', NULL),
        ('i-bike', 'p-oak', NULL, 'sports', 'bike', NULL, 45000),
        ('i-chair', 'p-oak', 's-den', 'furniture', 'Chair', '2023', NULL),
        ('i-elsewhere', 'p-old', NULL, 'furniture', 'Bookcase', NULL, NULL),
        ('i-nowhere', NULL, NULL, 'furniture', 'Trunk in storage', NULL, NULL)`;

    expect(yield* asking()).toEqual({
      counts: { items: 3, work: 0, spaces: 0 },
      property: "Oak Lane house",
      spaces: [den({ type: "item", id: "i-chair", name: "Chair", missing: ["price"] })],
      no_space: {
        items: [
          { type: "item", id: "i-bike", name: "bike", missing: ["acquired_on"] },
          { type: "item", id: "i-watch", name: "Watch", missing: ["price"] },
        ],
      },
      work: [],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// DIY Work often cost nothing, so no Cost on it is not a gap. Every piece of Work was done on
// some day, DIY or not. A piece of Work's name is its title.
it.effect(
  "Work that is not DIY and has no Cost is missing it, and Work with no date is missing that",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* oakLane;
      yield* todayIs(TODAY);
      yield* sql`INSERT INTO properties (id, name, end_on) VALUES ('p-old', 'Old flat', '2020')`;
      yield* sql`INSERT INTO spaces (id, property_id, name) VALUES ('s-old', 'p-old', 'Hall')`;
      yield* sql`INSERT INTO vendors (id, name, role) VALUES ('v-pipes', 'Pipes and Co', 'plumber')`;
      yield* sql`
        INSERT INTO work (id, property_id, kind, title, date, cost_cents, diy, vendor_id)
        VALUES
          ('w-diy', 'p-oak', 'repair', 'Patched the drywall', '2024-05-01', NULL, 1, NULL),
          ('w-vendor', 'p-oak', 'repair', 'Fixed the leak', '2024-06-01', NULL, 0, 'v-pipes'),
          ('w-undated', 'p-oak', 'maintenance', 'Cleaned the gutters', NULL, NULL, 1, NULL),
          ('w-neither', 'p-oak', 'inspection', 'Chimney inspection', NULL, NULL, 0, NULL),
          ('w-free', 'p-oak', 'repair', 'Warranty repair', '2025-01-15', 0, 0, 'v-pipes'),
          ('w-elsewhere', 'p-old', 'repair', 'Unclogged the drain', NULL, NULL, 0, 'v-pipes')`;
      yield* sql`INSERT INTO work_spaces (work_id, space_id) VALUES ('w-elsewhere', 's-old')`;

      const { counts, work } = yield* asking();
      expect(counts).toEqual({ items: 0, work: 3, spaces: 0 });
      // Newest first, and the ones with no date last.
      expect(work).toEqual([
        { type: "work", id: "w-vendor", name: "Fixed the leak", spaces: [], missing: ["cost"] },
        {
          type: "work",
          id: "w-undated",
          name: "Cleaned the gutters",
          spaces: [],
          missing: ["date"],
        },
        {
          type: "work",
          id: "w-neither",
          name: "Chimney inspection",
          spaces: [],
          missing: ["cost", "date"],
        },
      ]);
    }).pipe(Effect.provide(TestDatabase)),
);

// A year says when, and only roughly. So it is not missing, and it is not left alone either.
it.effect(
  "Work dated only to the year comes back as that, and Work dated to the month does not",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* oakLane;
      yield* sql`INSERT INTO spaces (id, property_id, name) VALUES ('s-attic', 'p-oak', 'attic')`;
      yield* sql`
      INSERT INTO work (id, property_id, kind, title, date, cost_cents, diy)
      VALUES
        ('w-year', 'p-oak', 'improvement', 'Replaced the water heater', '2023', 185000, 0),
        ('w-month', 'p-oak', 'repair', 'Rehung the door', '2023-06', 9000, 0),
        ('w-day', 'p-oak', 'repair', 'Fixed the latch', '2023-06-12', 2000, 0),
        ('w-year-diy', 'p-oak', 'improvement', 'Insulated the attic', '2022', NULL, 1),
        ('w-year-unpaid', 'p-oak', 'repair', 'Rewired the den', '2021', NULL, 0)`;
      yield* sql`
      INSERT INTO work_spaces (work_id, space_id)
      VALUES ('w-year', 's-den'), ('w-year', 's-attic'), ('w-year-unpaid', 's-den')`;

      const { counts, work } = yield* asking();
      expect(counts).toMatchObject({ items: 0, work: 3 });
      expect(work).toEqual([
        {
          type: "work",
          id: "w-year",
          name: "Replaced the water heater",
          // The Spaces it names, by name.
          spaces: ["attic", "Den"],
          missing: [],
          year_only: ["date"],
        },
        {
          type: "work",
          id: "w-year-diy",
          name: "Insulated the attic",
          spaces: [],
          missing: [],
          year_only: ["date"],
        },
        {
          type: "work",
          id: "w-year-unpaid",
          name: "Rewired the den",
          spaces: ["Den"],
          missing: ["cost"],
          year_only: ["date"],
        },
      ]);
    }).pipe(Effect.provide(TestDatabase)),
);

// A Space with nothing in it that is missing something, as `gaps` shows it.
const space = (id: string, name: string, ...missing: ReadonlyArray<string>) => ({
  type: "space",
  id,
  name,
  missing,
  items: [],
});

// The Den has a size and wall paint of its own, and Oak Lane has neither to give a Space. A key
// with nothing under it is missing for a Space as it is for an Item: a null, text with nothing
// in it, or an object or a list with nothing in it. A zero is a fact.
it.effect("a Space with no size is missing it, and so is one with no paint", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* oakLane;
    yield* sql`
      INSERT INTO spaces (id, property_id, name, data) VALUES
        ('s-hall', 'p-oak', 'Hall', '{"paint":{"walls":{"color":"Alabaster"}}}'),
        ('s-shed', 'p-oak', 'Shed', '{"sqft":80,"flooring":{"type":"concrete"}}'),
        ('s-porch', 'p-oak', 'Porch', '{}'),
        -- A patch that took the last surface out left the key behind.
        ('s-nook', 'p-oak', 'Nook', '{"sqft":"","paint":{}}'),
        ('s-loft', 'p-oak', 'Loft', '{"sqft":null,"paint":"  "}'),
        ('s-yard', 'p-oak', 'Yard', '{"sqft":0,"paint":[]}')`;

    const { counts, spaces } = yield* asking();
    expect(counts).toEqual({ items: 0, work: 0, spaces: 6 });
    expect(spaces).toEqual([
      space("s-hall", "Hall", "data.sqft"),
      space("s-loft", "Loft", "data.sqft", "data.paint"),
      space("s-nook", "Nook", "data.sqft", "data.paint"),
      space("s-porch", "Porch", "data.sqft", "data.paint"),
      space("s-shed", "Shed", "data.paint"),
      space("s-yard", "Yard", "data.paint"),
    ]);
  }).pipe(Effect.provide(TestDatabase)),
);

// A Space has paint when get_record would show some: its own, or what its Property has for
// every Space (ADR 0015). The Property's size is the size of no Space.
it.effect("a Space whose only paint is its Property's is not missing paint", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* oakLane;
    yield* sql`
      UPDATE properties
         SET data = '{"sqft":1800,"paint":{"trim":{"color":"Pure White"}}}' WHERE id = 'p-oak'`;
    yield* sql`
      INSERT INTO spaces (id, property_id, name, data) VALUES
        ('s-hall', 'p-oak', 'Hall', '{"sqft":60}'),
        ('s-porch', 'p-oak', 'Porch', '{}'),
        ('s-nook', 'p-oak', 'Nook', '{"sqft":20,"paint":{}}')`;

    const { counts, spaces } = yield* asking();
    expect(counts).toEqual({ items: 0, work: 0, spaces: 1 });
    expect(spaces).toEqual([space("s-porch", "Porch", "data.sqft")]);
  }).pipe(Effect.provide(TestDatabase)),
);

// The Space's own gaps and the Items in it come back together, so a client can ask about the
// whole of one Space at a time.
it.effect("a Space comes back with what it is missing itself and the Items in it", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* oakLane;
    yield* sql`INSERT INTO spaces (id, property_id, name) VALUES ('s-porch', 'p-oak', 'Porch')`;
    yield* sql`
      INSERT INTO items (id, property_id, space_id, category_id, name, acquired_on, price_cents)
      VALUES ('i-swing', 'p-oak', 's-porch', 'outdoor', 'Porch swing', '2022', NULL)`;

    const { counts, spaces } = yield* asking();
    expect(counts).toEqual({ items: 1, work: 0, spaces: 1 });
    expect(spaces).toEqual([
      {
        ...space("s-porch", "Porch", "data.sqft", "data.paint"),
        items: [{ type: "item", id: "i-swing", name: "Porch swing", missing: ["price"] }],
      },
    ]);
  }).pipe(Effect.provide(TestDatabase)),
);

// The Porch and what is on it, for the tests that ask for one Space. Each Space has an Item with
// no Price, and so does no Space at all. The Work is spread the same way.
const porchAndDen = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* oakLane;
  yield* sql`INSERT INTO spaces (id, property_id, name) VALUES ('s-porch', 'p-oak', 'Porch')`;
  yield* sql`
    INSERT INTO items (id, property_id, space_id, category_id, name, acquired_on, price_cents)
    VALUES
      ('i-swing', 'p-oak', 's-porch', 'outdoor', 'Porch swing', '2022', NULL),
      ('i-chair', 'p-oak', 's-den', 'furniture', 'Chair', '2023', NULL),
      ('i-watch', 'p-oak', NULL, 'jewelry', 'Watch', '2023-05', NULL)`;
  yield* sql`
    INSERT INTO work (id, property_id, kind, title, date, cost_cents, diy)
    VALUES
      ('w-porch', 'p-oak', 'repair', 'Fixed the porch step', NULL, 4000, 0),
      ('w-both', 'p-oak', 'improvement', 'Painted the trim', '2023', 60000, 0),
      ('w-den', 'p-oak', 'repair', 'Patched the den wall', NULL, 0, 1),
      ('w-none', 'p-oak', 'inspection', 'Roof inspection', NULL, 15000, 0)`;
  yield* sql`
    INSERT INTO work_spaces (work_id, space_id)
    VALUES ('w-porch', 's-porch'), ('w-both', 's-porch'), ('w-both', 's-den'), ('w-den', 's-den')`;
});

const SWING = { type: "item", id: "i-swing", name: "Porch swing", missing: ["price"] };
const TRIM = {
  type: "work",
  id: "w-both",
  name: "Painted the trim",
  spaces: ["Den", "Porch"],
  missing: [],
  year_only: ["date"],
};

it.effect(
  "with a Space, only that Space comes back: itself, its Items, and the Work that names it",
  () =>
    Effect.gen(function* () {
      yield* porchAndDen;

      // The name is matched whatever its case, as it is everywhere else.
      expect(yield* asking({ space: "porch" })).toEqual({
        counts: { items: 1, work: 2, spaces: 1 },
        property: "Oak Lane house",
        spaces: [{ ...space("s-porch", "Porch", "data.sqft", "data.paint"), items: [SWING] }],
        work: [
          TRIM,
          {
            type: "work",
            id: "w-porch",
            name: "Fixed the porch step",
            spaces: ["Porch"],
            missing: ["date"],
          },
        ],
      });

      // Without one, everything at the Property comes back.
      expect(yield* asking()).toMatchObject({
        counts: { items: 3, work: 4, spaces: 1 },
        spaces: [{ id: "s-den" }, { id: "s-porch" }],
        no_space: { items: [{ id: "i-watch" }] },
        work: [{ id: "w-both" }, { id: "w-porch" }, { id: "w-none" }, { id: "w-den" }],
      });
    }).pipe(Effect.provide(TestDatabase)),
);

// The Den has a size and paint, and its one Item gets a Price here.
it.effect("a Space with nothing missing comes back empty, with every count at zero", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* porchAndDen;
    yield* sql`UPDATE items SET price_cents = 9900 WHERE id = 'i-chair'`;
    yield* sql`DELETE FROM work_spaces WHERE space_id = 's-den'`;

    expect(yield* asking({ space: "Den" })).toEqual({
      counts: { items: 0, work: 0, spaces: 0 },
      property: "Oak Lane house",
      spaces: [],
      work: [],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a Space that is not at the Property is an error that lists the ones that are", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* porchAndDen;
    yield* todayIs(TODAY);
    yield* sql`INSERT INTO properties (id, name, end_on) VALUES ('p-old', 'Old flat', '2020')`;
    yield* sql`INSERT INTO spaces (id, property_id, name) VALUES ('s-hall', 'p-old', 'Hall')`;
    yield* sql`INSERT INTO properties (id, name, end_on) VALUES ('p-first', 'First flat', '2015')`;

    expect(yield* asking({ space: "Attic" })).toEqual({
      refused: 'There is no Space "Attic" at Oak Lane house. Its Spaces are: Den, Porch.',
    });
    // The Hall is a Space, at another Property.
    expect(yield* asking({ space: "Hall" })).toEqual({
      refused: 'There is no Space "Hall" at Oak Lane house. Its Spaces are: Den, Porch.',
    });
    expect(yield* asking({ property: "Old flat", space: "Hall" })).toMatchObject({
      property: "Old flat",
      spaces: [{ id: "s-hall", missing: ["data.sqft", "data.paint"] }],
    });
    expect(yield* asking({ property: "First flat", space: "Hall" })).toEqual({
      refused: 'There is no Space "Hall" at First flat. It has no Spaces yet.',
    });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("with no Property given and two Current properties, the error lists them", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* oakLane;
    yield* todayIs(TODAY);
    yield* sql`INSERT INTO properties (id, name) VALUES ('p-birch', 'Birch Road house')`;
    yield* sql`INSERT INTO spaces (id, property_id, name) VALUES ('s-loft', 'p-birch', 'Loft')`;

    expect(yield* asking()).toEqual({
      refused:
        "2 Properties are current: Birch Road house, Oak Lane house. Say which one this is for: give `property` its id or its name.",
    });

    // By its name, whatever the case, or by its id.
    for (const property of ["birch road HOUSE", "p-birch"]) {
      expect(yield* asking({ property }), property).toMatchObject({
        property: "Birch Road house",
        spaces: [{ id: "s-loft" }],
      });
    }
    expect(yield* asking({ property: "Cedar Court" })).toEqual({
      refused:
        'There is no Property "Cedar Court". The Properties are: Birch Road house, Oak Lane house.',
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// Items with no Price, named so that they sort in the order they are numbered: Bin 01, Bin 02.
const bins = (from: number, to: number, spaceId: string | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (let number = from; number <= to; number++) {
      const name = `Bin ${String(number).padStart(2, "0")}`;
      yield* sql`
        INSERT INTO items (id, property_id, space_id, name, acquired_on)
        VALUES (${`i-bin-${number}`}, 'p-oak', ${spaceId}, ${name}, '2024')`;
    }
  });

const names = (shown: Shown | undefined) => shown!.items.map(({ name }) => name);

const FILL_THESE_IN =
  "fill these in and ask again: a record with nothing missing is left out, so the next ones come up.";

// 25 in the Den, 30 on the Porch, and 5 in no Space. The 5 in no Space come first, because no
// Space can be asked for to see them. Then all of the Den's, and 20 of the Porch's. So every
// Item that was cut is in a Space, and asking for that Space shows it.
it.effect("a Property with 60 Items that have no Price shows 50 and counts the other 10", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* oakLane;
    yield* sql`
      INSERT INTO spaces (id, property_id, name, data)
      VALUES ('s-porch', 'p-oak', 'Porch', '{"sqft":90,"paint":{"walls":{"color":"Gray"}}}')`;
    yield* bins(1, 25, "s-den");
    yield* bins(26, 55, "s-porch");
    yield* bins(56, 60, null);

    const whole = yield* asking();
    expect(whole.counts).toEqual({ items: 60, work: 0, spaces: 0 });
    expect(names(whole.no_space)).toEqual(["Bin 56", "Bin 57", "Bin 58", "Bin 59", "Bin 60"]);
    expect(whole.no_space).not.toHaveProperty("more_items");
    const [inDen, onPorch] = whole.spaces!;
    expect(names(inDen)).toHaveLength(25);
    expect([names(inDen)[0], names(inDen).at(-1)]).toEqual(["Bin 01", "Bin 25"]);
    expect(inDen).not.toHaveProperty("more_items");
    expect(names(onPorch)).toHaveLength(20);
    expect(names(onPorch).at(-1)).toBe("Bin 45");
    expect(onPorch!.more_items).toBe(10);
    expect(whole.note).toBe(
      `Only the first 50 of the 60 Items are here. Give \`space\` the name of a Space to see the Items in it and the Work that names it. For anything else, ${FILL_THESE_IN}`,
    );

    // One Space at a time, every Item is there.
    const alone = yield* asking({ space: "Porch" });
    expect(alone.counts).toEqual({ items: 30, work: 0, spaces: 0 });
    expect(names(alone.spaces![0])).toHaveLength(30);
    expect(alone.spaces![0]).not.toHaveProperty("more_items");
    expect(alone).not.toHaveProperty("note");
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a Space with more than 50 Items is cut too when it is asked for alone", () =>
  Effect.gen(function* () {
    yield* oakLane;
    yield* bins(1, 60, "s-den");

    const alone = yield* asking({ space: "Den" });
    expect(alone.counts).toEqual({ items: 60, work: 0, spaces: 0 });
    expect(names(alone.spaces![0])).toHaveLength(50);
    expect(alone.spaces![0]!.more_items).toBe(10);
    // It was asked for alone already, so there is one way left to see the rest.
    expect(alone.note).toBe(
      `Only the first 50 of the 60 Items are here. To see the rest, ${FILL_THESE_IN}`,
    );
  }).pipe(Effect.provide(TestDatabase)),
);

// A Space that the cut left with no Item to show still comes back, with how many it has.
it.effect("a Space whose Items were all cut comes back with a count of them", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* oakLane;
    yield* sql`
      INSERT INTO spaces (id, property_id, name, data)
      VALUES ('s-porch', 'p-oak', 'Porch', '{"sqft":90,"paint":{"walls":{"color":"Gray"}}}')`;
    yield* bins(1, 50, "s-den");
    yield* bins(51, 53, "s-porch");

    const { spaces } = yield* asking();
    expect(spaces![1]).toEqual({
      type: "space",
      id: "s-porch",
      name: "Porch",
      missing: [],
      items: [],
      more_items: 3,
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// None of this Work names a Space, and none of these Items is in one. So asking for a Space
// shows none of what was cut, and the note does not say it would.
it.effect("55 pieces of Work with no date show 50, newest first, and count the other 5", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* oakLane;
    yield* bins(1, 51, null);
    for (let number = 1; number <= 55; number++) {
      const id = `w-${String(number).padStart(2, "0")}`;
      yield* sql`
        INSERT INTO work (id, property_id, kind, title, cost_cents)
        VALUES (${id}, 'p-oak', 'repair', ${`Repair ${number}`}, 1000)`;
    }

    const { counts, no_space, work, more_work, note } = yield* asking();
    expect(counts).toEqual({ items: 51, work: 55, spaces: 0 });
    expect(names(no_space)).toHaveLength(50);
    expect(no_space!.more_items).toBe(1);
    expect(work).toHaveLength(50);
    expect(work![0]!.id).toBe("w-55");
    expect(more_work).toBe(5);
    // Both lists were cut. The note says what a Space shows, and what works for anything else.
    expect(note).toBe(
      `Only the first 50 of the 51 Items are here. Only the first 50 of the 55 pieces of Work are here. Give \`space\` the name of a Space to see the Items in it and the Work that names it. For anything else, ${FILL_THESE_IN}`,
    );
  }).pipe(Effect.provide(TestDatabase)),
);

// The living room has a size and wall paint, and the couch in it has nothing missing, so it does
// not come back. The other three Spaces have no size. Their only paint is the trim, which is the
// Property's. The router is filed under Networking, and the serial it lacks is expected by
// Electronics, the Category above it. The exercise bike has no serial either, and it was sold.
it.effect("the gaps of the made-up household come back, grouped by Space", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);

    expect(yield* asking()).toEqual({
      counts: { items: 2, work: 1, spaces: 3 },
      property: "Maple Street house",
      spaces: [
        space("seed-space-exterior", "Exterior", "data.sqft"),
        {
          ...space("seed-space-garage", "Garage", "data.sqft"),
          items: [
            {
              type: "item",
              id: "seed-item-water-heater",
              name: "Water heater",
              missing: ["price"],
            },
          ],
        },
        space("seed-space-kitchen", "Kitchen", "data.sqft"),
      ],
      no_space: {
        items: [
          { type: "item", id: "seed-item-router", name: "Office router", missing: ["data.serial"] },
        ],
      },
      work: [
        {
          type: "work",
          id: "seed-work-water-heater",
          name: "Replaced the water heater",
          spaces: ["Garage"],
          missing: [],
          year_only: ["date"],
        },
      ],
    });

    // The former Property is asked about by name. The landlord's dishwasher was left there.
    expect(yield* asking({ property: "Elm Court apartment" })).toMatchObject({
      counts: { items: 1, work: 0, spaces: 1 },
      spaces: [
        {
          id: "seed-space-elm-kitchen",
          missing: ["data.sqft", "data.paint"],
          items: [
            {
              id: "seed-item-elm-dishwasher",
              missing: ["price", "acquired_on", "data.serial"],
            },
          ],
        },
      ],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// No tool stores a Document yet, so every Item would be missing a photo and a Receipt, and all
// Work a Receipt. Until one does, gaps says nothing of either. The made-up household has
// Documents on some records and none on others.
it.effect("nothing about a photo or a Receipt is in the reply or in the description", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const paperwork = /photo|receipt|document/i;

    for (const input of [{}, { space: "Kitchen" }, { property: "Elm Court apartment" }]) {
      const { text, isError } = yield* call(gaps, input);
      expect(isError).toBe(false);
      expect(text).not.toMatch(paperwork);
    }
    expect(gaps.description).not.toMatch(paperwork);
    const { jsonSchema } = gaps.input["~standard"];
    expect(JSON.stringify(jsonSchema.input({ target: "draft-2020-12" }))).not.toMatch(paperwork);
  }).pipe(Effect.provide(TestDatabase)),
);

it("gaps says what it is for and what it counts, names the script that uses it, and only reads", () => {
  expect(gaps.annotations).toEqual({ readOnlyHint: true });
  for (const said of [
    "what is missing at a Property, grouped by Space",
    "walk_the_house is the script that uses it",
    "a `data` key that one of its Categories expects",
    "no Price, or with no `acquired_on`",
    "not DIY and has no Cost",
    "Work dated only to the year",
    "no size",
    "no paint",
    "a Gone Item is left out",
    "At most 50 Items and 50 pieces of Work",
  ]) {
    expect(gaps.description, said).toContain(said);
  }
});
