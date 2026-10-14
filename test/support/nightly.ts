import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as Test from "alchemy/Test/Vitest";
import type { WorkerEnv } from "../../alchemy.run.ts";
import { nightlyChores } from "../../apps/server/src/nightly.ts";

// The Worker's nightly run, fired by hand, and what the Worker logged while it ran.

// Where Alchemy's local runtime writes what the Worker logs: one file for each start of the
// Worker, named by when it started.
const LOG_DIR = join(".alchemy", "log", Test.defaultStage(), "Worker");

// Every log file there is, with its text.
const logFiles = () =>
  new Map(
    readdirSync(LOG_DIR)
      .filter((name) => name.endsWith(".log"))
      .map((name) => [name, readFileSync(join(LOG_DIR, name), "utf8")]),
  );

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The names of the chores of the nightly run, which their lines of the log start with. They
// are read off the Worker's own list, so a chore that is added there is waited for here. A
// chore reads its bindings when it runs, so it gives its name with none.
const CHORE_NAMES = nightlyChores({} as WorkerEnv).map(({ name }) => name);

// What one chore logged in a run: its line, as it is in the log. A test of one chore reads
// its own line, so that it holds whatever the other chores say.
export const lineOf = (choreName: string, log: string) =>
  log
    .split("\n")
    .filter((line) => line.startsWith(`${choreName}: `))
    .map((line) => `${line}\n`)
    .join("");

// Fires the Worker's `scheduled` handler, the way a Cron Trigger does, through the address
// Alchemy's local runtime keeps for that. The answer comes once the handler has returned.
// `outcome` is "ok" unless the handler threw. `log` is what the Worker logged for the run:
// the log is written a moment after the handler returns, so this waits for the line of each
// chore.
//
// The local runtime also fires the Worker's Cron Trigger on its own clock, at 03:00 UTC under
// the tests' settings. A test that is running at that very second sees a run it did not fire.
export const runNightly = async (url: string) => {
  const before = logFiles();
  const fired = await fetch(`${url}/cdn-cgi/handler/scheduled?format=json`, { method: "POST" });
  const { outcome } = (await fired.json()) as { outcome: string };

  // A handler that threw logged nothing of its own, so there is no line to wait for.
  let log = "";
  const hasEveryLine = () => CHORE_NAMES.every((choreName) => lineOf(choreName, log) !== "");
  for (let waited = 0; outcome === "ok" && waited < 2000 && !hasEveryLine(); waited += 20) {
    await pause(20);
    log = [...logFiles()].map(([name, text]) => text.slice(before.get(name)?.length ?? 0)).join("");
  }
  return { outcome, log };
};
