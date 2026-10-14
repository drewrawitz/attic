import type { WorkerEnv } from "../../../alchemy.run.ts";
import { ChoreFailure, type Chore, type NightlyRun } from "./chore.ts";
import { databaseBackup } from "./database-backup.ts";

// The nightly run. The Cron Trigger in alchemy.run.ts fires the Worker's `scheduled` handler
// once a night, and the handler runs these chores, one after another.
const nightlyChores = (env: WorkerEnv): ReadonlyArray<Chore> => [databaseBackup(env)];

/**
 * How many subrequests one run makes at the most, between all of its chores. A cron run on
 * Workers Free gets 50 (ADR 0012), and a `fetch` past them fails. The run stops five short,
 * because a `fetch` that is sent on to another address counts once more for each hop.
 */
const SUBREQUEST_LIMIT = 45;

// How long a line of the log is at the most. An answer that said no is logged with the line,
// and can be any length.
const LINE_LENGTH = 600;

/**
 * Runs each chore, and logs one line for each: what it did, or why it stopped. A chore that
 * fails does not stop the next, and the run itself never throws. A night that fails only shows
 * in the log.
 */
export const runChores = async (chores: ReadonlyArray<Chore>): Promise<void> => {
  let subrequests = 0;
  // What must not be logged, longest first, so that a value inside another is not cut in two.
  // A line is cut short only once that is hidden, or the cut could leave the head of a secret.
  const keptOut: string[] = [];
  const fitForLog = (line: string) =>
    keptOut.reduce((text, value) => text.replaceAll(value, "[hidden]"), line).slice(0, LINE_LENGTH);

  const night: NightlyRun = {
    fetch: async (input, init) => {
      if (subrequests === SUBREQUEST_LIMIT) {
        throw new ChoreFailure(
          `The run has made its ${SUBREQUEST_LIMIT} subrequests. A cron run on Workers Free gets 50, so the rest waits for the next night.`,
        );
      }
      subrequests += 1;
      return fetch(input, init);
    },
    keepOut: (value) => {
      if (value === "") return;
      keptOut.push(value);
      keptOut.sort((a, b) => b.length - a.length);
    },
  };

  for (const chore of chores) {
    try {
      console.log(fitForLog(`${chore.name}: ${await chore.run(night)}`));
    } catch (error) {
      const reason = error instanceof ChoreFailure ? error.message : String(error);
      console.error(fitForLog(`${chore.name}: failed. ${reason}`));
    }
  }
};

export const nightly = (env: WorkerEnv) => runChores(nightlyChores(env));
