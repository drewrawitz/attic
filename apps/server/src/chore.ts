/** What one nightly run hands each of its chores. */
export interface NightlyRun {
  /** `fetch`, counted against the subrequests the whole run gets. */
  readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Keeps a secret, or a signed address, out of every line the run logs from here on. */
  readonly keepOut: (value: string) => void;
}

/** One chore of the nightly run. It returns what it did, in words for the log. */
export interface Chore {
  readonly name: string;
  readonly run: (night: NightlyRun) => Promise<string>;
}

/** Why a chore stopped, in words for the log. */
export class ChoreFailure extends Error {}

/**
 * The failure of a chore that was told no: who answered, with which status, to what, and what
 * the answer said, on one line. The run cuts a long line short itself, once it has hidden
 * what must not be logged.
 */
export const refusal = async (who: string, answer: Response, to?: string) => {
  const said = (await answer.text()).replace(/\s+/g, " ").trim();
  return new ChoreFailure(
    `${who} answered ${answer.status}${to === undefined ? "" : ` to ${to}`}: ${said}`,
  );
};
