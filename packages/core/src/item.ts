// An Item's status says whether the User still has it (ADR 0009). active and listed are an Item
// the User has. The others are a Gone Item's: the User no longer has it, and its row stays for
// the money trail its exit left. Any status can follow any other, since a save also puts a
// status right, and `save_item` writes a dated Note on each change. `get_schema` says what each
// one means.

/**
 * The statuses an Item can have, in the order of the CHECK list of the `items` table, which a
 * test holds it to.
 */
export const ITEM_STATUSES = [
  "active",
  "listed",
  "sold",
  "given",
  "lost",
  "stolen",
  "destroyed",
] as const;

export type ItemStatus = (typeof ITEM_STATUSES)[number];

/** The statuses of a Gone Item, in the same order. */
export const GONE_STATUSES: ReadonlyArray<ItemStatus> = [
  "sold",
  "given",
  "lost",
  "stolen",
  "destroyed",
];

/**
 * The SQL that holds for an Item the User still has, given the column its status is read from,
 * such as `item.status`. A Gone Item is left out of the Items a Property and a Space show, and
 * of what `gaps` asks about. Every tool that leaves one out asks this, so a status that is added
 * is left out everywhere or nowhere.
 */
export const notGone = (statusColumn: string) =>
  `${statusColumn} IN (${ITEM_STATUSES.filter((status) => !GONE_STATUSES.includes(status))
    .map((status) => `'${status}'`)
    .join(", ")})`;
