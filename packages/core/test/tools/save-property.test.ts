import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { getRecord } from "../../src/tools/get-record.ts";
import { saveProperty } from "../../src/tools/save-property.ts";
import { answer, call, callAsClient, readingLog, UNEXPECTED, type Answer } from "../call.ts";
import { TestDatabase } from "../TestDatabase.ts";

// A save the way a client sends one: checked against the tool's input first.
const saving = (input: unknown) => callAsClient(saveProperty, input).pipe(Effect.map(answer));

const getting = (id: string) => call(getRecord, { type: "property", id }).pipe(Effect.map(answer));

// The test database hands out ids in order. A save takes one for each record it creates, and
// then one for its Change.
it.effect(
  "save_property creates a Property, and get_record returns it with the Change that made it",
  () =>
    Effect.gen(function* () {
      const saved = yield* saving({
        name: "Maple Street house",
        tenure: "own",
        address: "12 Maple Street, Springfield",
        start_on: "2022-05-20",
        data: { paint: { trim: { color: "Pure White" } } },
      });

      // The whole record: every column of its row, with `data` as an object.
      const whole = {
        id: "id-0001",
        name: "Maple Street house",
        tenure: "own",
        address: "12 Maple Street, Springfield",
        start_on: "2022-05-20",
        end_on: null,
        data: { paint: { trim: { color: "Pure White" } } },
        created_at: expect.any(String),
        updated_at: expect.any(String),
      };
      const maple = {
        type: "property",
        ...whole,
        spaces: [],
        projects: [],
        schedules: [],
        items: [],
        work: [],
        documents: [],
        notes: [],
        changes: [
          {
            id: "id-0002",
            tool: "save_property",
            created_at: expect.any(String),
            undoes: null,
            before: null,
            after: whole,
          },
        ],
      };
      expect(yield* getting("id-0001")).toEqual(maple);

      // A call that saves one record returns it as get_record does.
      expect(saved).toEqual({
        change_id: "id-0002",
        created: [{ type: "property", id: "id-0001", name: "Maple Street house" }],
        updated: [],
        record: maple,
      });
    }).pipe(Effect.provide(TestDatabase)),
);

// How many Properties and Changes there are, read from the tables.
const counting = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [counts] = yield* sql<{ properties: number; changes: number; change_records: number }>`
    SELECT (SELECT count(*) FROM properties) AS properties,
           (SELECT count(*) FROM changes) AS changes,
           (SELECT count(*) FROM change_records) AS change_records`;
  return counts;
});

// Only one Property can have a name, so the name says which one a save is about.
it.effect(
  "saving under the same name in another case updates that Property and makes no second one",
  () =>
    Effect.gen(function* () {
      yield* saving({ name: "Maple Street house", start_on: "2022-05-20" });
      const saved = yield* saving({
        name: "maple street HOUSE",
        tenure: "rent",
        address: "12 Maple Street",
      });

      expect(saved).toMatchObject({
        change_id: "id-0003",
        created: [],
        // The name stays as it was first written.
        updated: [{ type: "property", id: "id-0001", name: "Maple Street house" }],
        record: { id: "id-0001", name: "Maple Street house", tenure: "rent" },
      });
      expect(yield* counting).toEqual({ properties: 1, changes: 2, change_records: 2 });

      // The Change has the whole record before and after, newest Change first.
      const before = {
        id: "id-0001",
        name: "Maple Street house",
        tenure: "own",
        address: null,
        start_on: "2022-05-20",
        end_on: null,
        data: {},
        created_at: expect.any(String),
        updated_at: expect.any(String),
      };
      const { changes } = yield* getting("id-0001");
      expect(changes).toEqual([
        {
          id: "id-0003",
          tool: "save_property",
          created_at: expect.any(String),
          undoes: null,
          before,
          after: { ...before, tenure: "rent", address: "12 Maple Street" },
        },
        expect.objectContaining({ id: "id-0002", before: null, after: before }),
      ]);
    }).pipe(Effect.provide(TestDatabase)),
);

it.effect("with an id, a new name renames the Property", () =>
  Effect.gen(function* () {
    yield* saving({ name: "Maple Street house" });

    expect(yield* saving({ id: "id-0001", name: "Maple Street cottage" })).toMatchObject({
      created: [],
      updated: [{ type: "property", id: "id-0001", name: "Maple Street cottage" }],
      record: { id: "id-0001", name: "Maple Street cottage" },
    });
    // The same name in another case is a rename too, when the id says which Property it is.
    expect(yield* saving({ id: "id-0001", name: "MAPLE STREET COTTAGE" })).toMatchObject({
      updated: [{ type: "property", id: "id-0001", name: "MAPLE STREET COTTAGE" }],
    });
    expect((yield* counting)?.properties).toBe(1);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("an id that is not there is an error that lists the Properties there are", () =>
  Effect.gen(function* () {
    yield* saving({ name: "Maple Street house" });
    yield* saving({ name: "Elm Court apartment" });
    const before = yield* counting;

    expect(yield* saving({ id: "id-9999", name: "Oak Lane flat" })).toEqual({
      refused:
        'There is no Property with the id "id-9999". To save one by its name, leave the id out. The Properties are: Elm Court apartment, Maple Street house.',
    });
    expect(yield* counting).toEqual(before);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a rename to a name that another Property has is refused", () =>
  Effect.gen(function* () {
    yield* saving({ name: "Maple Street house" });
    yield* saving({ name: "Elm Court apartment" });
    const before = yield* counting;

    expect(yield* saving({ id: "id-0001", name: "elm court apartment" })).toEqual({
      refused:
        'Another Property is already named "Elm Court apartment". No two Properties can have the same name, whatever its case.',
    });
    expect(yield* counting).toEqual(before);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a save with no id and no name is refused", () =>
  Effect.gen(function* () {
    expect(yield* saving({ tenure: "rent" })).toEqual({
      refused: "Give a name to create a Property, or the id of the Property to update.",
    });
    expect(yield* counting).toEqual({ properties: 0, changes: 0, change_records: 0 });
  }).pipe(Effect.provide(TestDatabase)),
);

// The former Property of the made-up household, as a client would save it.
const ELM = {
  name: "Elm Court apartment",
  tenure: "rent",
  address: "4 Elm Court, Springfield",
  start_on: "2019-08",
  end_on: "2022-05",
  data: { lease_until: "2022-07" },
};

it.effect("a field left out, or sent as null, is unchanged", () =>
  Effect.gen(function* () {
    yield* saving(ELM);

    const saved = yield* saving({
      name: "Elm Court apartment",
      tenure: null,
      start_on: null,
      end_on: "2022-06",
      data: null,
    });
    expect(saved.record).toMatchObject({ ...ELM, end_on: "2022-06" });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a field named in clear is emptied, and the rest are unchanged", () =>
  Effect.gen(function* () {
    yield* saving(ELM);

    const saved = yield* saving({ name: "Elm Court apartment", clear: ["end_on", "address"] });
    expect(saved.record).toMatchObject({ ...ELM, end_on: null, address: null });
  }).pipe(Effect.provide(TestDatabase)),
);

// A Property must have a name and a tenure, so neither is among the fields `clear` takes.
it.effect("clearing the name is refused, with the fields that can be cleared", () =>
  Effect.gen(function* () {
    yield* saving(ELM);
    const before = yield* counting;

    for (const field of ["name", "tenure"]) {
      const { refused } = yield* saving({ name: "Elm Court apartment", clear: [field] });
      for (const clearable of ["address", "start_on", "end_on"]) {
        expect(refused, field).toContain(`"${clearable}"`);
      }
    }
    expect(yield* counting).toEqual(before);
    expect((yield* getting("id-0001")).name).toBe("Elm Court apartment");
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a field cannot be given a value and cleared in the same call", () =>
  Effect.gen(function* () {
    yield* saving(ELM);
    const before = yield* counting;

    expect(
      yield* saving({
        name: "Elm Court apartment",
        end_on: "2022-06",
        clear: ["address", "end_on"],
      }),
    ).toEqual({
      refused:
        "A field is given a value or cleared, not both in one call. Both were asked for: end_on.",
    });
    expect(yield* counting).toEqual(before);
  }).pipe(Effect.provide(TestDatabase)),
);

// A name with spaces around it is the same name, so it never makes a second Property.
it.effect("the spaces around a name are dropped, and a name of nothing but spaces is refused", () =>
  Effect.gen(function* () {
    expect(yield* saving({ name: "  Maple Street house " })).toMatchObject({
      created: [{ type: "property", id: "id-0001", name: "Maple Street house" }],
    });
    expect(yield* saving({ name: "Maple Street house  ", tenure: "rent" })).toMatchObject({
      created: [],
      updated: [{ type: "property", id: "id-0001", name: "Maple Street house" }],
    });

    for (const name of ["", "   "]) {
      expect(yield* saving({ name }), name).toEqual({
        refused: "name: Expected a name with something in it.",
      });
    }
    expect((yield* counting)?.properties).toBe(1);
  }).pipe(Effect.provide(TestDatabase)),
);

// A fact with no field of its own belongs in `data`. Sent beside the fields, it was once
// dropped, and the save went through without it.
it.effect("a field save_property does not have is turned away by name, and nothing is saved", () =>
  Effect.gen(function* () {
    const { refused } = yield* saving({ name: "Maple Street house", sqft: 240, note: "x" });

    const fields =
      "There is no field with this name. The fields are: id, name, tenure, address, start_on, end_on, data, clear. A fact with no field of its own goes inside data.";
    expect(refused).toBe(`sqft: ${fields}, note: ${fields}`);
    expect(yield* counting).toEqual({ properties: 0, changes: 0, change_records: 0 });

    // Inside `data` the same fact is kept.
    const saved = yield* saving({ name: "Maple Street house", data: { sqft: 240 } });
    expect((saved.record as Answer).data).toEqual({ sqft: 240 });
  }).pipe(Effect.provide(TestDatabase)),
);

// `data` is a JSON merge patch: keys merge, null removes a key, and a list is replaced whole.
it.effect("data merges: a new key is added, a key sent as null is removed, the rest stay", () =>
  Effect.gen(function* () {
    yield* saving({
      name: "Maple Street house",
      data: {
        lease_until: "2027-06",
        utilities: ["water", "gas"],
        paint: { trim: { color: "Pure White", sheen: "semi-gloss" }, ceiling: { color: "White" } },
      },
    });

    const saved = yield* saving({
      name: "Maple Street house",
      data: {
        lease_until: null,
        utilities: ["electric"],
        paint: { trim: { sheen: null, code: "SW 7005" }, walls: { color: "Alabaster" } },
      },
    });
    expect((saved.record as Answer).data).toEqual({
      utilities: ["electric"],
      paint: {
        trim: { color: "Pure White", code: "SW 7005" },
        ceiling: { color: "White" },
        walls: { color: "Alabaster" },
      },
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// A key that is removed in the same call that creates the record was never there.
it.effect("data on a new Property is stored as written, without the keys sent as null", () =>
  Effect.gen(function* () {
    const saved = yield* saving({
      name: "Maple Street house",
      data: { lease_until: null, built: 1962, deposit_cents: 250000, paint: { trim: null } },
    });
    expect((saved.record as Answer).data).toEqual({ built: 1962, deposit: 2500, paint: {} });

    // Nothing in `data` is converted on its way in. Money there is integer cents.
    const sql = yield* SqlClient.SqlClient;
    expect(yield* sql`SELECT data FROM properties`).toEqual([
      { data: '{"built":1962,"deposit_cents":250000,"paint":{}}' },
    ]);
  }).pipe(Effect.provide(TestDatabase)),
);

// A Partial date stands for the whole period it names.
it.effect("a Partial date is accepted for start_on and end_on", () =>
  Effect.gen(function* () {
    const saved = yield* saving({
      name: "Elm Court apartment",
      start_on: "2019",
      end_on: "2022-05",
    });
    expect(saved.record).toMatchObject({ start_on: "2019", end_on: "2022-05" });

    const again = yield* saving({ name: "Elm Court apartment", start_on: "2019-08-01" });
    expect(again.record).toMatchObject({ start_on: "2019-08-01", end_on: "2022-05" });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect(
  "a date that is not one, or does not exist, is refused with the forms that are accepted",
  () =>
    Effect.gen(function* () {
      for (const date of [
        "2023-13",
        "June 2023",
        "2023-02-30",
        "2023-6",
        "23",
        "2023-06-12T10:00:00Z",
        "",
      ]) {
        for (const field of ["start_on", "end_on"]) {
          const { refused } = yield* saving({ name: "Elm Court apartment", [field]: date });
          expect(refused, date).toContain("2023, 2023-06, or 2023-06-12");
        }
      }
      // A leap day is a date in a leap year and not in any other.
      expect(
        (yield* saving({ name: "Elm Court apartment", start_on: "2024-02-29" })).refused,
      ).toBeUndefined();
      expect(
        (yield* saving({ name: "Elm Court apartment", start_on: "2023-02-29" })).refused,
      ).toContain("2023, 2023-06, or 2023-06-12");
      expect((yield* counting)?.properties).toBe(1);
    }).pipe(Effect.provide(TestDatabase)),
);

// The rows of a Change are the last thing a batch writes, after the Property's own row. A
// trigger that refuses them fails a create at its last statement and an update at its second.
it.effect("a batch the database refuses partway leaves nothing behind: no row and no Change", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* saving({ name: "Elm Court apartment" });
    const before = yield* counting;
    yield* sql`
        CREATE TRIGGER refuse_change_records BEFORE INSERT ON change_records
        BEGIN SELECT RAISE(ABORT, 'refused by the test'); END`;

    const created = yield* readingLog(saving({ name: "Maple Street house" }));
    expect(created.result).toEqual({ refused: UNEXPECTED.text });
    expect(created.logged).toEqual([expect.stringContaining("refused by the test")]);

    const updated = yield* readingLog(saving({ name: "Elm Court apartment", tenure: "rent" }));
    expect(updated.result).toEqual({ refused: UNEXPECTED.text });

    expect(yield* counting).toEqual(before);
    expect(yield* sql`SELECT name, tenure FROM properties`).toEqual([
      { name: "Elm Court apartment", tenure: "own" },
    ]);
  }).pipe(Effect.provide(TestDatabase)),
);

// The MCP layer hands a tool only the fields its input declares. A call that skips that check,
// as `call` does, can carry any key, and a key is never to end up in SQL.
it.effect("a key that is not a column of the record never reaches the database", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* saving({ name: "Maple Street house" });
    const before = yield* counting;

    const { result, logged } = yield* readingLog(
      call(saveProperty, { name: "Maple Street house", "tenure = 'rent', address": "1 Main" }),
    );
    expect(answer(result)).toEqual({ refused: UNEXPECTED.text });
    expect(logged).toEqual([expect.stringContaining("properties has no column to set named")]);

    expect(yield* counting).toEqual(before);
    expect(yield* sql`SELECT tenure, address FROM properties`).toEqual([
      { tenure: "own", address: null },
    ]);
  }).pipe(Effect.provide(TestDatabase)),
);
