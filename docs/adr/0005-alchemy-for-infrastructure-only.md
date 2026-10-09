# Alchemy declares infrastructure, the Worker stays a plain module

Alchemy 2 (a beta, pinned to an exact version) declares the Worker, D1, R2, KV, and secrets, and applies migrations on deploy. The Worker itself is a plain `export default { fetch }` module and does not use Alchemy's Effect-native Worker runtime. Because Alchemy stays out of the runtime, falling back to a wrangler config is a config rewrite and not a code rewrite.
