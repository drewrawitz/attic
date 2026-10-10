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

This is [`alchemy dev`](https://alchemy.run/cloudflare/local-development). The Worker runs in workerd at `http://localhost:1337` with local D1, R2, and KV behind it, and it reloads when a file changes. It starts with no Cloudflare account and no `.env`. The local data lives in `.alchemy/`, which git ignores. Delete that folder to start over.

Nothing answers without a token except the sign-in pages, so to use Attic locally you sign in the same way as on a deployed copy. That needs the three Google values in `.env` ([Sign-in with Google](#sign-in-with-google) says where they come from), and `http://localhost:1337/callback` among the Google client's redirect addresses. Until they are set, the sign-in page says which ones are missing. Two things can trip up a local sign-in:

- The sign-in cookies are marked secure. Chrome keeps those for a plain `http://localhost` address. A browser that does not will say that sign-in did not finish as soon as you press Allow.
- If something else already holds port 1337, `alchemy dev` serves on 1338 instead and says so when it starts. Google then refuses the sign-in, because the redirect address no longer matches.

- Run the tests:

```bash
vp run -r test
```

Both suites apply the real files in `migrations/`. The tests in `packages/core` run in Node and pin the rules the schema enforces, on an in-memory Node SQLite database. Node SQLite and D1 are not the same build (ADR 0006), so the tests in `test/` also run the real Worker and the real migration on local D1. They use [Alchemy's test harness](https://alchemy.run/testing/test-harness) in dev mode, which runs the same local simulators as `vp run dev`. Neither suite needs a Cloudflare account.

The tests in `test/` also sign in, and they need no Google account and no `.env`. They bring their own settings, and a stand-in for Google on your machine answers the two calls the Worker makes to it. The Worker finds Google through `GOOGLE_TOKEN_URL` and `GOOGLE_USERINFO_URL`, which only dev mode reads. A deploy always uses Google's own addresses.

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

### Sign-in with Google

Attic has no passwords. A client signs in through Google, and only the Google accounts you list get in. That takes a Google OAuth client of your own, which is free.

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project for Attic alone. The sign-in screen is set up once for a whole project, so a project shared with other apps would share its name and audience too.
2. Set up the sign-in screen (Google Auth Platform, then Audience):
   - **External**, left in **Testing**, is the choice for most people. Add your own Google account as a test user. Testing mode is enough, because Attic only asks Google who you are.
   - **Internal**, if your Google account belongs to a Google Workspace organization. Google then turns away everyone outside the organization itself, and there are no test users to manage.
3. Create an OAuth client of type **Web application**, with two redirect addresses:
   - `https://<your Attic address>/callback`. Without `ATTIC_DOMAIN` that address is `attic.<your workers.dev subdomain>.workers.dev`.
   - `http://localhost:1337/callback`, for `vp run dev`.
4. Put the client's id and secret in `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, and the Google accounts that may sign in as `ALLOWED_EMAILS`, separated by commas.

Attic asks Google for the account's email and name and nothing else, and it does not keep Google's tokens. An email only counts if Google has verified it.

### Deploy

1. Copy `.env.example` to `.env` and fill it in. Leave `ATTIC_DOMAIN` empty to use the workers.dev address.
2. Deploy:

```bash
vp run deploy
```

This is `alchemy deploy --stage prod`. It shows a plan and asks before it changes anything. It creates a Worker named `attic`, a D1 database, an R2 bucket, and a KV namespace, applies any migration in `migrations/` that the database has not seen, and prints the address. It stops if one of the three Google values is empty.

The Worker also gets a secret that you do not set. It signs the cookie that remembers which clients a browser has already allowed. Alchemy makes it on the first deploy and keeps it in its state store, so later deploys bind the same value.

To connect a client, give it the address plus `/mcp`. It registers itself, opens the sign-in page in your browser, and gets a token once you have signed in with a Google account on the list. Registration and the sign-in page are open to anyone, so each caller gets five registrations and ten sign-in page requests a minute. A caller is an IPv4 address or an IPv6 network.

Use `vp run deploy`, not a bare `alchemy deploy`. Alchemy's own default stage is `live_<your user name>`, so a bare deploy would plan a second copy of everything, with a Worker named `attic-live-<your user name>`.

The first deploy to an account also asks to set up [Alchemy's state store](https://alchemy.run/state-store), which is where Alchemy remembers what it has deployed. That is one more Worker, named `alchemy-state-store`, and a Secrets Store.

To deploy a second copy next to the first, pick another stage. Its Worker is named `attic-<stage>` and it gets its own database, bucket, and namespace:

```bash
vp exec alchemy deploy --stage staging
```
