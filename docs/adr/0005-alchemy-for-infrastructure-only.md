# Alchemy declares infrastructure, the Worker stays a plain module

Alchemy 2 (a beta, pinned to an exact version) declares the Worker, D1, R2, KV, and secrets, and applies migrations on deploy. The Worker itself is a plain `export default { fetch }` module and does not use Alchemy's Effect-native Worker runtime. Because Alchemy stays out of the runtime, falling back to a wrangler config is a config rewrite and not a code rewrite.

## Consequences

- The made-up household is the one place where Alchemy runs something for Attic and does not only declare it. A second stack, in `household/`, holds an Action that loads the set into a stage's database or removes it, through Alchemy's own D1 client (issue 24). It runs when the maintainer runs it, never as part of a deploy, and it is no part of the Worker. A move to wrangler would replace it with `wrangler d1 execute`.
