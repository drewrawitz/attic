import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { getSchema } from "../../src/tools/get-schema.ts";
import { saveCategory } from "../../src/tools/save-category.ts";
import { answer, call, callAsClient } from "../call.ts";
import { TestDatabase } from "../TestDatabase.ts";

// A save the way a client sends one: checked against the tool's input first.
const saving = (input: unknown) => callAsClient(saveCategory, input).pipe(Effect.map(answer));

// A Category as get_schema shows it in its tree.
interface Shown {
  readonly id: string;
  readonly name: string;
  readonly expects: ReadonlyArray<string>;
  readonly children: ReadonlyArray<Shown>;
}

// The top-level Category with an id, as get_schema shows it, with everything under it.
const shown = (id: string) =>
  call(getSchema, {}).pipe(
    Effect.map(({ text }) =>
      (JSON.parse(text) as { categories: Shown[] }).categories.find((each) => each.id === id),
    ),
  );

// How many Categories and Changes there are, read from the tables.
const counting = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [counts] = yield* sql<{ categories: number; changes: number; change_records: number }>`
    SELECT (SELECT count(*) FROM categories) AS categories,
           (SELECT count(*) FROM changes) AS changes,
           (SELECT count(*) FROM change_records) AS change_records`;
  return counts;
});

// A Category is not a type get_record takes, so its Changes are read from the log.
const changed = (change: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const records = yield* sql<{ before: string | null; after: string | null }>`
      SELECT changes.tool, touched.entity_type, touched.entity_id, touched.before, touched.after
        FROM change_records AS touched JOIN changes ON changes.id = touched.change_id
       WHERE changes.id = ${change}`;
    return records.map((record) => ({
      ...record,
      before: record.before === null ? null : JSON.parse(record.before),
      after: record.after === null ? null : JSON.parse(record.after),
    }));
  });

// The starter Categories that sit under no other, by id.
const TOP_LEVEL = [
  "appliances (Appliances)",
  "clothing (Clothing)",
  "decor (Art and decor)",
  "electronics (Electronics)",
  "fitness (Fitness)",
  "furniture (Furniture)",
  "instruments (Musical instruments)",
  "jewelry (Jewelry and watches)",
  "kids (Kids and toys)",
  "kitchen (Kitchen)",
  "lighting-plumbing (Lighting and plumbing)",
  "media (Books and media)",
  "office (Office)",
  "other (Other)",
  "outdoor (Outdoor and yard)",
  "sports (Sports and recreation)",
  "systems (Home systems)",
  "tools (Tools)",
  "vehicles (Vehicles)",
].join(", ");

// The starter Categories have `tools`, and `power-tools` under it. A Category's id is the
// client's to choose, so the only id a save takes is the one for its Change.
it.effect(
  "save_category adds a child under a parent, and get_schema shows it there with what it expects",
  () =>
    Effect.gen(function* () {
      const before = yield* counting;

      const saved = yield* saving({
        id: "hand-tools",
        name: "Hand tools",
        parent: "tools",
        data: { expects: ["brand"] },
      });
      const whole = {
        id: "hand-tools",
        name: "Hand tools",
        parent_id: "tools",
        data: { expects: ["brand"] },
      };
      expect(saved).toEqual({
        change_id: "id-0001",
        created: [{ type: "category", id: "hand-tools", name: "Hand tools" }],
        updated: [],
        record: { type: "category", ...whole, parent: "Tools" },
      });

      expect(yield* shown("tools")).toEqual({
        id: "tools",
        name: "Tools",
        expects: [],
        children: [
          { id: "hand-tools", name: "Hand tools", expects: ["brand"], children: [] },
          { id: "power-tools", name: "Power tools", expects: [], children: [] },
        ],
      });

      // One call is one Change, with the record it touched.
      expect(yield* counting).toEqual({
        categories: before!.categories + 1,
        changes: 1,
        change_records: 1,
      });
      expect(yield* changed("id-0001")).toEqual([
        {
          tool: "save_category",
          entity_type: "category",
          entity_id: "hand-tools",
          before: null,
          after: whole,
        },
      ]);
    }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a save under an id that exists updates that Category", () =>
  Effect.gen(function* () {
    const before = yield* counting;

    const saved = yield* saving({
      id: "power-tools",
      name: "Power tools and batteries",
      data: { expects: ["brand", "model"], note: "Cordless first" },
    });
    const was = { id: "power-tools", name: "Power tools", parent_id: "tools", data: {} };
    const is = {
      ...was,
      name: "Power tools and batteries",
      data: { expects: ["brand", "model"], note: "Cordless first" },
    };
    expect(saved).toEqual({
      change_id: "id-0001",
      created: [],
      updated: [{ type: "category", id: "power-tools", name: "Power tools and batteries" }],
      record: { type: "category", ...is, parent: "Tools" },
    });
    expect(yield* changed("id-0001")).toMatchObject([{ before: was, after: is }]);

    // A field left out is left alone, `data` merges, and a list is replaced whole.
    const again = yield* saving({ id: "power-tools", data: { expects: ["serial"], note: null } });
    expect(again.record).toEqual({
      type: "category",
      ...is,
      data: { expects: ["serial"] },
      parent: "Tools",
    });
    expect((yield* counting)?.categories).toBe(before!.categories);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a Category moves under another parent, and to the top when its parent is cleared", () =>
  Effect.gen(function* () {
    expect((yield* saving({ id: "power-tools", parent: "outdoor" })).record).toMatchObject({
      parent_id: "outdoor",
      parent: "Outdoor and yard",
    });
    expect((yield* shown("tools"))?.children).toEqual([]);
    expect((yield* shown("outdoor"))?.children).toMatchObject([{ id: "power-tools" }]);

    expect((yield* saving({ id: "power-tools", clear: ["parent"] })).record).toMatchObject({
      parent_id: null,
      parent: null,
    });
    expect(yield* shown("power-tools")).toMatchObject({ id: "power-tools", children: [] });

    expect(yield* saving({ id: "power-tools", parent: "tools", clear: ["parent"] })).toEqual({
      refused:
        "A field is given a value or cleared, not both in one call. Both were asked for: parent.",
    });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a parent that is not there is refused, with the closest matches by id and name", () =>
  Effect.gen(function* () {
    const before = yield* counting;

    expect(yield* saving({ id: "hand-tools", name: "Hand tools", parent: "tool" })).toEqual({
      refused:
        'There is no Category "tool". The closest are: tools (Tools), power-tools (Power tools). get_schema lists every Category, and save_category adds one.',
    });
    // A name is not an id, but it is how the Category is found.
    expect(
      (yield* saving({ id: "hand-tools", name: "Hand tools", parent: "Home Systems" })).refused,
    ).toContain("The closest are: systems (Home systems).");
    // A misspelling is close to what it was meant to be.
    expect(
      (yield* saving({ id: "blenders", name: "Blenders", parent: "applainces" })).refused,
    ).toContain("The closest are: appliances (Appliances).");
    // Nothing is close to this one. Three Categories that are not close would read as a
    // suggestion, so the error lists the top of the tree, which is where to start looking.
    expect(yield* saving({ id: "trowels", name: "Trowels", parent: "gardening" })).toEqual({
      refused: `There is no Category "gardening". None is close to it. The top-level Categories are: ${TOP_LEVEL}. get_schema lists every Category, and save_category adds one.`,
    });
    expect(yield* counting).toEqual(before);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a parent that would make a loop is refused", () =>
  Effect.gen(function* () {
    yield* saving({ id: "cordless", name: "Cordless", parent: "power-tools" });
    const before = yield* counting;

    expect(yield* saving({ id: "tools", parent: "tools" })).toEqual({
      refused: 'A Category cannot be its own parent: "tools".',
    });
    expect(yield* saving({ id: "tools", parent: "power-tools" })).toEqual({
      refused:
        '"power-tools" is under "tools" already, so "tools" cannot go under it. That would make a loop.',
    });
    // The loop is found however far down the parent sits.
    expect(yield* saving({ id: "tools", parent: "cordless" })).toEqual({
      refused:
        '"cordless" is under "tools" already, so "tools" cannot go under it. That would make a loop.',
    });
    expect(yield* counting).toEqual(before);

    // Moving down a branch that is not its own is no loop.
    expect((yield* saving({ id: "cordless", parent: "tools" })).record).toMatchObject({
      parent_id: "tools",
    });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a new Category needs a name, and an id that is not there may be a misspelling", () =>
  Effect.gen(function* () {
    const before = yield* counting;

    expect(yield* saving({ id: "powertools", data: { expects: ["brand"] } })).toEqual({
      refused:
        'There is no Category "powertools" to update, and a new Category needs a name. The closest are: power-tools (Power tools).',
    });
    expect(yield* counting).toEqual(before);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("an id that is not a slug is refused", () =>
  Effect.gen(function* () {
    const before = yield* counting;

    for (const id of ["Power Tools", "power_tools", "outils-électriques", ""]) {
      expect((yield* saving({ id, name: "Power tools" })).refused, id).toContain(
        "lowercase letters, digits, and hyphens, such as power-tools",
      );
    }
    expect(yield* counting).toEqual(before);
  }).pipe(Effect.provide(TestDatabase)),
);

// Nothing else checks what is stored under `expects`, and get_schema reads anything but a list
// of names as no list at all.
it.effect("data.expects is a list of key names, or null to remove it", () =>
  Effect.gen(function* () {
    const before = yield* counting;

    for (const expects of ["brand", ["brand", 7], { brand: true }, [""]]) {
      expect(
        (yield* saving({ id: "tools", data: { expects } })).refused,
        JSON.stringify(expects),
      ).toContain('data.expects is a list of `data` key names, such as ["brand", "model"]');
    }
    expect(yield* counting).toEqual(before);

    yield* saving({ id: "appliances", data: { expects: null } });
    expect((yield* shown("appliances"))?.expects).toEqual([]);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("clearing the name is refused, with the field that can be cleared", () =>
  Effect.gen(function* () {
    expect((yield* saving({ id: "tools", clear: ["name"] })).refused).toContain('"parent"');
    expect((yield* shown("tools"))?.name).toBe("Tools");
  }).pipe(Effect.provide(TestDatabase)),
);
