import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { ToolError } from "./tool.ts";

/** A Category, as a tool needs it to find one and to tell where it sits. */
export interface Category {
  readonly id: string;
  readonly name: string;
  readonly parent_id: string | null;
}

/**
 * The Category an Item is in unless a save names one, which is the table's own default. So it
 * has to be there, and no tool deletes it.
 */
export const DEFAULT_CATEGORY = "other";

/** Every Category there is. The list is short, so a tool reads it whole and looks in it. */
export const everyCategory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<Category>`SELECT id, name, parent_id FROM categories ORDER BY id`;
});

// A text as it is compared: its letters and digits, in lowercase. So "Power Tools" is the
// same as power-tools.
const plain = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

// The fewest single-character edits that turn one text into the other.
const edits = (from: string, to: string) => {
  let row = Array.from({ length: to.length + 1 }, (_, at) => at);
  for (let i = 1; i <= from.length; i++) {
    const next = [i];
    for (let j = 1; j <= to.length; j++) {
      const swap = row[j - 1]! + (from[i - 1] === to[j - 1] ? 0 : 1);
      next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, swap);
    }
    row = next;
  }
  return row[to.length]!;
};

// The shortest text that counts when one text is found inside another. Anything shorter is in
// too many names to say much.
const SHORTEST_PART = 3;

// How far a text is from an id or a name: 0 when they are the same, under 1 when one is
// inside the other, and otherwise the edits between them.
const distance = (given: string, own: string) => {
  const [short, long] = given.length <= own.length ? [given, own] : [own, given];
  return short.length >= SHORTEST_PART && long.includes(short)
    ? (long.length - short.length) / 100
    : edits(given, own);
};

// The most close Categories an error lists.
const MOST_CLOSE = 3;

// Categories as an error lists them, by id and name.
const listed = (categories: ReadonlyArray<Category>) =>
  categories.map(({ id, name }) => `${id} (${name})`).join(", ");

/**
 * What an error says of the Categories closest to a text that is no Category's id: up to
 * three, by id and name. A name counts as much as an id, since a name is what a client often
 * has. A misspelling is close when a third of its letters or fewer are wrong. When nothing is
 * close, it says so and lists the Categories at the top of the tree. Three that are not close
 * would read as a suggestion, and the top of the tree is where to start looking.
 */
export const closestTo = (given: string, categories: ReadonlyArray<Category>) => {
  const asked = plain(given);
  const within = Math.max(1, Math.floor(asked.length / 3));
  const near = categories
    .map((category) => ({
      category,
      away: Math.min(distance(asked, plain(category.id)), distance(asked, plain(category.name))),
    }))
    .filter(({ away }) => away <= within)
    .sort(
      (one, other) => one.away - other.away || one.category.id.localeCompare(other.category.id),
    );
  // One that is the same but for its case and punctuation is the one that was meant.
  const same = near.filter(({ away }) => away === 0);
  const close = (same.length > 0 ? same : near).slice(0, MOST_CLOSE);
  if (close.length > 0) return `The closest are: ${listed(close.map(({ category }) => category))}.`;

  const top = categories.filter(({ parent_id }) => parent_id === null);
  return top.length === 0
    ? "None is close to it."
    : `None is close to it. The top-level Categories are: ${listed(top)}.`;
};

/**
 * The Category with an id, among the ones there are. A Category must already exist: one that
 * does not is an error that lists the closest matches. save_category is the only tool that
 * makes one.
 */
export const categoryAmong = (given: string, categories: ReadonlyArray<Category>) => {
  const found = categories.find(({ id }) => id === given);
  return found !== undefined
    ? Effect.succeed(found)
    : Effect.fail(
        new ToolError({
          message: `There is no Category "${given}". ${closestTo(given, categories)} get_schema lists every Category, and save_category adds one.`,
        }),
      );
};

/** Whether a Category sits under another, however far down. */
export const isUnder = (id: string, above: string, categories: ReadonlyArray<Category>) => {
  const parents = new Map(categories.map((category) => [category.id, category.parent_id]));
  // Nothing in the schema stops parents from forming a loop, so the walk up stops at a
  // Category it has already passed.
  const passed = new Set<string>();
  for (let at = parents.get(id); at != null && !passed.has(at); at = parents.get(at)) {
    if (at === above) return true;
    passed.add(at);
  }
  return false;
};
