import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { partialDate } from "../dates.ts";
import { amount, inCents } from "../money.ts";
import { noteOn, notesMovedTo } from "../note.ts";
import { propertyFor } from "../property.ts";
import {
  askedOnce,
  dataPatch,
  definedColumns,
  entriesOf,
  insertRow,
  listOf,
  MOST_IN_ONE_CALL,
  nameKey,
  nameText,
  noteText,
  planEvery,
  referredOnce,
  refuseGivenAndCleared,
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

// What the list of a call is given in, and what its entries are.
const LIST = { field: "work", one: "piece of Work", many: "pieces of Work" };

const NO_KIND_OR_TITLE = "Give a kind and a title to log Work, or the id of the Work to update.";

const DESCRIPTION = `Logs Work, or updates Work that is logged: something already done to a Property or to Items, such as a repair, maintenance, an improvement, or an inspection. Give one piece of Work's fields, or \`work\` for a list of up to ${MOST_IN_ONE_CALL}.

Work is always finished. Anything that is planned, or still in progress, is not Work yet. It belongs to a Project, and is logged here once it is done.

With an id, the Work with that id is updated. Without one, new Work is logged, which needs a kind and a title. Two pieces of Work can have the same title, so a title never says which one a save is about: find the Work with search first, and update it by its id. A field that is left out, or sent as null, stays as it is. To empty a field, name it in \`clear\`.

\`kind\` is repair, maintenance, improvement, inspection, or other. It matters for a home the User owns, where an improvement generally adds to the cost basis and a repair does not.

\`date\` is when the Work was done or finished, and may be a Partial date such as 2023. Work with no date given has none: it is not taken to be today.

\`cost\` is everything paid for the job, materials included, in dollars. It is never added to an Item's price. The two answer different questions, so a part that is recorded as an Item with a price is still counted in the cost of the Work that fitted it. Money inside \`data\` is not converted. It is stored as written: integer cents under a key ending in _cents.

\`diy\` is true for Work the User did themselves. \`vendor\` is who did the Work, by name, matched whatever its case. On DIY Work the Vendor is where the materials came from. One that is not there yet is created, and the reply lists it, so check the reply for a Vendor you did not mean to make.

Work needs a Property or at least one Item. With no \`property\`, new Work is at the one Current property. When there is not exactly one, Work that names Items and no Spaces is saved at no Property, and any other Work is refused with the Properties to choose from. Work on an Item that was done away from every Property, such as a bike serviced at a shop, has \`property\` named in \`clear\`.

\`item_ids\` are the ids of the Items the Work was done to, and \`spaces\` are the names of the Spaces it was done in. Each list replaces the whole set, and an empty list empties it. An Item that is not there is an error. A Space is one at the Work's Property, matched whatever its case, and one that is not there yet is created, and listed in the reply. So Work at no Property takes no Spaces. Work that moves to another Property loses its Spaces, unless the same save gives it some there, and its Notes move with it.

Repainting is Work that names the Space. Put the color that was there before in \`data.replaced\`, and then save the new color on the Space with save_space, which is where a Space's paint is kept.

\`data\` is a merge patch, so a save adds to what is there.

A list is checked whole before anything is written. If any entry is refused, nothing is saved, and the error says which entries and why. The whole list is one Change.

What comes back is the id of the Change that recorded the save, and every record it created or updated: the Work, any Space or Vendor made on first use, and the Notes. A save of one piece of Work also returns the whole of it as get_record returns it.`;

const KINDS = ["repair", "maintenance", "improvement", "inspection", "other"] as const;

// The fields a save can empty. Work always has a kind and a title, and is DIY or is not. Its
// Items and its Spaces are sets, and a set is emptied with an empty list.
const CLEARABLE = ["property", "description", "date", "cost", "vendor"] as const;

// The fields of one piece of Work. A call gives them for one piece of Work, or a list of
// entries that each have them.
const FIELDS = {
  id: optional(
    Schema.String.annotate({
      description:
        "The id of the Work to update, as search or get_record gives it. Leave it out to log new Work.",
    }),
  ),
  kind: optional(
    Schema.Literals(KINDS).annotate({
      description:
        "What kind of Work it was. For a home the User owns, an improvement generally adds to the cost basis and a repair does not. New Work needs one.",
    }),
  ),
  title: optional(
    nameText(
      "What was done, in a few words, such as Replaced the kitchen faucet cartridge. New Work needs one. Two pieces of Work can have the same title.",
    ),
  ),
  description: optional(
    Schema.String.annotate({
      description:
        "What was done, at more length: what was wrong, what was replaced, and what to know next time.",
    }),
  ),
  date: optional(
    partialDate(
      "When it was done, or finished. Work with none given has no date, and not today's.",
    ),
  ),
  cost: optional(
    amount(
      "Everything paid for the job, materials included. It is never added to an Item's price.",
    ),
  ),
  diy: optional(
    Schema.Boolean.annotate({
      description:
        "true for Work the User did themselves, and false for Work someone else did. New Work is not DIY unless it says so.",
    }),
  ),
  vendor: optional(
    nameText(
      "The Vendor who did the Work, by name, such as Pipewise Plumbing. On DIY Work, the Vendor the materials came from. It is created if it is not there yet.",
    ),
  ),
  property: optional(
    nameText(
      "The Property the Work was done at, by its id or its name. Left out, new Work is at the one Current property, and Work that is logged already stays where it is.",
    ),
  ),
  item_ids: optional(
    Schema.Array(Schema.String).annotate({
      description:
        "The ids of the Items the Work was done to, as search or get_record gives them. The list replaces the whole set, and an empty list removes them all.",
    }),
  ),
  spaces: optional(
    Schema.Array(nameText("The name of one Space, such as Kitchen.")).annotate({
      description:
        "The Spaces the Work was done in, by name. Each is a Space at the Work's Property, and is created there if it is not there yet. The list replaces the whole set, and an empty list removes them all.",
    }),
  ),
  data: optional(dataPatch("Facts about the Work, such as permit, payments, and replaced.")),
  note: optional(noteText("A Note to add to the Work. It is a new Note each time.")),
  clear: optional(
    Schema.Array(Schema.Literals(CLEARABLE)).annotate({
      description:
        "Fields to empty. A field cannot be given a value and cleared in the same call. Clearing property puts Work on Items at no Property, and so in no Space. Work always has a kind and a title, and is DIY or is not, so those cannot be cleared. item_ids and spaces are emptied with an empty list.",
    }),
  ),
};

const Entry = Schema.Struct(FIELDS);
type Entry = typeof Entry.Type;

// A piece of Work a save gives the id of, as it is now.
interface Existing {
  readonly id: string;
  readonly title: string;
  readonly property_id: string | null;
  /** How many Items it names. */
  readonly item_count: number;
  /** The Notes on it, oldest first. */
  readonly notes: ReadonlyArray<{ readonly id: string; readonly body: string }>;
}

// The Work with these ids as it is now, by id. An id that is not there is not among them. A
// call that only logs new Work gives no ids, and reads nothing.
const workNow = Effect.fnUntraced(function* (ids: ReadonlyArray<string>) {
  if (ids.length === 0) return new Map<string, Existing>();
  const sql = yield* SqlClient.SqlClient;
  // The Notes come back as the text of a JSON list.
  const rows = yield* sql<Omit<Existing, "notes"> & { readonly notes: string }>`
    SELECT work.id, work.title, work.property_id,
           (SELECT count(*) FROM work_items WHERE work_id = work.id) AS item_count,
           (SELECT json_group_array(json_object('id', id, 'body', body))
              FROM (SELECT id, body FROM notes
                     WHERE entity_type = 'work' AND entity_id = work.id ORDER BY id)) AS notes
      FROM work
     WHERE work.id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`;
  return new Map(
    rows.map((row): [string, Existing] => [row.id, { ...row, notes: JSON.parse(row.notes) }]),
  );
});

// The ids among these that are an Item's. A call that names no Item reads nothing.
const itemsAmong = Effect.fnUntraced(function* (ids: ReadonlyArray<string>) {
  if (ids.length === 0) return new Set<string>();
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ id: string }>`
    SELECT id FROM items WHERE id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`;
  return new Set(rows.map(({ id }) => id));
});

// What the entries of one call share. Each Property, Space, and Vendor they name is read once,
// however many of them name it. A Space or a Vendor that is new comes with the steps that
// create it for the first entry that names it, and with none after that.
const sharedByEntries = Effect.gen(function* () {
  return {
    sql: yield* SqlClient.SqlClient,
    // A name is the same in any case. With none given, it is the Current property.
    property: askedOnce(propertyFor, (given) => (given === undefined ? undefined : nameKey(given))),
    space: referredOnce(
      (propertyId: string, name: string) => spaceOrNew(propertyId, name),
      (propertyId, name) => `${propertyId} ${nameKey(name)}`,
    ),
    vendor: referredOnce((name: string) => vendorOrNew(name), nameKey),
  };
});

// The steps that save one piece of Work, with its id. `was` is the Work as it is now, when the
// entry gives the id of one. `itemsThere` has the id of each Item the call names that is there.
// Nothing is written here, so an entry that is refused leaves nothing behind.
const stepsFor = Effect.fnUntraced(function* (
  entry: Entry,
  was: Existing | undefined,
  itemsThere: ReadonlySet<string>,
  { sql, ...once }: Effect.Success<typeof sharedByEntries>,
) {
  const { id, kind, title, data, note, clear = [] } = entry;
  if (id !== undefined && was === undefined) return yield* noRecord("work", id);
  const called = title ?? was?.title;
  if (called === undefined || (was === undefined && kind === undefined)) {
    return yield* new ToolError({ message: NO_KIND_OR_TITLE });
  }
  // An Item the Work names has to be there.
  const missing = (entry.item_ids ?? []).find((each) => !itemsThere.has(each));
  if (missing !== undefined) return yield* noRecord("item", missing);

  yield* refuseGivenAndCleared(entry, clear);
  // What the save does with a field that can be emptied: its new value, null to empty it, or
  // undefined to leave it as it is.
  const wanted = <Value>(field: (typeof CLEARABLE)[number], value: Value | undefined) =>
    clear.includes(field) ? null : value;

  // Where the Work is after the save. With no Property given, new Work is at the one Current
  // property. When there is not exactly one, Work on Items is at no Property. Work in a Space
  // is at that Space's Property, so it has to say which. Work that is there already stays
  // where it is.
  const itemIds = entry.item_ids === undefined ? undefined : [...new Set(entry.item_ids)];
  const onItems = (itemIds ?? []).length > 0 && (entry.spaces ?? []).length === 0;
  const propertyId = clear.includes("property")
    ? null
    : was !== undefined && entry.property === undefined
      ? was.property_id
      : yield* once.property(entry.property).pipe(
          Effect.map((property): string | null => property.id),
          Effect.catchTag("ToolError", (refusal) =>
            entry.property === undefined && onItems ? Effect.succeed(null) : Effect.fail(refusal),
          ),
        );
  const moved = was !== undefined && propertyId !== was.property_id;
  // Work needs a Property or at least one Item.
  if (propertyId === null && (itemIds?.length ?? was?.item_count ?? 0) === 0) {
    return yield* new ToolError({
      message: `Work needs a Property or at least one Item, and "${called}" would have neither. Give \`property\`, or the Items it was done to in \`item_ids\`.`,
    });
  }

  // A Space is one at a Property, so the Spaces a save names are ones at the Work's.
  if (propertyId === null && (entry.spaces ?? []).length > 0) {
    return yield* new ToolError({
      message: `A Space is one at a Property, and "${called}" is at none. Give \`property\` as well, or leave \`spaces\` out.`,
    });
  }
  const spaces =
    entry.spaces === undefined || propertyId === null
      ? undefined
      : yield* Effect.forEach(entry.spaces, (name) => once.space(propertyId, name));
  // Work that moves to another Property loses its Spaces, unless the save gives it some there.
  const spaceIds =
    spaces !== undefined ? [...new Set(spaces.map((space) => space.id))] : moved ? [] : undefined;
  const vendor = entry.vendor === undefined ? undefined : yield* once.vendor(entry.vendor);

  const logged = {
    type: "work",
    id: was?.id ?? (yield* (yield* Ids).next),
    name: called,
  } as const;
  const columns = definedColumns({
    property_id: was === undefined || moved ? propertyId : undefined,
    kind,
    title,
    description: wanted("description", entry.description),
    date: wanted("date", entry.date),
    cost_cents: wanted("cost", entry.cost === undefined ? undefined : inCents(entry.cost)),
    // It is true or false at the tool, and 1 or 0 in the table.
    diy: entry.diy === undefined ? undefined : Number(entry.diy),
    vendor_id: wanted("vendor", vendor?.id),
  });
  const row =
    was === undefined
      ? insertRow(sql, logged, columns, data)
      : updateRow(sql, logged, columns, data);
  // Each list replaces its whole set. One that is left out leaves its set as it is.
  const links = [
    ...(itemIds === undefined ? [] : replaceLinks(sql, row, "items", itemIds)),
    ...(spaceIds === undefined ? [] : replaceLinks(sql, row, "spaces", spaceIds)),
  ];
  // A Note on a record takes that record's Property, so the Notes on Work move with it.
  const carried = moved ? notesMovedTo(sql, was.notes, propertyId) : [];

  return {
    id: logged.id,
    steps: [
      ...(spaces ?? []).flatMap((space) => space.steps),
      ...(vendor?.steps ?? []),
      row,
      ...links,
      ...carried,
      ...(yield* noteOn(note, propertyId, logged)),
    ],
  };
});

export const logWork = defineTool({
  name: "log_work",
  description: DESCRIPTION,
  input: Schema.Struct({ ...FIELDS, work: optional(listOf(Entry, LIST)) }),
  annotations: SAVE_ANNOTATIONS,
  run: ({ work, ...one }) =>
    Effect.gen(function* () {
      const entries = yield* entriesOf(LIST, one, work);
      const shared = yield* sharedByEntries;
      // The reads do not grow with the list: the Work it updates is read in one query, and the
      // Items it names in another.
      const existing = yield* workNow(entries.ids);
      const itemsThere = yield* itemsAmong(entries.all.flatMap(({ item_ids = [] }) => item_ids));

      // Every entry is checked before anything is written.
      const saves = yield* planEvery(entries, (entry) =>
        stepsFor(
          entry,
          entry.id === undefined ? undefined : existing.get(entry.id),
          itemsThere,
          shared,
        ),
      );
      const reply = yield* runSave(saves.flatMap(({ steps }) => steps));
      // A call that logs one piece of Work also returns it as get_record does.
      const [only, ...others] = saves;
      return only === undefined || others.length > 0
        ? reply
        : { ...reply, record: yield* readRecord("work", only.id) };
    }),
});
