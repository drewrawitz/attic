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
- `query` is the one tool that does not run on Node SQLite. D1 says whether a statement changed the database only in its own result (`meta.changed_db`), so `query` asks the driver for that result and reads it as D1's (issue 24). Its guard also leans on how D1 treats a string of several statements. It is tested through the real Worker on local D1, and the check on `changed_db` with a stand-in driver.
- D1 has limits that Node SQLite does not, and a statement that breaks one passes every test in core. `search` met two (issue 25). D1 takes at most five SELECTs in one UNION, which its limits page does not mention and which was found on local D1 on 2026-10-10. It also takes at most 50 bytes in a `LIKE` pattern (ADR 0003). Neither shows up on Node SQLite. The tests of `search` that go through the real Worker on local D1 are what hold them.
