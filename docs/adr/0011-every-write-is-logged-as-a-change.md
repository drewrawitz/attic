# Every write is logged as a Change, and undo works from the log

A model is the only writer, a merge patch with `null` removes keys, and deleting is routine (ADR 0009). D1's Time Travel can only restore the whole database, and only 7 days back on the Free plan. So every write also appends a Change to an append-only log, in the same atomic batch as the write itself (ADR 0006): the tool, the record, and the record as it was before and after. One `undo` tool puts a record back from a Change, including a deleted row.

## Considered options

- No log, relying on Time Travel: nothing to build, but undoing one bad write means rolling back everything written since.

## Consequences

- Changes are kept forever. They are small, and they answer "what did the bot change in that session".
- There is no separate history tool. A record's recent Changes come back with the record, and the log can be read with `query`.
- A deleted Document's file stays in storage for 30 days before a nightly sweep removes it, so undo can bring the file back inside that window. Deleting a file is therefore not immediate.
- A tool's batch never runs without a Change (issue 32). A tool is not handed the atomic batch. It hands its statements to one write, each with the record it is about, and the step that runs the batch is the step that adds the Change to it, under the tool's name. One call is one write. That covers what a tool does through the write. Nothing stops a tool from running a statement of its own outside it, and no tool should.
- A snapshot is read by a statement inside the batch, before the tool's statements and again after them. So it holds what was stored, defaults and merge patch included, and not what a tool meant to store.
- One place says what a record of each type is: its table, its columns, and its link sets (`packages/core/src/records.ts`). Snapshots are built from it, and `undo` is to put records back from it (issue 36).
- A save that changes nothing still records a Change, because its statement still ran and moved `updated_at`. Its `before` and `after` differ in nothing else.
- A link set is written by statements about the record it belongs to, so the record's snapshots hold the set before and after (issue 34). An Item is 15 columns and one link set, which makes its snapshot 16 fields: the most one JSON object takes on D1 (ADR 0006). A sixteenth column on `items` stops the module from loading, and the snapshot has to be built in two parts before one can be added.
- Work is 14 columns and two link sets, its Items and its Spaces, so its snapshot is 16 fields as well (issue 35). A fifteenth column on `work` stops the module from loading in the same way. The `project` and `schedule_id` arguments that `log_work` is to take later set columns that are there already, `project_id` and `schedule_id`.
