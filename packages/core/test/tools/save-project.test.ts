import { expect, it } from "@effect/vitest";
import { DateTime, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { addNote } from "../../src/tools/add-note.ts";
import { getRecord } from "../../src/tools/get-record.ts";
import { saveProject } from "../../src/tools/save-project.ts";
import { answer, call, callAsClient, todayIs } from "../call.ts";
import { loadHousehold } from "../household.ts";
import { TestDatabase } from "../TestDatabase.ts";

// A Project saved the way a client saves one: checked against the tool's input first.
const saving = (input: unknown) => callAsClient(saveProject, input).pipe(Effect.map(answer));

const getting = (type: string, id: string) =>
  call(getRecord, { type, id }).pipe(Effect.map(answer));

// The made-up household has one Current property on this day: the Maple Street house. The Elm
// Court apartment ended in 2022-05.
const TODAY = "2026-10-11";

const MAPLE = "seed-property-maple";
const EXTERIOR = "seed-space-exterior";

// The test database hands out ids in order. A save takes one for each record it creates, in
// the order its batch writes them, and then one for its Change.
it.effect("a Project saved with two Spaces, one of them new, shows both", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);

    const saved = yield* saving({
      title: "Back fence",
      spaces: ["Exterior", "Side yard"],
      data: { goal: "A cedar fence along the back line" },
    });

    // The Project as it is stored, which is what its Change holds.
    const stored = {
      id: "id-0002",
      // With no Property given, a Project is at the one Current property.
      property_id: MAPLE,
      title: "Back fence",
      // A new Project is open, and has no dates unless the save gives them.
      status: "open",
      start_on: null,
      end_on: null,
      data: { goal: "A cedar fence along the back line" },
      created_at: expect.any(String),
      updated_at: expect.any(String),
    };
    const fence = {
      type: "project",
      ...stored,
      property: "Maple Street house",
      spaces: [
        { id: EXTERIOR, name: "Exterior" },
        { id: "id-0001", name: "Side yard" },
      ],
      quotes: [],
      total_cost: null,
      work: [],
      documents: [],
      notes: [],
      changes: [
        {
          id: "id-0003",
          tool: "save_project",
          created_at: expect.any(String),
          undoes: null,
          // The Changes of a Project's Quotes are listed with its own, and this is its own.
          quote_id: null,
          before: null,
          // A record lists its Spaces by name, and a Change by id.
          after: { ...stored, spaces: ["id-0001", EXTERIOR] },
        },
      ],
    };
    expect(yield* getting("project", "id-0002")).toEqual(fence);

    // The reply lists what the call created, in the order the batch wrote it. The Exterior was
    // there already, and the save did not write to it.
    expect(saved).toEqual({
      change_id: "id-0003",
      created: [
        { type: "space", id: "id-0001", name: "Side yard" },
        { type: "project", id: "id-0002", name: "Back fence" },
      ],
      updated: [],
      record: fence,
    });

    // The new Space is in the one Change with the Project, and shows the Project.
    expect(yield* getting("space", "id-0001")).toMatchObject({
      name: "Side yard",
      property: "Maple Street house",
      projects: [{ id: "id-0002", title: "Back fence", status: "open" }],
      changes: [{ id: "id-0003", tool: "save_project", before: null }],
    });
    const sql = yield* SqlClient.SqlClient;
    expect(
      yield* sql`SELECT entity_type, entity_id FROM change_records ORDER BY entity_type`,
    ).toEqual([
      { entity_type: "project", entity_id: "id-0002" },
      { entity_type: "space", entity_id: "id-0001" },
    ]);
  }).pipe(Effect.provide(TestDatabase)),
);

const LIGHTING = "seed-project-outdoor-lighting";

// The made-up household's one Project is open, and began in 2026-04.
it.effect("closing a Project dates its end today, unless the save gives the day", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);

    const done = yield* saving({ id: LIGHTING, status: "done" });
    expect(done.record).toMatchObject({ status: "done", start_on: "2026-04", end_on: TODAY });
    // Nothing moves or is copied: the Quotes, the Work, and the Note stay on the Project.
    expect(done.record).toMatchObject({
      quotes: [{ id: "seed-quote-glow" }, { id: "seed-quote-brightside" }],
      work: [{ id: "seed-work-lighting-transformer" }, { id: "seed-work-lighting-trench" }],
      notes: [{ id: "seed-note-lighting" }],
    });
    expect(done.updated).toEqual([{ type: "project", id: LIGHTING, name: "Outdoor lighting" }]);
    expect(done.created).toEqual([]);

    // A new Project starts out open, so one that is saved as dropped has been closed. The end
    // the save gives is kept, and may be a Partial date.
    const dropped = yield* saving({ title: "Heated driveway", status: "dropped", end_on: "2025" });
    expect(dropped.record).toMatchObject({ status: "dropped", end_on: "2025" });
    const finished = yield* saving({ title: "Shed roof", status: "done" });
    expect(finished.record).toMatchObject({ status: "done", end_on: TODAY });

    // A Project that is open has no end unless a save gives one.
    const open = yield* saving({ title: "Attic insulation" });
    expect(open.record).toMatchObject({ status: "open", end_on: null });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a Project that is closed already keeps its end, and a save can empty it", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs("2026-06-30");
    yield* saving({ id: LIGHTING, status: "done" });

    // Months later the Project is put right: it was dropped, not finished. It closed when it
    // closed.
    yield* todayIs(TODAY);
    const dropped = yield* saving({ id: LIGHTING, status: "dropped" });
    expect(dropped.record).toMatchObject({ status: "dropped", end_on: "2026-06-30" });
    const again = yield* saving({ id: LIGHTING, status: "dropped", data: { goal: "Path lights" } });
    expect(again.record).toMatchObject({ end_on: "2026-06-30", data: { goal: "Path lights" } });

    // Opening it again leaves the end as it is, unless the save empties it.
    const reopened = yield* saving({ id: LIGHTING, status: "open", clear: ["end_on"] });
    expect(reopened.record).toMatchObject({ status: "open", end_on: null });
    // And closing it again is dated again.
    const closed = yield* saving({ id: LIGHTING, status: "done" });
    expect(closed.record).toMatchObject({ status: "done", end_on: TODAY });

    // A save that closes a Project can say it has no end date.
    const undated = yield* saving({ title: "Old porch", status: "done", clear: ["end_on"] });
    expect(undated.record).toMatchObject({ status: "done", end_on: null });
    // A field is given a value or cleared, not both.
    expect(yield* saving({ id: LIGHTING, end_on: "2026", clear: ["end_on"] })).toEqual({
      refused:
        "A field is given a value or cleared, not both in one call. Both were asked for: end_on.",
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// The end a closed Project gets is the date where the User is.
it.effect("today is the date in the configured timezone, not the UTC date", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    // Half past ten in the evening of the 11th in Los Angeles. In UTC it is already the 12th.
    yield* TestClock.setTime(Date.parse("2026-10-12T05:30:00Z"));
    const inLosAngeles = Layer.orDie(DateTime.layerCurrentZoneNamed("America/Los_Angeles"));

    const there = yield* saving({ id: LIGHTING, status: "done" }).pipe(
      Effect.provide(inLosAngeles),
    );
    expect(there.record).toMatchObject({ end_on: "2026-10-11" });

    // The test database is in UTC.
    const here = yield* saving({ title: "Shed roof", status: "done" });
    expect(here.record).toMatchObject({ end_on: "2026-10-12" });
  }).pipe(Effect.provide(TestDatabase)),
);

// How many of each record a save of a Project can write there are, read from the tables.
const counting = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [counted] = yield* sql`
    SELECT (SELECT count(*) FROM projects) AS projects,
           (SELECT count(*) FROM project_spaces) AS project_spaces,
           (SELECT count(*) FROM spaces) AS spaces,
           (SELECT count(*) FROM notes) AS notes,
           (SELECT count(*) FROM changes) AS changes`;
  return counted;
});

// A Project is at one Property, as a Space is. Its Work and its Spaces are there.
it.effect("a save that names another Property for a Project that is there is refused", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const before = yield* counting;

    expect(yield* saving({ id: LIGHTING, property: "Elm Court apartment" })).toEqual({
      refused:
        'The Project "Outdoor lighting" is at Maple Street house, not at Elm Court apartment. A Project does not move to another Property.',
    });
    // A Property that is not there is an error that lists the ones that are.
    expect(yield* saving({ id: LIGHTING, property: "Oak Avenue" })).toEqual({
      refused:
        'There is no Property "Oak Avenue". The Properties are: Elm Court apartment, Maple Street house.',
    });
    expect(yield* counting).toEqual(before);

    // Naming the Property it is at is no move, by its name in any case or by its id.
    const byName = yield* saving({ id: LIGHTING, property: "maple street house", status: "done" });
    expect(byName.record).toMatchObject({ property: "Maple Street house", status: "done" });
    const byId = yield* saving({ id: LIGHTING, property: MAPLE, start_on: "2026-03" });
    expect(byId.record).toMatchObject({ property: "Maple Street house", start_on: "2026-03" });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a new Project is at the Property it names, and its Spaces are Spaces there", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);

    // Both Properties have a Kitchen. The Project gets the one at its own.
    const saved = yield* saving({
      title: "Kitchen repaint",
      property: "Elm Court apartment",
      status: "done",
      start_on: "2021-03",
      end_on: "2021-04",
      spaces: ["Kitchen"],
    });
    expect(saved.created).toEqual([{ type: "project", id: "id-0001", name: "Kitchen repaint" }]);
    expect(saved.record).toMatchObject({
      property: "Elm Court apartment",
      start_on: "2021-03",
      end_on: "2021-04",
      spaces: [{ id: "seed-space-elm-kitchen", name: "Kitchen" }],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("with no Current property, or with two, a new Project has to say where it is", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const sql = yield* SqlClient.SqlClient;
    const before = yield* counting;

    yield* sql`UPDATE properties SET end_on = NULL WHERE id = 'seed-property-elm'`;
    expect(yield* saving({ title: "Back fence" })).toEqual({
      refused:
        "2 Properties are current: Elm Court apartment, Maple Street house. Say which one this is for: give `property` its id or its name.",
    });
    expect(yield* counting).toEqual(before);

    // A Project that is there already is where it is, whatever is current.
    const renamed = yield* saving({ id: LIGHTING, title: "Path lighting" });
    expect(renamed.record).toMatchObject({
      title: "Path lighting",
      property: "Maple Street house",
    });
    expect(renamed.updated).toEqual([{ type: "project", id: LIGHTING, name: "Path lighting" }]);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("spaces replaces the set on an update, and the Change has the set before and after", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);

    // The Project covers the Exterior. Now it covers the Garage and a new Space, and not the
    // Exterior. A name is matched whatever its case, and a Space named twice is one Space.
    const saved = yield* saving({ id: LIGHTING, spaces: ["garage", "Front path", "FRONT PATH"] });
    expect(saved.created).toEqual([{ type: "space", id: "id-0001", name: "Front path" }]);
    expect(saved.updated).toEqual([{ type: "project", id: LIGHTING, name: "Outdoor lighting" }]);
    expect(saved.record).toMatchObject({
      spaces: [
        { id: "id-0001", name: "Front path" },
        { id: "seed-space-garage", name: "Garage" },
      ],
      changes: [
        {
          id: "id-0002",
          tool: "save_project",
          before: { title: "Outdoor lighting", spaces: [EXTERIOR] },
          after: { title: "Outdoor lighting", spaces: ["id-0001", "seed-space-garage"] },
        },
      ],
    });
    // The Exterior shows the Project no more, and the Garage does.
    expect(yield* getting("space", EXTERIOR)).toMatchObject({ projects: [] });
    expect(yield* getting("space", "seed-space-garage")).toMatchObject({
      projects: [{ id: LIGHTING }],
    });

    // A save that leaves `spaces` out leaves the set as it is, and an empty list empties it.
    const untouched = yield* saving({ id: LIGHTING, data: { goal: "Path lights" } });
    expect((untouched.record as { spaces: unknown[] }).spaces).toHaveLength(2);
    const emptied = yield* saving({ id: LIGHTING, spaces: [] });
    expect(emptied.record).toMatchObject({ spaces: [] });
    expect(emptied.created).toEqual([]);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("without an id a save always creates, and an id that is not there is an error", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);

    // Two Projects can have the same title, so a title never says which one a save is about.
    const second = yield* saving({ title: "Outdoor lighting" });
    expect(second.created).toEqual([{ type: "project", id: "id-0001", name: "Outdoor lighting" }]);
    expect((yield* counting)?.projects).toBe(2);

    const before = yield* counting;
    expect(yield* saving({ id: "no-such-project", title: "Back fence" })).toEqual({
      refused:
        'There is no Project with the id "no-such-project". Ids come from search and from the records get_record returns.',
    });
    expect(yield* saving({ status: "open" })).toEqual({
      refused: "Give a title to create a Project, or the id of the Project to update.",
    });
    // A title has something in it, and a date is one that exists.
    expect((yield* saving({ title: "  " })).refused).toContain("title");
    expect((yield* saving({ title: "Back fence", start_on: "2026-13" })).refused).toContain(
      "start_on: Expected a date that exists",
    );
    expect(yield* counting).toEqual(before);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a field is emptied by naming it in clear, and one left out stays as it is", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);

    const cleared = yield* saving({ id: LIGHTING, clear: ["start_on"] });
    expect(cleared.record).toMatchObject({
      title: "Outdoor lighting",
      status: "open",
      start_on: null,
      // A save that says nothing of `data` leaves it as it is.
      data: { goal: "Low-voltage lights along the front path and around the patio" },
    });
    // `data` is a merge patch: a key is added, and one sent as null is removed.
    const patched = yield* saving({ id: LIGHTING, data: { budget_cents: 500000, goal: null } });
    expect(patched.record).toMatchObject({ data: { budget: 5000 } });
    expect((patched.record as { data: object }).data).not.toHaveProperty("goal");
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("the optional Note is attached to the Project, at the Project's Property", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const sql = yield* SqlClient.SqlClient;

    const saved = yield* saving({
      title: "Kitchen repaint",
      property: "Elm Court apartment",
      note: "The landlord agreed to any off-white.",
    });
    expect(saved).toMatchObject({
      change_id: "id-0003",
      created: [
        { type: "project", id: "id-0001", name: "Kitchen repaint" },
        { type: "note", id: "id-0002", name: "The landlord agreed to any off-white." },
      ],
      record: { notes: [{ id: "id-0002", body: "The landlord agreed to any off-white." }] },
    });
    // The Project is at a former Property, and so is the Note.
    expect(
      yield* sql`SELECT property_id, entity_type, entity_id FROM notes WHERE id = 'id-0002'`,
    ).toEqual([{ property_id: "seed-property-elm", entity_type: "project", entity_id: "id-0001" }]);

    // Each Note given is a new Note.
    const again = yield* saving({ id: "id-0001", note: "Two coats, eggshell." });
    expect((again.record as { notes: unknown[] }).notes).toHaveLength(2);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a field save_project does not have is turned away by name", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    const before = yield* counting;

    // A Project has no cost of its own: its total is the Costs of its Work.
    expect(yield* saving({ title: "Back fence", cost: 4200 })).toEqual({
      refused:
        "cost: There is no field with this name. The fields are: id, title, property, status, start_on, end_on, spaces, data, note, clear. A fact with no field of its own goes inside data.",
    });
    expect((yield* saving({ id: LIGHTING, clear: ["title"] })).refused).toContain("clear");
    expect((yield* saving({ id: LIGHTING, status: "planned" })).refused).toContain("status");
    expect(yield* counting).toEqual(before);
  }).pipe(Effect.provide(TestDatabase)),
);

// A Note on a record takes that record's Property, whatever Property is current.
it.effect("a Note added to a Project is at the Project's Property", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const sql = yield* SqlClient.SqlClient;
    yield* saving({ title: "Kitchen repaint", property: "Elm Court apartment" });

    const added = yield* callAsClient(addNote, {
      body: "The landlord agreed to any off-white.",
      attach_to: { type: "project", id: "id-0001" },
    }).pipe(Effect.map(answer));
    expect(added.record).toMatchObject({
      property: "Elm Court apartment",
      attached_to: [{ type: "project", id: "id-0001", name: "Kitchen repaint" }],
    });
    expect(yield* sql`SELECT property_id FROM notes WHERE id = 'id-0003'`).toEqual([
      { property_id: "seed-property-elm" },
    ]);
    expect(yield* getting("project", "id-0001")).toMatchObject({
      notes: [{ id: "id-0003", body: "The landlord agreed to any off-white." }],
    });
  }).pipe(Effect.provide(TestDatabase)),
);
