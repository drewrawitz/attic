import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { getRecord } from "../../src/tools/get-record.ts";
import { saveProject } from "../../src/tools/save-project.ts";
import { saveProperty } from "../../src/tools/save-property.ts";
import { saveQuote } from "../../src/tools/save-quote.ts";
import { search } from "../../src/tools/search.ts";
import { answer, call, callAsClient, todayIs } from "../call.ts";
import { loadHousehold } from "../household.ts";
import { TestDatabase } from "../TestDatabase.ts";

// A Quote saved the way a client saves one: checked against the tool's input first.
const saving = (input: unknown) => callAsClient(saveQuote, input).pipe(Effect.map(answer));

const getting = (type: string, id: string) =>
  call(getRecord, { type, id }).pipe(Effect.map(answer));

// The made-up household has one Project, with a Quote from each of two Vendors: Brightside
// Electric at 4,200 on 2026-04-18, and Glow Landscape Lighting at 3,650 on 2026-05-02.
const LIGHTING = "seed-project-outdoor-lighting";
const BRIGHTSIDE = "seed-quote-brightside";
const GLOW = "seed-quote-glow";

// How many of each record a save of a Quote can write there are, read from the tables.
const counting = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [counted] = yield* sql`
    SELECT (SELECT count(*) FROM quotes) AS quotes,
           (SELECT count(*) FROM vendors) AS vendors,
           (SELECT count(*) FROM changes) AS changes`;
  return counted;
});

// The test database hands out ids in order. A save takes one for each record it creates, in
// the order its batch writes them, and then one for its Change.
it.effect("a Quote saved for a new Vendor creates the Vendor in the same Change", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    const sql = yield* SqlClient.SqlClient;

    const saved = yield* saving({
      project: LIGHTING,
      vendor: "Lumen Yard",
      amount: 3980.5,
      quoted_on: "2026-05",
      data: { includes: "8 path lights and a transformer" },
    });

    // A Quote has no name of its own. What names it is its Vendor, and the Project it is for.
    expect(saved).toMatchObject({
      change_id: "id-0003",
      created: [
        { type: "vendor", id: "id-0001", name: "Lumen Yard" },
        { type: "quote", id: "id-0002", name: "Lumen Yard for Outdoor lighting" },
      ],
      updated: [],
    });
    // An amount is in dollars at the tool, and integer cents in the database.
    expect(
      yield* sql`SELECT project_id, vendor_id, amount_cents FROM quotes WHERE id = 'id-0002'`,
    ).toEqual([{ project_id: LIGHTING, vendor_id: "id-0001", amount_cents: 398050 }]);

    // get_record takes no Quote: a Quote comes back with its Project. So the reply has the
    // Project, with the new Quote among the ones it had. They come newest first, and a date
    // known only to the month comes after the days in it.
    const project = yield* getting("project", LIGHTING);
    expect(saved.project).toEqual(project);
    expect(project).toMatchObject({
      type: "project",
      title: "Outdoor lighting",
      quotes: [
        { id: GLOW, vendor: "Glow Landscape Lighting", amount: 3650, quoted_on: "2026-05-02" },
        {
          id: "id-0002",
          vendor: "Lumen Yard",
          vendor_id: "id-0001",
          amount: 3980.5,
          quoted_on: "2026-05",
          data: { includes: "8 path lights and a transformer" },
        },
        { id: BRIGHTSIDE, vendor: "Brightside Electric", amount: 4200, quoted_on: "2026-04-18" },
      ],
    });

    // The Vendor is in the one Change with the Quote, and shows the Quote it gave.
    expect(yield* getting("vendor", "id-0001")).toMatchObject({
      name: "Lumen Yard",
      quotes: [
        { id: "id-0002", project: "Outdoor lighting", project_id: LIGHTING, amount: 3980.5 },
      ],
      changes: [{ id: "id-0003", tool: "save_quote", before: null }],
    });
    expect(
      yield* sql`SELECT entity_type, entity_id FROM change_records ORDER BY entity_type`,
    ).toEqual([
      { entity_type: "quote", entity_id: "id-0002" },
      { entity_type: "vendor", entity_id: "id-0001" },
    ]);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("an amount below zero, or with three decimal places, is a validation error", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    const before = yield* counting;
    const quote = { project: LIGHTING, vendor: "Lumen Yard" };

    expect(yield* saving({ ...quote, amount: -1 })).toEqual({
      refused: "amount: Expected an amount that is not below zero.",
    });
    expect(yield* saving({ ...quote, amount: 3980.505 })).toEqual({
      refused: "amount: Expected an amount with at most two decimal places, such as 1299.99.",
    });
    expect((yield* saving({ ...quote, quoted_on: "2026-02-30" })).refused).toContain(
      "quoted_on: Expected a date that exists",
    );
    expect(yield* counting).toEqual(before);

    // A Quote may have no amount yet, and one of nothing is not the same as none.
    yield* saving(quote);
    yield* saving({ project: LIGHTING, vendor: "Neighbor Ned", amount: 0 });
    const sql = yield* SqlClient.SqlClient;
    expect(yield* sql`SELECT amount_cents FROM quotes WHERE id LIKE 'id-%' ORDER BY id`).toEqual([
      { amount_cents: null },
      { amount_cents: 0 },
    ]);
  }).pipe(Effect.provide(TestDatabase)),
);

// One Quote per Vendor per Project. A revised Quote takes the place of the old one.
it.effect("a second save for the same Project and Vendor updates the one Quote", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    const before = yield* counting;

    // The Vendor is matched whatever the case of its name, and keeps its name as first written.
    const revised = yield* saving({
      project: LIGHTING,
      vendor: "BRIGHTSIDE electric",
      amount: 3900,
    });
    expect(revised).toMatchObject({
      created: [],
      updated: [
        { type: "quote", id: BRIGHTSIDE, name: "Brightside Electric for Outdoor lighting" },
      ],
    });
    // A field the save did not give is as it was: the date, and what the amount covers.
    expect(revised.project).toMatchObject({
      quotes: [
        { id: GLOW, amount: 3650 },
        {
          id: BRIGHTSIDE,
          vendor: "Brightside Electric",
          amount: 3900,
          quoted_on: "2026-04-18",
          data: { includes: "12 path lights, a transformer, and a two-year warranty" },
        },
      ],
    });
    expect(yield* counting).toEqual({ ...before, changes: 1 });

    // `data` is a merge patch, and a field is emptied by naming it in clear.
    const again = yield* saving({
      project: LIGHTING,
      vendor: "Brightside Electric",
      data: { warranty_years: 3 },
      clear: ["quoted_on"],
    });
    expect(again.project).toMatchObject({
      quotes: [
        { id: GLOW },
        {
          id: BRIGHTSIDE,
          amount: 3900,
          quoted_on: null,
          data: {
            includes: "12 path lights, a transformer, and a two-year warranty",
            warranty_years: 3,
          },
        },
      ],
    });
    expect(
      yield* saving({
        project: LIGHTING,
        vendor: "Brightside Electric",
        amount: 1,
        clear: ["amount"],
      }),
    ).toEqual({
      refused:
        "A field is given a value or cleared, not both in one call. Both were asked for: amount.",
    });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a Quote for a Project that is not there is an error, and nothing is written", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    const before = yield* counting;

    // The Vendor is new, and is not made for a Quote that was never saved.
    expect(
      yield* saving({ project: "no-such-project", vendor: "Lumen Yard", amount: 3980 }),
    ).toEqual({
      refused:
        'There is no Project with the id "no-such-project". Ids come from search and from the records get_record returns.',
    });
    // A Project is given by its id, and its title is not one.
    expect(
      (yield* saving({ project: "Outdoor lighting", vendor: "Lumen Yard" })).refused,
    ).toContain('There is no Project with the id "Outdoor lighting".');
    // A new Quote needs a Project and a Vendor.
    for (const lacking of [{ project: LIGHTING }, { vendor: "Lumen Yard" }, { amount: 100 }]) {
      expect(yield* saving(lacking)).toEqual({
        refused: "Give a Project and a Vendor to save a Quote, or the id of the Quote to update.",
      });
    }
    expect((yield* saving({ project: LIGHTING, vendor: " " })).refused).toContain("vendor");
    expect(yield* counting).toEqual(before);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("with an id, a save updates that Quote, and can put right its Vendor", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    const before = yield* counting;

    const revised = yield* saving({ id: GLOW, amount: 3500, quoted_on: "2026-05-20" });
    expect(revised).toMatchObject({
      created: [],
      updated: [{ type: "quote", id: GLOW, name: "Glow Landscape Lighting for Outdoor lighting" }],
      project: {
        id: LIGHTING,
        quotes: [
          { id: GLOW, amount: 3500, quoted_on: "2026-05-20" },
          { id: BRIGHTSIDE, amount: 4200 },
        ],
      },
    });

    // The Quote was saved under the wrong Vendor. With an id, a Vendor is its new one, which
    // is made on first use as any other is.
    const moved = yield* saving({ id: GLOW, vendor: "Glow Garden Lights" });
    expect(moved).toMatchObject({
      created: [{ type: "vendor", id: "id-0002", name: "Glow Garden Lights" }],
      updated: [{ type: "quote", id: GLOW, name: "Glow Garden Lights for Outdoor lighting" }],
      project: {
        quotes: [
          { id: GLOW, vendor: "Glow Garden Lights", vendor_id: "id-0002", amount: 3500 },
          { id: BRIGHTSIDE },
        ],
      },
    });
    expect(yield* getting("vendor", "seed-vendor-glow")).toMatchObject({ quotes: [] });

    // A Project has one Quote from each Vendor, so it cannot become a second one from Brightside.
    const settled = yield* counting;
    expect(yield* saving({ id: GLOW, vendor: "brightside electric" })).toEqual({
      refused: `The Project "Outdoor lighting" already has a Quote from Brightside Electric, with the id "${BRIGHTSIDE}". A Project has one Quote from each Vendor. Update that one, or give this one another Vendor.`,
    });
    expect(yield* saving({ id: "no-such-quote", amount: 1 })).toEqual({
      refused:
        // search finds no Quote, and get_record takes none, so the error says where one is.
        'There is no Quote with the id "no-such-quote". A Quote\'s id is in the record of its Project, which get_record returns.',
    });
    expect(yield* counting).toEqual(settled);
    expect(settled).toEqual({
      quotes: before!.quotes,
      vendors: Number(before!.vendors) + 1,
      changes: 2,
    });

    // Naming the Project and the Vendor it has is no change of either.
    const same = yield* saving({
      id: BRIGHTSIDE,
      project: LIGHTING,
      vendor: "Brightside Electric",
    });
    expect(same.updated).toEqual([
      { type: "quote", id: BRIGHTSIDE, name: "Brightside Electric for Outdoor lighting" },
    ]);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("with an id, a Project given is the Quote's new Project, and both show the Change", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projects (id, property_id, title)
      VALUES ('project-patio', 'seed-property-maple', 'Patio lighting')`;

    // The Quote was saved on the wrong Project. The reply has the Project it is on now.
    const moved = yield* saving({ id: GLOW, project: "project-patio" });
    expect(moved).toMatchObject({
      updated: [{ type: "quote", id: GLOW, name: "Glow Landscape Lighting for Patio lighting" }],
      project: { id: "project-patio", quotes: [{ id: GLOW, amount: 3650 }] },
    });
    expect(yield* getting("project", LIGHTING)).toMatchObject({ quotes: [{ id: BRIGHTSIDE }] });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a Quote takes no Note, and a field it does not have is turned away by name", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    const before = yield* counting;

    // A Note about a Quote goes on its Project.
    expect(
      yield* saving({ project: LIGHTING, vendor: "Lumen Yard", note: "Valid for 30 days." }),
    ).toEqual({
      refused:
        "note: There is no field with this name. The fields are: id, project, vendor, amount, quoted_on, data, clear. A fact with no field of its own goes inside data.",
    });
    expect((yield* saving({ id: GLOW, clear: ["vendor"] })).refused).toContain("clear");
    expect(yield* counting).toEqual(before);
  }).pipe(Effect.provide(TestDatabase)),
);

// get_record takes no Quote, and a Change has to be found to be undone. So the Changes that
// touched a Quote are listed on its Project, each with the Quote's id and the Quote before and
// after.
it.effect("a Project lists the Changes that touched only one of its Quotes", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    const sql = yield* SqlClient.SqlClient;

    yield* saving({ id: BRIGHTSIDE, amount: 3900 });
    const was = {
      id: BRIGHTSIDE,
      project_id: LIGHTING,
      vendor_id: "seed-vendor-brightside",
      amount: 4200,
      quoted_on: "2026-04-18",
      data: { includes: "12 path lights, a transformer, and a two-year warranty" },
      created_at: expect.any(String),
      updated_at: expect.any(String),
    };
    const revised = {
      id: "id-0001",
      tool: "save_quote",
      created_at: expect.any(String),
      undoes: null,
      quote_id: BRIGHTSIDE,
      before: was,
      after: { ...was, amount: 3900 },
    };
    expect((yield* getting("project", LIGHTING)).changes).toEqual([revised]);
    // The Change touched the Quote and nothing else.
    expect(yield* sql`SELECT entity_type, entity_id FROM change_records`).toEqual([
      { entity_type: "quote", entity_id: BRIGHTSIDE },
    ]);

    // A new Quote is listed the same way. The Vendor it made is not the Project's to list.
    yield* saving({ project: LIGHTING, vendor: "Lumen Yard", amount: 3980 });
    // A Change of the Project's own has no Quote to name.
    yield* sql`INSERT INTO changes (id, tool, created_at) VALUES ('id-9999', 'save_project', '2999-01-01T00:00:00.000Z')`;
    yield* sql`
      INSERT INTO change_records (change_id, entity_type, entity_id, after)
      VALUES ('id-9999', 'project', ${LIGHTING}, '{"title":"Outdoor lighting"}')`;
    expect((yield* getting("project", LIGHTING)).changes).toMatchObject([
      { id: "id-9999", tool: "save_project", quote_id: null, after: { title: "Outdoor lighting" } },
      {
        id: "id-0004",
        tool: "save_quote",
        quote_id: "id-0003",
        before: null,
        after: { amount: 3980 },
      },
      revised,
    ]);

    // A Quote that goes to another Project shows on the one it left and the one it joined.
    yield* sql`
      INSERT INTO projects (id, property_id, title)
      VALUES ('project-patio', 'seed-property-maple', 'Patio lighting')`;
    yield* saving({ id: GLOW, project: "project-patio" });
    const moved = {
      id: "id-0005",
      quote_id: GLOW,
      before: { project_id: LIGHTING },
      after: { project_id: "project-patio" },
    };
    expect((yield* getting("project", "project-patio")).changes).toMatchObject([moved]);
    expect((yield* getting("project", LIGHTING)).changes).toMatchObject([
      { id: "id-9999" },
      moved,
      { id: "id-0004" },
      revised,
    ]);

    // A Quote that was deleted is in no table, and the Change that deleted it is still here.
    yield* sql`INSERT INTO changes (id, tool) VALUES ('id-0006', 'delete_record')`;
    yield* sql`
      INSERT INTO change_records (change_id, entity_type, entity_id, before)
      SELECT 'id-0006', 'quote', id, json_object('id', id, 'project_id', project_id)
        FROM quotes WHERE id = ${BRIGHTSIDE}`;
    yield* sql`DELETE FROM quotes WHERE id = ${BRIGHTSIDE}`;
    expect((yield* getting("project", LIGHTING)).changes).toMatchObject([
      { id: "id-9999" },
      { id: "id-0006", tool: "delete_record", quote_id: BRIGHTSIDE, after: null },
      moved,
      { id: "id-0004" },
      revised,
    ]);
  }).pipe(Effect.provide(TestDatabase)),
);

// One of the questions Attic has to answer, asked of a database that has only what the tools
// wrote: a Property, a Project, and two Quotes.
it.effect("who quoted the outdoor lighting, and for how much, is answered", () =>
  Effect.gen(function* () {
    yield* todayIs("2026-10-11");
    yield* call(saveProperty, { name: "Maple Street house", start_on: "2022-05-20" });
    const project = yield* callAsClient(saveProject, {
      title: "Outdoor lighting",
      start_on: "2026-04",
      spaces: ["Exterior"],
      data: { goal: "Low-voltage lights along the front path and around the patio" },
    }).pipe(Effect.map(answer));
    const lighting = (project.record as { id: string }).id;
    const brightside = yield* saving({
      project: lighting,
      vendor: "Brightside Electric",
      amount: 4200,
      quoted_on: "2026-04-18",
      data: { includes: "12 path lights, a transformer, and a two-year warranty" },
    });
    const glow = yield* saving({
      project: lighting,
      vendor: "Glow Landscape Lighting",
      amount: 3650,
      quoted_on: "2026-05-02",
      data: { includes: "10 path lights and a transformer" },
    });
    expect([brightside.refused, glow.refused]).toEqual([undefined, undefined]);

    // The Project is found by what it is called, and by who quoted it.
    const found = yield* call(search, { words: "outdoor lighting" }).pipe(Effect.map(answer));
    expect(found.results).toMatchObject([{ type: "project", id: lighting }]);
    const quotedBy = yield* call(search, { words: "brightside", types: ["project"] }).pipe(
      Effect.map(answer),
    );
    expect(quotedBy.results).toMatchObject([
      { type: "project", id: lighting, matched: { vendors: ["Brightside Electric"] } },
    ]);

    // Its record has each Quote, with the Vendor and the amount, newest first.
    expect(yield* getting("project", lighting)).toMatchObject({
      title: "Outdoor lighting",
      spaces: [{ name: "Exterior" }],
      quotes: [
        {
          vendor: "Glow Landscape Lighting",
          amount: 3650,
          quoted_on: "2026-05-02",
          data: { includes: "10 path lights and a transformer" },
        },
        {
          vendor: "Brightside Electric",
          amount: 4200,
          quoted_on: "2026-04-18",
          data: { includes: "12 path lights, a transformer, and a two-year warranty" },
        },
      ],
    });
  }).pipe(Effect.provide(TestDatabase)),
);
