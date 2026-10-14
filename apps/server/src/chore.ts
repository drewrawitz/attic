// What one nightly run hands each of its chores.
export interface NightlyRun {
  // Asks someone outside: `fetch`, counted against the subrequests the whole run gets. `what`
  // is the call in words that start a sentence, as in "The call to Cloudflare for an export".
  // A call that gets no answer at all fails the chore, in those words. An answer that says no
  // is the chore's to read, since a 404 is not always a failure.
  readonly ask: (what: string, input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  // How many more times the run answers `ask`, between this chore and the ones after it. A
  // chore that has to keep a call back for its last step counts from this.
  readonly asksLeft: () => number;
  // Keeps a secret, or a signed address, out of every line the run logs from here on.
  readonly keepOut: (value: string) => void;
}

// One chore of the nightly run. It returns what it did, in words for the log.
export interface Chore {
  readonly name: string;
  readonly run: (night: NightlyRun) => Promise<string>;
}

// Why a chore stopped, in words for the log.
export class ChoreFailure extends Error {}

// What a line of the log says of something a chore threw: a failure's own words, or whatever
// else it was, as it reads.
export const reasonOf = (thrown: unknown) =>
  thrown instanceof ChoreFailure ? thrown.message : String(thrown);

// How long a chore has taken since it started, in seconds, as a line of the log says it.
export const secondsSince = (started: number) => ((Date.now() - started) / 1000).toFixed(1);

// The failure of a chore whose call was answered with a no: the call, in the words it was
// asked with, the status, and what the answer said. The run puts it on one line and cuts it
// short itself, once it has hidden what must not be logged.
export const refusal = async (what: string, answer: Response) =>
  new ChoreFailure(`${what} was answered with ${answer.status}: ${await answer.text()}`);
