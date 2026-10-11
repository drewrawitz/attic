import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { addNote } from "../../src/tools/add-note.ts";
import { getRecord } from "../../src/tools/get-record.ts";
import { saveProperty } from "../../src/tools/save-property.ts";
import { answer, call, callAsClient, todayIs } from "../call.ts";
import { loadHousehold } from "../household.ts";
import { TestDatabase } from "../TestDatabase.ts";

// A call the way a client sends one: checked against the tool's input first.
const adding = (input: unknown) => callAsClient(addNote, input).pipe(Effect.map(answer));

const getting = (type: string, id: string) =>
  call(getRecord, { type, id }).pipe(Effect.map(answer));

// The made-up household has one Current property on this day: the Maple Street house. The Elm
// Court apartment ended in 2022-05.
const TODAY = "2026-10-11";
const MAPLE = { property_id: "seed-property-maple", property: "Maple Street house" };
const ELM = { property_id: "seed-property-elm", property: "Elm Court apartment" };
const NOWHERE = { property_id: null, property: null };

// How many Notes and Changes there are, read from the tables.
const counting = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [counts] = yield* sql<{ notes: number; changes: number; change_records: number }>`
    SELECT (SELECT count(*) FROM notes) AS notes,
           (SELECT count(*) FROM changes) AS changes,
           (SELECT count(*) FROM change_records) AS change_records`;
  return counts;
});

// A record of each type a Note can be attached to, with the Property it is at. Two are at the
// former Property, and a Vendor is at none.
const RECORDS = [
  { type: "item", id: "seed-item-fridge", name: "Fridge", at: MAPLE },
  { type: "work", id: "seed-work-elm-drain", name: "Cleared the kitchen drain", at: ELM },
  { type: "vendor", id: "seed-vendor-hearth", name: "Hearth Heating and Air", at: NOWHERE },
  { type: "space", id: "seed-space-elm-kitchen", name: "Kitchen", at: ELM },
  { type: "project", id: "seed-project-outdoor-lighting", name: "Outdoor lighting", at: MAPLE },
] as const;

// The test database hands out ids in order: one for the Note, and then one for its Change.
it.effect(
  "add_note attaches a Note to a record of each of the five types, and get_record shows it there",
  () =>
    Effect.gen(function* () {
      yield* loadHousehold;
      yield* todayIs(TODAY);
      const before = yield* counting;

      for (const [index, { type, id, name, at }] of RECORDS.entries()) {
        const note = `id-${String(index * 2 + 1).padStart(4, "0")}`;
        const change = `id-${String(index * 2 + 2).padStart(4, "0")}`;
        const body = `A Note on the ${type}.`;

        const added = yield* adding({ body, attach_to: { type, id } });

        const whole = {
          type: "note",
          id: note,
          body,
          // A Note on a record takes that record's Property.
          ...at,
          data: {},
          attached_to: [{ type, id, name }],
          changes: [
            {
              id: change,
              tool: "add_note",
              created_at: expect.any(String),
              undoes: null,
              before: null,
              after: {
                id: note,
                property_id: at.property_id,
                entity_type: type,
                entity_id: id,
                body,
                data: {},
                created_at: expect.any(String),
              },
            },
          ],
          created_at: expect.any(String),
        };
        expect(added, type).toEqual({
          change_id: change,
          created: [{ type: "note", id: note, name: body }],
          updated: [],
          record: whole,
        });
        expect(yield* getting("note", note), type).toEqual(whole);

        const { notes } = yield* getting(type, id);
        expect(notes, type).toEqual(
          expect.arrayContaining([{ id: note, body, created_at: expect.any(String) }]),
        );
      }

      // Every call is one Change, with the one record it touched.
      expect(yield* counting).toEqual({
        notes: before!.notes + 5,
        changes: 5,
        change_records: 5,
      });
    }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a Note on an Item takes the Item's Property, and none when the Item is at none", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* loadHousehold;
    yield* todayIs(TODAY);
    // A Belonging can be at no Property, such as one in storage.
    yield* sql`UPDATE items SET property_id = NULL WHERE id = 'seed-item-watch'`;

    const left = yield* adding({
      body: "The landlord's, and it leaked.",
      attach_to: { type: "item", id: "seed-item-elm-dishwasher" },
    });
    expect(left.record).toMatchObject(ELM);

    const stored = yield* adding({
      body: "In the storage unit.",
      attach_to: { type: "item", id: "seed-item-watch" },
    });
    expect(stored.record).toMatchObject(NOWHERE);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a link to a record that is not there is an error, and nothing is written", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const before = yield* counting;

    expect(
      yield* adding({ body: "It hums.", attach_to: { type: "item", id: "seed-item-toaster" } }),
    ).toEqual({
      refused:
        'There is no Item with the id "seed-item-toaster". Ids come from search and from the records get_record returns.',
    });
    // The id of a record of another type is not the id of a Space.
    expect(
      (yield* adding({ body: "It hums.", attach_to: { type: "space", id: "seed-item-fridge" } }))
        .refused,
    ).toContain('There is no Space with the id "seed-item-fridge".');
    // A Note is not attached to a Property. One that stands alone at it says the same.
    expect(
      (yield* adding({
        body: "It hums.",
        attach_to: { type: "property", id: "seed-property-maple" },
      })).refused,
    ).toContain('"item"');
    expect(yield* counting).toEqual(before);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect(
  "a Note that stands alone goes to the Current property and shows on the Property's record",
  () =>
    Effect.gen(function* () {
      yield* loadHousehold;
      yield* todayIs(TODAY);

      const body = "The water shutoff is behind the washer.";
      const added = yield* adding({ body: `  ${body} `, attach_to: null });
      expect(added).toMatchObject({
        change_id: "id-0002",
        created: [{ type: "note", id: "id-0001", name: body }],
        record: { ...MAPLE, body, attached_to: [] },
      });

      const maple = yield* getting("property", "seed-property-maple");
      expect(maple.notes).toEqual(
        expect.arrayContaining([
          { id: "id-0001", body, created_at: expect.any(String) },
          expect.objectContaining({ id: "seed-note-breaker" }),
        ]),
      );
    }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a Note that stands alone goes to the Property given, by its id or its name", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);

    const added = yield* adding({
      body: "The deposit came back in full.",
      property: "elm court apartment",
    });
    expect(added.record).toMatchObject({ ...ELM, attached_to: [] });
    expect((yield* getting("property", "seed-property-elm")).notes).toMatchObject([
      { id: "id-0001" },
    ]);

    expect(yield* adding({ body: "Nobody lives here.", property: "Oak Lane flat" })).toEqual({
      refused:
        'There is no Property "Oak Lane flat". The Properties are: Elm Court apartment, Maple Street house.',
    });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("with two Current properties, only a Note that stands alone has to name one", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    yield* call(saveProperty, { name: "Birch Road cabin" });
    const before = yield* counting;

    expect(yield* adding({ body: "The key is under the mat." })).toEqual({
      refused:
        "2 Properties are current: Birch Road cabin, Maple Street house. Say which one this is for: give `property` its id or its name.",
    });
    expect(yield* counting).toEqual(before);

    // A Note on a record goes where the record is, whichever Properties are current.
    const added = yield* adding({
      body: "The filter light stays on for a day.",
      attach_to: { type: "item", id: "seed-item-fridge" },
    });
    expect(added.record).toMatchObject(MAPLE);
  }).pipe(Effect.provide(TestDatabase)),
);

// A Note on a record takes that record's Property, so a `property` beside it can only agree.
it.effect("a Property given beside a record has to be the record's own", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const before = yield* counting;

    const agreed = yield* adding({
      body: "The filter light stays on for a day.",
      attach_to: { type: "item", id: "seed-item-fridge" },
      property: "maple street house",
    });
    expect(agreed.record).toMatchObject(MAPLE);

    expect(
      yield* adding({
        body: "The filter light stays on for a day.",
        attach_to: { type: "item", id: "seed-item-fridge" },
        property: "Elm Court apartment",
      }),
    ).toEqual({
      refused:
        'A Note on a record takes that record\'s Property. The Item "Fridge" is at Maple Street house, so leave `property` out.',
    });
    expect(
      yield* adding({
        body: "Ask for the morning slot.",
        attach_to: { type: "vendor", id: "seed-vendor-hearth" },
        property: "Maple Street house",
      }),
    ).toEqual({
      refused:
        'A Note on a record takes that record\'s Property. The Vendor "Hearth Heating and Air" is at no Property, so leave `property` out.',
    });
    expect(yield* counting).toEqual({
      ...before,
      notes: before!.notes + 1,
      changes: 1,
      change_records: 1,
    });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a Note of nothing but spaces is refused", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const before = yield* counting;

    for (const body of ["", "   "]) {
      expect(yield* adding({ body }), body).toEqual({
        refused: "Expected a Note with something in it.",
      });
    }
    expect(yield* counting).toEqual(before);
  }).pipe(Effect.provide(TestDatabase)),
);
