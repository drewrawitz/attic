import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { search } from "../../src/tools/search.ts";
import { answer, call } from "../call.ts";
import { loadHousehold } from "../household.ts";
import { TestDatabase } from "../TestDatabase.ts";

// What `search` sends back: the records it found, and a note when there were more. A refusal
// is its text.
interface Found {
  readonly results: ReadonlyArray<Record<string, unknown>>;
  readonly note: string;
}

const searching = (input: unknown) =>
  call(search, input).pipe(Effect.map((sent) => answer<Found>(sent)));

// The fridge's `data`, as a curated tool shows it.
const FRIDGE_DATA = {
  brand: "Samsung",
  model: "RF28R7351SR",
  serial: "SEED-FRIDGE-0001",
  warranty_until: "2027-06",
  parts: { "water-filter": { name: "Water filter", part_number: "DA97-17376B" } },
};

// "Samsung" is the fridge's brand and is on its Receipt. "Kitchen" is the Space it is in. The
// microwave is in the Kitchen too, and it is a Panasonic.
it.effect("words that are in different places of one record find it", () =>
  Effect.gen(function* () {
    yield* loadHousehold;

    expect(yield* searching({ words: "samsung kitchen" })).toEqual({
      results: [
        {
          type: "item",
          id: "seed-item-fridge",
          name: "Fridge",
          property: "Maple Street house",
          status: "active",
          matched: {
            data: FRIDGE_DATA,
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
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("one word that is nowhere in a record means the record is not found", () =>
  Effect.gen(function* () {
    yield* loadHousehold;

    expect(yield* searching({ words: "samsung kitchen zamboni" })).toEqual({ results: [] });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect(
  "a word that is only in data, such as a model number or a paint color, finds its record",
  () =>
    Effect.gen(function* () {
      yield* loadHousehold;

      expect(yield* searching({ words: "nn-sn686s" })).toEqual({
        results: [
          {
            type: "item",
            id: "seed-item-microwave",
            name: "Microwave",
            property: "Maple Street house",
            status: "active",
            matched: {
              data: { brand: "Panasonic", model: "NN-SN686S", serial: "SEED-MICROWAVE-0001" },
            },
          },
        ],
      });

      expect(yield* searching({ words: "agreeable gray" })).toEqual({
        results: [
          {
            type: "space",
            id: "seed-space-living-room",
            name: "Living room",
            property: "Maple Street house",
            matched: {
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
          },
        ],
      });
    }).pipe(Effect.provide(TestDatabase)),
);

// "Descaling" is in the text of the fridge's manual and nowhere else.
const MANUAL_TEXT =
  "After changing the water filter, hold the Crushed Ice button for three seconds to reset the indicator. Descaling is not needed.";

it.effect(
  "a word that is only in a Document's text finds the Document and the records it is attached to",
  () =>
    Effect.gen(function* () {
      yield* loadHousehold;

      expect(yield* searching({ words: "descaling" })).toEqual({
        results: [
          {
            type: "item",
            id: "seed-item-fridge",
            name: "Fridge",
            property: "Maple Street house",
            status: "active",
            matched: {
              documents: [
                { id: "seed-doc-fridge-manual", title: "Fridge user manual", text: MANUAL_TEXT },
              ],
            },
          },
          {
            type: "document",
            id: "seed-doc-fridge-manual",
            title: "Fridge user manual",
            property: "Maple Street house",
            attached_to: [{ type: "item", id: "seed-item-fridge", name: "Fridge" }],
            matched: { text: MANUAL_TEXT },
          },
        ],
      });
    }).pipe(Effect.provide(TestDatabase)),
);

// The name is already in the result, so there is nothing more to say about why it was found.
it.effect("a record found by its own name comes back with no more than what it is", () =>
  Effect.gen(function* () {
    yield* loadHousehold;

    expect(yield* searching({ words: "couch" })).toEqual({
      results: [
        {
          type: "item",
          id: "seed-item-couch",
          name: "Sectional couch",
          property: "Maple Street house",
          status: "active",
        },
      ],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// "What fitness products do I own?" The treadmill is filed under Cardio, a child of Fitness.
// The watch is electronics first and fitness as an extra Category. The exercise bike is under
// Cardio too, and it was sold.
it.effect("an Item is found by the name of a Category above its own", () =>
  Effect.gen(function* () {
    yield* loadHousehold;

    const fitness = (id: string, name: string) => ({
      type: "item",
      id,
      name,
      property: "Maple Street house",
      status: "active",
      matched: { categories: ["Fitness"] },
    });
    expect(yield* searching({ words: "fitness" })).toEqual({
      results: [
        fitness("seed-item-dumbbells", "Adjustable dumbbells"),
        fitness("seed-item-watch", "Running watch"),
        fitness("seed-item-treadmill", "Treadmill"),
      ],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("Gone Items are left out, and come back when they are asked for", () =>
  Effect.gen(function* () {
    yield* loadHousehold;

    // The two bikes are left out. The Notes on them are Notes, and are still found.
    const notes = ["note seed-note-ebike", "note seed-note-exercise-bike"];
    expect(yield* found({ words: "bike" })).toEqual(notes);
    expect(yield* found({ words: "bike", include_gone: false })).toEqual(notes);

    expect(yield* searching({ words: "bike", types: ["item"], include_gone: true })).toEqual({
      results: [
        {
          type: "item",
          id: "seed-item-ebike",
          name: "Electric bike",
          property: "Maple Street house",
          status: "stolen",
          matched: {
            data: {
              brand: "Trek",
              model: "Verve+ 2",
              serial: "SEED-EBIKE-0001",
              claim_number: "SEED-CLAIM-1042",
            },
          },
        },
        {
          type: "item",
          id: "seed-item-exercise-bike",
          name: "Exercise bike",
          property: "Maple Street house",
          status: "sold",
        },
      ],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// "Who did we use for plumbing last time?" Work comes latest first, with its date, and each
// piece says which Vendor did it. Old Town Plumbing was the plumber at the former Property.
it.effect("a search for plumbing finds the Work plumbers did, latest first, and the plumbers", () =>
  Effect.gen(function* () {
    yield* loadHousehold;

    const faucetReceipt =
      "Pipewise Plumbing. Invoice 1187. Replaced kitchen faucet cartridge and two braided supply lines. Total $285.00.";
    const heaterReceipt =
      "Pipewise Plumbing. 50 gallon gas water heater, installed, with permit and haul away. Total $1,850.00.";
    expect(yield* searching({ words: "plumbing" })).toEqual({
      results: [
        {
          type: "work",
          id: "seed-work-faucet",
          title: "Replaced the kitchen faucet cartridge",
          property: "Maple Street house",
          date: "2023-06-12",
          matched: {
            vendors: ["Pipewise Plumbing (plumber)"],
            documents: [
              {
                id: "seed-doc-faucet-receipt",
                title: "Pipewise invoice 1187",
                text: faucetReceipt,
              },
            ],
          },
        },
        {
          type: "work",
          id: "seed-work-water-heater",
          title: "Replaced the water heater",
          property: "Maple Street house",
          date: "2023",
          matched: {
            vendors: ["Pipewise Plumbing (plumber)"],
            documents: [
              {
                id: "seed-doc-water-heater-receipt",
                title: "Water heater invoice",
                text: heaterReceipt,
              },
            ],
          },
        },
        {
          type: "work",
          id: "seed-work-elm-drain",
          title: "Cleared the kitchen drain",
          property: "Elm Court apartment",
          date: "2021-03-02",
          matched: { vendors: ["Old Town Plumbing (plumber)"] },
        },
        { type: "vendor", id: "seed-vendor-old-town", name: "Old Town Plumbing", property: null },
        { type: "vendor", id: "seed-vendor-pipewise", name: "Pipewise Plumbing", property: null },
        // The Note on Pipewise, found by the name of the Vendor it is attached to.
        {
          type: "note",
          id: "seed-note-pipewise",
          body: "Ask for Dana. A text gets a faster answer than a call.",
          property: null,
          attached_to: [{ type: "vendor", id: "seed-vendor-pipewise", name: "Pipewise Plumbing" }],
        },
        {
          type: "document",
          id: "seed-doc-faucet-receipt",
          title: "Pipewise invoice 1187",
          property: "Maple Street house",
          attached_to: [
            { type: "work", id: "seed-work-faucet", name: "Replaced the kitchen faucet cartridge" },
          ],
          matched: { text: faucetReceipt, vendors: ["Pipewise Plumbing (plumber)"] },
        },
        {
          type: "document",
          id: "seed-doc-water-heater-receipt",
          title: "Water heater invoice",
          property: "Maple Street house",
          attached_to: [
            { type: "work", id: "seed-work-water-heater", name: "Replaced the water heater" },
          ],
          matched: { text: heaterReceipt, vendors: ["Pipewise Plumbing (plumber)"] },
        },
      ],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// A Project's Vendors are the ones on its Quotes.
it.effect("a Project is found by a Vendor that quoted it, and a Note by what it says", () =>
  Effect.gen(function* () {
    yield* loadHousehold;

    const quote =
      "Glow Landscape Lighting. Quote for 10 aluminum path lights and one transformer. $3,650.00.";
    expect(yield* searching({ words: "glow" })).toEqual({
      results: [
        {
          type: "project",
          id: "seed-project-outdoor-lighting",
          title: "Outdoor lighting",
          property: "Maple Street house",
          matched: {
            vendors: ["Glow Landscape Lighting (landscape lighting)"],
            documents: [
              { id: "seed-doc-glow-quote", title: "Glow quote for outdoor lighting", text: quote },
            ],
          },
        },
        {
          type: "vendor",
          id: "seed-vendor-glow",
          name: "Glow Landscape Lighting",
          property: null,
          matched: { data: { email: "glow@example.com" } },
        },
        {
          type: "document",
          id: "seed-doc-glow-quote",
          title: "Glow quote for outdoor lighting",
          property: "Maple Street house",
          attached_to: [
            { type: "project", id: "seed-project-outdoor-lighting", name: "Outdoor lighting" },
          ],
          matched: { text: quote, vendors: ["Glow Landscape Lighting (landscape lighting)"] },
        },
      ],
    });

    expect(yield* searching({ words: "breaker" })).toEqual({
      results: [
        {
          type: "note",
          id: "seed-note-breaker",
          body: "Breaker 14 is the garage.",
          property: "Maple Street house",
        },
      ],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// What a search for plumbing finds, as type and id. The whole of it is in the test above.
const PLUMBING = [
  "work seed-work-faucet",
  "work seed-work-water-heater",
  "work seed-work-elm-drain",
  "vendor seed-vendor-old-town",
  "vendor seed-vendor-pipewise",
  "note seed-note-pipewise",
  "document seed-doc-faucet-receipt",
  "document seed-doc-water-heater-receipt",
];

const found = (input: unknown) =>
  searching(input).pipe(
    Effect.map(({ results }) => results?.map(({ type, id }) => `${String(type)} ${String(id)}`)),
  );

it.effect(
  "the record type filter keeps only the types it names, in the order search has them",
  () =>
    Effect.gen(function* () {
      yield* loadHousehold;

      expect(yield* found({ words: "plumbing", types: ["vendor"] })).toEqual([
        "vendor seed-vendor-old-town",
        "vendor seed-vendor-pipewise",
      ]);
      // A type named twice, or out of order, changes nothing.
      expect(yield* found({ words: "plumbing", types: ["document", "vendor", "vendor"] })).toEqual([
        "vendor seed-vendor-old-town",
        "vendor seed-vendor-pipewise",
        "document seed-doc-faucet-receipt",
        "document seed-doc-water-heater-receipt",
      ]);
      // A list that names none is the same as no list.
      expect(yield* found({ words: "plumbing", types: [] })).toEqual(PLUMBING);
    }).pipe(Effect.provide(TestDatabase)),
);

// "Who did we use last time" may be at a former Property, so search looks everywhere unless it
// is told where. It is the one tool that leaves the rule that no Property means the current one.
it.effect("no Property means every Property, and a Property keeps only what is at it", () =>
  Effect.gen(function* () {
    yield* loadHousehold;

    // Work at both Properties.
    expect(yield* found({ words: "plumbing" })).toEqual(PLUMBING);

    const elm = [
      "item seed-item-elm-dishwasher",
      "work seed-work-elm-drain",
      "space seed-space-elm-kitchen",
    ];
    expect(yield* found({ words: "kitchen", property: "seed-property-elm" })).toEqual(elm);
    // By name, whatever its case.
    expect(yield* found({ words: "kitchen", property: "elm court APARTMENT" })).toEqual(elm);

    // A Vendor has no Property, so it is at none of them.
    expect(yield* found({ words: "plumbing", property: "Maple Street house" })).toEqual([
      "work seed-work-faucet",
      "work seed-work-water-heater",
      "document seed-doc-faucet-receipt",
      "document seed-doc-water-heater-receipt",
    ]);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a Property that does not exist is an error that lists the ones that do", () =>
  Effect.gen(function* () {
    yield* loadHousehold;

    expect(yield* searching({ words: "kitchen", property: "Oak Lane" })).toEqual({
      refused:
        'There is no Property "Oak Lane". The Properties are: Elm Court apartment, Maple Street house.',
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// LIKE reads % as any run of characters and _ as any one, and search escapes them with a
// backslash, so that has to be escaped too.
it.effect("a %, a _, or a backslash in a word matches only itself", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO notes (id, body) VALUES
        ('note-percent', 'Keep the basement under 50% humidity.'),
        ('note-500', 'The sump pump cost 500 dollars.'),
        ('note-underscore', 'The furnace filter is a 16_25_1.'),
        ('note-x', 'The return vent filter is a 16x25x1.'),
        ('note-backslash', 'The manuals are scanned to C:\\manuals on the old laptop.'),
        ('note-plain', 'The paper manuals are in the hall closet.')`;

    expect(yield* found({ words: "50%" })).toEqual(["note note-percent"]);
    expect(yield* found({ words: "16_25" })).toEqual(["note note-underscore"]);
    expect(yield* found({ words: "c:\\manuals" })).toEqual(["note note-backslash"]);
    // Without them a word is still found anywhere in a text, whatever its case.
    expect(yield* found({ words: "MANUAL" })).toEqual(["note note-backslash", "note note-plain"]);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("at most 50 records come back, with a note only when there were more", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* loadHousehold;
    // The fridge is found in three places, and it still counts once.
    yield* sql`
      WITH RECURSIVE counting (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM counting WHERE n < 50)
      INSERT INTO notes (id, body)
      SELECT printf('note-%02d', n), printf('Samsung fridge filter change %02d', n) FROM counting`;

    const over = yield* searching({ words: "samsung" });
    expect(over.results).toHaveLength(50);
    expect(over.results!.at(0)).toMatchObject({ type: "item", id: "seed-item-fridge" });
    expect(over.results!.at(-1)).toMatchObject({ type: "note", id: "note-49" });
    expect(over.note).toContain("first 50");

    yield* sql`DELETE FROM notes WHERE id = 'note-50'`;
    const exactly = yield* searching({ words: "samsung", types: ["item", "note"] });
    expect(exactly.results).toHaveLength(50);
    expect(exactly).not.toHaveProperty("note");
  }).pipe(Effect.provide(TestDatabase)),
);

// A manual's text can run to many pages. Only the part around the word leaves the database.
it.effect("a long text is cut to the part around the first word found in it", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const document = (id: string, text: string) => sql`
      INSERT INTO documents (id, title, r2_key, mime_type, sha256, text)
      VALUES (${id}, ${id}, ${id}, 'application/pdf', ${id}, ${text})`;
    const middle = `${"a ".repeat(500)}The DSC-9 cartridge fits this model. ${"z ".repeat(500)}`;
    const opening = `DSC-9 cartridges are sold in pairs. ${"z ".repeat(500)}`;
    yield* document("doc-middle", middle);
    yield* document("doc-opening", opening);

    const { results } = yield* searching({ words: "dsc-9" });
    const excerpts = Object.fromEntries(
      results!.map(({ id, matched }) => [id, (matched as { text: string }).text]),
    );

    expect(excerpts["doc-middle"]).toMatch(/^…[a ]+The DSC-9 cartridge fits this model\. [z ]+…$/);
    expect(excerpts["doc-middle"]).toHaveLength(302);
    // Nothing was cut from the front of this one, so nothing says it was.
    expect(excerpts["doc-opening"]).toBe(`${opening.slice(0, 300)}…`);
  }).pipe(Effect.provide(TestDatabase)),
);

// `data` is JSON, and a piece of it would not be.
it.effect("data is never cut, however long it is", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const notes = `${"Call before noon. ".repeat(30)}Ask about the shingle warranty.`;
    yield* sql`
      INSERT INTO vendors (id, name, data)
      VALUES ('vendor-roofer', 'Ridgeline Roofing', ${JSON.stringify({ notes })})`;

    expect(yield* searching({ words: "shingle" })).toEqual({
      results: [
        {
          type: "vendor",
          id: "vendor-roofer",
          name: "Ridgeline Roofing",
          property: null,
          matched: { data: { notes } },
        },
      ],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a word given twice, in whatever case, is one word", () =>
  Effect.gen(function* () {
    yield* loadHousehold;

    expect(yield* found({ words: "Samsung  KITCHEN samsung" })).toEqual(["item seed-item-fridge"]);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a search with no word in it is refused", () =>
  Effect.gen(function* () {
    yield* loadHousehold;

    const { refused } = yield* searching({ words: "  \n " });
    expect(refused).toContain("at least one word");
  }).pipe(Effect.provide(TestDatabase)),
);

// D1 turns down a LIKE pattern of more than 50 bytes, which is the word and a % at each end.
// Node SQLite takes far longer ones, so only search itself can say no here. The test in
// test/search.test.ts at the root checks that D1 takes the longest word this lets through.
it.effect("a word too long for D1 to match is refused, and says which word", () =>
  Effect.gen(function* () {
    yield* loadHousehold;

    expect(yield* searching({ words: `fridge ${"a".repeat(48)}` })).toEqual({ results: [] });

    const { refused } = yield* searching({ words: `fridge ${"a".repeat(49)}` });
    expect(refused).toContain(`"${"a".repeat(49)}"`);
    expect(refused).toContain("48 bytes");

    // A letter outside ASCII is more than one byte, and an escaped character is two.
    expect((yield* searching({ words: "é".repeat(24) })).results).toEqual([]);
    expect((yield* searching({ words: "é".repeat(25) })).refused).toContain("48 bytes");
    expect((yield* searching({ words: `${"a".repeat(46)}%` })).results).toEqual([]);
    expect((yield* searching({ words: `${"a".repeat(47)}%` })).refused).toContain("48 bytes");
  }).pipe(Effect.provide(TestDatabase)),
);

// The desk is listed for 25000 cents. A curated tool shows money in dollars.
it.effect("money inside data comes back in dollars", () =>
  Effect.gen(function* () {
    yield* loadHousehold;

    expect(yield* searching({ words: "craigslist" })).toEqual({
      results: [
        {
          type: "item",
          id: "seed-item-desk",
          name: "Standing desk",
          property: "Maple Street house",
          status: "listed",
          matched: {
            data: {
              listing: {
                where: "Craigslist",
                asking: 250,
                url: "https://example.com/listings/standing-desk",
              },
            },
          },
        },
        {
          type: "note",
          id: "seed-note-desk",
          body: "2026-09-20: listed on Craigslist for $250.",
          property: "Maple Street house",
          attached_to: [{ type: "item", id: "seed-item-desk", name: "Standing desk" }],
        },
      ],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// `data` is JSON, which writes a quote or a backslash inside a value with a backslash before
// it, and ends every value with a quote of its own.
it.effect("a quote or a backslash in a word is found inside data, and only where it is", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const screens = JSON.stringify({ sells: 'monitors, 27" and up', drivers: "C:\\drivers" });
    const frames = JSON.stringify({ sells: "frames up to 127" });
    yield* sql`
      INSERT INTO vendors (id, name, data)
      VALUES ('vendor-screens', 'Screen Shed', ${screens}), ('vendor-frames', 'Frame Shed', ${frames})`;

    expect(yield* found({ words: '27"' })).toEqual(["vendor vendor-screens"]);
    expect(yield* found({ words: "c:\\drivers" })).toEqual(["vendor vendor-screens"]);
  }).pipe(Effect.provide(TestDatabase)),
);

// A Note has no name, so a result shows its body, and a long body is cut like any other text.
it.effect("a long Note comes back cut, and still shows the part a word was found in", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const body = `${"The sump pit is checked monthly. ".repeat(40)}The radon fan is on breaker 22. ${"z ".repeat(300)}`;
    yield* sql`INSERT INTO notes (id, body) VALUES ('note-long', ${body})`;
    const opening = `${body.slice(0, 300)}…`;

    // The word is at the start, which the result already shows.
    expect(yield* searching({ words: "sump" })).toEqual({
      results: [{ type: "note", id: "note-long", body: opening, property: null }],
    });

    const { results } = yield* searching({ words: "radon" });
    expect(results).toEqual([
      {
        type: "note",
        id: "note-long",
        body: opening,
        property: null,
        matched: { body: expect.stringMatching(/^….+ The radon fan is on breaker 22\. [z ]+…$/) },
      },
    ]);
  }).pipe(Effect.provide(TestDatabase)),
);

// A plumber need not have "plumbing" in its name. Its role says what it is either way, so the
// Work it did is found by the role, and that Work is what has a date.
it.effect("a record is found by the role of its Vendor as well as by the name", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* loadHousehold;

    expect(yield* found({ words: "plumber", types: ["work"] })).toEqual([
      "work seed-work-faucet",
      "work seed-work-water-heater",
      "work seed-work-elm-drain",
    ]);
    expect(yield* searching({ words: "hvac", types: ["work"] })).toEqual({
      results: [
        {
          type: "work",
          id: "seed-work-furnace",
          title: "Annual furnace service",
          property: "Maple Street house",
          date: "2025-09-08",
          matched: { vendors: ["Hearth Heating and Air (hvac)"] },
        },
      ],
    });

    // A Vendor with no role is shown by its name alone, and Work with no date has none.
    yield* sql`INSERT INTO vendors (id, name) VALUES ('vendor-gutters', 'Gutter Guys')`;
    yield* sql`
      INSERT INTO work (id, property_id, kind, title, vendor_id)
      VALUES ('work-gutters', 'seed-property-maple', 'maintenance', 'Cleaned out the downspouts', 'vendor-gutters')`;
    expect(yield* searching({ words: "gutter guys", types: ["work"] })).toEqual({
      results: [
        {
          type: "work",
          id: "work-gutters",
          title: "Cleaned out the downspouts",
          property: "Maple Street house",
          matched: { vendors: ["Gutter Guys"] },
        },
      ],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// The Note on Pipewise says to ask for Dana. Neither record has both words.
it.effect(
  "a Note is found by the name of what it is attached to, and always says what that is",
  () =>
    Effect.gen(function* () {
      yield* loadHousehold;

      const note = {
        type: "note",
        id: "seed-note-pipewise",
        body: "Ask for Dana. A text gets a faster answer than a call.",
        property: null,
        attached_to: [{ type: "vendor", id: "seed-vendor-pipewise", name: "Pipewise Plumbing" }],
      };
      expect(yield* searching({ words: "pipewise dana" })).toEqual({ results: [note] });
      expect(yield* searching({ words: "dana" })).toEqual({ results: [note] });
    }).pipe(Effect.provide(TestDatabase)),
);

it.effect(
  "a Document is found by the name of what it is attached to, and says every record that is",
  () =>
    Effect.gen(function* () {
      yield* loadHousehold;

      // "Updated" is in the title of the Work this Receipt is attached to, and not in the Receipt.
      expect(yield* found({ words: "updated confirmation", types: ["document"] })).toEqual([
        "document seed-doc-thermostat-receipt",
      ]);

      // One Receipt, attached to the Work it paid for and to the Item the Part went into.
      expect(yield* searching({ words: "20418", types: ["document"] })).toEqual({
        results: [
          {
            type: "document",
            id: "seed-doc-filter-receipt",
            title: "Filter Depot order confirmation",
            property: "Maple Street house",
            attached_to: [
              { type: "item", id: "seed-item-fridge", name: "Fridge" },
              {
                type: "work",
                id: "seed-work-filter-2026",
                name: "Replaced the fridge water filter",
              },
            ],
            matched: {
              text: "Filter Depot. Order 20418. 1 x DA97-17376B refrigerator water filter. Total $49.99.",
            },
          },
        ],
      });
    }).pipe(Effect.provide(TestDatabase)),
);
