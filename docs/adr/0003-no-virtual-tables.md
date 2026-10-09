# No FTS5 or other virtual tables

Search is plain `LIKE` over text columns and `data`, with no FTS5 index. D1 cannot export a database that contains a virtual table, and being able to take all the data out as one file matters more than search speed at household scale.

Checked against the D1 docs on 2026-10-09. Revisit if export starts supporting virtual tables or search gets slow.
