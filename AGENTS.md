# Attic

A personal, self-hosted record of the places its User lives and everything in them: repairs and improvements with receipts, vendors, maintenance schedules, appliance models and part numbers, paint colors, and a catalog of belongings for insurance and resale. Attic has no app. It is a remote MCP server on Cloudflare (Workers, D1, R2, KV) that the User's own AI clients connect to, and one deployment serves one User.

- **Vocabulary:** `GLOSSARY.md`. Use its terms in code, tool descriptions, issues, and docs.
- **Decisions:** `docs/adr/`. Read the ones that touch your area before changing it. They record why, so nothing gets relitigated.
- **Schema:** `migrations/0001_init.sql`. Its comments document the data conventions.
- **Work:** tracked in GitHub issues (see Agent skills below), never in plan files in the repo.

## Questions it must answer

The acceptance tests for the design:

- "List every repair and improvement since March 2023, with receipts."
- "Order a new water filter for the fridge." Return the part number and where it was bought last. Attic never buys anything.
- "Something's wrong with the microwave." Return the exact model so the client can troubleshoot.
- "What fitness products do I own?"
- "What did I pay for everything I own?" and "What's missing a receipt or photo?"
- "What did I sell this year?" and "Which stolen items haven't been paid out?"
- "What paint is in the living room?"
- "Who did we use for plumbing last time?" and "Who quoted the outdoor lighting, and for how much?"
- "What maintenance is coming up?"

## Stack

Pin exact versions. Each `package.json` is the source of truth for what is installed and at which version. The one exception to pinning is `@cloudflare/workers-types`, which stays on `latest`.

## Hard rules

- **MCP:** build on `createMcpHandler` and `@modelcontextprotocol/server` v2. `McpAgent` and the v1 `@modelcontextprotocol/sdk` are off the table (ADR 0001). The agents API moved recently, so read `apps/server/node_modules/agents/docs/mcp-servers.md` and `mcp-transports.md` before writing against it.
- **OAuth:** use the built-in helpers in `@cloudflare/workers-oauth-provider` 1.x, and read `apps/server/node_modules/@cloudflare/workers-oauth-provider/docs/upstream-sign-in.md` and `consent-page.md` first. The auth code in Cloudflare's old `remote-mcp-google-oauth` template (`workers-oauth-utils.ts`) is obsolete.
- **Layers:** Effect in tool handlers and `packages/core`. OAuth and the MCP transport stay on Cloudflare's libraries (ADR 0004). The Worker is a plain `export default { fetch }` module, and Alchemy only declares resources (ADR 0005).
- **Writes:** reads first, then one atomic batch that also records the Change (ADR 0011). Never call `withTransaction`, which dies on D1 (ADR 0006).
- **Tool schemas:** Effect Schema, converted with `Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema))`. Use `Schema.Finite` for numbers, because plain `Schema.Number` advertises Infinity and NaN.
- **Migrations:** a schema change is a new numbered file. An applied migration is never edited. No virtual tables (ADR 0003).
- **Any client:** tools work without client extras such as prompts, images in tool results, or scheduled tasks (ADR 0007).
- **Free plan:** code fits the Workers Free limits (ADR 0012).
- **Nothing personal:** no emails, domains, or secrets in the repo or in issues, which are public. Anything that varies by host is config (allowed emails, timezone, currency, domain, digest address, backup destination), and a feature that needs extra setup switches off cleanly when it is not configured.
- **No inbox access:** no Gmail or email-provider integration.
- **Writing:** docs, issues, and commit messages are plain and human, with no em dashes.

## Tool rules

Every tool follows these.

- **Property:** accepts an id or a name. When omitted, use the one Current property. With none or several, return an error that lists them. Tools decide "current" in code, with today in the configured timezone. The `current_properties` and `inventory` views use the UTC date and are only for `query`.
- **Spaces and Vendors:** referenced by name, matched ignoring case, created on first use.
- **Categories:** must already exist. An unknown one is an error that lists the closest matches.
- **Money:** dollars (the configured currency) at the tool boundary, integer cents in the database.
- **Dates:** ISO text, possibly partial (`2023`, `2023-06`, `2023-06-12`). In a range filter a Partial date counts as its whole period, and a match by overlap is marked approximate. "Today" is in the configured timezone.
- **`data`:** a JSON merge patch applied with `json_patch`. Keys come from the well-known list that `get_schema` publishes.
- **Status changes:** changing an Item's status writes a dated Note. `status_on` defaults to today.
- **Deleting:** a record's Notes go with it, and so does any Document attached to nothing else. A Vendor, Space, Category, or Project that other records point at is refused unless the call names a replacement. Properties are never deleted.
- **Output:** curated tools parse JSON columns and format money. `query` returns raw rows.
- **Annotations:** `readOnlyHint` on read tools, `destructiveHint` on `delete_record`.
- **Ids:** ULIDs generated in code.

<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Built-in Commands vs Scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script or a `vite.config.ts` task. Scripts cannot overwrite built-ins, so `vp dev` and `vp run dev` may do different things. Check `package.json` and `vite.config.ts` first, and run `vp run <name>` when the project defines a script or task with that name.

## Tool Versions

Run `vp toolchain` to show versions and relationships in the active Vite+
release. Add a tool name to select part of the graph. For example, run
`vp toolchain vite`. Use `--global` to ignore the local `vite-plus` package. Use
`vp why <package>` to show the package-manager dependency graph.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues on `drewrawitz/attic`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default triage labels are used as-is: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
