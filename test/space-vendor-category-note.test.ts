import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { onDatabase } from "./support/database.ts";
import { deployWith, eventually, test } from "./support/harness.ts";
import { answerFrom, householdClient, type Answer } from "./support/household.ts";
import { mcp } from "./support/mcp-client.ts";

// What `save_space`, `save_vendor`, `save_category`, and `add_note` do is tested on Node
// SQLite, in packages/core. In the Worker each save is one D1 batch (ADR 0006), a Change can
// hold records of two types, and today's date is read from the Worker's own clock. So these go
// through the real Worker on local D1, with the made-up household loaded. Its Maple Street
// house is the one Current property.

type Fields = Record<string, unknown>;

// What these tests save. Nothing else in the database has these names, and every Note they
// write starts the same way.
const SUNROOM = "Sunroom";
const PORCH = "Sunroom porch";
const GLAZIER = "Lumen Glass";
const CATEGORY = "sunroom-furniture";
const NOTED = "Written through the Worker:";
const CABIN = "Juniper Lane cabin";

// Takes out what these tests wrote. No tool deletes a record yet, and the database is kept
// between runs, so each test starts and ends with this.
const cleanUp = onDatabase(
  `DELETE FROM changes WHERE id IN (
     SELECT change_id FROM change_records
      WHERE (entity_type = 'space'
             AND entity_id IN (SELECT id FROM spaces WHERE name IN ('${SUNROOM}', '${PORCH}')))
         OR (entity_type = 'vendor'
             AND entity_id IN (SELECT id FROM vendors WHERE name = '${GLAZIER}'))
         OR (entity_type = 'category' AND entity_id = '${CATEGORY}')
         OR (entity_type = 'property'
             AND entity_id IN (SELECT id FROM properties WHERE name = '${CABIN}'))
         OR (entity_type = 'note'
             AND entity_id IN (SELECT id FROM notes WHERE body GLOB '${NOTED}*')))`,
  `DELETE FROM notes WHERE body GLOB '${NOTED}*'`,
  `DELETE FROM spaces WHERE name IN ('${SUNROOM}', '${PORCH}')`,
  `DELETE FROM vendors WHERE name = '${GLAZIER}'`,
  `DELETE FROM categories WHERE id = '${CATEGORY}'`,
  `DELETE FROM properties WHERE name = '${CABIN}'`,
);

// A test body that calls tools as a signed-in client, on a database with none of the above.
const asClient = <E, R>(
  body: (
    call: (tool: string, input: unknown) => Effect.Effect<Answer<Fields>>,
  ) => Effect.Effect<void, E, R>,
) =>
  Effect.gen(function* () {
    const client = yield* householdClient;
    yield* cleanUp;
    yield* body((tool, input) =>
      Effect.promise(() => answerFrom<Fields>(client, tool, input)),
    ).pipe(Effect.ensuring(Effect.orDie(cleanUp)));
  });

test(
  "a signed-in client is told what the four tools take, and that they write without destroying",
  Effect.gen(function* () {
    const { url, token } = yield* householdClient;
    const { message } = yield* Effect.promise(() => mcp(url, { method: "tools/list" }, token));
    const { result } = message as { result: { tools: { name: string }[] } };

    // A field says what it is for beside its type, and an optional one takes null or nothing.
    const described = (field: Fields) => ({ ...field, description: expect.any(String) });
    const optional = (field: Fields) => ({ anyOf: [described(field), { type: "null" }] });
    const text = optional({ type: "string" });
    const data = optional({ type: "object" });
    const clear = (field: string) =>
      optional({ type: "array", items: { type: "string", enum: [field] } });

    const inputs: Record<string, { properties: Fields; required?: string[] }> = {
      save_space: { properties: { id: text, name: text, property: text, data } },
      save_vendor: {
        properties: { id: text, name: text, role: text, data, note: text, clear: clear("role") },
      },
      save_category: {
        properties: {
          id: described({ type: "string" }),
          name: text,
          parent: text,
          data,
          clear: clear("parent"),
        },
        required: ["id"],
      },
      add_note: {
        properties: {
          body: described({ type: "string" }),
          attach_to: optional({
            type: "object",
            properties: {
              type: described({
                type: "string",
                enum: ["item", "work", "vendor", "space", "project"],
              }),
              id: described({ type: "string" }),
            },
            required: ["type", "id"],
            additionalProperties: true,
          }),
          property: text,
        },
        required: ["body"],
      },
    };
    for (const [name, input] of Object.entries(inputs)) {
      expect(
        result.tools.find((tool) => tool.name === name),
        name,
      ).toEqual(
        expect.objectContaining({
          description: expect.any(String),
          inputSchema: expect.objectContaining({ type: "object", ...input }),
          // MCP has a client assume a tool may destroy things unless it says otherwise.
          annotations: { readOnlyHint: false, destructiveHint: false },
        }),
      );
    }
  }),
);

// A ULID: 26 characters of Crockford's base 32.
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const WALLS = {
  brand: "Sherwin-Williams",
  color: "Sea Salt",
  code: "SW 6204",
  sheen: "eggshell",
};

test(
  "a Space saved with paint comes back from get_record, with its size and the Property's trim",
  asClient((call) =>
    Effect.gen(function* () {
      // With no Property given, it is the one Current property, by today's date in the Worker.
      const saved = yield* call("save_space", { name: SUNROOM, data: { sqft: 120 } });
      expect(saved).toEqual({
        change_id: expect.stringMatching(ULID),
        created: [{ type: "space", id: expect.stringMatching(ULID), name: SUNROOM }],
        updated: [],
        record: expect.objectContaining({ type: "space", property: "Maple Street house" }),
      });
      const { id } = (saved.created as Fields[])[0]!;

      // The same name in another case is the same Space. On D1 the merge patch and both
      // snapshots are the work of statements inside one batch.
      const painted = yield* call("save_space", {
        name: SUNROOM.toUpperCase(),
        property: "maple street house",
        data: { paint: { walls: WALLS } },
      });
      expect(painted).toMatchObject({ created: [], updated: [{ type: "space", id }] });

      const whole = { id, property_id: "seed-property-maple", name: SUNROOM };
      const record = yield* call("get_record", { type: "space", id });
      expect(record).toMatchObject({
        ...whole,
        property: "Maple Street house",
        data: { sqft: 120, paint: { walls: WALLS } },
        from_property: { paint: { trim: { color: "Pure White" } } },
        changes: [
          {
            id: painted.change_id,
            tool: "save_space",
            before: { ...whole, data: { sqft: 120 } },
            after: { ...whole, data: { sqft: 120, paint: { walls: WALLS } } },
          },
          { id: saved.change_id, before: null, after: { ...whole, data: { sqft: 120 } } },
        ],
      });
      expect(painted.record).toEqual(record);

      // With its id, a Space is renamed, and a name another Space has is refused.
      expect(yield* call("save_space", { id, name: PORCH })).toMatchObject({
        updated: [{ type: "space", id, name: PORCH }],
        record: { name: PORCH, data: { sqft: 120, paint: { walls: WALLS } } },
      });
      expect((yield* call("save_space", { id, name: "kitchen" })).refused).toContain(
        'Another Space at Maple Street house is already named "Kitchen".',
      );
    }),
  ),
);

test(
  "a Vendor saved with a Note is one Change on D1, with both records in it",
  asClient((call) =>
    Effect.gen(function* () {
      const body = `${NOTED} ask for the trade price.`;
      const saved = yield* call("save_vendor", { name: GLAZIER, role: "glazier", note: body });
      expect(saved).toMatchObject({
        change_id: expect.stringMatching(ULID),
        created: [
          { type: "vendor", id: expect.stringMatching(ULID), name: GLAZIER },
          { type: "note", id: expect.stringMatching(ULID), name: body },
        ],
        updated: [],
        record: { type: "vendor", name: GLAZIER, role: "glazier", notes: [{ body }] },
      });
      const [vendor, note] = saved.created as Fields[];

      const made = { id: saved.change_id, tool: "save_vendor", before: null };
      expect(yield* call("get_record", { type: "vendor", id: vendor!.id })).toMatchObject({
        changes: [{ ...made, after: { id: vendor!.id, name: GLAZIER, role: "glazier" } }],
      });
      expect(yield* call("get_record", { type: "note", id: note!.id })).toMatchObject({
        property_id: null,
        attached_to: [{ type: "vendor", id: vendor!.id, name: GLAZIER }],
        changes: [{ ...made, after: { entity_type: "vendor", entity_id: vendor!.id, body } }],
      });

      // The name in another case is the same Vendor, and its role can be emptied.
      expect(
        yield* call("save_vendor", { name: GLAZIER.toLowerCase(), clear: ["role"] }),
      ).toMatchObject({
        created: [],
        updated: [{ type: "vendor", id: vendor!.id, name: GLAZIER }],
        record: { role: null },
      });
    }),
  ),
);

test(
  "a Category saved under a parent shows there in get_schema, and a loop is refused",
  asClient((call) =>
    Effect.gen(function* () {
      const saved = yield* call("save_category", {
        id: CATEGORY,
        name: "Sunroom furniture",
        parent: "furniture",
        data: { expects: ["brand"] },
      });
      expect(saved).toEqual({
        change_id: expect.stringMatching(ULID),
        created: [{ type: "category", id: CATEGORY, name: "Sunroom furniture" }],
        updated: [],
        record: {
          type: "category",
          id: CATEGORY,
          name: "Sunroom furniture",
          parent_id: "furniture",
          parent: "Furniture",
          data: { expects: ["brand"] },
        },
      });

      const schema = yield* call("get_schema", {});
      const furniture = (schema.categories as { id: string; children: unknown[] }[]).find(
        (category) => category.id === "furniture",
      );
      expect(furniture?.children).toContainEqual({
        id: CATEGORY,
        name: "Sunroom furniture",
        expects: ["brand"],
        children: [],
      });

      expect((yield* call("save_category", { id: "furniture", parent: CATEGORY })).refused).toBe(
        `"${CATEGORY}" is under "furniture" already, so "furniture" cannot go under it. That would make a loop.`,
      );
      expect(
        (yield* call("save_category", { id: CATEGORY, parent: "furnishings" })).refused,
      ).toContain('There is no Category "furnishings".');
    }),
  ),
);

test(
  "a Note is added to a Space, and one that stands alone goes to the Current property",
  asClient((call) =>
    Effect.gen(function* () {
      const space = yield* call("save_space", { name: SUNROOM });
      const { id } = (space.created as Fields[])[0]!;

      const onSpace = `${NOTED} the blinds are cordless.`;
      const added = yield* call("add_note", {
        body: onSpace,
        attach_to: { type: "space", id },
      });
      expect(added).toMatchObject({
        change_id: expect.stringMatching(ULID),
        created: [{ type: "note", id: expect.stringMatching(ULID), name: onSpace }],
        record: {
          type: "note",
          body: onSpace,
          property: "Maple Street house",
          attached_to: [{ type: "space", id, name: SUNROOM }],
          changes: [{ id: added.change_id, tool: "add_note", before: null }],
        },
      });
      expect(yield* call("get_record", { type: "space", id })).toMatchObject({
        notes: [{ body: onSpace }],
      });

      const alone = `${NOTED} the water shutoff is behind the washer.`;
      const standing = yield* call("add_note", { body: alone });
      expect(standing.record).toMatchObject({ property: "Maple Street house", attached_to: [] });
      const maple = yield* call("get_record", { type: "property", id: "Maple Street house" });
      expect(maple.notes).toContainEqual(expect.objectContaining({ body: alone }));

      expect(
        (yield* call("add_note", { body: alone, attach_to: { type: "space", id: "no-such" } }))
          .refused,
      ).toContain('There is no Space with the id "no-such".');
    }),
  ),
);

// These change the Worker's settings for one test, so they sit at the end of the file.
test(
  "a timezone that is not one stops a deploy, and the Worker that was there stays",
  Effect.gen(function* () {
    const stopped = yield* Effect.flip(deployWith({ ATTIC_TIMEZONE: "Mars/Olympus" }));
    expect(String(stopped)).toContain('ATTIC_TIMEZONE is "Mars/Olympus", which is not a timezone.');

    const { url, token } = yield* householdClient;
    const { message } = yield* Effect.promise(() => mcp(url, { method: "tools/list" }, token));
    expect(message).toHaveProperty("result.tools");
    // Nothing was deployed, so there is nothing to put back unless this test has failed.
  }).pipe(Effect.ensuring(Effect.orDie(deployWith()))),
);

// The date in a timezone, written the way a date is stored.
const dateIn = (timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone }).format();

// The two timezones furthest from UTC, 14 hours ahead and 12 behind. At any moment the date in
// at least one of them is not the date in UTC.
const AHEAD = "Pacific/Kiritimati";
const BEHIND = "Etc/GMT+12";

test(
  "today is the date in the configured timezone, on the Worker's own clock",
  asClient((call) =>
    Effect.gen(function* () {
      // A timezone where it is another date than in UTC right now, and a last day for the
      // cabin that has passed in one of the two and not in the other: the earlier date.
      const elsewhere = dateIn(AHEAD) === dateIn("UTC") ? BEHIND : AHEAD;
      const lastDay = [dateIn("UTC"), dateIn(elsewhere)].sort()[0]!;
      const saved = yield* call("save_property", { name: CABIN, end_on: lastDay });
      expect(saved.refused).toBeUndefined();

      // What a Worker in a timezone makes of a save that names no Property. Where it is still
      // the cabin's last day, the cabin is current beside the house, and the save is refused.
      // Where that day is over, the house is the one Current property.
      const client = yield* householdClient;
      const holdsIn = (timeZone: string) => async () => {
        const space = await answerFrom<Fields>(client, "save_space", { name: SUNROOM });
        if (dateIn(timeZone) === lastDay) {
          expect(space.refused).toBe(
            `2 Properties are current: ${CABIN}, Maple Street house. Say which one this is for: give \`property\` its id or its name.`,
          );
        } else {
          expect(space.record).toMatchObject({ name: SUNROOM, property: "Maple Street house" });
        }
      };

      // The tests leave the timezone unset, which is UTC.
      yield* Effect.promise(holdsIn("UTC"));
      yield* deployWith({ ATTIC_TIMEZONE: elsewhere }).pipe(
        Effect.andThen(eventually(holdsIn(elsewhere))),
        // Puts the timezone back for whatever runs next, while the cabin is still there to
        // tell which Worker is answering.
        Effect.ensuring(
          deployWith().pipe(Effect.andThen(eventually(holdsIn("UTC"))), Effect.orDie),
        ),
      );
    }),
  ),
);
