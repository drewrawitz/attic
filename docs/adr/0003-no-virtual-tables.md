# No FTS5 or other virtual tables

Search is plain `LIKE` over text columns and `data`, with no FTS5 index. D1 cannot export a database that contains a virtual table, and being able to take all the data out as one file matters more than search speed at household scale.

Checked against the D1 docs on 2026-10-09. Revisit if export starts supporting virtual tables or search gets slow.

## Consequences

Found while building `search` (issue 25), on local D1 on 2026-10-10.

- `data` is searched as the JSON text it is stored as, so a word also finds a key: "paint" finds every Space with paint on record.
- Case is ignored for the letters a to z only. `'É' LIKE 'é'` is false on D1.
- D1 turns down a `LIKE` pattern of more than 50 bytes, which is also on its limits page. The pattern is the word and a `%` at each end, so `search` refuses a word of more than 48 bytes.
