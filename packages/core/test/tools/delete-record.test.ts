import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { Listed } from "../../src/records.ts";
import { addNote } from "../../src/tools/add-note.ts";
import { deleteRecord } from "../../src/tools/delete-record.ts";
import { getRecord } from "../../src/tools/get-record.ts";
import { logWork } from "../../src/tools/log-work.ts";
import { saveCategory } from "../../src/tools/save-category.ts";
import { saveItem } from "../../src/tools/save-item.ts";
import { saveProject } from "../../src/tools/save-project.ts";
import { saveProperty } from "../../src/tools/save-property.ts";
import { saveQuote } from "../../src/tools/save-quote.ts";
import { saveSpace } from "../../src/tools/save-space.ts";
import { saveVendor } from "../../src/tools/save-vendor.ts";
import { undo } from "../../src/tools/undo.ts";
import {
  answer,
  call,
  callAsClient,
  readingLog,
  todayIs,
  UNEXPECTED,
  type Answer,
} from "../call.ts";
import { TestDatabase } from "../TestDatabase.ts";

// A call the way a client sends one: checked against the tool's input first.
const calling = (tool: Parameters<typeof callAsClient>[0]) => (input: unknown) =>
  callAsClient(tool, input).pipe(Effect.map(answer));

const deleting = calling(deleteRecord);

const getting = (type: string, id: string) =>
  call(getRecord, { type, id }).pipe(Effect.map(answer));

// What a save created, in the order its reply lists it.
const created = (saved: Answer) => saved.created as Listed[];

// The records a Change has, by type and then by id, each with whether it was there before
// the Change and after it.
const recordedIn = Effect.fnUntraced(function* (changeId: unknown) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ type: string; id: string; before: number; after: number }>`
    SELECT entity_type AS type, entity_id AS id,
           before IS NOT NULL AS before, after IS NOT NULL AS after
      FROM change_records
     WHERE change_id = ${String(changeId)}
     ORDER BY entity_type, entity_id`;
});

// A record a Change deleted, and one it updated, as `recordedIn` has them.
const deleted = ({ type, id }: Listed) => ({ type, id, before: 1, after: 0 });
const changed = ({ type, id }: Listed) => ({ type, id, before: 1, after: 1 });

// How many rows there are in each table a delete can write to.
const counting = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [counted] = yield* sql`
    SELECT (SELECT count(*) FROM items) AS items,
           (SELECT count(*) FROM item_categories) AS item_categories,
           (SELECT count(*) FROM work) AS work,
           (SELECT count(*) FROM work_items) AS work_items,
           (SELECT count(*) FROM work_spaces) AS work_spaces,
           (SELECT count(*) FROM vendors) AS vendors,
           (SELECT count(*) FROM spaces) AS spaces,
           (SELECT count(*) FROM categories) AS categories,
           (SELECT count(*) FROM projects) AS projects,
           (SELECT count(*) FROM project_spaces) AS project_spaces,
           (SELECT count(*) FROM quotes) AS quotes,
           (SELECT count(*) FROM notes) AS notes,
           (SELECT count(*) FROM changes) AS changes,
           (SELECT count(*) FROM change_records) AS change_records`;
  return counted;
});

// The old dishwasher at the Maple Street house: an Item with two Notes, and the Work that
// was done on it.
const savingTheDishwasher = Effect.gen(function* () {
  yield* calling(saveProperty)({ name: "Maple Street house" });
  const saved = yield* calling(saveItem)({
    name: "Dishwasher",
    scope: "fixture",
    category: "appliances",
    extra_categories: ["kitchen"],
    note: "Came with the place.",
  });
  const [dishwasher, first] = created(saved) as [Listed, Listed];
  const added = yield* calling(addNote)({
    body: "The door latch sticks.",
    attach_to: { type: "item", id: dishwasher.id },
  });
  const [second] = created(added) as [Listed];
  const logged = yield* calling(logWork)({
    kind: "repair",
    title: "Replaced the drain pump",
    item_ids: [dishwasher.id],
  });
  const [pump] = created(logged) as [Listed];
  return { dishwasher, notes: [first, second], pump };
});

it.effect("an Item is deleted with its Notes, and comes off the Work that named it", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { dishwasher, notes, pump } = yield* savingTheDishwasher;

    const reply = yield* deleting({ type: "item", id: dishwasher.id });
    expect(reply).toEqual({
      change_id: expect.any(String),
      removed: [dishwasher, ...notes],
      updated: [pump],
    });

    expect(yield* getting("item", dishwasher.id)).toEqual({
      refused: `There is no Item with the id "${dishwasher.id}". Ids come from search and from the records get_record returns.`,
    });
    expect(yield* sql`SELECT count(*) AS notes FROM notes`).toEqual([{ notes: 0 }]);
    expect(yield* sql`SELECT count(*) AS extras FROM item_categories`).toEqual([{ extras: 0 }]);
    // The Work stays, as the history of the Property, without the Item.
    expect(yield* getting("work", pump.id)).toMatchObject({
      title: "Replaced the drain pump",
      property: "Maple Street house",
      items: [],
    });

    // The Change has all four records: the three that went, and the Work that lost the Item.
    expect(
      yield* sql`SELECT tool, undoes FROM changes WHERE id = ${String(reply.change_id)}`,
    ).toEqual([{ tool: "delete_record", undoes: null }]);
    expect(yield* recordedIn(reply.change_id)).toEqual([
      deleted(dishwasher),
      ...notes.map(deleted),
      changed(pump),
    ]);
  }).pipe(Effect.provide(TestDatabase)),
);

// Work needs a Property or at least one Item. A bike tuned at a shop is Work at no Property,
// so once the bike is deleted that Work is about nothing at all.
it.effect("Work at no Property that named only the deleted Item goes with it, and its Note", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* calling(saveProperty)({ name: "Maple Street house" });
    const [bike] = created(yield* calling(saveItem)({ name: "Road bike" })) as [Listed];
    const [helmet] = created(yield* calling(saveItem)({ name: "Helmet" })) as [Listed];
    const tuned = yield* calling(logWork)({
      kind: "maintenance",
      title: "Tuned the bike at the shop",
      item_ids: [bike.id],
      note: "New chain and brake pads.",
      clear: ["property"],
    });
    const [tuneUp, chain] = created(tuned) as [Listed, Listed];
    // Work at no Property that names another Item as well is still about that one.
    const [fitting] = created(
      yield* calling(logWork)({
        kind: "other",
        title: "Fitted the bike and the helmet",
        item_ids: [bike.id, helmet.id],
        clear: ["property"],
      }),
    ) as [Listed];
    // And Work at a Property is still part of the history of the Property.
    const [rack] = created(
      yield* calling(logWork)({
        kind: "improvement",
        title: "Hung the bike rack",
        item_ids: [bike.id],
      }),
    ) as [Listed];

    const reply = yield* deleting({ type: "item", id: bike.id });
    expect(reply).toEqual({
      change_id: expect.any(String),
      removed: [bike, tuneUp, chain],
      updated: [fitting, rack],
    });

    expect(yield* sql`SELECT title FROM work ORDER BY title`).toEqual([
      { title: "Fitted the bike and the helmet" },
      { title: "Hung the bike rack" },
    ]);
    expect(yield* sql`SELECT count(*) AS notes FROM notes`).toEqual([{ notes: 0 }]);
    expect(yield* getting("work", fitting.id)).toMatchObject({
      property: null,
      items: [{ id: helmet.id, name: "Helmet" }],
    });
    expect(yield* getting("work", rack.id)).toMatchObject({
      property: "Maple Street house",
      items: [],
    });
    expect(yield* recordedIn(reply.change_id)).toEqual([
      deleted(bike),
      deleted(chain),
      deleted(tuneUp),
      changed(fitting),
      changed(rack),
    ]);
  }).pipe(Effect.provide(TestDatabase)),
);

// Seven Items bought from one Vendor, which is two more than an error names.
const savingSevenFromAce = Effect.gen(function* () {
  yield* calling(saveProperty)({ name: "Maple Street house" });
  const saved = yield* calling(saveItem)({
    items: ["Faucet", "Hose", "Ladder", "Mallet", "Pliers", "Sander", "Trowel"].map((name) => ({
      name,
      bought_from: "Ace Hardware",
    })),
  });
  const [ace, ...items] = created(saved) as [Listed, ...Listed[]];
  return { ace, items };
});

it.effect("a Vendor that Items were bought from is refused, and the error names them", () =>
  Effect.gen(function* () {
    const { ace, items } = yield* savingSevenFromAce;
    const before = yield* counting;

    const named = items.slice(0, 5).map(({ id, name }) => `the Item "${name}" (${id})`);
    expect(yield* deleting({ type: "vendor", id: ace.id })).toEqual({
      refused: `Nothing was deleted, because the Vendor "Ace Hardware" (${ace.id}) is used by ${named.join(", ")}, and 2 more. To delete it all the same, give \`replacement\` the id of the Vendor they should use instead. They are then pointed at that one, and this one is deleted, in one Change.`,
    });
    // Nothing is written: every row is there, and there is no Change.
    expect(yield* counting).toEqual(before);
  }).pipe(Effect.provide(TestDatabase)),
);

// Its own Notes go with it, so they do not hold it there.
it.effect("a Vendor that only its own Notes are on is deleted with them", () =>
  Effect.gen(function* () {
    const saved = yield* calling(saveVendor)({
      name: "Ace Hardware",
      note: "Closed on Sundays.",
    });
    const [ace, sundays] = created(saved) as [Listed, Listed];

    expect(yield* deleting({ type: "vendor", id: ace.id })).toEqual({
      change_id: expect.any(String),
      removed: [ace, sundays],
      updated: [],
    });
    expect(yield* counting).toMatchObject({ vendors: 0, notes: 0 });
  }).pipe(Effect.provide(TestDatabase)),
);

// Two records of one Vendor: an Item, a piece of Work, a Quote, and a Note are on the one that
// was misspelled, and the other is the one to keep.
const savingTwoOfOneVendor = Effect.gen(function* () {
  yield* calling(saveProperty)({ name: "Maple Street house" });
  const [keep] = created(yield* calling(saveVendor)({ name: "Brightside Electric" })) as [Listed];
  const [duplicate, texts] = created(
    yield* calling(saveVendor)({
      name: "Briteside Electric",
      role: "electrician",
      data: { phone: "555-0163" },
      note: "Prefers texts.",
    }),
  ) as [Listed, Listed];
  const [lighting] = created(yield* calling(saveProject)({ title: "Outdoor lighting" })) as [
    Listed,
  ];
  const [transformer] = created(
    yield* calling(saveItem)({ name: "Transformer", bought_from: duplicate.name }),
  ) as [Listed];
  const [wiring] = created(
    yield* calling(logWork)({
      kind: "improvement",
      title: "Ran the low-voltage wiring",
      vendor: duplicate.name,
    }),
  ) as [Listed];
  const [quote] = created(
    yield* calling(saveQuote)({ project: lighting.id, vendor: duplicate.name, amount: 4200 }),
  ) as [Listed];
  return { keep, duplicate, texts, lighting, transformer, wiring, quote };
});

it.effect("a Vendor deleted with a replacement is merged into it, in one Change", () =>
  Effect.gen(function* () {
    const { keep, duplicate, texts, lighting, transformer, wiring, quote } =
      yield* savingTwoOfOneVendor;
    expect(quote.name).toBe("Briteside Electric for Outdoor lighting");
    const before = yield* counting;

    const reply = yield* deleting({ type: "vendor", id: duplicate.id, replacement: keep.id });
    expect(reply).toEqual({
      change_id: expect.any(String),
      removed: [duplicate],
      // A Quote is named by its Vendor, so it is called by the one it has now.
      updated: [
        transformer,
        { ...quote, name: "Brightside Electric for Outdoor lighting" },
        wiring,
        texts,
      ],
    });

    // Everything that pointed at the one points at the other, its Note included. Nothing the
    // one held itself is copied: its role and its `data` went with it.
    expect(yield* getting("vendor", keep.id)).toMatchObject({
      name: "Brightside Electric",
      role: null,
      data: {},
      items: [{ id: transformer.id }],
      work: [{ id: wiring.id }],
      quotes: [{ id: quote.id, project_id: lighting.id, amount: 4200 }],
      notes: [{ id: texts.id, body: "Prefers texts." }],
    });
    expect(yield* getting("vendor", duplicate.id)).toEqual({
      refused: `There is no Vendor with the id "${duplicate.id}". Ids come from search and from the records get_record returns.`,
    });
    expect(yield* counting).toEqual({
      ...before,
      vendors: 1,
      changes: Number(before?.changes) + 1,
      change_records: Number(before?.change_records) + 5,
    });
    expect(yield* recordedIn(reply.change_id)).toEqual([
      changed(transformer),
      changed(texts),
      changed(quote),
      deleted(duplicate),
      changed(wiring),
    ]);
  }).pipe(Effect.provide(TestDatabase)),
);

// A Project has one Quote from each Vendor. Two Vendors that are made one cannot both have
// quoted it.
it.effect("merging two Vendors that both quoted one Project is refused, and names the Quotes", () =>
  Effect.gen(function* () {
    const { keep, duplicate, lighting, quote } = yield* savingTwoOfOneVendor;
    const [other] = created(
      yield* calling(saveQuote)({ project: lighting.id, vendor: keep.name, amount: 3900 }),
    ) as [Listed];
    const before = yield* counting;

    expect(yield* deleting({ type: "vendor", id: duplicate.id, replacement: keep.id })).toEqual({
      refused: `Nothing was deleted, because two records would then be one and the same. A Quote cannot have the same Project and Vendor as another.
The Quote "Briteside Electric for Outdoor lighting" (${quote.id}) and the Quote "Brightside Electric for Outdoor lighting" (${other.id}).
Delete one of the two first, or point it elsewhere, and then delete the Vendor "Briteside Electric" (${duplicate.id}).`,
    });
    expect(yield* counting).toEqual(before);

    // With one of the two Quotes deleted, the Vendors are merged.
    expect(yield* deleting({ type: "quote", id: quote.id })).toMatchObject({ removed: [quote] });
    expect(
      yield* deleting({ type: "vendor", id: duplicate.id, replacement: keep.id }),
    ).toMatchObject({ removed: [duplicate] });
    expect(yield* getting("vendor", keep.id)).toMatchObject({ quotes: [{ id: other.id }] });
  }).pipe(Effect.provide(TestDatabase)),
);

// A pantry that is to be folded into the kitchen: an Item is in it, two pieces of Work and a
// Project named it, and a Note is on it. The former Property has a kitchen of its own.
const savingThePantry = Effect.gen(function* () {
  yield* todayIs("2026-10-12");
  yield* calling(saveProperty)({ name: "Elm Court apartment", end_on: "2022-07-31" });
  yield* calling(saveProperty)({ name: "Maple Street house" });
  const [elsewhere] = created(
    yield* calling(saveSpace)({ name: "Kitchen", property: "Elm Court apartment" }),
  ) as [Listed];
  const [kitchen] = created(yield* calling(saveSpace)({ name: "Kitchen" })) as [Listed];
  const [pantry] = created(yield* calling(saveSpace)({ name: "Pantry" })) as [Listed];
  const [shelf] = created(yield* calling(saveItem)({ name: "Wire shelf", space: "Pantry" })) as [
    Listed,
  ];
  const [painted] = created(
    yield* calling(logWork)({
      kind: "improvement",
      title: "Painted the pantry",
      spaces: ["Pantry"],
    }),
  ) as [Listed];
  // This one named both, so it has the kitchen already.
  const [tiled] = created(
    yield* calling(logWork)({
      kind: "improvement",
      title: "Tiled the floor",
      spaces: ["Kitchen", "Pantry"],
    }),
  ) as [Listed];
  const [remodel] = created(
    yield* calling(saveProject)({ title: "Kitchen remodel", spaces: ["Pantry"] }),
  ) as [Listed];
  const [dim] = created(
    yield* calling(addNote)({
      body: "The light switch is behind the door.",
      attach_to: { type: "space", id: pantry.id },
    }),
  ) as [Listed];
  return { elsewhere, kitchen, pantry, shelf, painted, tiled, remodel, dim };
});

it.effect("a Space in use is refused, and is merged into a replacement at its Property", () =>
  Effect.gen(function* () {
    const { elsewhere, kitchen, pantry, shelf, painted, tiled, remodel, dim } =
      yield* savingThePantry;
    const before = yield* counting;

    expect(yield* deleting({ type: "space", id: pantry.id })).toEqual({
      refused: `Nothing was deleted, because the Space "Pantry" (${pantry.id}) is used by the Item "Wire shelf" (${shelf.id}), the Project "Kitchen remodel" (${remodel.id}), the Work "Painted the pantry" (${painted.id}), the Work "Tiled the floor" (${tiled.id}). To delete it all the same, give \`replacement\` the id of the Space they should use instead. They are then pointed at that one, and this one is deleted, in one Change.`,
    });
    // What is in a Space is at the Space's Property, so the other Space is one there too.
    expect(yield* deleting({ type: "space", id: pantry.id, replacement: elsewhere.id })).toEqual({
      refused: `Nothing was deleted, because the Space "Pantry" (${pantry.id}) is at Maple Street house, and the Space "Kitchen" (${elsewhere.id}) is at Elm Court apartment. A replacement for a Space is a Space at the same Property.`,
    });
    expect(yield* counting).toEqual(before);

    const reply = yield* deleting({ type: "space", id: pantry.id, replacement: kitchen.id });
    expect(reply).toEqual({
      change_id: expect.any(String),
      removed: [pantry],
      updated: [shelf, remodel, painted, tiled, dim],
    });
    expect(yield* getting("space", kitchen.id)).toMatchObject({
      name: "Kitchen",
      property: "Maple Street house",
      items: [{ id: shelf.id }],
      work: [{ id: tiled.id }, { id: painted.id }],
      projects: [{ id: remodel.id }],
      notes: [{ id: dim.id }],
    });
    // The Work that named both names the kitchen once.
    expect(yield* getting("work", tiled.id)).toMatchObject({
      spaces: [{ id: kitchen.id, name: "Kitchen" }],
    });
    expect(yield* getting("project", remodel.id)).toMatchObject({
      spaces: [{ id: kitchen.id, name: "Kitchen" }],
    });
    expect(yield* counting).toMatchObject({ spaces: 2, work_spaces: 2, project_spaces: 1 });
    expect(yield* recordedIn(reply.change_id)).toEqual([
      changed(shelf),
      changed(dim),
      changed(remodel),
      deleted(pantry),
      changed(painted),
      changed(tiled),
    ]);
  }).pipe(Effect.provide(TestDatabase)),
);

// Cardio is under fitness, and treadmills are under cardio. Cardio is to be folded into
// sports. Four Items have it, each in another way.
const CARDIO = { type: "category", id: "cardio", name: "Cardio" } as const;
const TREADMILLS = { type: "category", id: "treadmills", name: "Treadmills" } as const;

const savingCardio = Effect.gen(function* () {
  yield* calling(saveProperty)({ name: "Maple Street house" });
  yield* calling(saveCategory)({ id: CARDIO.id, name: CARDIO.name, parent: "fitness" });
  yield* calling(saveCategory)({ id: TREADMILLS.id, name: TREADMILLS.name, parent: CARDIO.id });
  const item = (name: string, category: string, extra_categories: string[]) =>
    Effect.map(
      calling(saveItem)({ name, category, extra_categories }),
      (saved) => created(saved)[0] as Listed,
    );
  return {
    // Cardio is its primary Category, and it has no other.
    rower: yield* item("Rowing machine", CARDIO.id, []),
    // Cardio is its primary Category, and sports is an extra one already.
    bike: yield* item("Exercise bike", CARDIO.id, ["sports"]),
    // Sports is its primary Category already, and cardio is an extra one.
    rope: yield* item("Jump rope", "sports", [CARDIO.id]),
    // Both are extra ones.
    watch: yield* item("Running watch", "electronics", [CARDIO.id, "sports"]),
  };
});

// An Item's primary Category and its extra ones, as they are stored.
const categoriesOf = Effect.fnUntraced(function* (item: Listed) {
  const sql = yield* SqlClient.SqlClient;
  const [found] = yield* sql<{ primary_id: string; extras: string }>`
    SELECT category_id AS primary_id,
           (SELECT json_group_array(category_id)
              FROM (SELECT category_id FROM item_categories
                     WHERE item_id = item.id ORDER BY category_id)) AS extras
      FROM items AS item WHERE id = ${item.id}`;
  return { primary: found?.primary_id, extras: JSON.parse(found?.extras ?? "[]") as string[] };
});

it.effect("a Category in use is refused, and is merged into a replacement", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { rower, bike, rope, watch } = yield* savingCardio;
    const before = yield* counting;

    // A Category under it uses it, and so does an Item that has it either way.
    expect(yield* deleting({ type: "category", id: CARDIO.id })).toEqual({
      refused: `Nothing was deleted, because the Category "Cardio" (cardio) is used by the Category "Treadmills" (treadmills), the Item "Rowing machine" (${rower.id}), the Item "Exercise bike" (${bike.id}), the Item "Jump rope" (${rope.id}), the Item "Running watch" (${watch.id}). To delete it all the same, give \`replacement\` the id of the Category they should use instead. They are then pointed at that one, and this one is deleted, in one Change.`,
    });
    expect(yield* counting).toEqual(before);

    const reply = yield* deleting({ type: "category", id: CARDIO.id, replacement: "sports" });
    expect(reply).toEqual({
      change_id: expect.any(String),
      removed: [CARDIO],
      updated: [TREADMILLS, rower, bike, rope, watch],
    });

    // The Category under it is under the other one now.
    expect(
      yield* sql`SELECT id, parent_id FROM categories WHERE id IN ('cardio', 'treadmills')`,
    ).toEqual([{ id: "treadmills", parent_id: "sports" }]);
    // And each Item has the other one once: as its primary Category, or as an extra one.
    expect(yield* categoriesOf(rower)).toEqual({ primary: "sports", extras: [] });
    expect(yield* categoriesOf(bike)).toEqual({ primary: "sports", extras: [] });
    expect(yield* categoriesOf(rope)).toEqual({ primary: "sports", extras: [] });
    expect(yield* categoriesOf(watch)).toEqual({ primary: "electronics", extras: ["sports"] });
    expect(yield* recordedIn(reply.change_id)).toEqual([
      deleted(CARDIO),
      changed(TREADMILLS),
      ...[rower, bike, rope, watch].map(changed),
    ]);
  }).pipe(Effect.provide(TestDatabase)),
);

// An Item is in the Category `other` when a save names none, which is the table's own default.
it.effect("the Category an Item is in by default is never deleted", () =>
  Effect.gen(function* () {
    yield* calling(saveProperty)({ name: "Maple Street house" });
    const before = yield* counting;
    const never =
      'The Category "other" is never deleted: an Item is in it when a save names no Category. To call it something else, save it with save_category and a new name.';

    expect(yield* deleting({ type: "category", id: "other" })).toEqual({ refused: never });
    expect(yield* deleting({ type: "category", id: "other", replacement: "decor" })).toEqual({
      refused: never,
    });
    expect(yield* counting).toEqual(before);
    // So a save that names no Category still has one to put the Item in.
    expect(yield* calling(saveItem)({ name: "Doorstop" })).toMatchObject({
      record: { category_id: "other" },
    });
    // Another Category can be merged into it.
    expect(yield* deleting({ type: "category", id: "decor", replacement: "other" })).toMatchObject({
      removed: [{ type: "category", id: "decor" }],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// What is under a Category goes under its replacement. A replacement that is under it would
// then be under itself.
it.effect("a replacement that is under the Category, or is the Category, is refused", () =>
  Effect.gen(function* () {
    yield* savingCardio;
    yield* calling(saveCategory)({
      id: "folding",
      name: "Folding treadmills",
      parent: "treadmills",
    });
    const before = yield* counting;

    for (const [under, name] of [
      ["treadmills", "Treadmills"],
      ["folding", "Folding treadmills"],
    ]) {
      expect(yield* deleting({ type: "category", id: CARDIO.id, replacement: under })).toEqual({
        refused: `Nothing was deleted, because the Category "${name}" (${under}) is under the Category "Cardio" (cardio). What is under a Category goes under its replacement, so that one would be under itself. Give a replacement that is not under it.`,
      });
    }
    expect(yield* deleting({ type: "category", id: CARDIO.id, replacement: CARDIO.id })).toEqual({
      refused:
        "A Category cannot be its own replacement. Give `replacement` the id of another Category, or leave it out.",
    });
    // One that is not there is an error that lists the closest, as it is everywhere else.
    expect(yield* deleting({ type: "category", id: CARDIO.id, replacement: "sport" })).toEqual({
      refused:
        'There is no Category "sport". The closest are: sports (Sports and recreation). get_schema lists every Category, and save_category adds one.',
    });
    expect(yield* deleting({ type: "category", id: "cardoi" })).toEqual({
      refused:
        'There is no Category "cardoi". The closest are: cardio (Cardio). get_schema lists every Category, and save_category adds one.',
    });
    expect(yield* counting).toEqual(before);
  }).pipe(Effect.provide(TestDatabase)),
);

// Two Projects for the one effort. The first has a Space, a Quote, a piece of Work, and a Note.
// The former Property has a Project too.
const savingTwoProjects = Effect.gen(function* () {
  yield* todayIs("2026-10-12");
  yield* calling(saveProperty)({ name: "Elm Court apartment", end_on: "2022-07-31" });
  yield* calling(saveProperty)({ name: "Maple Street house" });
  const [elsewhere] = created(
    yield* calling(saveProject)({ title: "Balcony lights", property: "Elm Court apartment" }),
  ) as [Listed];
  const [keep] = created(yield* calling(saveProject)({ title: "Yard lighting" })) as [Listed];
  const [exterior, duplicate, hoa] = created(
    yield* calling(saveProject)({
      title: "Outdoor lighting",
      spaces: ["Exterior"],
      note: "The HOA approved the fixtures.",
    }),
  ) as [Listed, Listed, Listed];
  const [brightside, quote] = created(
    yield* calling(saveQuote)({ project: duplicate.id, vendor: "Brightside Electric" }),
  ) as [Listed, Listed];
  const [trench] = created(
    yield* calling(logWork)({
      kind: "improvement",
      title: "Dug the trench",
      project: duplicate.id,
    }),
  ) as [Listed];
  return { elsewhere, keep, exterior, duplicate, hoa, brightside, quote, trench };
});

it.effect("a Project with a Quote and Work is refused, and goes with a replacement", () =>
  Effect.gen(function* () {
    const { elsewhere, keep, duplicate, hoa, brightside, quote, trench } = yield* savingTwoProjects;
    const before = yield* counting;

    expect(yield* deleting({ type: "project", id: duplicate.id })).toEqual({
      refused: `Nothing was deleted, because the Project "Outdoor lighting" (${duplicate.id}) is used by the Quote "Brightside Electric for Outdoor lighting" (${quote.id}), the Work "Dug the trench" (${trench.id}). To delete it all the same, give \`replacement\` the id of the Project they should use instead. They are then pointed at that one, and this one is deleted, in one Change.`,
    });
    // Work in a Project is at the Project's Property, so the other Project is one there too.
    expect(
      yield* deleting({ type: "project", id: duplicate.id, replacement: elsewhere.id }),
    ).toEqual({
      refused: `Nothing was deleted, because the Project "Outdoor lighting" (${duplicate.id}) is at Maple Street house, and the Project "Balcony lights" (${elsewhere.id}) is at Elm Court apartment. A replacement for a Project is a Project at the same Property.`,
    });
    expect(yield* counting).toEqual(before);

    const reply = yield* deleting({ type: "project", id: duplicate.id, replacement: keep.id });
    expect(reply).toEqual({
      change_id: expect.any(String),
      removed: [duplicate],
      // A Quote is named by its Project, so it is called by the one it has now.
      updated: [{ ...quote, name: "Brightside Electric for Yard lighting" }, trench, hoa],
    });
    expect(yield* getting("project", keep.id)).toMatchObject({
      title: "Yard lighting",
      // The Spaces of a Project are its own, and went with it.
      spaces: [],
      quotes: [{ id: quote.id, vendor_id: brightside.id }],
      work: [{ id: trench.id }],
      notes: [{ id: hoa.id }],
    });
    expect(yield* counting).toMatchObject({ projects: 2, project_spaces: 0, quotes: 1, work: 1 });
    expect(yield* recordedIn(reply.change_id)).toEqual([
      changed(hoa),
      deleted(duplicate),
      changed(quote),
      changed(trench),
    ]);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("merging two Projects that one Vendor quoted is refused, and names the Quotes", () =>
  Effect.gen(function* () {
    const { keep, duplicate, quote } = yield* savingTwoProjects;
    const [other] = created(
      yield* calling(saveQuote)({ project: keep.id, vendor: "Brightside Electric" }),
    ) as [Listed];
    const before = yield* counting;

    expect(yield* deleting({ type: "project", id: duplicate.id, replacement: keep.id })).toEqual({
      refused: `Nothing was deleted, because two records would then be one and the same. A Quote cannot have the same Project and Vendor as another.
The Quote "Brightside Electric for Outdoor lighting" (${quote.id}) and the Quote "Brightside Electric for Yard lighting" (${other.id}).
Delete one of the two first, or point it elsewhere, and then delete the Project "Outdoor lighting" (${duplicate.id}).`,
    });
    expect(yield* counting).toEqual(before);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a Note and a Quote are each deleted on their own", () =>
  Effect.gen(function* () {
    const { duplicate, hoa, brightside, quote } = yield* savingTwoProjects;
    const before = yield* counting;

    const withoutNote = yield* deleting({ type: "note", id: hoa.id });
    expect(withoutNote).toEqual({ change_id: expect.any(String), removed: [hoa], updated: [] });
    expect(yield* recordedIn(withoutNote.change_id)).toEqual([deleted(hoa)]);

    const withoutQuote = yield* deleting({ type: "quote", id: quote.id });
    expect(withoutQuote).toEqual({ change_id: expect.any(String), removed: [quote], updated: [] });
    expect(yield* recordedIn(withoutQuote.change_id)).toEqual([deleted(quote)]);

    // The Project and the Vendor are as they were, without the Note and the Quote.
    expect(yield* getting("project", duplicate.id)).toMatchObject({ notes: [], quotes: [] });
    expect(yield* getting("vendor", brightside.id)).toMatchObject({ quotes: [] });
    expect(yield* counting).toEqual({
      ...before,
      notes: Number(before?.notes) - 1,
      quotes: Number(before?.quotes) - 1,
      changes: Number(before?.changes) + 2,
      change_records: Number(before?.change_records) + 2,
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// Work has Items and Spaces in tables of their own, and Notes on it.
it.effect("Work is deleted with its Notes, and its Items and Spaces stay", () =>
  Effect.gen(function* () {
    const { pantry, shelf } = yield* savingThePantry;
    const [swapped, loose] = created(
      yield* calling(logWork)({
        kind: "repair",
        title: "Swapped the shelf brackets",
        item_ids: [shelf.id],
        spaces: ["Pantry"],
        note: "One bracket was loose.",
      }),
    ) as [Listed, Listed];
    const before = yield* counting;

    expect(yield* deleting({ type: "work", id: swapped.id })).toEqual({
      change_id: expect.any(String),
      removed: [swapped, loose],
      updated: [],
    });
    expect(yield* counting).toEqual({
      ...before,
      work: Number(before?.work) - 1,
      work_items: Number(before?.work_items) - 1,
      work_spaces: Number(before?.work_spaces) - 1,
      notes: Number(before?.notes) - 1,
      changes: Number(before?.changes) + 1,
      change_records: Number(before?.change_records) + 2,
    });
    expect(yield* getting("item", shelf.id)).toMatchObject({ name: "Wire shelf", work: [] });
    expect(yield* getting("space", pantry.id)).toMatchObject({ name: "Pantry" });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a Property is never deleted, and the error says to give it an end date", () =>
  Effect.gen(function* () {
    const { dishwasher } = yield* savingTheDishwasher;
    const before = yield* counting;
    const [property] = yield* (yield* SqlClient.SqlClient)<{
      id: string;
    }>`SELECT id FROM properties`;

    expect(yield* deleting({ type: "property", id: property?.id })).toEqual({
      refused:
        "A Property is never deleted. One that is no longer the User's gets an end date instead: save it with save_property and give `end_on` the day it stopped being theirs. Its records stay as they are.",
    });
    // Nothing points at an Item in a way that has to be pointed elsewhere.
    expect(
      yield* deleting({ type: "item", id: dishwasher.id, replacement: dishwasher.id }),
    ).toEqual({
      refused:
        "`replacement` is only for a Vendor, a Space, a Category, or a Project: it is the record that what uses the deleted one is pointed at instead. Leave it out for a record of any other type.",
    });
    expect(yield* counting).toEqual(before);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect.each([
  { type: "item", where: "Ids come from search and from the records get_record returns." },
  { type: "work", where: "Ids come from search and from the records get_record returns." },
  { type: "vendor", where: "Ids come from search and from the records get_record returns." },
  { type: "space", where: "Ids come from search and from the records get_record returns." },
  { type: "project", where: "Ids come from search and from the records get_record returns." },
  { type: "note", where: "Ids come from search and from the records get_record returns." },
  {
    type: "quote",
    where: "A Quote's id is in the record of its Project, which get_record returns.",
  },
])("a $type that is not there is an error that names the id", ({ type, where }) =>
  Effect.gen(function* () {
    const term = `${type.charAt(0).toUpperCase()}${type.slice(1)}`;
    expect(yield* deleting({ type, id: "no-such-id" })).toEqual({
      refused: `There is no ${term} with the id "no-such-id". ${where}`,
    });
    expect(yield* counting).toMatchObject({ changes: 0 });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a replacement that is not there is an error that names its id", () =>
  Effect.gen(function* () {
    const { duplicate } = yield* savingTwoOfOneVendor;
    const before = yield* counting;

    expect(
      yield* deleting({ type: "vendor", id: duplicate.id, replacement: "no-such-id" }),
    ).toEqual({
      refused:
        'There is no Vendor with the id "no-such-id". Ids come from search and from the records get_record returns.',
    });
    expect(
      yield* deleting({ type: "vendor", id: duplicate.id, replacement: duplicate.id }),
    ).toEqual({
      refused:
        "A Vendor cannot be its own replacement. Give `replacement` the id of another Vendor, or leave it out.",
    });
    expect(yield* counting).toEqual(before);
  }).pipe(Effect.provide(TestDatabase)),
);

// No tool writes a Schedule or a Document yet, so a test puts them in as rows. A Document is
// attached to a record by type and id, and can name a Vendor in a column of its own.
const NOT_YET =
  "Nothing was deleted, because a record with a Schedule or a Document on it cannot be deleted yet. No tool writes those yet, so no Change would say what became of them:";

const schedulingOn = Effect.fnUntraced(function* (item: Listed, title: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO schedules (id, item_id, title, interval_days, next_due_on)
             VALUES (${`schedule-${title}`}, ${item.id}, ${title}, 90, '2026-12-01')`;
});

const filing = Effect.fnUntraced(function* (title: string, vendor?: Listed) {
  const sql = yield* SqlClient.SqlClient;
  const id = `document-${title}`;
  yield* sql`INSERT INTO documents (id, title, r2_key, mime_type, sha256, vendor_id)
             VALUES (${id}, ${title}, ${`files/${title}`}, 'application/pdf', ${`hash-${title}`},
                     ${vendor?.id ?? null})`;
  return id;
});

const attaching = Effect.fnUntraced(function* (title: string, to: Listed) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO document_links (document_id, entity_type, entity_id)
             VALUES (${yield* filing(title)}, ${to.type}, ${to.id})`;
});

it.effect("an Item with a Schedule or a Document on it is refused, and the error says which", () =>
  Effect.gen(function* () {
    const { dishwasher, pump } = yield* savingTheDishwasher;
    yield* schedulingOn(dishwasher, "Clean the filter");
    const before = yield* counting;
    const named = `The Item "Dishwasher" (${dishwasher.id})`;

    expect(yield* deleting({ type: "item", id: dishwasher.id })).toEqual({
      refused: `${NOT_YET}\n${named} has 1 Schedule.`,
    });
    yield* attaching("Manual", dishwasher);
    yield* attaching("Receipt", dishwasher);
    expect(yield* deleting({ type: "item", id: dishwasher.id })).toEqual({
      refused: `${NOT_YET}\n${named} has 1 Schedule and 2 Documents.`,
    });
    // Work that only names the Item stays, so what is on the Work is not in the way.
    yield* attaching("Pump receipt", pump);
    yield* (yield* SqlClient.SqlClient)`DELETE FROM schedules`;
    expect(yield* deleting({ type: "item", id: dishwasher.id })).toEqual({
      refused: `${NOT_YET}\n${named} has 2 Documents.`,
    });
    expect(yield* counting).toEqual(before);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("Work, a Space, a Project, and a Vendor with a Document are each refused", () =>
  Effect.gen(function* () {
    const { pantry, painted, remodel } = yield* savingThePantry;
    const [ace] = created(yield* calling(saveVendor)({ name: "Ace Hardware" })) as [Listed];
    const [other] = created(yield* calling(saveVendor)({ name: "Best Hardware" })) as [Listed];
    yield* attaching("Paint receipt", painted);
    yield* attaching("Pantry photo", pantry);
    yield* attaching("Remodel quote", remodel);
    // One Document is attached to the Vendor and names it too, and another only names it.
    yield* (yield* SqlClient.SqlClient)`
      INSERT INTO document_links (document_id, entity_type, entity_id)
      VALUES (${yield* filing("Ace warranty", ace)}, 'vendor', ${ace.id})`;
    yield* filing("Ace receipt", ace);
    const before = yield* counting;

    for (const [record, has] of [
      [painted, `The Work "Painted the pantry" (${painted.id}) has 1 Document.`],
      [pantry, `The Space "Pantry" (${pantry.id}) has 1 Document.`],
      [remodel, `The Project "Kitchen remodel" (${remodel.id}) has 1 Document.`],
      [ace, `The Vendor "Ace Hardware" (${ace.id}) has 2 Documents.`],
    ] as const) {
      expect(yield* deleting({ type: record.type, id: record.id })).toEqual({
        refused: `${NOT_YET}\n${has}`,
      });
    }
    // A replacement does not clear the way: a Document would have to be pointed at it too.
    expect(yield* deleting({ type: "vendor", id: ace.id, replacement: other.id })).toEqual({
      refused: `${NOT_YET}\nThe Vendor "Ace Hardware" (${ace.id}) has 2 Documents.`,
    });
    expect(yield* counting).toEqual(before);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("an Item is refused when Work that would go with it has a Document", () =>
  Effect.gen(function* () {
    yield* calling(saveProperty)({ name: "Maple Street house" });
    const [bike] = created(yield* calling(saveItem)({ name: "Road bike" })) as [Listed];
    const [tuneUp] = created(
      yield* calling(logWork)({
        kind: "maintenance",
        title: "Tuned the bike at the shop",
        item_ids: [bike.id],
        clear: ["property"],
      }),
    ) as [Listed];
    yield* attaching("Shop receipt", tuneUp);
    const before = yield* counting;

    expect(yield* deleting({ type: "item", id: bike.id })).toEqual({
      refused: `${NOT_YET}\nThe Work "Tuned the bike at the shop" (${tuneUp.id}) has 1 Document.`,
    });
    expect(yield* counting).toEqual(before);
  }).pipe(Effect.provide(TestDatabase)),
);

// Undoing a delete. `undo` has no code for a delete: it goes by the Change, so these hold what
// a delete writes into one.

const undoing = (changeId: unknown) => calling(undo)({ change_id: changeId });

// Every row of every table a delete can write to, in a fixed order: the whole of what a
// delete and its undo have to leave as it was, `updated_at` included.
const everyRow = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = [
    "items",
    "item_categories",
    "work",
    "work_items",
    "work_spaces",
    "vendors",
    "spaces",
    "categories",
    "projects",
    "project_spaces",
    "quotes",
    "notes",
  ];
  return yield* Effect.forEach(tables, (table) =>
    Effect.map(sql.unsafe(`SELECT * FROM ${table} ORDER BY 1, 2`), (rows) => ({ table, rows })),
  );
});

// What get_record returns of each of these records, without its Changes: what each is,
// whatever was done to it.
const reading = (records: ReadonlyArray<Listed>) =>
  Effect.forEach(records, ({ type, id }) =>
    Effect.map(getting(type, id), (record) => ({ ...record, changes: undefined })),
  );

it.effect("undoing the delete of an Item puts it back with its Notes and on its Work", () =>
  Effect.gen(function* () {
    const { dishwasher, notes, pump } = yield* savingTheDishwasher;
    const records = [dishwasher, ...notes, pump];
    const [was, rows] = [yield* reading(records), yield* everyRow];

    const removal = yield* deleting({ type: "item", id: dishwasher.id });
    const back = yield* undoing(removal.change_id);
    expect(back).toEqual({
      change_id: expect.any(String),
      taken_out: [],
      restored: [pump],
      put_back: [dishwasher, ...notes],
    });

    expect(yield* reading(records)).toEqual(was);
    expect(yield* everyRow).toEqual(rows);
    expect(yield* getting("item", dishwasher.id)).toMatchObject({
      name: "Dishwasher",
      extra_categories: [{ id: "kitchen" }],
      work: [{ id: pump.id, title: "Replaced the drain pump" }],
      notes: [{ body: "The door latch sticks." }, { body: "Came with the place." }],
      // The delete and its undo are the Item's latest Changes.
      changes: [
        { tool: "undo", undoes: removal.change_id, before: null },
        { id: removal.change_id, tool: "delete_record", after: null },
        { tool: "save_item" },
      ],
    });
    // And the delete is made again by undoing the undo.
    expect(yield* undoing(back.change_id)).toMatchObject({
      taken_out: [dishwasher, ...notes],
      restored: [pump],
      put_back: [],
    });
    expect(yield* counting).toMatchObject({ items: 0, notes: 0, work: 1, work_items: 0 });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("undoing the delete of an Item puts back the Work that went with it", () =>
  Effect.gen(function* () {
    yield* calling(saveProperty)({ name: "Maple Street house" });
    const [bike] = created(yield* calling(saveItem)({ name: "Road bike" })) as [Listed];
    const [tuneUp, chain] = created(
      yield* calling(logWork)({
        kind: "maintenance",
        title: "Tuned the bike at the shop",
        item_ids: [bike.id],
        note: "New chain and brake pads.",
        clear: ["property"],
      }),
    ) as [Listed, Listed];
    const records = [bike, tuneUp, chain];
    const [was, rows] = [yield* reading(records), yield* everyRow];

    const removal = yield* deleting({ type: "item", id: bike.id });
    expect(removal.removed).toEqual(records);
    expect(yield* undoing(removal.change_id)).toMatchObject({
      taken_out: [],
      restored: [],
      put_back: [bike, chain, tuneUp],
    });
    expect(yield* reading(records)).toEqual(was);
    expect(yield* everyRow).toEqual(rows);
    expect(yield* getting("work", tuneUp.id)).toMatchObject({
      property: null,
      items: [{ id: bike.id }],
      notes: [{ id: chain.id }],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("undoing a merge of Vendors puts the Vendor back with everything that used it", () =>
  Effect.gen(function* () {
    const { keep, duplicate, texts, transformer, wiring, quote, lighting } =
      yield* savingTwoOfOneVendor;
    const records = [keep, duplicate, texts, transformer, wiring, lighting];
    const [was, rows] = [yield* reading(records), yield* everyRow];

    const merged = yield* deleting({ type: "vendor", id: duplicate.id, replacement: keep.id });
    expect(yield* undoing(merged.change_id)).toEqual({
      change_id: expect.any(String),
      taken_out: [],
      // By type, and then by id. The Quote is named by the Vendor it has again.
      restored: [transformer, texts, quote, wiring],
      put_back: [duplicate],
    });

    expect(yield* reading(records)).toEqual(was);
    expect(yield* everyRow).toEqual(rows);
    expect(yield* getting("vendor", duplicate.id)).toMatchObject({
      name: "Briteside Electric",
      items: [{ id: transformer.id }],
      work: [{ id: wiring.id }],
      quotes: [{ id: quote.id }],
      notes: [{ id: texts.id }],
    });
    expect(yield* getting("vendor", keep.id)).toMatchObject({
      items: [],
      work: [],
      quotes: [],
      notes: [],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("undoing a merge of Spaces, of Projects, and of Categories puts each back", () =>
  Effect.gen(function* () {
    const { kitchen, pantry, shelf, painted, tiled, remodel, dim } = yield* savingThePantry;
    const [keep] = created(yield* calling(saveProject)({ title: "Pantry shelving" })) as [Listed];
    const [brightside, quote] = created(
      yield* calling(saveQuote)({ project: remodel.id, vendor: "Brightside Electric" }),
    ) as [Listed, Listed];
    const [wired] = created(
      yield* calling(logWork)({
        kind: "improvement",
        title: "Wired the lights",
        project: remodel.id,
      }),
    ) as [Listed];
    yield* calling(saveCategory)({ id: CARDIO.id, name: CARDIO.name, parent: "fitness" });
    yield* calling(saveCategory)({ id: TREADMILLS.id, name: TREADMILLS.name, parent: CARDIO.id });
    const [bike] = created(
      yield* calling(saveItem)({
        name: "Exercise bike",
        category: CARDIO.id,
        extra_categories: ["sports"],
      }),
    ) as [Listed];
    const [watch] = created(
      yield* calling(saveItem)({
        name: "Running watch",
        category: "electronics",
        extra_categories: [CARDIO.id, "sports"],
      }),
    ) as [Listed];
    const records = [
      kitchen,
      pantry,
      shelf,
      painted,
      tiled,
      remodel,
      dim,
      keep,
      brightside,
      wired,
      bike,
      watch,
    ];
    const [was, rows] = [yield* reading(records), yield* everyRow];

    const spaces = yield* deleting({ type: "space", id: pantry.id, replacement: kitchen.id });
    const projects = yield* deleting({ type: "project", id: remodel.id, replacement: keep.id });
    const categories = yield* deleting({ type: "category", id: CARDIO.id, replacement: "sports" });
    expect(yield* everyRow).not.toEqual(rows);

    // Newest first: each undo leaves the records the one before it touched as that one left
    // them.
    expect(yield* undoing(categories.change_id)).toMatchObject({
      restored: [TREADMILLS, bike, watch],
      put_back: [CARDIO],
    });
    expect(yield* undoing(projects.change_id)).toMatchObject({
      restored: [quote, wired],
      put_back: [remodel],
    });
    expect(yield* undoing(spaces.change_id)).toMatchObject({
      restored: [shelf, dim, remodel, painted, tiled],
      put_back: [pantry],
    });

    expect(yield* reading(records)).toEqual(was);
    expect(yield* everyRow).toEqual(rows);
    // The Work that named both Spaces names both again, and the Project has its Space and
    // its Quote. Each Item has the Categories it had.
    expect(yield* getting("work", tiled.id)).toMatchObject({
      spaces: [{ name: "Kitchen" }, { name: "Pantry" }],
    });
    expect(yield* getting("project", remodel.id)).toMatchObject({
      spaces: [{ id: pantry.id }],
      quotes: [{ id: quote.id }],
      work: [{ id: wired.id }],
    });
    expect(yield* categoriesOf(bike)).toEqual({ primary: "cardio", extras: ["sports"] });
    expect(yield* categoriesOf(watch)).toEqual({
      primary: "electronics",
      extras: ["cardio", "sports"],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("undoing the delete of a Note, of a Quote, and of Work puts each back", () =>
  Effect.gen(function* () {
    const { duplicate, hoa, quote, trench, exterior } = yield* savingTwoProjects;
    const [damp] = created(
      yield* calling(logWork)({ id: trench.id, spaces: ["Exterior"], note: "The soil was damp." }),
    ) as [Listed];
    const records = [duplicate, hoa, trench, exterior];
    const [was, rows] = [yield* reading(records), yield* everyRow];

    for (const [record, putBack] of [
      [hoa, [hoa]],
      [quote, [quote]],
      // By type, and then by id.
      [trench, [damp, trench]],
    ] as const) {
      const removal = yield* deleting({ type: record.type, id: record.id });
      expect(yield* undoing(removal.change_id)).toMatchObject({
        taken_out: [],
        restored: [],
        put_back: putBack,
      });
    }
    expect(yield* reading(records)).toEqual(was);
    expect(yield* everyRow).toEqual(rows);
  }).pipe(Effect.provide(TestDatabase)),
);

// The loop of issue 46, from a delete. Cardio is under fitness, and treadmills are under
// cardio. Cardio is deleted into sports, so treadmills move under sports. Then fitness is put
// under treadmills, which the delete never touched. Undoing the delete would bring cardio
// back under fitness, and treadmills back under cardio: fitness, treadmills, cardio, fitness.
it.effect("undoing a delete that would put a Category under itself is refused", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* calling(saveCategory)({ id: CARDIO.id, name: CARDIO.name, parent: "fitness" });
    yield* calling(saveCategory)({ id: TREADMILLS.id, name: TREADMILLS.name, parent: CARDIO.id });
    const merged = yield* deleting({ type: "category", id: CARDIO.id, replacement: "sports" });
    const moved = yield* calling(saveCategory)({ id: "fitness", parent: TREADMILLS.id });
    const parents = sql`
      SELECT id, parent_id FROM categories WHERE id IN ('cardio', 'treadmills', 'fitness')
       ORDER BY id`;
    const before = yield* parents;

    expect(yield* undoing(merged.change_id)).toEqual({
      refused: `Nothing was undone, because a record would be back under one that is under it already, which is a loop. One of the others in the loop has to come out from under its parent first, by a save of it or by undoing the Change that put it there:
The Category "Cardio" (cardio) would be back under the Category "Fitness" (fitness), which is under the Category "Treadmills" (treadmills), which would be back under the Category "Cardio" (cardio).`,
    });
    expect(yield* parents).toEqual(before);

    // With fitness out from under the treadmills, the delete is undone.
    yield* undoing(moved.change_id);
    expect(yield* undoing(merged.change_id)).toMatchObject({
      restored: [TREADMILLS],
      put_back: [CARDIO],
    });
    expect(yield* parents).toEqual([
      { id: "cardio", parent_id: "fitness" },
      { id: "fitness", parent_id: null },
      { id: "treadmills", parent_id: "cardio" },
    ]);
  }).pipe(Effect.provide(TestDatabase)),
);

// The statements of a delete run in order: the Item comes off its Work, its Notes go, and
// then its own row. A trigger that refuses the row fails the batch after the others ran.
it.effect("a delete the database refuses partway leaves nothing behind: no row and no Change", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { dishwasher, notes } = yield* savingTheDishwasher;
    const [rows, before] = [yield* everyRow, yield* counting];
    yield* sql`
      CREATE TRIGGER refuse_items BEFORE DELETE ON items
      BEGIN SELECT RAISE(ABORT, 'refused by the test'); END`;

    const { result, logged } = yield* readingLog(deleting({ type: "item", id: dishwasher.id }));
    expect(result).toEqual({ refused: UNEXPECTED.text });
    expect(logged).toEqual([expect.stringContaining("refused by the test")]);
    expect(yield* everyRow).toEqual(rows);
    expect(yield* counting).toEqual(before);

    // Without the trigger, the same delete goes through.
    yield* sql`DROP TRIGGER refuse_items`;
    expect(yield* deleting({ type: "item", id: dishwasher.id })).toMatchObject({
      removed: [dishwasher, ...notes],
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// Several foreign keys would delete a row on their own when the row it points at goes: an
// Item's links from Work, and what a record has in a link set of its own. No Change would say
// so. With the foreign keys off, nothing acts but the statements of the delete itself.
it.effect("a delete writes every row itself, and leans on no foreign key that acts", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { shelf, painted, remodel } = yield* savingThePantry;
    const [swapped] = created(
      yield* calling(logWork)({
        kind: "repair",
        title: "Swapped the shelf brackets",
        item_ids: [shelf.id],
      }),
    ) as [Listed];
    yield* calling(saveItem)({ id: shelf.id, extra_categories: ["kitchen", "office"] });
    expect(yield* counting).toMatchObject({
      item_categories: 2,
      work_items: 1,
      work_spaces: 3,
      project_spaces: 1,
    });
    yield* sql`PRAGMA foreign_keys = OFF`;

    // The Item comes off the Work, and its extra Categories go with it.
    const withoutItem = yield* deleting({ type: "item", id: shelf.id });
    expect(withoutItem).toMatchObject({ removed: [shelf], updated: [swapped] });
    expect(yield* counting).toMatchObject({ item_categories: 0, work_items: 0 });
    // Work goes with its Spaces, and a Project with its own.
    yield* deleting({ type: "work", id: painted.id });
    expect(yield* counting).toMatchObject({ work_spaces: 2 });
    yield* deleting({ type: "project", id: remodel.id });
    expect(yield* counting).toMatchObject({ project_spaces: 0 });
  }).pipe(Effect.provide(TestDatabase)),
);
