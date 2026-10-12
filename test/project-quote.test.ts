import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { onDatabase } from "./support/database.ts";
import { test } from "./support/harness.ts";
import {
  asClientWith,
  householdClient,
  ULID,
  type Call,
  type Fields,
  type Listed,
} from "./support/household.ts";
import { mcp } from "./support/mcp-client.ts";

// What `save_project` and `save_quote` do is tested on Node SQLite, in packages/core. In the
// Worker a save is one D1 batch, and a Project's Spaces are read into its Change by a statement
// inside that batch. A Quote has no column to be named by, so `undo` reads its name with two
// lookups inside the one statement it reads what blocks it with, and `get_record` finds a
// Quote's Changes by what their snapshots say. Those are forms Node SQLite takes and D1 might
// not. So these go through the real Worker on local D1, with the made-up household loaded. Its
// Maple Street house is the one Current property.

// What these tests save. Every name starts with the same word, and nothing else in the database
// has a name that does. A Quote has no name, so it is found by what its `data` says it covers.
const PROJECT = "Pergola build";
const CORNER = "Pergola corner";
const TIMBER = "Pergola Timber Co";
const DECKS = "Pergola and Deck";
const POSTS = "Pergola posts set";
const PERMIT = "Pergola needs no permit under 120 square feet.";
const OURS = `LIKE 'Pergola%'`;

// Takes out what these tests wrote. An undo takes a record out and leaves its Changes, which
// are kept forever, and the database is kept between runs. So the Changes are found by what
// their snapshots call a record, whether the record is still there or not.
const SNAPSHOT = "coalesce(after, before)";
const cleanUp = onDatabase(
  `DELETE FROM changes WHERE id IN (
     SELECT change_id FROM change_records
      WHERE coalesce(json_extract(${SNAPSHOT}, '$.name'),
                     json_extract(${SNAPSHOT}, '$.title'),
                     json_extract(${SNAPSHOT}, '$.body'),
                     json_extract(${SNAPSHOT}, '$.data.includes')) ${OURS})`,
  `DELETE FROM notes WHERE body ${OURS}`,
  `DELETE FROM work WHERE title ${OURS}`,
  `DELETE FROM quotes WHERE json_extract(data, '$.includes') ${OURS}`,
  `DELETE FROM projects WHERE title ${OURS}`,
  `DELETE FROM spaces WHERE name ${OURS}`,
  `DELETE FROM vendors WHERE name ${OURS}`,
);

// A test body that calls tools as a signed-in client, on a database with none of the above.
const asClient = asClientWith(cleanUp);

// How many rows these tests have in each table, as `query` counts them.
const counting = (call: Call) =>
  Effect.map(
    call("query", {
      sql: `SELECT (SELECT count(*) FROM projects WHERE title ${OURS}) AS projects,
                   (SELECT count(*) FROM project_spaces
                     WHERE project_id IN (SELECT id FROM projects WHERE title ${OURS})) AS project_spaces,
                   (SELECT count(*) FROM quotes
                     WHERE json_extract(data, '$.includes') ${OURS}) AS quotes,
                   (SELECT count(*) FROM spaces WHERE name ${OURS}) AS spaces,
                   (SELECT count(*) FROM vendors WHERE name ${OURS}) AS vendors,
                   (SELECT count(*) FROM notes WHERE body ${OURS}) AS notes,
                   (SELECT count(*) FROM work WHERE title ${OURS}) AS work`,
    }),
    (counted) => (counted.rows as [Fields])[0],
  );
const NONE = {
  projects: 0,
  project_spaces: 0,
  quotes: 0,
  spaces: 0,
  vendors: 0,
  notes: 0,
  work: 0,
};

test(
  "a signed-in client is told what save_project and save_quote take",
  Effect.gen(function* () {
    const { url, token } = yield* householdClient;
    const { message } = yield* Effect.promise(() => mcp(url, { method: "tools/list" }, token));
    const { result } = message as {
      result: { tools: { name: string; description: string }[] };
    };
    const tool = (name: string) => result.tools.find((each) => each.name === name);

    // A field says what it is for beside its type, and an optional one takes null or nothing.
    const described = (field: Fields) => ({ ...field, description: expect.any(String) });
    const optional = (field: Fields) => ({ anyOf: [described(field), { type: "null" }] });
    const text = optional({ type: "string" });
    const cleared = (fields: ReadonlyArray<string>) =>
      optional({ type: "array", items: { type: "string", enum: fields } });
    // Every field is optional, and a key that is not one of them is turned away.
    const taking = (properties: Fields) =>
      expect.objectContaining({
        inputSchema: expect.objectContaining({
          type: "object",
          properties,
          additionalProperties: false,
        }),
        // MCP has a client assume a tool may destroy things unless it says otherwise.
        annotations: { readOnlyHint: false, destructiveHint: false },
      });

    expect(tool("save_project")).toEqual(
      taking({
        id: text,
        title: text,
        property: text,
        status: optional({ type: "string", enum: ["open", "done", "dropped"] }),
        start_on: text,
        end_on: text,
        spaces: optional({ type: "array", items: described({ type: "string" }) }),
        data: optional({ type: "object" }),
        note: text,
        clear: cleared(["start_on", "end_on"]),
      }),
    );
    expect(tool("save_quote")).toEqual(
      taking({
        id: text,
        project: text,
        vendor: text,
        // An amount is in dollars, and is never below zero.
        amount: optional({ type: "number", minimum: 0 }),
        quoted_on: text,
        data: optional({ type: "object" }),
        clear: cleared(["amount", "quoted_on"]),
      }),
    );

    // What each description has to say, because nothing else tells a client.
    for (const said of [
      "A Project is not Work.",
      "Two Projects can have the same title",
      "A Project is at one Property and does not move to another.",
      "The list replaces the whole set",
      "its `end_on` is then today, unless the save gives one",
      "Nothing moves or is copied",
      "What the Project is for goes in `data.goal`.",
    ]) {
      expect(tool("save_project")?.description, said).toContain(said);
    }
    for (const said of [
      "what one Vendor said a Project would cost",
      "A Project has one Quote from each Vendor.",
      "a field the save leaves out stays as it was",
      "It is not what was paid",
      "What the amount covers goes in `data.includes`.",
      "A Quote takes no Note.",
      "get_record takes no Quote, because a Quote comes back with its Project.",
      "A reply names it by its Vendor and its Project",
    ]) {
      expect(tool("save_quote")?.description, said).toContain(said);
    }
    // And what the tools beside them say of a Project and a Quote.
    expect(tool("log_work")?.description).toContain(
      "To take Work out of its Project, name `project` in `clear`.",
    );
    expect(tool("get_record")?.description).toContain(
      "a Change that touched a Quote has the Quote's id as `quote_id`",
    );
  }),
);

test(
  "a Project saved with a Space and two Quotes comes back from get_record, and is undone",
  asClient((call) =>
    Effect.gen(function* () {
      // The Space is made on first use, and the Note is written in the same Change.
      const saved = yield* call("save_project", {
        title: PROJECT,
        start_on: "2026-09",
        spaces: [CORNER, "exterior"],
        data: { goal: "A cedar pergola over the patio" },
        note: PERMIT,
      });
      const [corner, project, note] = saved.created as [Listed, Listed, Listed];
      expect(saved).toMatchObject({
        change_id: expect.stringMatching(ULID),
        created: [
          { type: "space", id: expect.stringMatching(ULID), name: CORNER },
          { type: "project", id: expect.stringMatching(ULID), name: PROJECT },
          { type: "note", id: expect.stringMatching(ULID), name: PERMIT },
        ],
        updated: [],
        record: { type: "project", id: project.id, property: "Maple Street house" },
      });

      // Each Quote makes its Vendor on first use, and comes back with the Project.
      const first = yield* call("save_quote", {
        project: project.id,
        vendor: TIMBER,
        amount: 6400.5,
        quoted_on: "2026-09-12",
        data: { includes: "Pergola in cedar, with footings" },
      });
      const [timber, timberQuote] = first.created as [Listed, Listed];
      expect(first.created).toEqual([
        { type: "vendor", id: expect.stringMatching(ULID), name: TIMBER },
        { type: "quote", id: expect.stringMatching(ULID), name: `${TIMBER} for ${PROJECT}` },
      ]);
      const second = yield* call("save_quote", {
        project: project.id,
        vendor: DECKS,
        amount: 5800,
        quoted_on: "2026-09",
        data: { includes: "Pergola in pine, no footings" },
      });
      const [decks, decksQuote] = second.created as [Listed, Listed];
      // A revised Quote takes the place of the old one, whatever the case of the Vendor's name.
      const revised = yield* call("save_quote", {
        project: project.id,
        vendor: DECKS.toUpperCase(),
        amount: 5650,
      });
      expect(revised).toMatchObject({ created: [], updated: [decksQuote] });
      // Work that is done goes into the Project by its id.
      const logged = yield* call("log_work", {
        kind: "improvement",
        title: POSTS,
        date: "2026-10-03",
        cost: 900,
        project: project.id,
      });
      const [posts] = logged.created as [Listed];
      expect(yield* counting(call)).toEqual({
        projects: 1,
        project_spaces: 2,
        quotes: 2,
        spaces: 1,
        vendors: 2,
        notes: 1,
        work: 1,
      });

      const stored = {
        id: project.id,
        property_id: "seed-property-maple",
        title: PROJECT,
        status: "open",
        start_on: "2026-09",
        end_on: null,
        data: { goal: "A cedar pergola over the patio" },
        created_at: expect.any(String),
        updated_at: expect.any(String),
      };
      const quoted = (id: string, vendor: Listed, amount: number, quoted_on: string) => ({
        id,
        project_id: project.id,
        vendor_id: vendor.id,
        amount,
        quoted_on,
        data: expect.any(Object),
        created_at: expect.any(String),
        updated_at: expect.any(String),
      });
      const change = (id: unknown, tool: string) => ({
        id,
        tool,
        created_at: expect.any(String),
        undoes: null,
      });
      const read = yield* call("get_record", { type: "project", id: project.id });
      expect(read).toEqual({
        type: "project",
        ...stored,
        property: "Maple Street house",
        spaces: [
          { id: "seed-space-exterior", name: "Exterior" },
          { id: corner.id, name: CORNER },
        ],
        // Newest first, and a date known only to the month comes after the days in it.
        quotes: [
          {
            id: timberQuote.id,
            vendor: TIMBER,
            vendor_id: timber.id,
            amount: 6400.5,
            quoted_on: "2026-09-12",
            data: { includes: "Pergola in cedar, with footings" },
          },
          {
            id: decksQuote.id,
            vendor: DECKS,
            vendor_id: decks.id,
            amount: 5650,
            quoted_on: "2026-09",
            data: { includes: "Pergola in pine, no footings" },
          },
        ],
        total_cost: 900,
        work: [expect.objectContaining({ id: posts.id, title: POSTS, cost: 900 })],
        documents: [],
        notes: [{ id: note.id, body: PERMIT, created_at: expect.any(String) }],
        // Its own Change, and the Changes of its Quotes, which are found by their snapshots.
        // The Project's own has its Spaces by id, as the batch read them.
        changes: [
          {
            ...change(revised.change_id, "save_quote"),
            quote_id: decksQuote.id,
            before: quoted(decksQuote.id, decks, 5800, "2026-09"),
            after: quoted(decksQuote.id, decks, 5650, "2026-09"),
          },
          {
            ...change(second.change_id, "save_quote"),
            quote_id: decksQuote.id,
            before: null,
            after: quoted(decksQuote.id, decks, 5800, "2026-09"),
          },
          {
            ...change(first.change_id, "save_quote"),
            quote_id: timberQuote.id,
            before: null,
            after: quoted(timberQuote.id, timber, 6400.5, "2026-09-12"),
          },
          {
            ...change(saved.change_id, "save_project"),
            quote_id: null,
            before: null,
            after: { ...stored, spaces: [corner.id, "seed-space-exterior"].sort() },
          },
        ],
      });
      // The reply of the last save of a Quote had the Project as it was then.
      expect(revised.project).toMatchObject({ id: project.id, quotes: read.quotes });

      // The Project is in use, and D1 reads who by in the one statement: a Quote by its
      // Vendor and its Project, which takes two lookups for each.
      const early = yield* call("undo", { change_id: saved.change_id });
      expect(early.refused).toBe(
        `Nothing was undone, because undoing the Change "${String(saved.change_id)}" would take out what other records use now. Point those records elsewhere first, or undo the Changes that made them use it:
The Project "${PROJECT}" (${project.id}) is used by the Quote "${TIMBER} for ${PROJECT}" (${timberQuote.id}), the Quote "${DECKS} for ${PROJECT}" (${decksQuote.id}), the Work "${POSTS}" (${posts.id}).`,
      );

      // Each comes off in turn, newest first. A Quote is restored by an UPDATE that reads its
      // Change, and taken out with the Vendor its save made.
      expect(yield* call("undo", { change_id: logged.change_id })).toMatchObject({
        taken_out: [posts],
      });
      expect(yield* call("undo", { change_id: revised.change_id })).toEqual({
        change_id: expect.stringMatching(ULID),
        taken_out: [],
        restored: [decksQuote],
        put_back: [],
      });
      const restored = yield* call("get_record", { type: "project", id: project.id });
      expect(restored).toMatchObject({
        quotes: [{ id: timberQuote.id }, { id: decksQuote.id, amount: 5800 }],
        total_cost: null,
        changes: [
          { tool: "undo", undoes: revised.change_id, quote_id: decksQuote.id },
          {},
          {},
          {},
          {},
        ],
      });
      expect(yield* call("undo", { change_id: second.change_id })).toMatchObject({
        taken_out: [decksQuote, decks],
      });
      const out = yield* call("undo", { change_id: first.change_id });
      expect(out).toMatchObject({ taken_out: [timberQuote, timber] });
      // An undo that is undone puts the Quote back with its Vendor. The Vendor is not there to
      // ask when the undo reads what to call the Quote, so the Change's own snapshot says.
      const back = yield* call("undo", { change_id: out.change_id });
      expect(back).toEqual({
        change_id: expect.stringMatching(ULID),
        taken_out: [],
        restored: [],
        put_back: [timberQuote, timber],
      });
      expect(yield* call("undo", { change_id: back.change_id })).toMatchObject({
        taken_out: [timberQuote, timber],
      });

      // And then the Project goes, with the Space and the Note its save made.
      expect(yield* call("undo", { change_id: saved.change_id })).toEqual({
        change_id: expect.stringMatching(ULID),
        // By type, and then by id.
        taken_out: [note, project, corner],
        restored: [],
        put_back: [],
      });
      expect(yield* counting(call)).toEqual(NONE);
      expect(yield* call("get_record", { type: "project", id: project.id })).toEqual({
        refused: `There is no Project with the id "${project.id}". Ids come from search and from the records get_record returns.`,
      });
    }),
  ),
);
