# A deploy keeps Alchemy's state on Cloudflare, dev and tests keep it local

A deploy keeps Alchemy's state in the Cloudflare state store (`Cloudflare.state()`), so it does not depend on one machine's disk. `alchemy dev` and the tests keep theirs in the local `.alchemy/` folder. With the Cloudflare state store everywhere, running Attic locally or running its tests would need Cloudflare credentials and a state store that is already deployed, and the first `alchemy dev` on a new account would deploy that state store without asking, because dev mode implies `--yes`. Dev and test state only describes simulators on one machine, so nothing is lost by keeping it there.

Checked against alchemy 2.0.0-beta.81 on 2026-10-09.

## Consequences

- Anyone can clone the repo and run `vp run dev` and the tests with no Cloudflare account.
- Local data is reset by deleting `.alchemy/`. Alchemy's docs suggest `alchemy destroy --stage dev_$USER` for that, but a destroy does not run in dev mode, so it reads the Cloudflare state store and never sees the local stage.
- A command that is told only a stage's name cannot go by dev mode, because plain `alchemy deploy` is never in it. The made-up household's stack (issue 24) looks for the stage in `.alchemy/` first and uses the Cloudflare state store otherwise. That is how it reaches the database behind `vp run dev` with no Cloudflare account.
