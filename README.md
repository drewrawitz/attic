# Attic

A personal, self-hosted record of the places its User lives and everything in them: repairs and improvements with receipts, vendors, maintenance schedules, appliance models and part numbers, paint colors, and a catalog of belongings for insurance and resale.

Attic has no app. It is a remote MCP server on Cloudflare (Workers, D1, R2, KV) that the User's own AI clients connect to. One deployment serves one User.

## Layout

- `apps/server` is the Worker.
- `packages/core` is the domain logic, written with Effect. Nothing in it is specific to Workers, so its tests run in Node.
- `alchemy.run.ts` declares the Cloudflare resources: the Worker, the D1 database, the R2 bucket, and the KV namespace.
- `migrations/` is the database schema. It is applied on every deploy, and to the local database on every start.
- `test/` runs the stack in `alchemy.run.ts` on local simulators.
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

- Run Attic on your machine:

```bash
vp run dev
```

This is [`alchemy dev`](https://alchemy.run/cloudflare/local-development). The Worker runs in workerd at `http://localhost:1337` with local D1, R2, and KV behind it, and it reloads when a file changes. It needs no Cloudflare account and no `.env`. The local data lives in `.alchemy/`, which git ignores. Delete that folder to start over.

- Run the tests:

```bash
vp run -r test
```

Both suites apply the real files in `migrations/`. The tests in `packages/core` run in Node and pin the rules the schema enforces, on an in-memory Node SQLite database. Node SQLite and D1 are not the same build (ADR 0006), so the tests in `test/` also run the real Worker and the real migration on local D1. They use [Alchemy's test harness](https://alchemy.run/testing/test-harness) in dev mode, which runs the same local simulators as `vp run dev`. Neither suite needs a Cloudflare account.

- Run all of the above checks before pushing:

```bash
vp run ready
```

## Deploying your own copy

One deployment serves one User, so you deploy Attic to your own Cloudflare account. It is built to fit the Workers Free plan.

### What the Cloudflare account needs first

- **A workers.dev subdomain.** A new account picks one the first time it opens Workers & Pages in the dashboard.
- **R2 enabled.** Cloudflare asks for a payment method before R2 can be used, even on the free tier.
- **An API token**, scoped to the one account. A token with these permissions was enough for a first deploy to a workers.dev address. Whether every one of them is needed has not been tested:
  - Account: Workers Scripts Edit, Workers KV Storage Edit, Workers R2 Storage Edit, D1 Edit, Secrets Store Edit, Workers Tail Read, Account Settings Read
  - User: User Details Read
- **A choice of address.** Either the Worker's workers.dev address, or a domain on a zone that is already in the account. The address ends up in Google's redirect settings and in every client's connector config, so changing it later means reconnecting everything.

A custom domain has not been deployed yet, so that path is untested. The token should also need Workers Routes Edit, Zone Read, and DNS Edit on the zone.

### Deploy

1. Copy `.env.example` to `.env` and fill it in. Leave `ATTIC_DOMAIN` empty to use the workers.dev address.
2. Deploy:

```bash
vp run deploy
```

This is `alchemy deploy --stage prod`. It shows a plan and asks before it changes anything. It creates a Worker named `attic`, a D1 database, an R2 bucket, and a KV namespace, applies any migration in `migrations/` that the database has not seen, and prints the address.

Use `vp run deploy`, not a bare `alchemy deploy`. Alchemy's own default stage is `live_<your user name>`, so a bare deploy would plan a second copy of everything, with a Worker named `attic-live-<your user name>`.

The first deploy to an account also asks to set up [Alchemy's state store](https://alchemy.run/state-store), which is where Alchemy remembers what it has deployed. That is one more Worker, named `alchemy-state-store`, and a Secrets Store.

To deploy a second copy next to the first, pick another stage. Its Worker is named `attic-<stage>` and it gets its own database, bucket, and namespace:

```bash
vp exec alchemy deploy --stage staging
```
