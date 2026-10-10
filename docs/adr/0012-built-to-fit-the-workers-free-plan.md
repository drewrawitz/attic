# Built to fit the Workers Free plan

Attic should cost nothing to run for one household, and other people hosting it may be on the Free plan. So v1 is built to fit that plan's limits: 10 ms of CPU per request and per cron run, 1,000 calls per request to Cloudflare's own services (D1, R2, KV), 50 subrequests per request to anything else, and 1,000 KV writes a day. If the stack itself cannot fit in 10 ms, the answer is the $5 Workers Paid plan, not a rewrite.

Checked against the Workers and D1 limits docs on 2026-10-09, and measured on a deployed Worker the same day (issue 11).

## Measured

- The limit on D1 is 1,000 calls per request, not 50. The 1,001st call fails with "Too many API requests by single Worker invocation". The D1 limits page says 50 queries per invocation on Free, but the Workers limits page lists a separate cap of 1,000 for Cloudflare's own services, and that is the one the deployed Worker enforced. Only D1 was measured. That R2 and KV share the same 1,000 comes from the docs.
- A batch counts as one call, however many statements it holds. Thirteen calls carrying 1,200 statements went through.
- A request that makes one query and one batch of three statements, through Effect and `@effect/sql-d1`, used a median of 3.5 ms of CPU over 40 requests, and 9 ms at the 90th percentile. Four of the 40 went over 10 ms, up to 29 ms, which looks like the cost of a fresh isolate. Each further D1 call added about 0.8 ms.
- Cloudflare cut off no request for CPU, including ones that used a full second. Its docs say occasional overruns are tolerated and a Worker that consistently exceeds the limit is terminated, so 10 ms is still the budget to design for.

## Consequences

- The browser hashes a file before uploading it, so the Worker never spends CPU hashing.
- The backup copies files in small batches across runs instead of all at once.
- Sign-in and the MCP layer run on every request and were not part of the measurement. CPU time is the limit to watch as they land, not the number of D1 calls.
- Time Travel reaches back 7 days, not 30. That is one reason the change log (ADR 0011) and the off-Cloudflare backup exist.
