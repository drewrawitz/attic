# Each write is reads first, then one atomic batch

D1 has no interactive transactions, and `@effect/sql-d1` dies with a defect if `withTransaction` is called (checked against 4.0.2 on 2026-10-09). So every write tool does its reads first, builds all of its statements, and sends them as one atomic batch. Core reaches this through a small atomic-write service with two implementations: D1's batch in the Worker, and an ordinary transaction in the Node SQLite tests.

## Considered options

- Non-atomic writes, ordered so a failure leaves only harmless leftovers: simpler, but a half-written record is hard to notice in a database that only a model writes to.
- Dropping Node SQLite and testing only on local D1: closer to production, but slower tests and a core package tied to the Workers runtime.

## Consequences

- Never call `withTransaction` in core.
- A write cannot read back its own earlier statements. Ids are ULIDs generated in code, so every statement can be written before any of them runs.
- Space and Vendor names get case-insensitive unique indexes, so "create on first use" cannot produce both "Kitchen" and "kitchen".
- Node SQLite and D1 are not the same build, so a small smoke suite runs the real migration on local D1. It must cover the recursive category view, which is valid SQLite but was not confirmed on D1.
