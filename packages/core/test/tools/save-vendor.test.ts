import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { getRecord } from "../../src/tools/get-record.ts";
import { saveVendor } from "../../src/tools/save-vendor.ts";
import { answer, call, callAsClient } from "../call.ts";
import { loadHousehold } from "../household.ts";
import { TestDatabase } from "../TestDatabase.ts";

// A save the way a client sends one: checked against the tool's input first.
const saving = (input: unknown) => callAsClient(saveVendor, input).pipe(Effect.map(answer));

const getting = (type: string, id: string) =>
  call(getRecord, { type, id }).pipe(Effect.map(answer));

// How many Vendors, Notes, and Changes there are, read from the tables.
const counting = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [counts] = yield* sql<{ vendors: number; notes: number; changes: number }>`
    SELECT (SELECT count(*) FROM vendors) AS vendors,
           (SELECT count(*) FROM notes) AS notes,
           (SELECT count(*) FROM changes) AS changes`;
  return counts;
});

// The test database hands out ids in order. A save takes one for each record it creates, and
// then one for its Change.
it.effect("save_vendor creates a Vendor, and get_record returns it with the Change", () =>
  Effect.gen(function* () {
    const saved = yield* saving({
      name: "Pipewise Plumbing",
      role: "plumber",
      data: { phone: "555-0142" },
    });

    const whole = {
      id: "id-0001",
      name: "Pipewise Plumbing",
      role: "plumber",
      data: { phone: "555-0142" },
      created_at: expect.any(String),
      updated_at: expect.any(String),
    };
    const pipewise = {
      type: "vendor",
      ...whole,
      work: [],
      quotes: [],
      items: [],
      documents: [],
      notes: [],
      changes: [
        {
          id: "id-0002",
          tool: "save_vendor",
          created_at: expect.any(String),
          undoes: null,
          before: null,
          after: whole,
        },
      ],
    };
    expect(yield* getting("vendor", "id-0001")).toEqual(pipewise);
    expect(saved).toEqual({
      change_id: "id-0002",
      created: [{ type: "vendor", id: "id-0001", name: "Pipewise Plumbing" }],
      updated: [],
      record: pipewise,
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// There is one Vendor for each name, so the name says which one a save is about.
it.effect("save_vendor under a name that exists updates that Vendor, whatever its case", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    const before = yield* counting;

    const saved = yield* saving({
      name: "pipewise PLUMBING",
      role: "plumber and gas fitter",
      data: { url: "https://pipewise.example.com", email: null },
    });
    const was = {
      id: "seed-vendor-pipewise",
      name: "Pipewise Plumbing",
      role: "plumber",
      data: { phone: "555-0142", email: "pipewise@example.com" },
    };
    const is = {
      ...was,
      role: "plumber and gas fitter",
      data: { phone: "555-0142", url: "https://pipewise.example.com" },
    };
    expect(saved).toMatchObject({
      change_id: "id-0001",
      created: [],
      // The name stays as it was first written.
      updated: [{ type: "vendor", id: "seed-vendor-pipewise", name: "Pipewise Plumbing" }],
      record: { ...is, changes: [{ id: "id-0001", tool: "save_vendor", before: was, after: is }] },
    });
    expect(yield* counting).toEqual({ ...before, changes: 1 });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("the optional Note is attached to the Vendor, in the same Change", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    const before = yield* counting;

    const saved = yield* saving({
      name: "Pipewise Plumbing",
      note: " Dana retired in 2026. Ask for Sam. ",
    });
    const body = "Dana retired in 2026. Ask for Sam.";
    expect(saved).toMatchObject({
      change_id: "id-0002",
      // A reply says what the call created, the Note included.
      created: [{ type: "note", id: "id-0001", name: body }],
      updated: [{ type: "vendor", id: "seed-vendor-pipewise", name: "Pipewise Plumbing" }],
      record: {
        id: "seed-vendor-pipewise",
        notes: expect.arrayContaining([
          expect.objectContaining({ id: "id-0001", body }),
          expect.objectContaining({ id: "seed-note-pipewise" }),
        ]),
      },
    });

    // One call is one Change, with every record it touched: the Vendor and the Note.
    expect(yield* counting).toEqual({ ...before, notes: before!.notes + 1, changes: 1 });
    expect(yield* getting("note", "id-0001")).toMatchObject({
      body,
      // A Vendor has no Property, so a Note on one has none.
      property_id: null,
      attached_to: [{ type: "vendor", id: "seed-vendor-pipewise", name: "Pipewise Plumbing" }],
      changes: [
        {
          id: "id-0002",
          tool: "save_vendor",
          before: null,
          after: {
            id: "id-0001",
            property_id: null,
            entity_type: "vendor",
            entity_id: "seed-vendor-pipewise",
            body,
            data: {},
            created_at: expect.any(String),
          },
        },
      ],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a new Vendor can come with a Note, and a second Note adds to the first", () =>
  Effect.gen(function* () {
    const saved = yield* saving({ name: "Sparrow Roofing", role: "roofer", note: "Cash only." });
    expect(saved).toMatchObject({
      change_id: "id-0003",
      created: [
        { type: "vendor", id: "id-0001", name: "Sparrow Roofing" },
        { type: "note", id: "id-0002", name: "Cash only." },
      ],
      updated: [],
      record: { notes: [{ id: "id-0002", body: "Cash only." }] },
    });

    const again = yield* saving({ name: "Sparrow Roofing", note: "Books up by March." });
    expect((again.record as { notes: unknown[] }).notes).toHaveLength(2);
    expect(yield* counting).toEqual({ vendors: 1, notes: 2, changes: 2 });
  }).pipe(Effect.provide(TestDatabase)),
);

// A long Note is not sent back whole as its own name.
it.effect("a long Note is named in the reply by how it starts", () =>
  Effect.gen(function* () {
    const body =
      `They quoted the gutters twice. ${"The second quote was lower. ".repeat(8)}`.trim();
    const saved = yield* saving({ name: "Sparrow Roofing", note: body });

    const [, note] = saved.created as { name: string }[];
    expect(note!.name).toBe(`${body.slice(0, 80)}…`);
    expect((yield* getting("note", "id-0002")).body).toBe(body);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("with an id, a new name renames the Vendor", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    const before = yield* counting;

    expect(
      yield* saving({ id: "seed-vendor-pipewise", name: "Pipewise Plumbing and Gas" }),
    ).toMatchObject({
      created: [],
      updated: [{ type: "vendor", id: "seed-vendor-pipewise", name: "Pipewise Plumbing and Gas" }],
      // The Work it did is still its own.
      record: { name: "Pipewise Plumbing and Gas", role: "plumber", work: [{}, {}] },
    });
    // The same name in another case is a rename too, when the id says which Vendor it is.
    expect(
      yield* saving({ id: "seed-vendor-pipewise", name: "PIPEWISE PLUMBING AND GAS" }),
    ).toMatchObject({ record: { name: "PIPEWISE PLUMBING AND GAS" } });
    // With an id and no name, the Vendor keeps its name.
    expect(yield* saving({ id: "seed-vendor-pipewise", role: "gas fitter" })).toMatchObject({
      updated: [{ type: "vendor", id: "seed-vendor-pipewise", name: "PIPEWISE PLUMBING AND GAS" }],
      record: { role: "gas fitter" },
    });
    expect((yield* counting)?.vendors).toBe(before!.vendors);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("an id that is not there is an error, and nothing is written", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    const before = yield* counting;

    expect(yield* saving({ id: "seed-vendor-nobody", name: "Nobody", note: "Not here." })).toEqual({
      refused:
        'There is no Vendor with the id "seed-vendor-nobody". To save one by its name, leave the id out.',
    });
    expect(yield* counting).toEqual(before);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a rename to a name another Vendor has is refused", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    const before = yield* counting;

    expect(yield* saving({ id: "seed-vendor-pipewise", name: "old town plumbing" })).toEqual({
      refused:
        'Another Vendor is already named "Old Town Plumbing". There is one Vendor for each name, whatever its case.',
    });
    expect(yield* counting).toEqual(before);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a save with no id and no name is refused", () =>
  Effect.gen(function* () {
    expect(yield* saving({ role: "plumber" })).toEqual({
      refused: "Give a name to create a Vendor, or the id of the Vendor to update.",
    });
    expect(yield* counting).toEqual({ vendors: 0, notes: 0, changes: 0 });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a field left out, or sent as null, is unchanged, and role can be cleared", () =>
  Effect.gen(function* () {
    yield* loadHousehold;

    const same = yield* saving({ name: "Pipewise Plumbing", role: null, data: null, note: null });
    expect(same.record).toMatchObject({
      role: "plumber",
      data: { phone: "555-0142", email: "pipewise@example.com" },
    });
    expect(same.created).toEqual([]);

    const cleared = yield* saving({ name: "Pipewise Plumbing", clear: ["role"] });
    expect(cleared.record).toMatchObject({ role: null, data: { phone: "555-0142" } });

    expect(yield* saving({ name: "Pipewise Plumbing", role: "plumber", clear: ["role"] })).toEqual({
      refused:
        "A field is given a value or cleared, not both in one call. Both were asked for: role.",
    });
    // A Vendor always has a name, so it is not among the fields `clear` takes.
    expect((yield* saving({ name: "Pipewise Plumbing", clear: ["name"] })).refused).toContain(
      '"role"',
    );
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a name or a Note of nothing but spaces is refused", () =>
  Effect.gen(function* () {
    expect(yield* saving({ name: "   " })).toEqual({
      refused: "name: Expected a name with something in it.",
    });
    expect(yield* saving({ name: "Sparrow Roofing", note: "  " })).toEqual({
      refused: "note: Expected a Note with something in it.",
    });
    expect(yield* counting).toEqual({ vendors: 0, notes: 0, changes: 0 });
  }).pipe(Effect.provide(TestDatabase)),
);
