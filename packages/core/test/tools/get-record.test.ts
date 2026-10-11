import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { getRecord } from "../../src/tools/get-record.ts";
import { answer, call } from "../call.ts";
import { loadHousehold } from "../household.ts";
import { TestDatabase } from "../TestDatabase.ts";

// What `get_record` sends back: the record, or the text of a refusal.
const getting = (type: string, id: string) =>
  call(getRecord, { type, id }).pipe(Effect.map((sent) => answer(sent)));

// The ids of a list's entries, in the order they came back.
const ids = (list: unknown) => (list as ReadonlyArray<{ id: string }>).map(({ id }) => id);

// "Something's wrong with the microwave." It cost 17999 cents, and nothing hangs off it.
it.effect("an Item comes back with its exact model, data as an object, and money in dollars", () =>
  Effect.gen(function* () {
    yield* loadHousehold;

    expect(yield* getting("item", "seed-item-microwave")).toEqual({
      type: "item",
      id: "seed-item-microwave",
      name: "Microwave",
      scope: "belonging",
      status: "active",
      status_on: null,
      property_id: "seed-property-maple",
      property: "Maple Street house",
      space_id: "seed-space-kitchen",
      space: "Kitchen",
      category_id: "appliances",
      category: "Appliances",
      extra_categories: [],
      acquired_on: "2023-02-11",
      price: 179.99,
      vendor_id: null,
      bought_from: null,
      proceeds: null,
      data: { brand: "Panasonic", model: "NN-SN686S", serial: "SEED-MICROWAVE-0001" },
      schedules: [],
      work: [],
      documents: [],
      notes: [],
      changes: [],
      created_at: expect.any(String),
      updated_at: expect.any(String),
    });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a record that does not exist is an error that names the type and the id", () =>
  Effect.gen(function* () {
    yield* loadHousehold;

    expect(yield* getting("item", "seed-item-toaster")).toEqual({
      refused:
        'There is no Item with the id "seed-item-toaster". Ids come from search and from the records get_record returns.',
    });
    // The id of a record of another type is not the id of an Item.
    expect((yield* getting("item", "seed-vendor-pipewise")).refused).toContain(
      'There is no Item with the id "seed-vendor-pipewise".',
    );
  }).pipe(Effect.provide(TestDatabase)),
);

// The two times the fridge's water filter was changed, as a list of Work shows them. The filter
// came from a different Vendor each time, and Filter Depot is the later one.
const FILTER_2026 = {
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
const FILTER_2025 = {
  id: "seed-work-filter-2025",
  kind: "maintenance",
  title: "Replaced the fridge water filter",
  date: "2025-12-14",
  cost: 54.99,
  diy: 1,
  property: "Maple Street house",
  vendor: "Appliance Barn",
  vendor_id: "seed-vendor-appliance-barn",
};

// "Order a new water filter for the fridge." The part number is in the Item's `data`, the
// cadence is on the Schedule, and where the Part was bought last is the Vendor on the last Work
// logged against that Schedule.
it.effect(
  "the fridge comes back with its water filter Part, the Schedule for it, and the Vendor on the last Work for that Schedule",
  () =>
    Effect.gen(function* () {
      yield* loadHousehold;

      expect(yield* getting("item", "seed-item-fridge")).toMatchObject({
        name: "Fridge",
        bought_from: "Appliance Barn",
        data: { parts: { "water-filter": { name: "Water filter", part_number: "DA97-17376B" } } },
        schedules: [
          {
            id: "seed-schedule-fridge-filter",
            title: "Replace fridge water filter",
            interval_days: 180,
            last_done_on: "2026-06-20",
            next_due_on: "2026-12-17",
            active: 1,
            data: {},
            last_work: FILTER_2026,
          },
        ],
        // Newest first.
        work: [FILTER_2026, FILTER_2025],
        // The dated ones first, newest first. A Document in a list comes without its text.
        documents: [
          {
            id: "seed-doc-filter-receipt",
            kind: "receipt",
            title: "Filter Depot order confirmation",
            doc_date: "2026-06-16",
            total: 49.99,
            vendor: "Filter Depot",
          },
          {
            id: "seed-doc-fridge-receipt",
            kind: "receipt",
            title: "Appliance Barn receipt",
            doc_date: "2022-06-03",
            total: 2199,
            vendor: "Appliance Barn",
          },
          {
            id: "seed-doc-fridge-photo",
            kind: "photo",
            title: "Fridge rating plate",
            doc_date: null,
            total: null,
            vendor: null,
          },
          {
            id: "seed-doc-fridge-manual",
            kind: "manual",
            title: "Fridge user manual",
            doc_date: null,
            total: null,
            vendor: null,
          },
        ],
      });
    }).pipe(Effect.provide(TestDatabase)),
);

// A Schedule on an Item is maintenance on that Item, so Work logged against it is Work on the
// Item, whether or not the Work names the Item as well.
it.effect("an Item's Work includes the Work logged against its Schedules", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* loadHousehold;
    yield* sql`
      INSERT INTO work (id, property_id, kind, title, date, schedule_id)
      VALUES ('work-filter-2024', 'seed-property-maple', 'maintenance',
              'Replaced the fridge water filter', '2024-12-01', 'seed-schedule-fridge-filter')`;

    const fridge = yield* getting("item", "seed-item-fridge");
    expect(ids(fridge.work)).toEqual([
      "seed-work-filter-2026",
      "seed-work-filter-2025",
      "work-filter-2024",
    ]);
  }).pipe(Effect.provide(TestDatabase)),
);

// The watch is electronics first, and fitness as an extra Category. The treadmill has one
// Category, Cardio, which sits under Fitness.
it.effect("an Item's extra Categories come back with its primary one", () =>
  Effect.gen(function* () {
    yield* loadHousehold;

    expect(yield* getting("item", "seed-item-watch")).toMatchObject({
      category_id: "electronics",
      category: "Electronics",
      extra_categories: [{ id: "fitness", name: "Fitness" }],
    });
    expect(yield* getting("item", "seed-item-treadmill")).toMatchObject({
      category_id: "seed-cardio",
      category: "Cardio",
      extra_categories: [],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// Changing an Item's status writes a dated Note, so the listed desk has one. It is listed for
// 25000 cents.
it.effect("a record comes back with the Notes attached to it, newest first", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* loadHousehold;
    yield* sql`
      INSERT INTO notes (id, entity_type, entity_id, body, created_at)
      VALUES ('note-wobble', 'item', 'seed-item-desk', 'Wobbles at full height.', '2025-01-05T10:00:00.000Z')`;

    expect(yield* getting("item", "seed-item-desk")).toMatchObject({
      status: "listed",
      status_on: "2026-09-20",
      data: {
        listing: {
          where: "Craigslist",
          asking: 250,
          url: "https://example.com/listings/standing-desk",
        },
      },
      notes: [
        {
          id: "seed-note-desk",
          body: "2026-09-20: listed on Craigslist for $250.",
          created_at: expect.any(String),
        },
        {
          id: "note-wobble",
          body: "Wobbles at full height.",
          created_at: "2025-01-05T10:00:00.000Z",
        },
      ],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// No tool writes yet, so these Changes are put in by hand: the desk was saved, and later listed
// in a Change that also wrote the Note about it.
it.effect("a record with a Change shows it, newest first, as it was before and after", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* loadHousehold;
    const saved = { name: "Standing desk", status: "active", price_cents: 59900 };
    const listed = { name: "Standing desk", status: "listed", price_cents: 59900 };
    yield* sql`
      INSERT INTO changes (id, tool, created_at) VALUES
        ('change-saved', 'save_item', '2026-09-01T12:00:00.000Z'),
        ('change-listed', 'save_item', '2026-09-20T12:00:00.000Z')`;
    yield* sql`
      INSERT INTO change_records (change_id, entity_type, entity_id, before, after) VALUES
        ('change-saved', 'item', 'seed-item-desk', NULL, ${JSON.stringify(saved)}),
        ('change-listed', 'item', 'seed-item-desk', ${JSON.stringify(saved)}, ${JSON.stringify(listed)}),
        ('change-listed', 'note', 'seed-note-desk', NULL, '{"body":"2026-09-20: listed on Craigslist for $250."}')`;

    const desk = yield* getting("item", "seed-item-desk");
    expect(desk.changes).toEqual([
      {
        id: "change-listed",
        tool: "save_item",
        created_at: "2026-09-20T12:00:00.000Z",
        undoes: null,
        before: { name: "Standing desk", status: "active", price: 599 },
        after: { name: "Standing desk", status: "listed", price: 599 },
      },
      {
        id: "change-saved",
        tool: "save_item",
        created_at: "2026-09-01T12:00:00.000Z",
        undoes: null,
        before: null,
        after: { name: "Standing desk", status: "active", price: 599 },
      },
    ]);

    // A record no Change has touched.
    expect((yield* getting("item", "seed-item-microwave")).changes).toEqual([]);
  }).pipe(Effect.provide(TestDatabase)),
);

// Changes are kept forever, and a record that is saved often gathers many. The rest of the log
// is read with `query`.
it.effect("only a record's five most recent Changes come back", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* loadHousehold;
    yield* sql`
      WITH RECURSIVE counting (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM counting WHERE n < 6)
      INSERT INTO changes (id, tool, created_at)
      SELECT printf('change-%d', n), 'save_item', printf('2026-09-0%dT12:00:00.000Z', n) FROM counting`;
    yield* sql`
      INSERT INTO change_records (change_id, entity_type, entity_id, after)
      SELECT id, 'item', 'seed-item-desk', '{}' FROM changes`;

    const desk = yield* getting("item", "seed-item-desk");
    expect(ids(desk.changes)).toEqual(["change-6", "change-5", "change-4", "change-3", "change-2"]);
  }).pipe(Effect.provide(TestDatabase)),
);

const TRIM = {
  brand: "Sherwin-Williams",
  color: "Pure White",
  code: "SW 7005",
  sheen: "semi-gloss",
};

// "What paint is in the living room?" It has wall paint of its own and no trim entry. The trim
// color is the same in every Space, so it is a fact about the Property.
it.effect(
  "the living room comes back with its own wall paint and the Property's trim color, marked as the Property's",
  () =>
    Effect.gen(function* () {
      yield* loadHousehold;

      expect(yield* getting("space", "seed-space-living-room")).toMatchObject({
        type: "space",
        id: "seed-space-living-room",
        name: "Living room",
        property_id: "seed-property-maple",
        property: "Maple Street house",
        data: {
          sqft: 240,
          paint: {
            walls: {
              brand: "Sherwin-Williams",
              color: "Agreeable Gray",
              code: "SW 7029",
              sheen: "eggshell",
            },
          },
          flooring: { type: "oak hardwood", installed: "2019" },
        },
        from_property: { paint: { trim: TRIM } },
      });
    }).pipe(Effect.provide(TestDatabase)),
);

// A Property's `data` holds what is true of the whole place. A Space shows the entries it has
// none of its own for. Paint is a list kept by surface, each surface an object of its own, so it
// is compared surface by surface, and so is any list kept that way. Flooring is one entry with
// nothing but plain values in it, so a Space with flooring of its own gets none of the
// Property's.
it.effect("a Space's own entry for a house-wide fact wins, and paint goes by surface", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* loadHousehold;
    const houseWide = {
      lease_until: "2027-06",
      flooring: { type: "oak hardwood", installed: "2019" },
      paint: {
        walls: { color: "Alabaster" },
        trim: { color: "Pure White", sheen: "semi-gloss" },
        ceiling: { color: "Ceiling White" },
      },
      blinds: { front: { kind: "shutters" }, back: { kind: "roller" } },
    };
    const den = {
      flooring: { type: "carpet" },
      paint: { walls: { color: "Sea Salt" }, trim: { color: "Tricorn Black" } },
      blinds: { front: { kind: "curtains" } },
    };
    const bath = { paint: { walls: {}, trim: {}, ceiling: {} } };
    yield* sql`
      INSERT INTO properties (id, name, data)
      VALUES ('property-oak', 'Oak Lane flat', ${JSON.stringify(houseWide)})`;
    yield* sql`
      INSERT INTO spaces (id, property_id, name, data) VALUES
        ('space-hall', 'property-oak', 'Hall', '{}'),
        ('space-den', 'property-oak', 'Den', ${JSON.stringify(den)}),
        ('space-bath', 'property-oak', 'Bath', ${JSON.stringify(bath)})`;
    const fromProperty = (id: string) =>
      getting("space", id).pipe(Effect.map((space) => space.from_property));

    // With nothing of its own, a Space gets every house-wide fact.
    expect(yield* fromProperty("space-hall")).toEqual(houseWide);
    // The den's own trim wins whole: the Property's sheen is not added to it.
    expect(yield* fromProperty("space-den")).toEqual({
      lease_until: "2027-06",
      paint: { ceiling: { color: "Ceiling White" } },
      blinds: { back: { kind: "roller" } },
    });
    expect(yield* fromProperty("space-bath")).toEqual({
      lease_until: "2027-06",
      flooring: { type: "oak hardwood", installed: "2019" },
      blinds: { front: { kind: "shutters" }, back: { kind: "roller" } },
    });
    // A Property with no house-wide facts.
    expect(yield* fromProperty("seed-space-elm-kitchen")).toEqual({});
  }).pipe(Effect.provide(TestDatabase)),
);

// A Property's paint is kept by surface, and nothing stops it from holding something else too.
// The year it was last repainted is not a surface, and the trim beside it still is.
it.effect(
  "a Space still gets the Property's trim when the Property's paint holds more than surfaces",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* loadHousehold;
      yield* sql`
        UPDATE properties SET data = json_patch(data, '{"paint":{"repainted":"2024"}}')
         WHERE id = 'seed-property-maple'`;

      // The living room has wall paint of its own, so it says for itself when it was painted.
      expect((yield* getting("space", "seed-space-living-room")).from_property).toEqual({
        paint: { trim: TRIM },
      });
      // The garage has no paint of its own, so it gets all of the Property's.
      expect((yield* getting("space", "seed-space-garage")).from_property).toEqual({
        paint: { trim: TRIM, repainted: "2024" },
      });
    }).pipe(Effect.provide(TestDatabase)),
);

// The fridge and the microwave are in the Kitchen, and the faucet was repaired there. The
// Exterior is named by the outdoor lighting Project and by three pieces of Work.
it.effect("a Space comes back with the Items in it, and the Work and Projects that named it", () =>
  Effect.gen(function* () {
    yield* loadHousehold;

    expect(yield* getting("space", "seed-space-kitchen")).toMatchObject({
      items: [
        {
          id: "seed-item-fridge",
          name: "Fridge",
          scope: "fixture",
          status: "active",
          category: "Appliances",
        },
        {
          id: "seed-item-microwave",
          name: "Microwave",
          scope: "belonging",
          status: "active",
          category: "Appliances",
        },
      ],
      work: [
        {
          id: "seed-work-faucet",
          kind: "repair",
          title: "Replaced the kitchen faucet cartridge",
          date: "2023-06-12",
          cost: 285,
          diy: 0,
          property: "Maple Street house",
          vendor: "Pipewise Plumbing",
          vendor_id: "seed-vendor-pipewise",
        },
      ],
      projects: [],
    });

    const exterior = yield* getting("space", "seed-space-exterior");
    expect(exterior).toMatchObject({
      items: [],
      projects: [
        {
          id: "seed-project-outdoor-lighting",
          title: "Outdoor lighting",
          status: "open",
          start_on: "2026-04",
          end_on: null,
        },
      ],
    });
    expect(ids(exterior.work)).toEqual([
      "seed-work-lighting-transformer",
      "seed-work-lighting-trench",
      "seed-work-gutter",
    ]);
  }).pipe(Effect.provide(TestDatabase)),
);

// A Gone Item keeps its row for the money trail. It is not in the Space any more.
it.effect("a Space leaves out the Gone Items that were in it", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* loadHousehold;
    yield* sql`
      INSERT INTO items (id, property_id, space_id, name, status, status_on) VALUES
        ('item-armchair', 'seed-property-maple', 'seed-space-living-room', 'Armchair', 'sold', '2026-02'),
        ('item-lamp', 'seed-property-maple', 'seed-space-living-room', 'Floor lamp', 'listed', '2026-09')`;

    const livingRoom = yield* getting("space", "seed-space-living-room");
    expect(ids(livingRoom.items)).toEqual(["item-lamp", "seed-item-couch"]);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a Space comes back with its own Notes and Documents", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* loadHousehold;
    yield* sql`
      INSERT INTO notes (id, entity_type, entity_id, body, created_at)
      VALUES ('note-outlet', 'space', 'seed-space-garage', 'The outlet by the door is on a GFCI.', '2026-01-02T09:00:00.000Z')`;
    yield* sql`
      INSERT INTO documents (id, kind, title, r2_key, mime_type, sha256)
      VALUES ('doc-garage', 'photo', 'Garage before the shelves', 'garage.jpg', 'image/jpeg', 'sha-garage')`;
    yield* sql`
      INSERT INTO document_links (document_id, entity_type, entity_id)
      VALUES ('doc-garage', 'space', 'seed-space-garage')`;

    expect(yield* getting("space", "seed-space-garage")).toMatchObject({
      notes: [
        {
          id: "note-outlet",
          body: "The outlet by the door is on a GFCI.",
          created_at: "2026-01-02T09:00:00.000Z",
        },
      ],
      documents: [
        {
          id: "doc-garage",
          kind: "photo",
          title: "Garage before the shelves",
          doc_date: null,
          total: null,
          vendor: null,
        },
      ],
      changes: [],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// "Who quoted the outdoor lighting, and for how much?" Two Vendors did. Two pieces of Work are
// logged under the Project so far, for 450 and 380 dollars.
it.effect(
  "the outdoor lighting Project comes back with both Quotes, their Vendors and amounts, and the total of its Work's Costs",
  () =>
    Effect.gen(function* () {
      yield* loadHousehold;

      expect(yield* getting("project", "seed-project-outdoor-lighting")).toEqual({
        type: "project",
        id: "seed-project-outdoor-lighting",
        title: "Outdoor lighting",
        status: "open",
        start_on: "2026-04",
        end_on: null,
        property_id: "seed-property-maple",
        property: "Maple Street house",
        data: { goal: "Low-voltage lights along the front path and around the patio" },
        spaces: [{ id: "seed-space-exterior", name: "Exterior" }],
        quotes: [
          {
            id: "seed-quote-glow",
            vendor: "Glow Landscape Lighting",
            vendor_id: "seed-vendor-glow",
            amount: 3650,
            quoted_on: "2026-05-02",
            data: { includes: "10 path lights and a transformer" },
          },
          {
            id: "seed-quote-brightside",
            vendor: "Brightside Electric",
            vendor_id: "seed-vendor-brightside",
            amount: 4200,
            quoted_on: "2026-04-18",
            data: { includes: "12 path lights, a transformer, and a two-year warranty" },
          },
        ],
        total_cost: 830,
        work: [
          {
            id: "seed-work-lighting-transformer",
            kind: "improvement",
            title: "Installed the lighting transformer and an outdoor outlet",
            date: "2026-06-20",
            cost: 380,
            diy: 0,
            property: "Maple Street house",
            vendor: "Brightside Electric",
            vendor_id: "seed-vendor-brightside",
          },
          {
            id: "seed-work-lighting-trench",
            kind: "improvement",
            title: "Trenched and laid cable for the path lights",
            date: "2026-06-06",
            cost: 450,
            diy: 1,
            property: "Maple Street house",
            vendor: null,
            vendor_id: null,
          },
        ],
        // The paper each Quote came on.
        documents: [
          {
            id: "seed-doc-glow-quote",
            kind: "quote",
            title: "Glow quote for outdoor lighting",
            doc_date: "2026-05-02",
            total: 3650,
            vendor: "Glow Landscape Lighting",
          },
          {
            id: "seed-doc-brightside-quote",
            kind: "quote",
            title: "Brightside quote for outdoor lighting",
            doc_date: "2026-04-18",
            total: 4200,
            vendor: "Brightside Electric",
          },
        ],
        notes: [
          {
            id: "seed-note-lighting",
            body: "The HOA allows warm white fixtures only, 2700K.",
            created_at: expect.any(String),
          },
        ],
        changes: [],
        created_at: expect.any(String),
        updated_at: expect.any(String),
      });
    }).pipe(Effect.provide(TestDatabase)),
);

// A total of 0 would say the Work cost nothing.
it.effect("a Project's total is null until one piece of its Work has a Cost", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* loadHousehold;
    yield* sql`
      INSERT INTO projects (id, property_id, title)
      VALUES ('project-fence', 'seed-property-maple', 'Back fence')`;
    expect(yield* getting("project", "project-fence")).toMatchObject({
      title: "Back fence",
      spaces: [],
      quotes: [],
      total_cost: null,
      work: [],
    });

    yield* sql`
      INSERT INTO work (id, property_id, project_id, kind, title)
      VALUES ('work-posts', 'seed-property-maple', 'project-fence', 'improvement', 'Set the posts')`;
    expect(yield* getting("project", "project-fence")).toMatchObject({
      total_cost: null,
      work: [{ id: "work-posts", cost: null }],
    });

    yield* sql`
      INSERT INTO work (id, property_id, project_id, kind, title, cost_cents)
      VALUES ('work-panels', 'seed-property-maple', 'project-fence', 'improvement', 'Hung the panels', 120000)`;
    expect(yield* getting("project", "project-fence")).toMatchObject({ total_cost: 1200 });
  }).pipe(Effect.provide(TestDatabase)),
);

// "Who did we use for plumbing last time?" Pipewise did two pieces of Work. The water heater is dated
// only to the year, and as text that comes after a full date in the same year.
it.effect("a Vendor comes back with the Work it did, newest first", () =>
  Effect.gen(function* () {
    yield* loadHousehold;

    expect(yield* getting("vendor", "seed-vendor-pipewise")).toEqual({
      type: "vendor",
      id: "seed-vendor-pipewise",
      name: "Pipewise Plumbing",
      role: "plumber",
      data: { phone: "555-0142", email: "pipewise@example.com" },
      work: [
        {
          id: "seed-work-faucet",
          kind: "repair",
          title: "Replaced the kitchen faucet cartridge",
          date: "2023-06-12",
          cost: 285,
          diy: 0,
          property: "Maple Street house",
          vendor: "Pipewise Plumbing",
          vendor_id: "seed-vendor-pipewise",
        },
        {
          id: "seed-work-water-heater",
          kind: "improvement",
          title: "Replaced the water heater",
          date: "2023",
          cost: 1850,
          diy: 0,
          property: "Maple Street house",
          vendor: "Pipewise Plumbing",
          vendor_id: "seed-vendor-pipewise",
        },
      ],
      quotes: [],
      items: [],
      documents: [],
      notes: [
        {
          id: "seed-note-pipewise",
          body: "Ask for Dana. A text gets a faster answer than a call.",
          created_at: expect.any(String),
        },
      ],
      changes: [],
      created_at: expect.any(String),
      updated_at: expect.any(String),
    });

    // Work says which Property it was at, because a Vendor may have been used at a former one.
    expect(yield* getting("vendor", "seed-vendor-old-town")).toMatchObject({
      work: [{ id: "seed-work-elm-drain", date: "2021-03-02", property: "Elm Court apartment" }],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// Brightside quoted the outdoor lighting. The fridge came from Appliance Barn, and so did the
// exercise bike in this test, which has since been sold.
it.effect("a Vendor comes back with the Quotes it gave and the Items bought from it", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* loadHousehold;
    yield* sql`
      UPDATE items SET vendor_id = 'seed-vendor-appliance-barn' WHERE id = 'seed-item-exercise-bike'`;

    expect(yield* getting("vendor", "seed-vendor-brightside")).toMatchObject({
      quotes: [
        {
          id: "seed-quote-brightside",
          project: "Outdoor lighting",
          project_id: "seed-project-outdoor-lighting",
          amount: 4200,
          quoted_on: "2026-04-18",
          data: { includes: "12 path lights, a transformer, and a two-year warranty" },
        },
      ],
      items: [],
    });

    // A Gone Item was still bought there, and its status says it is gone.
    expect(yield* getting("vendor", "seed-vendor-appliance-barn")).toMatchObject({
      quotes: [],
      items: [
        {
          id: "seed-item-exercise-bike",
          name: "Exercise bike",
          scope: "belonging",
          status: "sold",
          category: "Cardio",
        },
        {
          id: "seed-item-fridge",
          name: "Fridge",
          scope: "fixture",
          status: "active",
          category: "Appliances",
        },
      ],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// The water heater was replaced by Pipewise, in the Garage, with a permit. The Receipt for it
// has no date that can be read, which is why the Work is dated only to the year.
it.effect("Work comes back with its Vendor, its Items and Spaces, and its Receipt", () =>
  Effect.gen(function* () {
    yield* loadHousehold;

    expect(yield* getting("work", "seed-work-water-heater")).toEqual({
      type: "work",
      id: "seed-work-water-heater",
      kind: "improvement",
      title: "Replaced the water heater",
      description: null,
      date: "2023",
      cost: 1850,
      diy: 0,
      property_id: "seed-property-maple",
      property: "Maple Street house",
      project_id: null,
      project: null,
      vendor_id: "seed-vendor-pipewise",
      vendor: "Pipewise Plumbing",
      schedule_id: null,
      schedule: null,
      data: { permit: "SEED-PERMIT-0417", replaced: "A 40 gallon tank from 2008" },
      items: [
        {
          id: "seed-item-water-heater",
          name: "Water heater",
          scope: "fixture",
          status: "active",
          category: "Home systems",
        },
      ],
      spaces: [{ id: "seed-space-garage", name: "Garage" }],
      documents: [
        {
          id: "seed-doc-water-heater-receipt",
          kind: "receipt",
          title: "Water heater invoice",
          doc_date: null,
          total: 1850,
          vendor: "Pipewise Plumbing",
        },
      ],
      notes: [],
      changes: [],
      created_at: expect.any(String),
      updated_at: expect.any(String),
    });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect(
  "Work comes back with the Project it is under and the Schedule it was logged against",
  () =>
    Effect.gen(function* () {
      yield* loadHousehold;

      expect(yield* getting("work", "seed-work-lighting-transformer")).toMatchObject({
        project_id: "seed-project-outdoor-lighting",
        project: "Outdoor lighting",
        schedule_id: null,
        schedule: null,
      });
      expect(yield* getting("work", "seed-work-filter-2026")).toMatchObject({
        project_id: null,
        project: null,
        schedule_id: "seed-schedule-fridge-filter",
        schedule: "Replace fridge water filter",
        items: [{ id: "seed-item-fridge", name: "Fridge" }],
        spaces: [],
      });
      expect(yield* getting("work", "seed-work-faucet")).toMatchObject({
        description: "The faucet dripped. Pipewise replaced the cartridge and both supply lines.",
      });
    }).pipe(Effect.provide(TestDatabase)),
);

// One Receipt, attached to the Work it paid for and to the Item the Part went into.
it.effect("a Document comes back with its text and every record it is attached to", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* loadHousehold;

    expect(yield* getting("document", "seed-doc-filter-receipt")).toEqual({
      type: "document",
      id: "seed-doc-filter-receipt",
      kind: "receipt",
      status: "filed",
      title: "Filter Depot order confirmation",
      doc_date: "2026-06-16",
      total: 49.99,
      property_id: "seed-property-maple",
      property: "Maple Street house",
      vendor_id: "seed-vendor-filter-depot",
      vendor: "Filter Depot",
      source: null,
      mime_type: "application/pdf",
      size_bytes: null,
      text: "Filter Depot. Order 20418. 1 x DA97-17376B refrigerator water filter. Total $49.99.",
      data: {},
      attached_to: [
        { type: "item", id: "seed-item-fridge", name: "Fridge" },
        { type: "work", id: "seed-work-filter-2026", name: "Replaced the fridge water filter" },
      ],
      changes: [],
      received_at: expect.any(String),
      updated_at: expect.any(String),
    });

    // One that has arrived and is attached to nothing yet.
    yield* sql`
      INSERT INTO documents (id, r2_key, mime_type, sha256)
      VALUES ('doc-pending', 'pending.jpg', 'image/jpeg', 'sha-pending')`;
    expect(yield* getting("document", "doc-pending")).toMatchObject({
      status: "pending",
      kind: "other",
      title: null,
      text: null,
      attached_to: [],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// The Note on Pipewise is attached to a Vendor, which has no Property. The Note about the
// breaker stands alone at a Property.
it.effect("a Note comes back with what it is attached to", () =>
  Effect.gen(function* () {
    yield* loadHousehold;

    expect(yield* getting("note", "seed-note-pipewise")).toEqual({
      type: "note",
      id: "seed-note-pipewise",
      body: "Ask for Dana. A text gets a faster answer than a call.",
      property_id: null,
      property: null,
      data: {},
      attached_to: [{ type: "vendor", id: "seed-vendor-pipewise", name: "Pipewise Plumbing" }],
      changes: [],
      created_at: expect.any(String),
    });
    expect(yield* getting("note", "seed-note-breaker")).toMatchObject({
      body: "Breaker 14 is the garage.",
      property_id: "seed-property-maple",
      property: "Maple Street house",
      attached_to: [],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// A Schedule is on an Item or on a Property, never both.
it.effect("a Schedule comes back with what it is on and the Work logged against it", () =>
  Effect.gen(function* () {
    yield* loadHousehold;

    expect(yield* getting("schedule", "seed-schedule-fridge-filter")).toEqual({
      type: "schedule",
      id: "seed-schedule-fridge-filter",
      title: "Replace fridge water filter",
      interval_days: 180,
      last_done_on: "2026-06-20",
      next_due_on: "2026-12-17",
      active: 1,
      property_id: null,
      property: null,
      item_id: "seed-item-fridge",
      item: "Fridge",
      data: {},
      work: [FILTER_2026, FILTER_2025],
      changes: [],
    });

    expect(yield* getting("schedule", "seed-schedule-furnace")).toMatchObject({
      title: "Service the furnace",
      property_id: "seed-property-maple",
      property: "Maple Street house",
      item_id: null,
      item: null,
      work: [
        {
          id: "seed-work-furnace",
          date: "2025-09-08",
          cost: 189,
          vendor: "Hearth Heating and Air",
          vendor_id: "seed-vendor-hearth",
        },
      ],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// The fridge's Schedule is the fridge's, so the Property's only one is the furnace. The Note
// about the breaker is attached to nothing, so it is the Property's. The two Gone Items are not
// at the Property any more.
it.effect(
  "a Property comes back with its Spaces, Projects, Schedules, Items, and Work, and the Notes that stand alone at it",
  () =>
    Effect.gen(function* () {
      yield* loadHousehold;

      const maple = yield* getting("property", "seed-property-maple");
      expect(maple).toEqual({
        type: "property",
        id: "seed-property-maple",
        name: "Maple Street house",
        tenure: "own",
        address: "12 Maple Street, Springfield",
        start_on: "2022-05-20",
        end_on: null,
        data: { paint: { trim: TRIM } },
        spaces: [
          { id: "seed-space-exterior", name: "Exterior" },
          { id: "seed-space-garage", name: "Garage" },
          { id: "seed-space-kitchen", name: "Kitchen" },
          { id: "seed-space-living-room", name: "Living room" },
        ],
        projects: [
          {
            id: "seed-project-outdoor-lighting",
            title: "Outdoor lighting",
            status: "open",
            start_on: "2026-04",
            end_on: null,
          },
        ],
        schedules: [
          {
            id: "seed-schedule-furnace",
            title: "Service the furnace",
            interval_days: 365,
            last_done_on: "2025-09-08",
            next_due_on: "2026-09-08",
            active: 1,
            data: {},
            last_work: {
              id: "seed-work-furnace",
              kind: "maintenance",
              title: "Annual furnace service",
              date: "2025-09-08",
              cost: 189,
              diy: 0,
              property: "Maple Street house",
              vendor: "Hearth Heating and Air",
              vendor_id: "seed-vendor-hearth",
            },
          },
        ],
        items: expect.any(Array),
        work: expect.any(Array),
        documents: [],
        notes: [
          {
            id: "seed-note-breaker",
            body: "Breaker 14 is the garage.",
            created_at: expect.any(String),
          },
        ],
        changes: [],
        created_at: expect.any(String),
        updated_at: expect.any(String),
      });
      expect(ids(maple.items)).toEqual([
        "seed-item-dumbbells",
        "seed-item-fridge",
        "seed-item-microwave",
        "seed-item-watch",
        "seed-item-couch",
        "seed-item-desk",
        "seed-item-treadmill",
        "seed-item-water-heater",
      ]);
      // Newest first. The water heater is dated only 2023, which as text comes last in its year.
      expect(ids(maple.work)).toEqual([
        "seed-work-lighting-transformer",
        "seed-work-filter-2026",
        "seed-work-lighting-trench",
        "seed-work-filter-2025",
        "seed-work-furnace",
        "seed-work-thermostat",
        "seed-work-faucet",
        "seed-work-gutter",
        "seed-work-water-heater",
      ]);

      // A former Property, known only to the month at both ends.
      expect(yield* getting("property", "seed-property-elm")).toMatchObject({
        name: "Elm Court apartment",
        tenure: "rent",
        start_on: "2019-08",
        end_on: "2022-05",
        spaces: [{ id: "seed-space-elm-kitchen", name: "Kitchen" }],
        schedules: [],
        notes: [],
      });
    }).pipe(Effect.provide(TestDatabase)),
);

// Every tool takes a Property by its id or by its name. `search` does not find Properties, so
// the name is what a client has.
it.effect("a Property can be given by its name, whatever its case", () =>
  Effect.gen(function* () {
    yield* loadHousehold;

    const byId = yield* getting("property", "seed-property-elm");
    expect(byId).toMatchObject({
      id: "seed-property-elm",
      name: "Elm Court apartment",
      spaces: [{ id: "seed-space-elm-kitchen", name: "Kitchen" }],
    });
    expect(yield* getting("property", "elm court APARTMENT")).toEqual(byId);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a Property that does not exist is an error that lists the ones that do", () =>
  Effect.gen(function* () {
    yield* loadHousehold;

    expect(yield* getting("property", "Oak Lane")).toEqual({
      refused:
        'There is no Property "Oak Lane". The Properties are: Elm Court apartment, Maple Street house.',
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// A Vendor the User buys from every week, or a Property with years of Work, would otherwise
// come back with lists that run to hundreds of entries.
it.effect("a list has at most 50 entries, and the record names the lists that were cut", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* loadHousehold;
    // 51 Notes on the fridge, written a day apart, and 51 pieces of Work on it.
    yield* sql`
      WITH RECURSIVE counting (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM counting WHERE n < 51)
      INSERT INTO notes (id, entity_type, entity_id, body, created_at)
      SELECT printf('note-%02d', n), 'item', 'seed-item-fridge', 'Wiped the coils.',
             strftime('%Y-%m-%dT00:00:00.000Z', '2025-01-01', printf('+%d days', n))
        FROM counting`;
    yield* sql`
      WITH RECURSIVE counting (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM counting WHERE n < 51)
      INSERT INTO work (id, property_id, kind, title, date)
      SELECT printf('work-%02d', n), 'seed-property-maple', 'maintenance', 'Wiped the coils',
             date('2020-01-01', printf('+%d days', n))
        FROM counting`;
    yield* sql`
      INSERT INTO work_items (work_id, item_id) SELECT id, 'seed-item-fridge' FROM work WHERE id GLOB 'work-*'`;

    // With the two filter changes, the fridge has 53 pieces of Work.
    const over = yield* getting("item", "seed-item-fridge");
    expect(over.notes).toHaveLength(50);
    expect(ids(over.notes).at(0)).toBe("note-51");
    expect(ids(over.notes).at(-1)).toBe("note-02");
    expect(over.work).toHaveLength(50);
    expect(ids(over.work).at(0)).toBe("seed-work-filter-2026");
    expect(ids(over.work).at(-1)).toBe("work-04");
    expect(over.lists_cut).toBe(
      "Each of these lists has more than 50 entries, and only the first 50 are here: work, notes. Read the rest with query.",
    );
    // The lists that fit are whole.
    expect(over.documents).toHaveLength(4);

    // A list of exactly 50 is whole, and nothing says it was cut.
    yield* sql`DELETE FROM notes WHERE id = 'note-51'`;
    yield* sql`DELETE FROM work WHERE id IN ('work-49', 'work-50', 'work-51')`;
    const exactly = yield* getting("item", "seed-item-fridge");
    expect(exactly.notes).toHaveLength(50);
    expect(exactly.work).toHaveLength(50);
    expect(exactly).not.toHaveProperty("lists_cut");
  }).pipe(Effect.provide(TestDatabase)),
);

// The MCP layer checks a call against the tool's input before the tool runs, and sends what the
// check says to the client. A Quote is not a type: it comes back with its Project.
it("a type that does not exist is turned away with a list of the types there are", async () => {
  const { validate } = getRecord.input["~standard"];

  const { issues } = await validate({ type: "quote", id: "seed-quote-glow" });
  expect(issues).toHaveLength(1);
  expect(issues![0]!.path).toEqual(["type"]);
  for (const type of [
    "property",
    "space",
    "item",
    "work",
    "project",
    "vendor",
    "document",
    "schedule",
    "note",
  ]) {
    expect(issues![0]!.message).toContain(`"${type}"`);
  }

  expect(await validate({ type: "item", id: "seed-item-fridge" })).toEqual({
    value: { type: "item", id: "seed-item-fridge" },
  });
  expect(await validate({ type: "item" })).toHaveProperty("issues");
});

// Notes, Documents, and Changes each point at a record by its type and its id. A Note cannot
// be attached to a Property, a Document, a Schedule, or another Note, and a Document cannot be
// attached to a Document, a Schedule, or a Note.
it.effect(
  "a record of every type shows the Notes, Documents, and Changes recorded against it",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* loadHousehold;
      const records: ReadonlyArray<readonly [type: string, id: string]> = [
        ["property", "seed-property-maple"],
        ["space", "seed-space-garage"],
        ["item", "seed-item-microwave"],
        ["work", "seed-work-gutter"],
        ["project", "seed-project-outdoor-lighting"],
        ["vendor", "seed-vendor-hearth"],
        ["document", "seed-doc-fridge-photo"],
        ["schedule", "seed-schedule-furnace"],
        ["note", "seed-note-breaker"],
      ];
      const withNotes = ["space", "item", "work", "project", "vendor"];
      const withDocuments = ["property", "space", "item", "work", "project", "vendor"];
      for (const [type, id] of records) {
        yield* sql`INSERT INTO changes (id, tool) VALUES (${`change-${type}`}, 'save')`;
        yield* sql`
          INSERT INTO change_records (change_id, entity_type, entity_id, after)
          VALUES (${`change-${type}`}, ${type}, ${id}, '{}')`;
        if (withNotes.includes(type)) {
          yield* sql`
            INSERT INTO notes (id, entity_type, entity_id, body)
            VALUES (${`note-${type}`}, ${type}, ${id}, 'A Note on it.')`;
        }
        if (withDocuments.includes(type)) {
          yield* sql`
            INSERT INTO documents (id, r2_key, mime_type, sha256)
            VALUES (${`doc-${type}`}, ${`${type}.pdf`}, 'application/pdf', ${`sha-${type}`})`;
          yield* sql`
            INSERT INTO document_links (document_id, entity_type, entity_id)
            VALUES (${`doc-${type}`}, ${type}, ${id})`;
        }
      }

      for (const [type, id] of records) {
        const record = yield* getting(type, id);
        expect(ids(record.changes), type).toEqual([`change-${type}`]);
        if (withNotes.includes(type)) expect(ids(record.notes), type).toContain(`note-${type}`);
        if (withDocuments.includes(type)) {
          expect(ids(record.documents), type).toContain(`doc-${type}`);
        }
      }
    }).pipe(Effect.provide(TestDatabase)),
);
