// The made-up household: one small set of records that gives the questions in AGENTS.md real
// answers. The tests of the read tools share it, and the two commands beside this file load it
// into a stage's database and remove it again.
//
// Nothing here is real. The names and the street are made up, the email addresses are at
// example.com, the phone numbers are in the range kept for fiction, and every serial, permit,
// and claim number says SEED.
//
// Every id starts with `seed-`. That prefix is how the set is removed without touching anything
// else: a record of the User's own has a ULID for its id, and a ULID has no hyphen.

/** One SQL statement and the values bound to it, for whichever database client runs it. */
export interface Statement {
  readonly sql: string;
  readonly params: ReadonlyArray<string | number | null>;
}

// A column's value. An object is a `data` column, and it is stored as JSON text.
type Value = string | number | null | { readonly [key: string]: unknown };
type Row = Readonly<Record<string, Value>>;

const MAPLE = "seed-property-maple";
const ELM = "seed-property-elm";

// The tables in the order their rows go in, so that a row never comes before one it points at.
const RECORDS: ReadonlyArray<readonly [table: string, rows: ReadonlyArray<Row>]> = [
  [
    "properties",
    [
      {
        id: MAPLE,
        name: "Maple Street house",
        tenure: "own",
        address: "12 Maple Street, Springfield",
        start_on: "2022-05-20",
        // The trim color is the same in every Space, so it is a fact about the Property.
        data: {
          paint: {
            trim: {
              brand: "Sherwin-Williams",
              color: "Pure White",
              code: "SW 7005",
              sheen: "semi-gloss",
            },
          },
        },
      },
      // A former Property, known only to the month at both ends.
      {
        id: ELM,
        name: "Elm Court apartment",
        tenure: "rent",
        address: "4B, 30 Elm Court, Springfield",
        start_on: "2019-08",
        end_on: "2022-05",
        data: {},
      },
    ],
  ],
  [
    "spaces",
    [
      {
        id: "seed-space-kitchen",
        property_id: MAPLE,
        name: "Kitchen",
        data: { flooring: { type: "porcelain tile" }, counters: "quartz" },
      },
      // It has wall paint of its own and no trim entry, so its trim is the Property's.
      {
        id: "seed-space-living-room",
        property_id: MAPLE,
        name: "Living room",
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
      },
      { id: "seed-space-garage", property_id: MAPLE, name: "Garage", data: {} },
      { id: "seed-space-exterior", property_id: MAPLE, name: "Exterior", data: {} },
      { id: "seed-space-elm-kitchen", property_id: ELM, name: "Kitchen", data: {} },
    ],
  ],
  [
    "vendors",
    [
      // The plumber used last. Old Town Plumbing was the one before, at the former Property.
      {
        id: "seed-vendor-pipewise",
        name: "Pipewise Plumbing",
        role: "plumber",
        data: { phone: "555-0142", email: "pipewise@example.com" },
      },
      {
        id: "seed-vendor-old-town",
        name: "Old Town Plumbing",
        role: "plumber",
        data: { phone: "555-0117" },
      },
      // The two who quoted the outdoor lighting.
      {
        id: "seed-vendor-brightside",
        name: "Brightside Electric",
        role: "electrician",
        data: { phone: "555-0163", email: "brightside@example.com" },
      },
      {
        id: "seed-vendor-glow",
        name: "Glow Landscape Lighting",
        role: "landscape lighting",
        data: { email: "glow@example.com" },
      },
      { id: "seed-vendor-appliance-barn", name: "Appliance Barn", role: "retailer", data: {} },
      {
        id: "seed-vendor-filter-depot",
        name: "Filter Depot",
        role: "retailer",
        data: { url: "https://filter-depot.example.com" },
      },
      {
        id: "seed-vendor-hearth",
        name: "Hearth Heating and Air",
        role: "hvac",
        data: { phone: "555-0188" },
      },
      { id: "seed-vendor-stride", name: "Stride Supply", role: "retailer", data: {} },
    ],
  ],
  // A child of the starter Category `fitness`, so an Item filed here is a fitness Item only
  // through its parent. Nothing else about the treadmill says "fitness", its Vendor included.
  ["categories", [{ id: "seed-cardio", name: "Cardio", parent_id: "fitness", data: {} }]],
  [
    "items",
    [
      // "Order a new water filter for the fridge": the Part is here, its cadence is on the
      // Schedule, and where it was bought last is the Vendor on the latest Work for that
      // Schedule.
      {
        id: "seed-item-fridge",
        property_id: MAPLE,
        space_id: "seed-space-kitchen",
        scope: "fixture",
        category_id: "appliances",
        name: "Fridge",
        acquired_on: "2022-06-03",
        price_cents: 219900,
        vendor_id: "seed-vendor-appliance-barn",
        data: {
          brand: "Samsung",
          model: "RF28R7351SR",
          serial: "SEED-FRIDGE-0001",
          warranty_until: "2027-06",
          parts: { "water-filter": { name: "Water filter", part_number: "DA97-17376B" } },
        },
      },
      // "Something's wrong with the microwave": the exact model. It has no Receipt and no photo.
      {
        id: "seed-item-microwave",
        property_id: MAPLE,
        space_id: "seed-space-kitchen",
        category_id: "appliances",
        name: "Microwave",
        acquired_on: "2023-02-11",
        price_cents: 17999,
        data: { brand: "Panasonic", model: "NN-SN686S", serial: "SEED-MICROWAVE-0001" },
      },
      {
        id: "seed-item-water-heater",
        property_id: MAPLE,
        space_id: "seed-space-garage",
        scope: "fixture",
        category_id: "systems",
        name: "Water heater",
        acquired_on: "2023",
        data: { brand: "Rheem", model: "XG50T06EC36U1", serial: "SEED-HEATER-0001" },
      },
      // The fitness Items: one under the child Category, one under `fitness` itself, and one
      // that is electronics first and fitness as an extra Category.
      {
        id: "seed-item-treadmill",
        property_id: MAPLE,
        space_id: "seed-space-garage",
        category_id: "seed-cardio",
        name: "Treadmill",
        acquired_on: "2024-01-20",
        price_cents: 189900,
        vendor_id: "seed-vendor-stride",
        data: {
          brand: "NordicTrack",
          model: "Commercial 1750",
          serial: "SEED-TREADMILL-0001",
          condition: "good",
        },
      },
      {
        id: "seed-item-dumbbells",
        property_id: MAPLE,
        space_id: "seed-space-garage",
        category_id: "fitness",
        name: "Adjustable dumbbells",
        acquired_on: "2023-11",
        price_cents: 42900,
        data: { brand: "Bowflex", model: "SelectTech 552", quantity: 2 },
      },
      {
        id: "seed-item-watch",
        property_id: MAPLE,
        category_id: "electronics",
        name: "Running watch",
        acquired_on: "2024-05-02",
        price_cents: 34999,
        data: { brand: "Garmin", model: "Forerunner 255", serial: "SEED-WATCH-0001" },
      },
      {
        id: "seed-item-couch",
        property_id: MAPLE,
        space_id: "seed-space-living-room",
        category_id: "furniture",
        name: "Sectional couch",
        acquired_on: "2022-07",
        price_cents: 249900,
        data: { condition: "good" },
      },
      // Still the User's, and up for sale.
      {
        id: "seed-item-desk",
        property_id: MAPLE,
        category_id: "office",
        name: "Standing desk",
        acquired_on: "2021-10-04",
        price_cents: 59900,
        status: "listed",
        status_on: "2026-09-20",
        data: {
          listing: {
            where: "Craigslist",
            asking_cents: 25000,
            url: "https://example.com/listings/standing-desk",
          },
        },
      },
      // The Gone Items: one sold this year, and one stolen with no payout yet.
      {
        id: "seed-item-exercise-bike",
        property_id: MAPLE,
        category_id: "seed-cardio",
        name: "Exercise bike",
        acquired_on: "2021-01",
        price_cents: 65000,
        status: "sold",
        status_on: "2026-03-14",
        proceeds_cents: 30000,
        data: {
          brand: "Schwinn",
          model: "IC4",
          sold_to: "a neighbor",
          where: "Facebook Marketplace",
        },
      },
      {
        id: "seed-item-ebike",
        property_id: MAPLE,
        category_id: "sports",
        name: "Electric bike",
        acquired_on: "2023-04-15",
        price_cents: 240000,
        status: "stolen",
        status_on: "2025-09-02",
        data: {
          brand: "Trek",
          model: "Verve+ 2",
          serial: "SEED-EBIKE-0001",
          claim_number: "SEED-CLAIM-1042",
        },
      },
      // The landlord's, left behind at the former Property.
      {
        id: "seed-item-elm-dishwasher",
        property_id: ELM,
        space_id: "seed-space-elm-kitchen",
        scope: "fixture",
        category_id: "appliances",
        name: "Dishwasher",
        data: { brand: "Bosch", model: "SHE3AR75UC" },
      },
    ],
  ],
  ["item_categories", [{ item_id: "seed-item-watch", category_id: "fitness" }]],
  [
    "projects",
    [
      {
        id: "seed-project-outdoor-lighting",
        property_id: MAPLE,
        title: "Outdoor lighting",
        start_on: "2026-04",
        data: { goal: "Low-voltage lights along the front path and around the patio" },
      },
    ],
  ],
  [
    "project_spaces",
    [{ project_id: "seed-project-outdoor-lighting", space_id: "seed-space-exterior" }],
  ],
  [
    "quotes",
    [
      {
        id: "seed-quote-brightside",
        project_id: "seed-project-outdoor-lighting",
        vendor_id: "seed-vendor-brightside",
        amount_cents: 420000,
        quoted_on: "2026-04-18",
        data: { includes: "12 path lights, a transformer, and a two-year warranty" },
      },
      {
        id: "seed-quote-glow",
        project_id: "seed-project-outdoor-lighting",
        vendor_id: "seed-vendor-glow",
        amount_cents: 365000,
        quoted_on: "2026-05-02",
        data: { includes: "10 path lights and a transformer" },
      },
    ],
  ],
  [
    "schedules",
    [
      {
        id: "seed-schedule-fridge-filter",
        item_id: "seed-item-fridge",
        title: "Replace fridge water filter",
        interval_days: 180,
        last_done_on: "2026-06-20",
        next_due_on: "2026-12-17",
      },
      // Due: its date passed before this set was written.
      {
        id: "seed-schedule-furnace",
        property_id: MAPLE,
        title: "Service the furnace",
        interval_days: 365,
        last_done_on: "2025-09-08",
        next_due_on: "2026-09-08",
      },
    ],
  ],
  [
    "work",
    [
      // "Every repair and improvement since March 2023": the five rows from here to the end of
      // the Project's Work, less the gutter, which was in January. The water heater is dated
      // only `2023`, and a year counts as its whole self, so it is in.
      {
        id: "seed-work-gutter",
        property_id: MAPLE,
        kind: "repair",
        title: "Reattached a loose gutter",
        date: "2023-01-28",
        cost_cents: 4200,
        diy: 1,
      },
      {
        id: "seed-work-faucet",
        property_id: MAPLE,
        kind: "repair",
        title: "Replaced the kitchen faucet cartridge",
        description: "The faucet dripped. Pipewise replaced the cartridge and both supply lines.",
        date: "2023-06-12",
        cost_cents: 28500,
        vendor_id: "seed-vendor-pipewise",
      },
      {
        id: "seed-work-water-heater",
        property_id: MAPLE,
        kind: "improvement",
        title: "Replaced the water heater",
        date: "2023",
        cost_cents: 185000,
        vendor_id: "seed-vendor-pipewise",
        data: { permit: "SEED-PERMIT-0417", replaced: "A 40 gallon tank from 2008" },
      },
      {
        id: "seed-work-thermostat",
        property_id: MAPLE,
        kind: "improvement",
        title: "Updated the thermostat to a smart model",
        date: "2024-03-09",
        cost_cents: 24900,
        diy: 1,
      },
      // The Project's Work. Its total is the sum of these two Costs.
      {
        id: "seed-work-lighting-trench",
        property_id: MAPLE,
        project_id: "seed-project-outdoor-lighting",
        kind: "improvement",
        title: "Trenched and laid cable for the path lights",
        date: "2026-06-06",
        cost_cents: 45000,
        diy: 1,
      },
      {
        id: "seed-work-lighting-transformer",
        property_id: MAPLE,
        project_id: "seed-project-outdoor-lighting",
        kind: "improvement",
        title: "Installed the lighting transformer and an outdoor outlet",
        date: "2026-06-20",
        cost_cents: 38000,
        vendor_id: "seed-vendor-brightside",
      },
      // The fridge filter, bought from two Vendors. Filter Depot is the later one.
      {
        id: "seed-work-filter-2025",
        property_id: MAPLE,
        kind: "maintenance",
        title: "Replaced the fridge water filter",
        date: "2025-12-14",
        cost_cents: 5499,
        diy: 1,
        vendor_id: "seed-vendor-appliance-barn",
        schedule_id: "seed-schedule-fridge-filter",
      },
      {
        id: "seed-work-filter-2026",
        property_id: MAPLE,
        kind: "maintenance",
        title: "Replaced the fridge water filter",
        date: "2026-06-20",
        cost_cents: 4999,
        diy: 1,
        vendor_id: "seed-vendor-filter-depot",
        schedule_id: "seed-schedule-fridge-filter",
      },
      {
        id: "seed-work-furnace",
        property_id: MAPLE,
        kind: "maintenance",
        title: "Annual furnace service",
        date: "2025-09-08",
        cost_cents: 18900,
        vendor_id: "seed-vendor-hearth",
        schedule_id: "seed-schedule-furnace",
      },
      {
        id: "seed-work-elm-drain",
        property_id: ELM,
        kind: "repair",
        title: "Cleared the kitchen drain",
        date: "2021-03-02",
        cost_cents: 12000,
        vendor_id: "seed-vendor-old-town",
      },
    ],
  ],
  [
    "work_items",
    [
      { work_id: "seed-work-water-heater", item_id: "seed-item-water-heater" },
      { work_id: "seed-work-filter-2025", item_id: "seed-item-fridge" },
      { work_id: "seed-work-filter-2026", item_id: "seed-item-fridge" },
    ],
  ],
  [
    "work_spaces",
    [
      { work_id: "seed-work-gutter", space_id: "seed-space-exterior" },
      { work_id: "seed-work-faucet", space_id: "seed-space-kitchen" },
      { work_id: "seed-work-water-heater", space_id: "seed-space-garage" },
      { work_id: "seed-work-thermostat", space_id: "seed-space-living-room" },
      { work_id: "seed-work-lighting-trench", space_id: "seed-space-exterior" },
      { work_id: "seed-work-lighting-transformer", space_id: "seed-space-exterior" },
      { work_id: "seed-work-elm-drain", space_id: "seed-space-elm-kitchen" },
    ],
  ],
  [
    "notes",
    [
      { id: "seed-note-breaker", property_id: MAPLE, body: "Breaker 14 is the garage." },
      {
        id: "seed-note-pipewise",
        entity_type: "vendor",
        entity_id: "seed-vendor-pipewise",
        body: "Ask for Dana. A text gets a faster answer than a call.",
      },
      {
        id: "seed-note-lighting",
        property_id: MAPLE,
        entity_type: "project",
        entity_id: "seed-project-outdoor-lighting",
        body: "The HOA allows warm white fixtures only, 2700K.",
      },
      // Changing an Item's status writes a dated Note.
      {
        id: "seed-note-desk",
        property_id: MAPLE,
        entity_type: "item",
        entity_id: "seed-item-desk",
        body: "2026-09-20: listed on Craigslist for $250.",
      },
      {
        id: "seed-note-exercise-bike",
        property_id: MAPLE,
        entity_type: "item",
        entity_id: "seed-item-exercise-bike",
        body: "2026-03-14: sold to a neighbor for $300.",
      },
      {
        id: "seed-note-ebike",
        property_id: MAPLE,
        entity_type: "item",
        entity_id: "seed-item-ebike",
        body: "2025-09-02: stolen from the garage. The insurer has the claim and has not paid.",
      },
    ],
  ],
  [
    "documents",
    [
      // No file sits behind any of these in R2. The rows are here for what the tools read:
      // which records have a Receipt or a photo, and the text a search looks through.
      {
        id: "seed-doc-faucet-receipt",
        property_id: MAPLE,
        status: "filed",
        kind: "receipt",
        title: "Pipewise invoice 1187",
        doc_date: "2023-06-12",
        total_cents: 28500,
        vendor_id: "seed-vendor-pipewise",
        r2_key: "seed/faucet-receipt.pdf",
        mime_type: "application/pdf",
        sha256: "seed-sha256-faucet-receipt",
        text: "Pipewise Plumbing. Invoice 1187. Replaced kitchen faucet cartridge and two braided supply lines. Total $285.00.",
      },
      // The date on this one cannot be read, which is why its Work is dated only to the year.
      {
        id: "seed-doc-water-heater-receipt",
        property_id: MAPLE,
        status: "filed",
        kind: "receipt",
        title: "Water heater invoice",
        total_cents: 185000,
        vendor_id: "seed-vendor-pipewise",
        r2_key: "seed/water-heater-receipt.jpg",
        mime_type: "image/jpeg",
        sha256: "seed-sha256-water-heater-receipt",
        text: "Pipewise Plumbing. 50 gallon gas water heater, installed, with permit and haul away. Total $1,850.00.",
      },
      {
        id: "seed-doc-thermostat-receipt",
        property_id: MAPLE,
        status: "filed",
        kind: "receipt",
        title: "Thermostat order confirmation",
        doc_date: "2024-03-05",
        total_cents: 24900,
        r2_key: "seed/thermostat-receipt.pdf",
        mime_type: "application/pdf",
        sha256: "seed-sha256-thermostat-receipt",
        text: "Order confirmed. 1 x smart thermostat with room sensor. Total $249.00.",
      },
      {
        id: "seed-doc-transformer-receipt",
        property_id: MAPLE,
        status: "filed",
        kind: "receipt",
        title: "Brightside invoice 3320",
        doc_date: "2026-06-20",
        total_cents: 38000,
        vendor_id: "seed-vendor-brightside",
        r2_key: "seed/transformer-receipt.pdf",
        mime_type: "application/pdf",
        sha256: "seed-sha256-transformer-receipt",
        text: "Brightside Electric. Invoice 3320. 300 watt low-voltage transformer and one weatherproof outlet, installed. Total $380.00.",
      },
      {
        id: "seed-doc-fridge-receipt",
        property_id: MAPLE,
        status: "filed",
        kind: "receipt",
        title: "Appliance Barn receipt",
        doc_date: "2022-06-03",
        total_cents: 219900,
        vendor_id: "seed-vendor-appliance-barn",
        r2_key: "seed/fridge-receipt.pdf",
        mime_type: "application/pdf",
        sha256: "seed-sha256-fridge-receipt",
        text: "Appliance Barn. Samsung RF28R7351SR french door refrigerator. Delivered and installed. Total $2,199.00.",
      },
      {
        id: "seed-doc-fridge-photo",
        property_id: MAPLE,
        status: "filed",
        kind: "photo",
        title: "Fridge rating plate",
        r2_key: "seed/fridge-photo.jpg",
        mime_type: "image/jpeg",
        sha256: "seed-sha256-fridge-photo",
      },
      // "Descaling" is in this text and nowhere else in the set.
      {
        id: "seed-doc-fridge-manual",
        property_id: MAPLE,
        status: "filed",
        kind: "manual",
        title: "Fridge user manual",
        r2_key: "seed/fridge-manual.pdf",
        mime_type: "application/pdf",
        sha256: "seed-sha256-fridge-manual",
        text: "After changing the water filter, hold the Crushed Ice button for three seconds to reset the indicator. Descaling is not needed.",
      },
      {
        id: "seed-doc-filter-receipt",
        property_id: MAPLE,
        status: "filed",
        kind: "receipt",
        title: "Filter Depot order confirmation",
        doc_date: "2026-06-16",
        total_cents: 4999,
        vendor_id: "seed-vendor-filter-depot",
        r2_key: "seed/filter-receipt.pdf",
        mime_type: "application/pdf",
        sha256: "seed-sha256-filter-receipt",
        text: "Filter Depot. Order 20418. 1 x DA97-17376B refrigerator water filter. Total $49.99.",
      },
      {
        id: "seed-doc-treadmill-receipt",
        property_id: MAPLE,
        status: "filed",
        kind: "receipt",
        title: "Stride Supply receipt",
        doc_date: "2024-01-20",
        total_cents: 189900,
        vendor_id: "seed-vendor-stride",
        r2_key: "seed/treadmill-receipt.pdf",
        mime_type: "application/pdf",
        sha256: "seed-sha256-treadmill-receipt",
        text: "Stride Supply. NordicTrack Commercial 1750 treadmill. Total $1,899.00.",
      },
      {
        id: "seed-doc-treadmill-photo",
        property_id: MAPLE,
        status: "filed",
        kind: "photo",
        title: "Treadmill in the garage",
        r2_key: "seed/treadmill-photo.jpg",
        mime_type: "image/jpeg",
        sha256: "seed-sha256-treadmill-photo",
      },
      // The paper each Quote came on is a Document attached to the Project.
      {
        id: "seed-doc-brightside-quote",
        property_id: MAPLE,
        status: "filed",
        kind: "quote",
        title: "Brightside quote for outdoor lighting",
        doc_date: "2026-04-18",
        total_cents: 420000,
        vendor_id: "seed-vendor-brightside",
        r2_key: "seed/brightside-quote.pdf",
        mime_type: "application/pdf",
        sha256: "seed-sha256-brightside-quote",
        text: "Brightside Electric. Quote for 12 brass path lights, one transformer, trenching, and a two-year warranty. $4,200.00.",
      },
      {
        id: "seed-doc-glow-quote",
        property_id: MAPLE,
        status: "filed",
        kind: "quote",
        title: "Glow quote for outdoor lighting",
        doc_date: "2026-05-02",
        total_cents: 365000,
        vendor_id: "seed-vendor-glow",
        r2_key: "seed/glow-quote.pdf",
        mime_type: "application/pdf",
        sha256: "seed-sha256-glow-quote",
        text: "Glow Landscape Lighting. Quote for 10 aluminum path lights and one transformer. $3,650.00.",
      },
    ],
  ],
  [
    "document_links",
    [
      {
        document_id: "seed-doc-faucet-receipt",
        entity_type: "work",
        entity_id: "seed-work-faucet",
      },
      {
        document_id: "seed-doc-water-heater-receipt",
        entity_type: "work",
        entity_id: "seed-work-water-heater",
      },
      {
        document_id: "seed-doc-thermostat-receipt",
        entity_type: "work",
        entity_id: "seed-work-thermostat",
      },
      {
        document_id: "seed-doc-transformer-receipt",
        entity_type: "work",
        entity_id: "seed-work-lighting-transformer",
      },
      {
        document_id: "seed-doc-fridge-receipt",
        entity_type: "item",
        entity_id: "seed-item-fridge",
      },
      { document_id: "seed-doc-fridge-photo", entity_type: "item", entity_id: "seed-item-fridge" },
      { document_id: "seed-doc-fridge-manual", entity_type: "item", entity_id: "seed-item-fridge" },
      // One Receipt, attached to the Work it paid for and to the Item the Part went into.
      {
        document_id: "seed-doc-filter-receipt",
        entity_type: "work",
        entity_id: "seed-work-filter-2026",
      },
      {
        document_id: "seed-doc-filter-receipt",
        entity_type: "item",
        entity_id: "seed-item-fridge",
      },
      {
        document_id: "seed-doc-treadmill-receipt",
        entity_type: "item",
        entity_id: "seed-item-treadmill",
      },
      {
        document_id: "seed-doc-treadmill-photo",
        entity_type: "item",
        entity_id: "seed-item-treadmill",
      },
      {
        document_id: "seed-doc-brightside-quote",
        entity_type: "project",
        entity_id: "seed-project-outdoor-lighting",
      },
      {
        document_id: "seed-doc-glow-quote",
        entity_type: "project",
        entity_id: "seed-project-outdoor-lighting",
      },
    ],
  ],
];

// The column that marks a row as part of the set. A link table has no id of its own, so it
// goes by the record it hangs off.
const MARKED_BY: Readonly<Record<string, string>> = {
  item_categories: "item_id",
  project_spaces: "project_id",
  work_items: "work_id",
  work_spaces: "work_id",
  document_links: "document_id",
};

// What a value is bound as. An object goes in as JSON text.
const stored = (value: Value) =>
  typeof value === "object" && value !== null ? JSON.stringify(value) : value;

// Takes the set's rows out of one table: the rows whose id starts with `seed-`. That reaches a
// copy loaded from an earlier version of this file too. Categories are the exception, because
// a Category's id is a name the User picks, and one of theirs could start the same way. Those
// go by the ids listed here and no others.
const clear = (table: string, rows: ReadonlyArray<Row>): Statement =>
  table === "categories"
    ? {
        sql: `DELETE FROM categories WHERE id IN (${rows.map(() => "?").join(", ")})`,
        params: rows.map((row) => stored(row.id)),
      }
    : { sql: `DELETE FROM ${table} WHERE ${MARKED_BY[table] ?? "id"} GLOB 'seed-*'`, params: [] };

const insert = (table: string, row: Row): Statement => {
  const columns = Object.keys(row);
  return {
    sql: `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    params: Object.values(row).map(stored),
  };
};

/**
 * The statements that take the made-up household out: one DELETE for each table, last table
 * first, so that a row goes before the one it points at. Each removes only rows the set put
 * there, which is what makes the number of rows it reports exact.
 */
export const removeStatements: ReadonlyArray<Statement> = RECORDS.map(([table, rows]) =>
  clear(table, rows),
).reverse();

/**
 * The statements that put the made-up household in. They open with `removeStatements`, so
 * loading twice leaves one copy, and a set that has changed since it was last loaded replaces
 * the old one. The INSERTs follow.
 */
export const loadStatements: ReadonlyArray<Statement> = [
  ...removeStatements,
  ...RECORDS.flatMap(([table, rows]) => rows.map((row) => insert(table, row))),
];
