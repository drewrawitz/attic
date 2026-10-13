# A thin typed spine plus a `data` JSON object on every record

Every record has typed columns only for what code joins, filters, sums, or branches on (ids, links between records, kind and status, dates, money) and one `data` JSON object for everything descriptive. A water heater, a paint color, and a lease do not share fields, and recording a new kind of thing should never need a migration.

## Considered options

- Fully typed columns: too rigid, every new kind of thing needs a migration.
- Fully unstructured records: nothing to join, filter, or sum on.

## Consequences

- A `data` key that a tool starts to branch on is promoted to a generated column. No data migration is needed.
- `data` is written by merge patch, which replaces arrays whole. A list that gets edited one entry at a time is stored as an object keyed by a slug.
- Key names would drift between sessions, so clients are given a short list of well-known keys, and each Category can declare the keys it expects.
- Money inside `data` is integer cents under a key ending in `_cents`.
- `gaps` reads three `data` keys and promotes none of them (issue 52). A generated column is there for SQL to join, filter, or sort on one value, and to be indexed. A Category's `expects` is a list. The statement walks it with `json_each`, and it would walk a column that held the list the same way, with nothing to index. A Space's `sqft` and `paint` are only looked at in code, to see whether anything is under them, in the `data` the statement has already read whole. That is how `get_record` reads `paint` as well (ADR 0015). A column is also a migration, and a tool that only reads should not need one.
