# Every write is logged as a Change, and undo works from the log

A model is the only writer, a merge patch with `null` removes keys, and deleting is routine (ADR 0009). D1's Time Travel can only restore the whole database, and only 7 days back on the Free plan. So every write also appends a Change to an append-only log, in the same atomic batch as the write itself (ADR 0006): the tool, the record, and the record as it was before and after. One `undo` tool puts a record back from a Change, including a deleted row.

## Considered options

- No log, relying on Time Travel: nothing to build, but undoing one bad write means rolling back everything written since.

## Consequences

- Changes are kept forever. They are small, and they answer "what did the bot change in that session".
- There is no separate history tool. A record's recent Changes come back with the record, and the log can be read with `query`.
- A deleted Document's file stays in storage for 30 days before a nightly sweep removes it, so undo can bring the file back inside that window. Deleting a file is therefore not immediate.
