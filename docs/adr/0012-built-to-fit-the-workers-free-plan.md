# Built to fit the Workers Free plan

Attic should cost nothing to run for one household, and other people hosting it may be on the Free plan. So v1 is built to fit that plan's limits: 10 ms of CPU per request and per cron run, 1,000 calls per request to Cloudflare's own services (D1, R2, KV), 50 subrequests per request to anything else, and 1,000 KV writes a day. If the stack itself cannot fit in 10 ms, the answer is the $5 Workers Paid plan, not a rewrite.

Checked against the Workers and D1 limits docs on 2026-10-09, and measured on a deployed Worker the same day (issue 11). Sign-in and the MCP layer were measured on the deployed Worker on 2026-10-10 (issues 18 and 19).

## Measured

- The limit on D1 is 1,000 calls per request, not 50. The 1,001st call fails with "Too many API requests by single Worker invocation". The D1 limits page says 50 queries per invocation on Free, but the Workers limits page lists a separate cap of 1,000 for Cloudflare's own services, and that is the one the deployed Worker enforced. Only D1 was measured. That R2 and KV share the same 1,000 comes from the docs.
- A batch counts as one call, however many statements it holds. Thirteen calls carrying 1,200 statements went through.
- A request that makes one query and one batch of three statements, through Effect and `@effect/sql-d1`, used a median of 3.5 ms of CPU over 40 requests, and 9 ms at the 90th percentile. Four of the 40 went over 10 ms, up to 29 ms, which looks like the cost of a fresh isolate. Each further D1 call added about 0.8 ms.
- Cloudflare cut off no request for CPU, including ones that used a full second. Its docs say occasional overruns are tolerated and a Worker that consistently exceeds the limit is terminated, so 10 ms is still the budget to design for.
- A request that is turned away for having no token used under 1 ms of CPU at the median and 2 ms at the 90th percentile, over 53 requests.
- A signed-in call of the placeholder tool, which makes one D1 query, arrives from Claude as two requests. Over 36 calls the first used a median of 4 ms and went over 10 ms twice. The second, which is most likely the tool call itself, used a median of 9 ms and went over 10 ms in 14 of 36, up to 61 ms. None was cut off.
- In KV, a client registration is 1 write, a first sign-in is 5, and a token refresh is 2. Access tokens last an hour, so a client in constant use spends up to 48 writes a day.
- The Rate Limiting binding works on Workers Free, but it counts loosely. A burst from one caller got about 20 registrations, or 60 requests for the sign-in page, in before the first refusal.

## Consequences

- The browser hashes a file before uploading it, so the Worker never spends CPU hashing.
- The backup copies files in small batches across runs instead of all at once.
- CPU time is the limit to watch, not the number of D1 calls. A signed-in tool call already sits at 10 ms with a placeholder tool that makes one query, so the real tools are expected to go over it. Cloudflare is not cutting anything off. Tool calls failing for CPU would be the sign that it is time for the paid plan.
- The rate limit on registration and the sign-in page is a brake, not a cap. It cannot keep a determined caller from using up the 1,000 KV writes a day. One deployment serves one User, so that is accepted. A counter in D1 or the paid plan would close it.
- Time Travel reaches back 7 days, not 30. That is one reason the change log (ADR 0011) and the off-Cloudflare backup exist.
