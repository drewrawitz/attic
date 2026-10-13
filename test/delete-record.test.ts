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

// What `delete_record` does is tested on Node SQLite, in packages/core. In the Worker a delete
// is one D1 batch, and D1 holds each statement of it to the foreign keys (ADR 0006): what uses
// a record is pointed elsewhere or loses it first, and only then does the record's row go. Its
// one read names the records that go in a `WITH`, and its batch has an `UPDATE OR IGNORE` and
// deletes that read a JSON list. Those are forms Node SQLite takes and D1 might not. So these
// go through the real Worker on local D1, with the made-up household loaded. Its Maple Street
// house is the one Current property.

// What these tests save. Every name starts with the same word, and nothing else in the database
// has a name that does. A Quote has no name, so it is found by what its `data` says it covers.
const KILN = "Kiln for the pottery";
const OUTLET = "Kiln needs a 240 volt outlet.";
const ELEMENTS = "Kiln elements replaced";
const FIRING = "Kiln test firing at the studio";
const CONE = "Kiln reached cone 6.";
const CLAY = "Kiln and Clay";
const SUPPLY = "Kiln & Clay Supply";
const TEXTS = "Kiln and Clay prefers texts.";
const WIRING = "Kiln circuit and wiring";
const OURS = `LIKE 'Kiln%'`;

// The made-up household's one Project, which a Vendor here gives a Quote for.
const LIGHTING = "seed-project-outdoor-lighting";

// Takes out what these tests wrote. A delete takes a record out and leaves its Change, which
// is kept forever, and the database is kept between runs. So the Changes are found by what
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
  `DELETE FROM items WHERE name ${OURS}`,
  `DELETE FROM vendors WHERE name ${OURS}`,
  `DELETE FROM categories WHERE name ${OURS}`,
);

// A test body that calls tools as a signed-in client, on a database with none of the above.
const asClient = asClientWith(cleanUp);

// How many rows these tests have in each table, as `query` counts them.
const counting = (call: Call) =>
  Effect.map(
    call("query", {
      sql: `SELECT (SELECT count(*) FROM items WHERE name ${OURS}) AS items,
                   (SELECT count(*) FROM item_categories
                     WHERE item_id IN (SELECT id FROM items WHERE name ${OURS})) AS item_categories,
                   (SELECT count(*) FROM work WHERE title ${OURS}) AS work,
                   (SELECT count(*) FROM work_items
                     WHERE work_id IN (SELECT id FROM work WHERE title ${OURS})) AS work_items,
                   (SELECT count(*) FROM vendors WHERE name ${OURS}) AS vendors,
                   (SELECT count(*) FROM quotes
                     WHERE json_extract(data, '$.includes') ${OURS}) AS quotes,
                   (SELECT count(*) FROM categories WHERE name ${OURS}) AS categories,
                   (SELECT count(*) FROM notes WHERE body ${OURS}) AS notes`,
    }),
    (counted) => (counted.rows as [Fields])[0],
  );
const NONE = {
  items: 0,
  item_categories: 0,
  work: 0,
  work_items: 0,
  vendors: 0,
  quotes: 0,
  categories: 0,
  notes: 0,
};

// A record as get_record returns it, without its Changes: what it is, whatever was done to it.
const apartFromChanges = (record: Fields) => ({ ...record, changes: undefined });

// What a save created, in the order its reply lists it.
const created = (saved: Fields) => saved.created as Listed[];

test(
  "a signed-in client is told what delete_record takes, and that it is the one tool that destroys",
  Effect.gen(function* () {
    const { url, token } = yield* householdClient;
    const { message } = yield* Effect.promise(() => mcp(url, { method: "tools/list" }, token));
    const { result } = message as {
      result: {
        tools: { name: string; description: string; annotations: { destructiveHint?: boolean } }[];
      };
    };
    const tool = (name: string) => result.tools.find((each) => each.name === name);
    const text = { type: "string", description: expect.any(String) };

    expect(tool("delete_record")).toEqual(
      expect.objectContaining({
        inputSchema: expect.objectContaining({
          type: "object",
          properties: {
            // A Property is among them so that the error can say what to do instead.
            type: {
              ...text,
              enum: [
                "property",
                "space",
                "vendor",
                "category",
                "item",
                "project",
                "quote",
                "work",
                "note",
              ],
            },
            id: text,
            replacement: { anyOf: [text, { type: "null" }] },
          },
          required: ["type", "id"],
          additionalProperties: false,
        }),
        annotations: { readOnlyHint: false, destructiveHint: true },
      }),
    );
    // No other tool is marked as one that may destroy.
    expect(
      result.tools
        .filter(({ annotations }) => annotations.destructiveHint === true)
        .map(({ name }) => name),
    ).toEqual(["delete_record"]);

    // What the description has to say, because nothing else tells a client.
    for (const said of [
      "an Item, Work, a Vendor, a Note, a Category, a Space, a Project, or a Quote",
      "undo puts back what a Change took out",
      "an Item that was returned or thrown away",
      "An Item that was sold, given away, lost, stolen, or destroyed is not deleted.",
      "give it that `status` with save_item instead",
      "A record's Notes go with it.",
      "Work at no Property that named only that Item is deleted with it",
      "the error lists what uses it",
      "delete the duplicate, with the one to keep as its `replacement`",
      "Nothing the deleted record held itself is copied to the other",
      "A replacement for a Space or a Project is one at the same Property.",
      "A replacement for a Category is not one under it.",
      "An Item that would then have a Category twice keeps it once.",
      "A Property is never deleted.",
      "The Category `other` is never deleted either",
      "A record with a Schedule or a Document on it cannot be deleted yet.",
      "what was `removed`, and what was `updated`",
    ]) {
      expect(tool("delete_record")?.description, said).toContain(said);
    }
    // And what log_work could not say before there was a tool to name.
    for (const said of [
      "Replacing an Item is three writes.",
      "Delete the old Item with delete_record.",
      "Save the new Item with save_item",
      "log the Work here as an improvement, with the whole `cost`",
    ]) {
      expect(tool("log_work")?.description, said).toContain(said);
    }
  }),
);

// The kiln comes off its Work before its row goes, and the Work that would be left with
// nothing goes with it. D1 would refuse nothing here if the order were wrong: a foreign key
// would drop the links on its own, and the Change would not have the Work.
test(
  "an Item with a Note and a link from Work is deleted on D1, and put back with undo",
  asClient((call) =>
    Effect.gen(function* () {
      const [item, outlet] = created(
        yield* call("save_item", {
          name: KILN,
          category: "tools",
          extra_categories: ["decor", "office"],
          note: OUTLET,
        }),
      ) as [Listed, Listed];
      const [elements] = created(
        yield* call("log_work", { kind: "repair", title: ELEMENTS, item_ids: [item.id] }),
      ) as [Listed];
      // Work at no Property that names only the kiln.
      const [firing, cone] = created(
        yield* call("log_work", {
          kind: "other",
          title: FIRING,
          item_ids: [item.id],
          note: CONE,
          clear: ["property"],
        }),
      ) as [Listed, Listed];
      const getting = (record: Listed) => call("get_record", { type: record.type, id: record.id });
      const records = [item, outlet, elements, firing, cone];
      const was = yield* Effect.forEach(records, getting);
      expect(yield* counting(call)).toEqual({
        ...NONE,
        items: 1,
        item_categories: 2,
        work: 2,
        work_items: 2,
        notes: 2,
      });

      const removal = yield* call("delete_record", { type: "item", id: item.id });
      expect(removal).toEqual({
        change_id: expect.stringMatching(ULID),
        // The Item, the Work that went with it, and the Notes on either.
        removed: [
          item,
          firing,
          ...[outlet, cone].sort((one, other) => (one.id < other.id ? -1 : 1)),
        ],
        updated: [elements],
      });
      expect(yield* counting(call)).toEqual({ ...NONE, work: 1 });
      expect(yield* getting(item)).toEqual({
        refused: `There is no Item with the id "${item.id}". Ids come from search and from the records get_record returns.`,
      });
      expect(yield* getting(elements)).toMatchObject({ title: ELEMENTS, items: [] });

      // Every row that went or changed is in the Change, as it was before and after.
      const recorded = yield* call("query", {
        sql: `SELECT touched.entity_type AS type, touched.entity_id AS id,
                     touched.before IS NOT NULL AS before, touched.after IS NOT NULL AS after
                FROM change_records AS touched
               WHERE touched.change_id = '${String(removal.change_id)}'
               ORDER BY touched.after, touched.entity_type, touched.entity_id`,
      });
      expect(recorded.rows).toEqual([
        { type: "item", id: item.id, before: 1, after: 0 },
        ...[outlet, cone]
          .map(({ id }) => ({ type: "note", id, before: 1, after: 0 }))
          .sort((one, other) => (one.id < other.id ? -1 : 1)),
        { type: "work", id: firing.id, before: 1, after: 0 },
        { type: "work", id: elements.id, before: 1, after: 1 },
      ]);

      const back = yield* call("undo", { change_id: removal.change_id });
      expect(back).toMatchObject({
        taken_out: [],
        restored: [elements],
        put_back: [{ type: "item" }, { type: "note" }, { type: "note" }, { type: "work" }],
      });
      expect((yield* Effect.forEach(records, getting)).map(apartFromChanges)).toEqual(
        was.map(apartFromChanges),
      );
      expect(yield* getting(item)).toMatchObject({
        extra_categories: [{ id: "decor" }, { id: "office" }],
        work: [{ title: FIRING }, { title: ELEMENTS }],
        notes: [{ body: OUTLET }],
        changes: [
          { tool: "undo", undoes: removal.change_id },
          { id: removal.change_id, tool: "delete_record", after: null },
          { tool: "save_item" },
        ],
      });
    }),
  ),
);

// A Vendor cannot go while a row points at it: D1 refuses the batch at that statement. So the
// Item, the Work, and the Quote are pointed at the other Vendor first.
test(
  "one Vendor is merged into another on D1, and two Quotes that would collide are named",
  asClient((call) =>
    Effect.gen(function* () {
      const [keep] = created(yield* call("save_vendor", { name: CLAY })) as [Listed];
      const [duplicate, texts] = created(
        yield* call("save_vendor", { name: SUPPLY, note: TEXTS }),
      ) as [Listed, Listed];
      const [item] = created(yield* call("save_item", { name: KILN, bought_from: SUPPLY })) as [
        Listed,
      ];
      const [work] = created(
        yield* call("log_work", { kind: "repair", title: ELEMENTS, vendor: SUPPLY }),
      ) as [Listed];
      const [quote] = created(
        yield* call("save_quote", {
          project: LIGHTING,
          vendor: SUPPLY,
          amount: 850,
          data: { includes: WIRING },
        }),
      ) as [Listed];
      const [other] = created(
        yield* call("save_quote", {
          project: LIGHTING,
          vendor: CLAY,
          data: { includes: `${WIRING}, revised` },
        }),
      ) as [Listed];
      const getting = (record: Listed) => call("get_record", { type: record.type, id: record.id });
      const before = yield* counting(call);

      const inUse = yield* call("delete_record", { type: "vendor", id: duplicate.id });
      expect(inUse.refused).toContain(
        `the Vendor "${SUPPLY}" (${duplicate.id}) is used by the Item "${KILN}" (${item.id}), the Quote "${SUPPLY} for Outdoor lighting" (${quote.id}), the Work "${ELEMENTS}" (${work.id}).`,
      );
      // A Project has one Quote from each Vendor, and both of these gave it one.
      const merging = { type: "vendor", id: duplicate.id, replacement: keep.id };
      const colliding = yield* call("delete_record", merging);
      expect(colliding.refused).toContain(
        `The Quote "${SUPPLY} for Outdoor lighting" (${quote.id}) and the Quote "${CLAY} for Outdoor lighting" (${other.id}).`,
      );
      expect(yield* counting(call)).toEqual(before);

      // With the other Quote deleted, the two Vendors are made one.
      expect(yield* call("delete_record", { type: "quote", id: other.id })).toMatchObject({
        removed: [other],
        updated: [],
      });
      const was = yield* getting(duplicate);
      const merged = yield* call("delete_record", merging);
      expect(merged).toEqual({
        change_id: expect.stringMatching(ULID),
        removed: [duplicate],
        // A Quote is named by its Vendor, so it is called by the one it has now.
        updated: [item, { ...quote, name: `${CLAY} for Outdoor lighting` }, work, texts],
      });
      expect(yield* counting(call)).toEqual({ ...before, vendors: 1, quotes: 1 });
      expect(yield* getting(keep)).toMatchObject({
        name: CLAY,
        items: [{ id: item.id }],
        work: [{ id: work.id }],
        quotes: [{ id: quote.id, project_id: LIGHTING, amount: 850 }],
        notes: [{ id: texts.id, body: TEXTS }],
      });

      // Undoing the merge puts the Vendor back, with everything that pointed at it.
      expect(yield* call("undo", { change_id: merged.change_id })).toEqual({
        change_id: expect.stringMatching(ULID),
        taken_out: [],
        restored: [item, texts, quote, work],
        put_back: [duplicate],
      });
      expect(apartFromChanges(yield* getting(duplicate))).toEqual(apartFromChanges(was));
      expect(yield* getting(keep)).toMatchObject({ items: [], work: [], quotes: [], notes: [] });
    }),
  ),
);

// An Item's extra Categories are in a table of their own, which is where a record can come to
// have the replacement twice. D1 would refuse a second link at the statement that made it.
test(
  "a Category is merged into another on D1, and an Item keeps the Category once",
  asClient((call) =>
    Effect.gen(function* () {
      const [glazes, cones, supplies] = ["kiln-glazes", "kiln-cones", "kiln-supplies"];
      yield* call("save_category", { id: glazes, name: "Kiln glazes" });
      yield* call("save_category", { id: cones, name: "Kiln cones", parent: glazes });
      yield* call("save_category", { id: supplies, name: "Kiln supplies" });
      const item = (name: string, category: string, extra_categories: string[]) =>
        Effect.map(
          call("save_item", { name, category, extra_categories }),
          (saved) => created(saved)[0] as Listed,
        );
      // The glazes are the first one's primary Category, and an extra one of the other two.
      const primary = yield* item(`${KILN}, celadon`, glazes!, [supplies!]);
      const extra = yield* item(`${KILN}, shelf wash`, supplies!, [glazes!]);
      const both = yield* item(`${KILN}, brushes`, "tools", [glazes!, supplies!]);
      const filed = Effect.map(
        call("query", {
          sql: `SELECT item.name, item.category_id,
                       (SELECT json_group_array(category_id)
                          FROM (SELECT category_id FROM item_categories
                                 WHERE item_id = item.id ORDER BY category_id)) AS extras
                  FROM items AS item WHERE item.name ${OURS} ORDER BY item.id`,
        }),
        ({ rows }) => rows,
      );
      const was = yield* filed;

      const merged = yield* call("delete_record", {
        type: "category",
        id: glazes,
        replacement: supplies,
      });
      expect(merged).toEqual({
        change_id: expect.stringMatching(ULID),
        removed: [{ type: "category", id: glazes, name: "Kiln glazes" }],
        updated: [{ type: "category", id: cones, name: "Kiln cones" }, primary, extra, both],
      });
      expect(yield* filed).toEqual([
        { name: primary.name, category_id: supplies, extras: "[]" },
        { name: extra.name, category_id: supplies, extras: "[]" },
        { name: both.name, category_id: "tools", extras: `["${supplies}"]` },
      ]);
      const parents = call("query", {
        sql: `SELECT id, parent_id FROM categories WHERE name ${OURS} ORDER BY id`,
      });
      expect((yield* parents).rows).toEqual([
        { id: cones, parent_id: supplies },
        { id: supplies, parent_id: null },
      ]);

      yield* call("undo", { change_id: merged.change_id });
      expect(yield* filed).toEqual(was);
      expect((yield* parents).rows).toEqual([
        { id: cones, parent_id: glazes },
        { id: glazes, parent_id: null },
        { id: supplies, parent_id: null },
      ]);
    }),
  ),
);
