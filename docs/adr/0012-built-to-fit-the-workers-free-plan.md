# Built to fit the Workers Free plan

Attic should cost nothing to run for one household, and other people hosting it may be on the Free plan. So v1 is built to fit that plan's limits: 10 ms of CPU per request and per cron run, 50 subrequests per request (D1 queries count), and 1,000 KV writes a day. If the stack itself cannot fit in 10 ms, the answer is the $5 Workers Paid plan, not a rewrite.

Checked against the Workers and D1 limits docs on 2026-10-09.

## Consequences

- The browser hashes a file before uploading it, so the Worker never spends CPU hashing.
- The backup copies files in small batches across runs instead of all at once.
- The scaffold step measures real CPU time per tool call on a deployed Worker before any tool is built on top of it. It also measures how a batch of statements counts against the 50, which the docs do not say.
- Time Travel reaches back 7 days, not 30. That is one reason the change log (ADR 0011) and the off-Cloudflare backup exist.
