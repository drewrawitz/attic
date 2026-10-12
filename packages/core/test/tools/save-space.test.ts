import { expect, it } from "@effect/vitest";
import { DateTime, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { getRecord } from "../../src/tools/get-record.ts";
import { saveProperty } from "../../src/tools/save-property.ts";
import { saveSpace } from "../../src/tools/save-space.ts";
import { answer, call, callAsClient, todayIs } from "../call.ts";
import { loadHousehold } from "../household.ts";
import { TestDatabase } from "../TestDatabase.ts";

// A save the way a client sends one: checked against the tool's input first.
const saving = (input: unknown) => callAsClient(saveSpace, input).pipe(Effect.map(answer));

const getting = (id: string) => call(getRecord, { type: "space", id }).pipe(Effect.map(answer));

// The made-up household has one Current property on this day: the Maple Street house. The Elm
// Court apartment ended in 2022-05.
const TODAY = "2026-10-11";

// The test database hands out ids in order. A save takes one for each record it creates, and
// then one for its Change.
it.effect("save_space creates a Space at the Current property when no Property is given", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);

    const saved = yield* saving({ name: "Pantry", data: { sqft: 30 } });

    const whole = { id: "id-0001", property_id: "seed-property-maple", name: "Pantry" };
    const pantry = {
      type: "space",
      ...whole,
      property: "Maple Street house",
      data: { sqft: 30 },
      // The trim paint is the Property's, and the Pantry has no paint of its own.
      from_property: { paint: { trim: expect.objectContaining({ color: "Pure White" }) } },
      items: [],
      work: [],
      projects: [],
      documents: [],
      notes: [],
      changes: [
        {
          id: "id-0002",
          tool: "save_space",
          created_at: expect.any(String),
          undoes: null,
          before: null,
          after: { ...whole, data: { sqft: 30 } },
        },
      ],
    };
    expect(yield* getting("id-0001")).toEqual(pantry);

    // A call that saves one record returns it as get_record does.
    expect(saved).toEqual({
      change_id: "id-0002",
      created: [{ type: "space", id: "id-0001", name: "Pantry" }],
      updated: [],
      record: pantry,
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// The reply follows the rule get_record follows: of the Property's `data`, a Space shows what is
// marked as the same in every Space and nothing else (ADR 0015).
it.effect("the reply of save_space shows nothing of the Property's size or its lease", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    yield* call(saveProperty, {
      name: "Maple Street house",
      data: { sqft: 1800, lease_until: "2027-06", built: 1962 },
    });

    const created = yield* saving({ name: "Pantry" });
    const onlyTrim = { paint: { trim: expect.objectContaining({ color: "Pure White" }) } };
    expect(created.record).toHaveProperty("from_property", onlyTrim);

    // A Space with a size of its own, on the save that updates it.
    const sized = yield* saving({ name: "Pantry", data: { sqft: 30 } });
    expect(sized.record).toHaveProperty("data", { sqft: 30 });
    expect(sized.record).toHaveProperty("from_property", onlyTrim);
  }).pipe(Effect.provide(TestDatabase)),
);

// How many Spaces and Changes there are, read from the tables.
const counting = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [counts] = yield* sql<{ spaces: number; changes: number }>`
    SELECT (SELECT count(*) FROM spaces) AS spaces, (SELECT count(*) FROM changes) AS changes`;
  return counts;
});

it.effect("save_space creates a Space at a named Property, by its name in any case or its id", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);

    const byName = yield* saving({ name: "Balcony", property: "elm court APARTMENT" });
    expect(byName).toMatchObject({
      created: [{ type: "space", id: "id-0001", name: "Balcony" }],
      record: { property_id: "seed-property-elm", property: "Elm Court apartment" },
    });

    const byId = yield* saving({ name: "Hall", property: "seed-property-elm" });
    expect(byId.record).toMatchObject({ name: "Hall", property: "Elm Court apartment" });

    // The spaces around a Property's name are dropped, as they are around a Space's.
    const spaced = yield* saving({ name: "Loft", property: "  Elm Court apartment " });
    expect(spaced.record).toMatchObject({ name: "Loft", property: "Elm Court apartment" });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a Property that is not there is an error that lists the ones that are", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const before = yield* counting;

    expect(yield* saving({ name: "Balcony", property: "Oak Lane flat" })).toEqual({
      refused:
        'There is no Property "Oak Lane flat". The Properties are: Elm Court apartment, Maple Street house.',
    });
    expect(yield* counting).toEqual(before);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("with two Current properties, a save with no Property is an error that lists them", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    yield* call(saveProperty, { name: "Birch Road cabin", start_on: "2026-08" });
    const before = yield* counting;

    expect(yield* saving({ name: "Pantry" })).toEqual({
      refused:
        "2 Properties are current: Birch Road cabin, Maple Street house. Say which one this is for: give `property` its id or its name.",
    });
    expect(yield* counting).toEqual(before);

    // Naming one of them is all it takes.
    expect(yield* saving({ name: "Pantry", property: "Birch Road cabin" })).toMatchObject({
      record: { name: "Pantry", property: "Birch Road cabin" },
    });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("with no Current property, a save with no Property is an error that lists them all", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    yield* call(saveProperty, { name: "Maple Street house", end_on: "2026-09-30" });
    const before = yield* counting;

    expect(yield* saving({ name: "Pantry" })).toEqual({
      refused:
        "No Property is current: each one has an end date that has passed. The Properties are: Elm Court apartment, Maple Street house. Say which one this is for: give `property` its id or its name.",
    });
    expect(yield* counting).toEqual(before);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("with no Property at all, a save with no Property says to save one first", () =>
  Effect.gen(function* () {
    yield* todayIs(TODAY);

    expect(yield* saving({ name: "Pantry" })).toEqual({
      refused: "There are no Properties yet. Save one with save_property first.",
    });
    expect(yield* counting).toEqual({ spaces: 0, changes: 0 });
  }).pipe(Effect.provide(TestDatabase)),
);

// A Partial date counts through the whole period it names. The end date is the Property's
// last day, so the Property is still current on it.
it.effect("a Property is current until its end date has passed, a Partial one included", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs("2026-10-11");

    for (const [endOn, current] of [
      ["2026-10-11", true],
      ["2026-10-10", false],
      ["2026-10", true],
      ["2026-09", false],
      ["2026", true],
      ["2025", false],
      ["2027-01-01", true],
    ] as const) {
      yield* call(saveProperty, { name: "Maple Street house", end_on: endOn });
      const saved = yield* saving({ name: `Space until ${endOn}` });
      if (current) {
        expect(saved.record, endOn).toMatchObject({ property: "Maple Street house" });
      } else {
        expect(saved.refused, endOn).toContain("No Property is current");
      }
    }
  }).pipe(Effect.provide(TestDatabase)),
);

// The `current_properties` view goes by the UTC date. A tool goes by the date where the User is.
it.effect("today is the date in the configured timezone, not the UTC date", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* call(saveProperty, { name: "Maple Street house", end_on: "2026-10-11" });
    // Half past ten in the evening of the Property's last day in Los Angeles. In UTC it is
    // already the 12th.
    yield* TestClock.setTime(Date.parse("2026-10-12T05:30:00Z"));
    const inLosAngeles = Layer.orDie(DateTime.layerCurrentZoneNamed("America/Los_Angeles"));

    expect(yield* saving({ name: "Pantry" }).pipe(Effect.provide(inLosAngeles))).toMatchObject({
      created: [{ type: "space", name: "Pantry" }],
      record: { property: "Maple Street house" },
    });
    // The test database is in UTC, where the end date has passed.
    expect((yield* saving({ name: "Larder" })).refused).toContain("No Property is current");

    // An hour and a half later it is the 12th in Los Angeles too.
    yield* TestClock.setTime(Date.parse("2026-10-12T07:00:00Z"));
    expect(
      (yield* saving({ name: "Larder" }).pipe(Effect.provide(inLosAngeles))).refused,
    ).toContain("No Property is current");
  }).pipe(Effect.provide(TestDatabase)),
);

const WALLS = {
  brand: "Sherwin-Williams",
  color: "Agreeable Gray",
  code: "SW 7029",
  sheen: "eggshell",
};

// `data` is a JSON merge patch: keys merge, null removes a key, and the rest stay.
it.effect("a Space's data merges: wall paint is added without losing the size", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    yield* saving({ name: "Pantry", data: { sqft: 30 } });

    const painted = yield* saving({ name: "Pantry", data: { paint: { walls: WALLS } } });
    expect(painted).toMatchObject({
      created: [],
      updated: [{ type: "space", id: "id-0001", name: "Pantry" }],
    });
    expect(yield* getting("id-0001")).toMatchObject({
      data: { sqft: 30, paint: { walls: WALLS } },
      // The trim is still the Property's.
      from_property: { paint: { trim: { color: "Pure White" } } },
    });

    // One surface at a time: the ceiling goes in beside the walls, and a key sent as null goes.
    yield* saving({ name: "Pantry", data: { sqft: null, paint: { ceiling: { color: "White" } } } });
    expect((yield* getting("id-0001")).data).toEqual({
      paint: { walls: WALLS, ceiling: { color: "White" } },
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// A Property has one Space for each name, so the name says which Space a save is about.
it.effect(
  "a Space saved under its name in another case is updated, and no second one is made",
  () =>
    Effect.gen(function* () {
      yield* loadHousehold;
      yield* todayIs(TODAY);
      const before = yield* counting;

      const saved = yield* saving({ name: "KITCHEN", data: { sqft: 180 } });
      const kitchen = {
        id: "seed-space-kitchen",
        property_id: "seed-property-maple",
        name: "Kitchen",
      };
      const data = { flooring: { type: "porcelain tile" }, counters: "quartz" };
      expect(saved).toMatchObject({
        change_id: "id-0001",
        created: [],
        // The name stays as it was first written.
        updated: [{ type: "space", id: "seed-space-kitchen", name: "Kitchen" }],
        record: {
          ...kitchen,
          data: { ...data, sqft: 180 },
          // The Change has the whole record before and after.
          changes: [
            {
              id: "id-0001",
              tool: "save_space",
              before: { ...kitchen, data },
              after: { ...kitchen, data: { ...data, sqft: 180 } },
            },
          ],
        },
      });
      expect(yield* counting).toEqual({ spaces: before!.spaces, changes: 1 });

      // The former Property has a Kitchen of its own, which is another Space.
      expect(
        yield* saving({ name: "kitchen", property: "Elm Court apartment", data: { sqft: 90 } }),
      ).toMatchObject({
        updated: [{ type: "space", id: "seed-space-elm-kitchen", name: "Kitchen" }],
      });
      expect((yield* getting("seed-space-kitchen")).data).toMatchObject({ sqft: 180 });
    }).pipe(Effect.provide(TestDatabase)),
);

it.effect("with an id, a new name renames the Space, and what is in it stays", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const before = yield* counting;

    const saved = yield* saving({ id: "seed-space-garage", name: "Workshop", data: { sqft: 400 } });
    expect(saved).toMatchObject({
      created: [],
      updated: [{ type: "space", id: "seed-space-garage", name: "Workshop" }],
      record: {
        id: "seed-space-garage",
        name: "Workshop",
        data: { sqft: 400 },
        items: [{ name: "Adjustable dumbbells" }, { name: "Treadmill" }, { name: "Water heater" }],
      },
    });
    // The same name in another case is a rename too, when the id says which Space it is.
    expect(yield* saving({ id: "seed-space-garage", name: "WORKSHOP" })).toMatchObject({
      updated: [{ type: "space", id: "seed-space-garage", name: "WORKSHOP" }],
    });
    // With an id and no name, the Space keeps its name.
    expect(yield* saving({ id: "seed-space-garage", data: { sqft: 420 } })).toMatchObject({
      updated: [{ type: "space", id: "seed-space-garage", name: "WORKSHOP" }],
      record: { name: "WORKSHOP", data: { sqft: 420 } },
    });
    expect((yield* counting)?.spaces).toBe(before!.spaces);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("an id that is not there is an error, and nothing is written", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const before = yield* counting;

    expect(yield* saving({ id: "seed-space-attic", name: "Attic" })).toEqual({
      refused:
        'There is no Space with the id "seed-space-attic". To save one by its name, leave the id out.',
    });
    expect(yield* counting).toEqual(before);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a rename to a name another Space at the Property has is refused", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const before = yield* counting;

    expect(yield* saving({ id: "seed-space-garage", name: "kitchen" })).toEqual({
      refused:
        'Another Space at Maple Street house is already named "Kitchen". A Property has one Space for each name, whatever its case.',
    });
    expect(yield* counting).toEqual(before);

    // A name that only a Space at another Property has is free.
    yield* saving({ name: "Balcony", property: "Elm Court apartment" });
    expect(yield* saving({ id: "seed-space-garage", name: "Balcony" })).toMatchObject({
      updated: [{ type: "space", id: "seed-space-garage", name: "Balcony" }],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a Space does not move to another Property", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const before = yield* counting;

    expect(yield* saving({ id: "seed-space-garage", property: "Elm Court apartment" })).toEqual({
      refused:
        'The Space "Garage" is at Maple Street house, not at Elm Court apartment. A Space does not move to another Property.',
    });
    expect(yield* counting).toEqual(before);

    // Naming the Property it is at changes nothing.
    expect(
      yield* saving({
        id: "seed-space-garage",
        property: "maple street house",
        data: { sqft: 400 },
      }),
    ).toMatchObject({ record: { property: "Maple Street house", data: { sqft: 400 } } });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a save with no id and no name is refused", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const before = yield* counting;

    expect(yield* saving({ data: { sqft: 30 } })).toEqual({
      refused: "Give a name to create a Space, or the id of the Space to update.",
    });
    expect(yield* counting).toEqual(before);
  }).pipe(Effect.provide(TestDatabase)),
);

// A name with spaces around it is the same name, so it never makes a second Space.
it.effect("the spaces around a name are dropped, and a name of nothing but spaces is refused", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const before = yield* counting;

    expect(yield* saving({ name: "  Kitchen " })).toMatchObject({
      created: [],
      updated: [{ type: "space", id: "seed-space-kitchen", name: "Kitchen" }],
    });
    expect(yield* saving({ name: "   " })).toEqual({
      refused: "name: Expected a name with something in it.",
    });
    expect((yield* counting)?.spaces).toBe(before!.spaces);
  }).pipe(Effect.provide(TestDatabase)),
);

// A room's size goes inside `data`, and a Space has no `clear` and no Note of its own. Each
// of these was once dropped, and the save went through as if it had been taken.
it.effect("a field save_space does not have is turned away by name, and nothing is saved", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const before = yield* counting;

    const fields =
      "There is no field with this name. The fields are: id, name, property, data. A fact with no field of its own goes inside data.";
    for (const [field, value] of [
      ["sqft", 240],
      ["note", "Repainted in the spring."],
      ["clear", ["name"]],
    ] as const) {
      expect(yield* saving({ name: "Kitchen", [field]: value }), field).toEqual({
        refused: `${field}: ${fields}`,
      });
    }
    expect(yield* counting).toEqual(before);
  }).pipe(Effect.provide(TestDatabase)),
);
