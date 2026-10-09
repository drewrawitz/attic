# Attic

A personal, self-hosted record of the places its User lives and everything in them: repairs and improvements with receipts, vendors, maintenance schedules, appliance models and part numbers, paint colors, and a catalog of belongings for insurance and resale.

Attic has no app. It is a remote MCP server on Cloudflare (Workers, D1, R2, KV) that the User's own AI clients connect to. One deployment serves one User.

## Layout

- `apps/server` is the Worker.
- `packages/core` is the domain logic, written with Effect. Nothing in it is specific to Workers, so its tests run in Node.
- `migrations/` is the database schema.
- `docs/adr/` records decisions and the reasons behind them.
- `GLOSSARY.md` is the vocabulary used in code and docs.

## Development

- Install dependencies:

```bash
vp install
```

- Format, lint, and type check:

```bash
vp check
```

- Run the tests:

```bash
vp run -r test
```

- Run all of the above checks before pushing:

```bash
vp run ready
```
