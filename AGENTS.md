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
- **Layers:** Effect in tool handlers and `packages/core`. OAuth and the MCP transport stay on Cloudflare's libraries (ADR 0004). The Worker is a plain `export default { fetch }` module, and in `alchemy.run.ts` Alchemy only declares resources (ADR 0005).
- **Writes:** reads first, then one atomic batch that also records the Change (ADR 0011). A tool writes through `Write` in `packages/core/src/write.ts`, and a type of record it writes is first added to `packages/core/src/records.ts`, with what it points at, which columns no two records can share, and the column in which it follows a record it is attached to. Never call `withTransaction` in `packages/core/src`, where it would die on D1 (ADR 0006). The Node SQLite tests call it to stand in for the batch.
- **Tool schemas:** Effect Schema, handed to `defineTool` in `packages/core/src/tool.ts`. It converts the schema with `Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema, ...))`, set to turn away a key the schema does not declare, and nothing else converts a tool's schema (ADR 0014). Use `Schema.Finite` for numbers, because plain `Schema.Number` advertises Infinity and NaN.
- **Migrations:** a schema change is a new numbered file. An applied migration is never edited. No virtual tables (ADR 0003).
- **Any client:** tools work without client extras such as prompts, images in tool results, or scheduled tasks (ADR 0007).
- **Free plan:** code fits the Workers Free limits (ADR 0012).
- **Nothing personal:** no emails, domains, or secrets in the repo or in issues, which are public. Anything that varies by host is config (allowed emails, timezone, currency, domain, digest address, backup destination), and a feature that needs extra setup switches off cleanly when it is not configured.
- **No inbox access:** no Gmail or email-provider integration.
- **Writing:** docs, issues, and commit messages are plain and human, with no em dashes.

## Tool rules

Every tool follows these.

- **Property:** accepts an id or a name. When omitted, use the one Current property. With none or several, return an error that lists them. Tools decide "current" in code, with today in the configured timezone. The `current_properties` and `inventory` views use the UTC date and are only for `query`. There are two exceptions. `search` with no Property looks through every Property, because a Vendor has none and "who did we use last time" may be at a former Property. And Work that names Items can be saved with no Property, as the Work rule below says. A tool gets the Property it works at from `propertyFor` in `packages/core/src/property.ts`, and looks up one a caller named with `propertyNamed` there. Its `property` field is `nameText`, which drops the spaces around what is given.
- **Spaces and Vendors:** referenced by name, matched ignoring case, created on first use. `spaceOrNew` in `packages/core/src/space.ts` and `vendorOrNew` in `vendor.ts` find one or hand back the step that creates it, which goes in the caller's batch. A Space is one at a Property, so a tool settles the Property first.
- **Categories:** must already exist. An unknown one is an error that lists the closest matches, or the top-level Categories when none is close, through `categoryAmong` in `packages/core/src/category.ts`. `save_category` is the only tool that makes one.
- **Notes:** a Note on a record takes that record's Property, and moves with the record: a save that moves a record moves its Notes in the same Change, through `notesMovedTo` in `packages/core/src/note.ts`. A Note that stands alone goes to the Property given, or to the Current property. The optional Note of a save is attached to the record that was saved and written in the same Change, through `noteOn` in `packages/core/src/note.ts`.
- **Money:** dollars (the configured currency) at the tool boundary, integer cents in the database. An amount below zero, or with more than two decimal places, is a validation error. A tool takes one with `amount` in `packages/core/src/money.ts`, stores it with `inCents`, and writes one out in a Note with `formatCents`.
- **Dates:** ISO text, possibly partial (`2023`, `2023-06`, `2023-06-12`). Anything else, and a date that does not exist such as `2023-13`, is a validation error that shows the three forms. In a range filter a Partial date counts as its whole period, and a match by overlap is marked approximate. "Today" is in the configured timezone, and a tool reads it from `today` in `packages/core/src/dates.ts`.
- **`data`:** a JSON merge patch applied with `json_patch`, and stored as written. So money inside it goes in as integer cents under a key ending in `_cents`, though a curated tool shows it in dollars. Keys come from the well-known list that `get_schema` publishes, so a tool that takes `data` for a kind of record adds a list for that kind there.
- **Unknown fields:** a key a tool does not declare is a validation error that names the key and lists the fields there are. Nothing is dropped. Only `data` takes any key (ADR 0014).
- **Saving:** with an `id` a save updates that record, and an id that is not there is an error. Without one it creates, except that where no two records can have the same name, a save under a name that is taken updates the record that has it. A field left out, or sent as null, is left alone. A field is emptied by naming it in `clear`. It cannot be both given and cleared, and a field that must have a value cannot be cleared. The reply has the id of the Change and every record the call created or updated, by type, id, and name. A save's steps are its batch and its reply both, so a record created on first use is always in what comes back. A call that saves one record also returns it as `get_record` does. A Category goes its own way in two things. Its id is a slug the caller chooses, so a save under an id that is not there creates it. And `get_record` takes no Category, so `save_category` returns it as it was stored, with its parent's name. The shared pieces are in `packages/core/src/save.ts`.
- **Status changes:** changing an Item's status writes a dated Note. The Note has the Item's proceeds when the new status is a Gone Item's and the proceeds are more than zero. `status_on` defaults to today, and cannot be cleared in the save that changes the status. A new Item starts out active, so one saved with another status has changed it.
- **Moving an Item:** an Item that moves to another Property loses its Space, unless the save gives it one there. A Fixture does not move: a save that would move one is refused, and one that is taken along is saved as a Belonging in the same call.
- **Work:** needs a Property or at least one Item, which code enforces because the Items are in a table of their own. With no Property given, new Work is at the Current property. With none or several, Work that names Items and no Spaces is saved with no Property, and any other Work is an error that lists them. Its Items are given by id and must be there. Its Spaces are Spaces at its Property, so Work at no Property takes none, and Work that moves to another Property loses its Spaces unless the save gives it some there. Work that is in a Project, or was logged against a Schedule on a Property, does not move. `diy` is true or false in a tool's input, and 1 or 0 in the database and in a record.
- **Lists:** a tool that takes a list takes up to 50 entries and saves them all or nothing, as one Change. Every entry is checked before anything is written. The error names each entry that was refused by its place in the list, counted from 0 as a validation error counts, and says why. A Property, a Space, or a Vendor that several entries name is read once, whatever the case of its name, and a new one is created once. A tool asks through `propertyForOnce`, `spaceOrNewOnce`, and `vendorOrNewOnce`, which sit beside the helpers they wrap and are built on `askedOnce` and `referredOnce` in `packages/core/src/save.ts`. A set of links, such as an Item's extra Categories or the Items and Spaces of Work, is replaced whole with `replaceLinks` there. The list itself is declared with `listOf`, and a call's entries are read with `entriesOf` and checked with `planEvery`, there too.
- **Deleting:** a record's Notes go with it, and so does any Document attached to nothing else. A Vendor, Space, Category, or Project that other records point at is refused unless the call names a replacement. `delete_record` never deletes a Property.
- **Undoing:** `undo` takes the id of a Change and makes every record it touched what the Change's own snapshots say it was before: one the Change created is taken out, one it updated is restored, and one it deleted is put back, each with its link sets. It has no code for any one tool. It goes by what `packages/core/src/records.ts` says a record of each type is and points at, so a type is covered once it is there. An undo is a Change with `undoes` set, and can be undone. It is refused, with nothing written, when a later Change touched one of the records, and the error lists those Changes newest first. A Change and the undo of it do not count, so the way is clear once the later ones are undone. It is also refused when it would leave a pointer at nothing or two records under one name: a record it would take out is pointed at by a record outside the Change, a record it would restore or put back pointed at one that is not there now, or had a name another record has now. Each error names the records. And it is refused when it would leave what a save does not allow. One is a Category under itself, by way of the Categories above it: the error names every Category in the loop, and one of the others has to come out from under its parent first. The other is a Note at another Property than the record it is on, from either side. A record would move back and leave a Note that was added to it since: the error names the Note and the Change that added it, which is the one to undo first. Or a Note would come back on a record that is elsewhere now: the error names both, and the Change that moved the record when one did. No tool deletes a Property: undoing the Change that made one takes it out.
- **Output:** curated tools parse JSON columns and format money. `query` returns raw rows.
- **Annotations:** `readOnlyHint` on read tools, `destructiveHint` on `delete_record`. A save sets both to false, and so does `undo`, because a client assumes a tool may destroy things when `destructiveHint` is left out.
- **Ids:** ULIDs generated in code. The one a caller chooses is a Category's.

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
