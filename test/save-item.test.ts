import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { onDatabase } from "./support/database.ts";
import { deployWith, eventually, test } from "./support/harness.ts";
import {
  answerFrom,
  asClientWith,
  householdClient,
  ULID,
  type Call,
  type Fields,
  type Listed,
} from "./support/household.ts";
import { mcp } from "./support/mcp-client.ts";

// What `save_item` does is tested on Node SQLite, in packages/core. In the Worker a list of
// 50 is one D1 batch of more than sixty statements (ADR 0006), an Item's extra Categories are
// read into its Change by a statement inside that batch, and `query` only runs on D1. So
// these go through the real Worker on local D1, with the made-up household loaded. Its Maple
// Street house is the one Current property.

// What these tests save. Nothing else in the database has these names.
const CRATE = "Attic crate";
const STOREROOM = "Crate storeroom";
const CARRIER = "Crate and Carry";
const CRATES = `SELECT id FROM items WHERE name GLOB '${CRATE}*'`;

// Takes out what these tests wrote. No tool deletes a record yet, and the database is kept
// between runs, so each test starts and ends with this. An Item's extra Categories go with it.
const cleanUp = onDatabase(
  `DELETE FROM changes WHERE id IN (
     SELECT change_id FROM change_records
      WHERE (entity_type = 'item' AND entity_id IN (${CRATES}))
         OR (entity_type = 'space'
             AND entity_id IN (SELECT id FROM spaces WHERE name = '${STOREROOM}'))
         OR (entity_type = 'vendor'
             AND entity_id IN (SELECT id FROM vendors WHERE name = '${CARRIER}')))`,
  `DELETE FROM notes WHERE entity_type = 'item' AND entity_id IN (${CRATES})`,
  `DELETE FROM items WHERE name GLOB '${CRATE}*'`,
  `DELETE FROM spaces WHERE name = '${STOREROOM}'`,
  `DELETE FROM vendors WHERE name = '${CARRIER}'`,
);

// A test body that calls tools as a signed-in client, on a database with none of the above.
const asClient = asClientWith(cleanUp);

test(
  "a signed-in client is told what save_item takes, for one Item and for a list",
  Effect.gen(function* () {
    const { url, token } = yield* householdClient;
    const { message } = yield* Effect.promise(() => mcp(url, { method: "tools/list" }, token));
    const { result } = message as {
      result: { tools: { name: string; description: string }[] };
    };
    const tool = result.tools.find(({ name }) => name === "save_item");

    // A field says what it is for beside its type, and an optional one takes null or nothing.
    const optional = (field: Fields) => ({
      anyOf: [{ ...field, description: expect.any(String) }, { type: "null" }],
    });
    const text = optional({ type: "string" });
    // An amount is in dollars, and is never below zero.
    const amount = optional({ type: "number", minimum: 0 });
    const fields = {
      id: text,
      name: text,
      property: text,
      space: text,
      scope: optional({ type: "string", enum: ["fixture", "belonging"] }),
      category: text,
      extra_categories: optional({ type: "array", items: { type: "string" } }),
      acquired_on: text,
      price: amount,
      bought_from: text,
      status: optional({
        type: "string",
        enum: ["active", "listed", "sold", "given", "lost", "stolen", "destroyed"],
      }),
      status_on: text,
      proceeds: amount,
      data: optional({ type: "object" }),
      note: text,
      clear: optional({
        type: "array",
        items: {
          type: "string",
          enum: [
            "property",
            "space",
            "acquired_on",
            "price",
            "bought_from",
            "status_on",
            "proceeds",
          ],
        },
      }),
    };
    expect(tool).toEqual(
      expect.objectContaining({
        inputSchema: expect.objectContaining({
          type: "object",
          properties: {
            ...fields,
            // An entry of a list has the fields of one Item, and takes no key but those.
            items: optional({
              type: "array",
              minItems: 1,
              maxItems: 50,
              items: { type: "object", properties: fields, additionalProperties: false },
            }),
          },
          additionalProperties: false,
        }),
        // MCP has a client assume a tool may destroy things unless it says otherwise.
        annotations: { readOnlyHint: false, destructiveHint: false },
      }),
    );

    // What the description has to say, because nothing else tells a client.
    for (const said of [
      "One Item is one line on an insurance claim.",
      "is one Item with `data.quantity`, priced as a whole",
      "there is no field for an appraisal or an estimate",
      "integer cents under a key ending in _cents",
      "would be stored as a second key",
      "Something that was returned or thrown away is deleted, not given a status.",
      "A lost Item that turns up goes back to active.",
      "Moving day is a list update",
    ]) {
      expect(tool?.description, said).toContain(said);
    }
  }),
);

// How many Items these tests have saved, as `query` counts them.
const crates = (call: Call) =>
  Effect.map(
    call("query", { sql: `SELECT count(*) AS crates FROM items WHERE name GLOB '${CRATE}*'` }),
    (counted) => (counted.rows as [{ crates: number }])[0].crates,
  );

test(
  "a list of 50 Items is saved in one call, as one Change on D1",
  asClient((call) =>
    Effect.gen(function* () {
      // Every entry names the same new Space and the same new Vendor, in one case or another.
      // The first is in two extra Categories, and was sold before it was written down.
      const list = Array.from({ length: 50 }, (_, at) => ({
        name: `${CRATE} ${at + 1}`,
        space: at % 2 === 0 ? STOREROOM : STOREROOM.toUpperCase(),
        bought_from: at % 2 === 0 ? CARRIER : CARRIER.toLowerCase(),
        acquired_on: "2026-08",
        price: at + 0.99,
        data: { quantity: at + 1 },
      }));
      const sold = { extra_categories: ["tools", "office"], status: "sold", proceeds: 450 };
      const saved = yield* call("save_item", {
        items: [{ ...list[0], ...sold }, ...list.slice(1)],
      });

      const created = saved.created as Listed[];
      expect(saved).toEqual({
        change_id: expect.stringMatching(ULID),
        created: expect.any(Array),
        updated: [],
      });
      // One Space and one Vendor, then the Items in the order of the list, with the Note that
      // marks the first one sold after it.
      expect(created.map(({ type }) => type)).toEqual([
        "space",
        "vendor",
        "item",
        "note",
        ...Array.from({ length: 49 }, () => "item"),
      ]);
      expect(created.slice(0, 3)).toEqual([
        { type: "space", id: expect.stringMatching(ULID), name: STOREROOM },
        { type: "vendor", id: expect.stringMatching(ULID), name: CARRIER },
        { type: "item", id: expect.stringMatching(ULID), name: `${CRATE} 1` },
      ]);
      expect(created[52]).toEqual({
        type: "item",
        id: expect.stringMatching(ULID),
        name: `${CRATE} 50`,
      });
      expect(yield* crates(call)).toBe(50);
      const [space, vendor, first, note] = created as [Listed, Listed, Listed, Listed];

      // The first of them, as get_record returns it. `status_on` is today's date on the
      // Worker's own clock, and the Note has the same date and the amount in dollars.
      const record = yield* call("get_record", { type: "item", id: first.id });
      const today = record.status_on as string;
      expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const stored = {
        id: first.id,
        property_id: "seed-property-maple",
        space_id: space.id,
        scope: "belonging",
        category_id: "other",
        name: `${CRATE} 1`,
        acquired_on: "2026-08",
        price: 0.99,
        vendor_id: vendor.id,
        status: "sold",
        status_on: today,
        proceeds: 450,
        data: { quantity: 1 },
      };
      expect(record).toMatchObject({
        type: "item",
        ...stored,
        property: "Maple Street house",
        space: STOREROOM,
        category: "Other",
        bought_from: CARRIER,
        extra_categories: [
          { id: "office", name: "Office" },
          { id: "tools", name: "Tools" },
        ],
        notes: [{ id: note.id, body: `Marked sold on ${today} for $450.00.` }],
        // On D1 the snapshot is read inside the batch, the extra Categories with it.
        changes: [
          {
            id: saved.change_id,
            tool: "save_item",
            undoes: null,
            before: null,
            after: { ...stored, extra_categories: ["office", "tools"] },
          },
        ],
      });

      // The last of them is in the same Change, and so are the Space and the Vendor.
      const made = { id: saved.change_id, tool: "save_item", before: null };
      expect(yield* call("get_record", { type: "item", id: created[52]!.id })).toMatchObject({
        name: `${CRATE} 50`,
        price: 49.99,
        space_id: space.id,
        vendor_id: vendor.id,
        extra_categories: [],
        changes: [made],
      });
      const storeroom = yield* call("get_record", { type: "space", id: space.id });
      expect(storeroom).toMatchObject({
        name: STOREROOM,
        property: "Maple Street house",
        changes: [made],
      });
      // The one that was sold is gone, so it is not in the Space.
      expect(storeroom.items).toHaveLength(49);
      expect(yield* call("get_record", { type: "vendor", id: vendor.id })).toMatchObject({
        name: CARRIER,
        changes: [made],
      });
    }),
  ),
);

test(
  "a list with one bad entry leaves nothing behind, and a list update is one Change too",
  asClient((call) =>
    Effect.gen(function* () {
      const list = Array.from({ length: 4 }, (_, at) => ({
        name: `${CRATE} ${at + 1}`,
        space: STOREROOM,
        category: "tools",
        extra_categories: ["office"],
      }));
      const refused = yield* call("save_item", {
        items: [...list, { name: `${CRATE} 5`, category: "crates" }],
      });
      expect(refused.refused).toContain(
        'Nothing was saved, because 1 of the 5 entries in `items` was refused. Entries are counted from 0.\nitems.4: There is no Category "crates".',
      );
      expect(yield* crates(call)).toBe(0);
      const spaces = yield* call("query", {
        sql: `SELECT count(*) AS spaces FROM spaces WHERE name = '${STOREROOM}'`,
      });
      expect(spaces).toEqual({ rows: [{ spaces: 0 }] });

      // A list of more than 50 is turned away before the tool runs.
      const long = Array.from({ length: 51 }, (_, at) => ({ name: `${CRATE} ${at + 1}` }));
      expect((yield* call("save_item", { items: long })).refused).toContain(
        "Expected at most 50 Items in one call.",
      );
      expect(yield* crates(call)).toBe(0);

      const saved = yield* call("save_item", { items: list });
      const items = (saved.created as Listed[]).filter(({ type }) => type === "item");
      expect(items).toHaveLength(4);

      // Moving day in small: each one moves to the apartment, loses its Space, and is filed
      // again. On D1 the extra Categories are replaced by two statements inside the batch.
      const moved = yield* call("save_item", {
        items: items.map(({ id }) => ({
          id,
          property: "Elm Court apartment",
          category: "office",
          extra_categories: ["tools", "furniture"],
          data: { condition: "good" },
        })),
      });
      expect(moved).toEqual({
        change_id: expect.stringMatching(ULID),
        created: [],
        updated: items,
      });
      const here = { property_id: "seed-property-maple", category_id: "tools" };
      const there = { property_id: "seed-property-elm", space_id: null, category_id: "office" };
      expect(yield* call("get_record", { type: "item", id: items[3]!.id })).toMatchObject({
        ...there,
        property: "Elm Court apartment",
        space: null,
        data: { condition: "good" },
        extra_categories: [{ id: "furniture" }, { id: "tools" }],
        changes: [
          {
            id: moved.change_id,
            before: { ...here, data: {}, extra_categories: ["office"] },
            after: {
              ...there,
              data: { condition: "good" },
              extra_categories: ["furniture", "tools"],
            },
          },
          { id: saved.change_id, before: null, after: { ...here, extra_categories: ["office"] } },
        ],
      });
    }),
  ),
);

// Two of the questions in AGENTS.md, asked the way a client asks them: with the SQL the
// schema's own comments give, through `query`.
test(
  "what was paid for everything owned, and what was sold this year, are answered with query",
  asClient((call) =>
    Effect.gen(function* () {
      const paid = Effect.map(
        call("query", { sql: `SELECT sum(price_cents) AS paid FROM inventory` }),
        (answer) => (answer.rows as [{ paid: number }])[0].paid,
      );
      // The made-up household has Items of its own, so this counts from what they come to.
      const before = yield* paid;

      const saved = yield* call("save_item", {
        items: [
          { name: `${CRATE} of books`, price: 120.5 },
          // Listed for sale is still owned.
          { name: `${CRATE} of records`, price: 80, status: "listed" },
          { name: `${CRATE} of tools`, price: 300, status: "sold", proceeds: 175.25 },
          { name: `${CRATE} of toys`, price: 40, status: "given" },
          // In storage, at no Property, and still owned.
          { name: `${CRATE} of winter coats`, price: 310.99, clear: ["property"] },
        ],
      });
      expect(saved.refused).toBeUndefined();

      // What was paid for everything the User still has: the books, the records, the coats.
      expect(yield* paid).toBe(before + 12050 + 8000 + 31099);

      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format();
      const sold = yield* call("query", {
        sql: `SELECT name, status_on, price_cents, proceeds_cents FROM items
               WHERE status = 'sold' AND status_on >= '${today.slice(0, 4)}'`,
      });
      const tools = (sold.rows as Fields[]).filter(({ name }) => name === `${CRATE} of tools`);
      expect(tools).toEqual([
        {
          name: `${CRATE} of tools`,
          status_on: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
          price_cents: 30000,
          proceeds_cents: 17525,
        },
      ]);
      // The one that was given away was not sold.
      expect(sold.rows).not.toContainEqual(expect.objectContaining({ name: `${CRATE} of toys` }));
    }),
  ),
);

// These change the Worker's settings for one test, so they sit at the end of the file.
test(
  "a currency that is not one stops a deploy, and the Worker that was there stays",
  Effect.gen(function* () {
    const stopped = yield* Effect.flip(deployWith({ ATTIC_CURRENCY: "dollars" }));
    expect(String(stopped)).toContain('ATTIC_CURRENCY is "dollars", which is not a currency.');

    const { url, token } = yield* householdClient;
    const { message } = yield* Effect.promise(() => mcp(url, { method: "tools/list" }, token));
    expect(message).toHaveProperty("result.tools");
    // Nothing was deployed, so there is nothing to put back unless this test has failed.
  }).pipe(Effect.ensuring(Effect.orDie(deployWith()))),
);

test(
  "the amount in a Note is written in the configured currency",
  asClient(() =>
    Effect.gen(function* () {
      // What a Worker with a currency makes of an Item that is sold: the amount in its Note.
      const client = yield* householdClient;
      const writesIn = (symbol: string) => async () => {
        const saved = await answerFrom<Fields>(client, "save_item", {
          name: `${CRATE} of lamps`,
          status: "sold",
          proceeds: 1450.5,
        });
        expect(saved.record).toMatchObject({
          notes: [{ body: expect.stringContaining(`for ${symbol}1,450.50.`) }],
        });
      };

      // The tests leave the currency unset, which is USD. The code is taken in any case.
      yield* Effect.promise(writesIn("$"));
      yield* deployWith({ ATTIC_CURRENCY: " eur " }).pipe(
        Effect.andThen(eventually(writesIn("€"))),
        // Puts the currency back for whatever runs next.
        Effect.ensuring(deployWith().pipe(Effect.andThen(eventually(writesIn("$"))), Effect.orDie)),
      );
    }),
  ),
);
