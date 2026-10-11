import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { categoryAmong, everyCategory } from "../category.ts";
import { partialDate, today } from "../dates.ts";
import { amount, formatCents, inCents } from "../money.ts";
import { newNote, noteOn } from "../note.ts";
import { propertyFor } from "../property.ts";
import {
  askedOnce,
  dataPatch,
  givenOrCleared,
  insertRow,
  nameKey,
  nameText,
  noteText,
  referredOnce,
  replaceLinks,
  runSave,
  SAVE_ANNOTATIONS,
  updateRow,
} from "../save.ts";
import { spaceOrNew } from "../space.ts";
import { defineTool, optional, ToolError } from "../tool.ts";
import { vendorOrNew } from "../vendor.ts";
import { Ids } from "../write.ts";
import { noRecord, readRecord } from "./get-record.ts";

// The most Items one call saves. A longer list is saved in several calls.
const MOST_ITEMS = 50;

const NO_NAME = "Give a name to create an Item, or the id of the Item to update.";

const NO_PROPERTY =
  "A Fixture stays with its Property, so it has to be at one. Only a Belonging can be at no Property.";

const NO_DATE =
  "A change of status is dated, so `status_on` cannot be cleared in the save that changes the status. Give `status_on` the date, which may be a Partial date such as 2024, or leave it out for today.";

const DESCRIPTION = `Creates or updates an Item: one thing in or on a Property, such as the fridge, a couch, or a bike. Give one Item's fields, or \`items\` for a list of up to ${MOST_ITEMS}.

One Item is one line on an insurance claim. A matching set, such as six dining chairs, is one Item with \`data.quantity\`, priced as a whole. \`scope\` says whether it is a Fixture, which stays with the Property when the User leaves, or a Belonging, which is the User's own and moves with them.

With an id, the Item with that id is updated. Without one, a new Item is created, which needs a name. Two Items can have the same name, so a name never says which Item a save is about: find the Item with search first, and update it by its id. A field that is left out, or sent as null, stays as it is. To empty a field, name it in \`clear\`.

\`price\` is what was paid for the Item, and \`proceeds\` is what came back for it: a sale price, an insurance payout, or a trade-in. Both are in dollars. Attic records what was paid, so there is no field for an appraisal or an estimate of what an Item is worth.

Money inside \`data\` is not converted. It is stored as written: integer cents under a key ending in _cents, such as \`{"listing": {"asking_cents": 25000}}\` for an asking price of 250 dollars. A read shows that key in dollars under the name without _cents, as \`asking: 250\`. So never write back what a read showed: \`asking\` would be stored as a second key beside \`asking_cents\`.

\`category\` is the id of the Item's primary Category, which must exist: get_schema lists them, and save_category adds one. One that is not there is an error with the closest matches. \`extra_categories\` replaces the whole set of Categories the Item is in beside its primary one. The primary Category is never an extra one as well, so it is left out of them.

\`space\` and \`bought_from\` are names, matched whatever their case. One that is not there yet is created, and the reply lists it, so check the reply for a Space or a Vendor you did not mean to make. A Space is one at the Item's Property.

With no \`property\`, a new Item is at the one Current property, and when there is not exactly one, the error lists the Properties to choose from. A Belonging can be at no Property, such as one in storage: name \`property\` in \`clear\`. A Fixture has to have one. An Item that moves to another Property loses its Space, unless the same save gives it one there.

\`status\` says whether the User still has the Item. sold, given, lost, stolen, and destroyed mean it is gone, and the Item is kept for its money trail: the sale, the donation, or the claim. Something that was returned or thrown away is deleted, not given a status. A lost Item that turns up goes back to active. A change of status writes a dated Note on the Item in the same Change, such as "Marked sold on 2026-09-20 for $450.00.", with the Item's proceeds when it has any. The date is \`status_on\`, which is today when it is left out. A new Item starts out active, so one that is saved with another status gets the Note too. Who bought it, or where it went, goes in \`data\` as sold_to or donated_to.

\`data\` is a merge patch, so a save adds to what is there. Parts are kept by slug, so one is added without touching the others: \`{"parts": {"water-filter": {"name": "Water filter", "part_number": "DA97-17376B"}}}\`.

A list is checked whole before anything is written. If any entry is refused, nothing is saved, and the error says which entries and why. The whole list is one Change. Moving day is a list update: give each Belonging's id with the new \`property\`, and each one moves there and loses its Space. Leave the Fixtures out of the list, because they stay with the Property.

What comes back is the id of the Change that recorded the save, and every record it created or updated: the Items, any Space or Vendor made on first use, and the Notes. A save of one Item also returns the whole Item as get_record returns it.`;

const SCOPES = ["fixture", "belonging"] as const;

const STATUSES = ["active", "listed", "sold", "given", "lost", "stolen", "destroyed"] as const;
type Status = (typeof STATUSES)[number];

// The status a new Item has unless the save gives one, which is the table's own default.
const ACTIVE: Status = "active";

// The Category a new Item is in unless the save names one, which is the table's own default.
const OTHER = "other";

// The fields a save can empty. An Item always has a name, a scope, a Category, and a status.
const CLEARABLE = [
  "property",
  "space",
  "acquired_on",
  "price",
  "bought_from",
  "status_on",
  "proceeds",
] as const;

// The fields of one Item. A call gives them for one Item, or a list of entries that each have
// them.
const FIELDS = {
  id: optional(
    Schema.String.annotate({
      description:
        "The id of the Item to update, as search or get_record gives it. Leave it out to create an Item.",
    }),
  ),
  name: optional(
    nameText(
      "What the Item is called, such as Fridge, Office router, or Dining chairs. A new Item needs one. Two Items can have the same name.",
    ),
  ),
  property: optional(
    nameText(
      "The Property the Item is at, by its id or its name. Left out, a new Item is at the one Current property, and an Item that is there already stays where it is.",
    ),
  ),
  space: optional(
    nameText(
      "The Space the Item is in, by its name, such as Kitchen. It is a Space at the Item's Property, and is created there if it is not there yet.",
    ),
  ),
  scope: optional(
    Schema.Literals(SCOPES).annotate({
      description:
        "fixture for an Item that stays with the Property when the User leaves, such as a water heater or the landlord's fridge. belonging for one that is the User's own and moves with them. A new Item is a belonging.",
    }),
  ),
  category: optional(
    Schema.String.annotate({
      description:
        "The id of the Item's primary Category, such as appliances. It must exist, and get_schema lists them. A new Item with none is in other.",
    }),
  ),
  extra_categories: optional(
    Schema.Array(Schema.String).annotate({
      description:
        "The ids of the Categories the Item is in beside its primary one. The list replaces the whole set, and an empty list removes them all.",
    }),
  ),
  acquired_on: optional(partialDate("When it was bought, received, or installed.")),
  price: optional(
    amount(
      "What was paid for it, not what it is worth. For a matching set, what was paid for the whole set.",
    ),
  ),
  bought_from: optional(
    nameText(
      "The Vendor the Item came from, by name, such as Appliance Barn. It is created if it is not there yet.",
    ),
  ),
  status: optional(
    Schema.Literals(STATUSES).annotate({
      description:
        "active or listed for an Item the User still has, where listed means it is for sale. sold, given, lost, stolen, or destroyed for one that is gone. A new Item is active.",
    }),
  ),
  status_on: optional(
    partialDate(
      "When the status changed: the day it was listed, sold, or lost. Left out on a change of status, it is today.",
    ),
  ),
  proceeds: optional(
    amount("What came back for it: the sale price, the insurance payout, or the trade-in."),
  ),
  data: optional(
    dataPatch(
      "Facts about the Item, such as brand, model, serial, warranty_until, quantity, and parts keyed by slug.",
    ),
  ),
  note: optional(noteText("A Note to add to the Item. It is a new Note each time.")),
  clear: optional(
    Schema.Array(Schema.Literals(CLEARABLE)).annotate({
      description:
        "Fields to empty. A field cannot be given a value and cleared in the same call. Clearing property puts a Belonging at no Property, and so in no Space. An Item always has a name, a scope, a Category, and a status, so those cannot be cleared.",
    }),
  ),
};

const Entry = Schema.Struct(FIELDS);
type Entry = typeof Entry.Type;

// An Item a save gives the id of, as it is now.
interface Existing {
  readonly id: string;
  readonly name: string;
  readonly scope: (typeof SCOPES)[number];
  readonly status: Status;
  readonly property_id: string | null;
  readonly category_id: string;
  readonly proceeds_cents: number | null;
  /** The ids of its extra Categories. */
  readonly extra_categories: ReadonlyArray<string>;
}

// The Items with these ids as they are now, by id. An id that is not there is not among them.
// A call that only creates gives no ids, and reads nothing.
const itemsNow = Effect.fnUntraced(function* (ids: ReadonlyArray<string>) {
  if (ids.length === 0) return new Map<string, Existing>();
  const sql = yield* SqlClient.SqlClient;
  // The extra Categories come back as the text of a JSON list.
  const items = yield* sql<Omit<Existing, "extra_categories"> & { extra_categories: string }>`
    SELECT item.id, item.name, item.scope, item.status, item.property_id, item.category_id,
           item.proceeds_cents,
           (SELECT json_group_array(category_id)
              FROM item_categories WHERE item_id = item.id) AS extra_categories
      FROM items AS item
     WHERE item.id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`;
  return new Map(
    items.map((item): [string, Existing] => [
      item.id,
      { ...item, extra_categories: JSON.parse(item.extra_categories) },
    ]),
  );
});

// What the entries of one call share. A list reads each thing once: the Categories, today's
// date, and each Property, Space, and Vendor its entries name, however many of them name it.
// The Categories are read when the first entry that names one asks, so a call that names none,
// such as moving day, does not read them. A Space or a Vendor that is new comes with the steps
// that create it for the first entry that names it, and with none after that.
const sharedByEntries = Effect.gen(function* () {
  return {
    sql: yield* SqlClient.SqlClient,
    categories: yield* Effect.cached(everyCategory),
    day: yield* today,
    // No Property has a name with nothing in it, so that key is free for the Current property.
    property: askedOnce(propertyFor, (given) => given ?? ""),
    space: referredOnce(
      (propertyId: string, name: string) => spaceOrNew(propertyId, name),
      (propertyId, name) => `${propertyId} ${nameKey(name)}`,
    ),
    vendor: referredOnce((name: string) => vendorOrNew(name), nameKey),
  };
});

// The columns among these that a save has something to say of: a value to set, or null to
// empty the column. One that is undefined is left out, and so left as it is.
const defined = (columns: Readonly<Record<string, unknown>>) =>
  Object.fromEntries(Object.entries(columns).filter(([, value]) => value !== undefined));

// The steps that save one Item, with its id. `was` is the Item as it is now, when the entry
// gives the id of one. Nothing is written here, so an entry that is refused leaves nothing
// behind.
const stepsFor = Effect.fnUntraced(function* (
  entry: Entry,
  was: Existing | undefined,
  { sql, categories, day, ...once }: Effect.Success<typeof sharedByEntries>,
) {
  const { id, name, scope, category, status, data, note, clear = [] } = entry;
  if (id !== undefined && was === undefined) return yield* noRecord("item", id);
  const called = name ?? was?.name;
  if (called === undefined) return yield* new ToolError({ message: NO_NAME });

  yield* givenOrCleared(entry, clear);
  // What the save does with a field that can be emptied: its new value, null to empty it, or
  // undefined to leave it as it is.
  const wanted = <Value>(field: (typeof CLEARABLE)[number], value: Value | undefined) =>
    clear.includes(field) ? null : value;

  // Where the Item is after the save. A new Item is at the Current property unless the save
  // says where, and an Item that is there already stays where it is.
  const propertyId = clear.includes("property")
    ? null
    : was !== undefined && entry.property === undefined
      ? was.property_id
      : (yield* once.property(entry.property)).id;
  const moved = was !== undefined && propertyId !== was.property_id;
  if ((scope ?? was?.scope) === "fixture" && propertyId === null) {
    return yield* new ToolError({ message: NO_PROPERTY });
  }

  // A Space is one at a Property, so the Space a save names is one at the Item's.
  if (entry.space !== undefined && propertyId === null) {
    return yield* new ToolError({
      message: `A Space is one at a Property, and "${called}" is at none. Give \`property\` as well, or leave \`space\` out.`,
    });
  }
  const space =
    entry.space === undefined || propertyId === null
      ? undefined
      : yield* once.space(propertyId, entry.space);
  // An Item that moves to another Property loses its Space, unless the save gives it one there.
  const spaceId =
    space !== undefined ? space.id : moved || clear.includes("space") ? null : undefined;

  const vendor =
    entry.bought_from === undefined ? undefined : yield* once.vendor(entry.bought_from);

  // A Category must already exist: the primary one a save gives an Item, and each extra one.
  // The one an Item has already is not looked up again.
  const primary = category ?? was?.category_id ?? OTHER;
  const filedUnder = was === undefined || category !== undefined ? primary : undefined;
  for (const each of [
    ...(filedUnder === undefined ? [] : [filedUnder]),
    ...(entry.extra_categories ?? []),
  ]) {
    yield* categoryAmong(each, yield* categories);
  }
  // The primary Category is never an extra one as well. So a new primary Category that was an
  // extra one is taken out of them, though the save says nothing of the extras.
  const wasExtra = was?.extra_categories ?? [];
  const extras = entry.extra_categories ?? (wasExtra.includes(primary) ? wasExtra : undefined);

  // A new Item starts out active, so one that is saved with another status has changed it. A
  // change of status is dated: by the date the save gives, or by today.
  const marked = status !== undefined && status !== (was?.status ?? ACTIVE) ? status : undefined;
  if (marked !== undefined && clear.includes("status_on")) {
    return yield* new ToolError({ message: NO_DATE });
  }
  const statusOn = wanted("status_on", entry.status_on ?? (marked === undefined ? undefined : day));
  const proceedsCents = wanted(
    "proceeds",
    entry.proceeds === undefined ? undefined : inCents(entry.proceeds),
  );

  const item = {
    type: "item",
    id: was?.id ?? (yield* (yield* Ids).next),
    name: called,
  } as const;
  const columns = defined({
    name,
    scope,
    property_id: was === undefined || moved ? propertyId : undefined,
    space_id: spaceId,
    category_id: filedUnder,
    acquired_on: wanted("acquired_on", entry.acquired_on),
    price_cents: wanted("price", entry.price === undefined ? undefined : inCents(entry.price)),
    vendor_id: wanted("bought_from", vendor?.id),
    status,
    status_on: statusOn,
    proceeds_cents: proceedsCents,
  });
  const row =
    was === undefined ? insertRow(sql, item, columns, data) : updateRow(sql, item, columns, data);
  const links =
    extras === undefined
      ? []
      : replaceLinks(
          sql,
          row,
          "extra_categories",
          [...new Set(extras)].filter((each) => each !== primary),
        );

  // A change of status writes a dated Note on the Item. The amount is the Item's proceeds as
  // the save leaves them, whether this save gave them or an earlier one did.
  const on = { type: "item", id: item.id } as const;
  const cameBack = proceedsCents === undefined ? (was?.proceeds_cents ?? null) : proceedsCents;
  const forAmount =
    marked === undefined || cameBack === null ? "" : ` for ${yield* formatCents(cameBack)}`;
  const notes = [
    ...(marked === undefined
      ? []
      : [yield* newNote(`Marked ${marked} on ${statusOn}${forAmount}.`, propertyId, on)]),
    ...(yield* noteOn(note, propertyId, on)),
  ];

  return {
    id: item.id,
    steps: [...(space?.steps ?? []), ...(vendor?.steps ?? []), row, ...links, ...notes],
  };
});

// What an error says of a list that was not saved: each entry that was refused, by where it is
// in `items`, and why. Entries refused for the same reason are named together, so fifty Items
// with no Property to be at say so once.
const listRefused = (refused: ReadonlyArray<readonly [at: number, why: string]>, of: number) => {
  const lines = [...Map.groupBy(refused, ([, why]) => why)].map(
    ([why, forThat]) => `${forThat.map(([at]) => `items.${at}`).join(", ")}: ${why}`,
  );
  const were = refused.length === 1 ? "was" : "were";
  return `Nothing was saved, because ${refused.length} of the ${of} entries in \`items\` ${were} refused. Entries are counted from 0.\n${lines.join("\n")}`;
};

export const saveItem = defineTool({
  name: "save_item",
  description: DESCRIPTION,
  input: Schema.Struct({
    ...FIELDS,
    items: optional(
      Schema.Array(Entry)
        .annotate({
          description: `A list of up to ${MOST_ITEMS} Items to save in one call, all or nothing. Each entry has the fields of one Item. Leave every other field out when this is given.`,
        })
        .check(
          Schema.isMinLength(1, { message: "Expected at least one Item in the list." }),
          Schema.isMaxLength(MOST_ITEMS, {
            message: `Expected at most ${MOST_ITEMS} Items in one call. Save a longer list in several calls.`,
          }),
        ),
    ),
  }),
  annotations: SAVE_ANNOTATIONS,
  run: ({ items, ...one }) =>
    Effect.gen(function* () {
      const beside = Object.keys(one);
      if (items !== undefined && beside.length > 0) {
        return yield* new ToolError({
          message: `Give one Item's fields, or \`items\` for a list, and not both. Beside \`items\` there was: ${beside.join(", ")}. Each entry of a list has fields of its own.`,
        });
      }
      const entries = items ?? [one];
      const shared = yield* sharedByEntries;
      const existing = yield* itemsNow(entries.flatMap(({ id }) => (id === undefined ? [] : [id])));

      // Every entry is checked before anything is written, and a refusal is kept beside the
      // others, so that one error names every entry that has to change.
      const outcomes = yield* Effect.forEach(entries, (entry, at) => {
        const { id } = entry;
        const first = id === undefined ? at : entries.findIndex((other) => other.id === id);
        const steps =
          first < at
            ? Effect.fail(
                new ToolError({
                  message: `The Item "${id}" is in this list already, at items.${first}. Give each Item once.`,
                }),
              )
            : stepsFor(entry, id === undefined ? undefined : existing.get(id), shared);
        return Effect.catchTag(steps, "ToolError", ({ message }) =>
          Effect.succeed({ refused: message }),
        );
      });
      const refused = outcomes.flatMap((outcome, at) =>
        "refused" in outcome ? [[at, outcome.refused] as const] : [],
      );
      const [refusal] = refused;
      if (refusal !== undefined) {
        // One Item given by its fields is refused in the words of the refusal alone.
        return yield* new ToolError({
          message: items === undefined ? refusal[1] : listRefused(refused, entries.length),
        });
      }

      const saves = outcomes.flatMap((outcome) => ("refused" in outcome ? [] : [outcome]));
      const reply = yield* runSave(saves.flatMap(({ steps }) => steps));
      // A call that saves one Item also returns it as get_record does.
      const [only, ...others] = saves;
      return only === undefined || others.length > 0
        ? reply
        : { ...reply, record: yield* readRecord("item", only.id) };
    }),
});
