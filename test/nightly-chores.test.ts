import { afterAll, afterEach, expect, it, vi } from "@effect/vitest";
import type { WorkerEnv } from "../alchemy.run.ts";
import { ChoreFailure, type NightlyRun } from "../apps/server/src/chore.ts";
import { fileBackup } from "../apps/server/src/file-backup.ts";
import { runChores } from "../apps/server/src/nightly.ts";
import { serve } from "./support/stand-in.ts";

// What holds for the nightly run whatever its chores are: one that fails does not stop the
// next, the run stops short of the subrequests it gets, and what a chore keeps out is logged
// nowhere. The run's own chores do not show that through the Worker. So these call the code
// that runs the chores, with chores of their own, and run no stack. The last of them are about
// one real chore, the copy of the files, where what it does cannot be seen through the Worker
// either.

// Counts the requests it is sent, and answers each with nothing.
let received = 0;
const { origin, close } = await serve((_request, response) => {
  received += 1;
  response.writeHead(204).end();
});
afterAll(close);

// A chore that makes this many calls to the stand-in above.
const calls = (count: number) => async (night: NightlyRun) => {
  for (let made = 0; made < count; made++) await night.ask("A call", origin);
  return `made ${count} calls.`;
};

// What a run logs, with nothing printed.
const logged = () => {
  const lines: string[] = [];
  const keep = (line: string) => void lines.push(line);
  vi.spyOn(console, "log").mockImplementation(keep);
  vi.spyOn(console, "error").mockImplementation(keep);
  return lines;
};
afterEach(() => vi.restoreAllMocks());

it("a chore that fails does not stop the next, and the run does not throw", async () => {
  const lines = logged();

  await runChores([
    {
      name: "first",
      run: async () => {
        throw new ChoreFailure("The door was locked.");
      },
    },
    {
      name: "second",
      run: async () => {
        throw new TypeError("no chore meant to throw this");
      },
    },
    { name: "third", run: async () => "done." },
  ]);

  expect(lines).toEqual([
    "first: failed. The door was locked.",
    "second: failed. TypeError: no chore meant to throw this",
    "third: done.",
  ]);
});

it("a chore gets one line in the log, whatever line breaks its words have", async () => {
  const lines = logged();

  await runChores([
    { name: "first", run: async () => "did this,\n  and then that." },
    {
      name: "second",
      run: async () => {
        throw new ChoreFailure("The answer was:\r\n<Error>\n\t<Code>No</Code>\n</Error>\n");
      },
    },
  ]);

  expect(lines).toEqual([
    "first: did this, and then that.",
    "second: failed. The answer was: <Error> <Code>No</Code> </Error>",
  ]);
});

// A call that gets no answer at all is the chore's failure too, and the line says which call.
it("a call that reaches nobody fails the chore, in words that say what was asked", async () => {
  const lines = logged();

  await runChores([
    {
      name: "first",
      // Nothing listens on port 9 of this machine.
      run: async (night) => {
        await night.ask("The call to nobody", "http://127.0.0.1:9/");
        return "reached somebody.";
      },
    },
  ]);

  expect(lines).toEqual([
    expect.stringMatching(/^first: failed\. The call to nobody got no answer: \S/),
  ]);
});

// A cron run on Workers Free gets 50 subrequests (ADR 0012), and the chores of one run share
// them. The run counts them itself and stops at 45, whichever chore is asking.
it("a run makes 45 subrequests and no more, and says so to the chore that asks for another", async () => {
  const lines = logged();
  received = 0;

  await runChores([
    { name: "first", run: calls(30) },
    { name: "second", run: calls(30) },
    { name: "third", run: calls(1) },
  ]);

  expect(received).toBe(45);
  const spent =
    "failed. The run has made its 45 subrequests. A cron run on Workers Free gets 50, so the rest waits for the next night.";
  expect(lines).toEqual(["first: made 30 calls.", `second: ${spent}`, `third: ${spent}`]);
});

// A chore that has to keep a call back, as the copy of the files keeps one for its cursor, asks
// the run how many it has left.
it("a chore is told how many subrequests the run has left", async () => {
  const lines = logged();
  const asksLeft = async (night: NightlyRun) => `has ${night.asksLeft()} left.`;

  await runChores([
    { name: "first", run: asksLeft },
    { name: "second", run: calls(30) },
    { name: "third", run: asksLeft },
  ]);

  expect(lines).toEqual(["first: has 45 left.", "second: made 30 calls.", "third: has 15 left."]);
});

// A chore hands the run whatever must not be logged, and the run hides it in every line from
// then on. A long line is cut short only after that, so that no cut can leave the head of a
// secret behind.
it("what a chore keeps out is hidden in every line, before a long line is cut short", async () => {
  const lines = logged();
  const secret = "s3cr3t-".repeat(4);
  // The secret starts 13 characters before the 600th of the line, which is where it is cut.
  const refused = `${"x".repeat(570)} ${secret} was refused.`;

  await runChores([
    {
      name: "first",
      run: async (night) => {
        night.keepOut(secret);
        return `signed with ${secret}.`;
      },
    },
    {
      name: "second",
      run: async () => {
        throw new ChoreFailure(refused);
      },
    },
  ]);

  expect(lines).toEqual([
    "first: signed with [hidden].",
    `second: failed. ${"x".repeat(570)} [hidden] was `,
  ]);
});

// The rest are about a real chore, the copy of the files.

// The backup's bindings, for a bucket at an address on this machine.
const bucketAt = (endpoint: string) => ({
  BACKUP_ENDPOINT: endpoint,
  BACKUP_REGION: "test-region-1",
  BACKUP_BUCKET: "attic-backup",
  BACKUP_ACCESS_KEY_ID: "test-backup-key-id",
  BACKUP_SECRET_ACCESS_KEY: "test-backup-secret-key",
});

// A read from R2 leaves no trace outside the Worker, and the export never leaves the copy
// fewer than 23 subrequests. So what the copy does before it touches `FILES` is seen here,
// with a `FILES` that only keeps what was asked of it.
const untouchedFiles = () => {
  const touched: string[] = [];
  const FILES = new Proxy({} as WorkerEnv["FILES"], {
    get: (_bucket, method) => {
      touched.push(String(method));
      throw new Error(`FILES.${String(method)} was read.`);
    },
  });
  return { FILES, touched };
};

// With the backup off, the Worker has none of the backup's bindings.
it("with no backup bucket configured, the copy of the files reads nothing from FILES", async () => {
  const lines = logged();
  const { FILES, touched } = untouchedFiles();

  await runChores([fileBackup({ FILES } as WorkerEnv)]);

  expect(lines).toEqual(["file backup: off, because no backup bucket is configured."]);
  expect(touched).toEqual([]);
});

// The copy reads its cursor and writes it back, so a file is the third subrequest it makes. A
// chore that is put before it may one day leave it fewer.
it("with fewer than three subrequests left, the copy of the files asks nobody and says so", async () => {
  const lines = logged();
  received = 0;
  const { FILES, touched } = untouchedFiles();

  await runChores([
    { name: "first", run: calls(43) },
    fileBackup({ ...bucketAt(origin), FILES } as WorkerEnv),
  ]);

  expect(lines).toEqual([
    "first: made 43 calls.",
    "file backup: failed. The run has 2 of its subrequests left, and the first file takes 3: the cursor is read, the file is sent, and the cursor is written. The files wait for the next night.",
  ]);
  expect(received).toBe(43);
  expect(touched).toEqual([]);
});

// Stands in for a backup bucket that holds nothing, so that the copy finds no cursor there.
const emptyBucket = await serve((_request, response) => {
  response.writeHead(404).end();
});
afterAll(emptyBucket.close);

// The local R2 cannot be made to fail. This `FILES` lists one file and fails the read of it,
// and then fails the list itself. The line says what was read, as it does for a bucket that
// says no.
it("a read from R2 that fails is a logged failure that names what was read", async () => {
  const lines = logged();
  const lost = async () => {
    throw new Error("Network connection lost.");
  };
  const key = "01K7C3Q9ZV0000000000000001/kitchen-tap.jpg";
  const backedUp = bucketAt(emptyBucket.origin);

  await runChores([
    fileBackup({
      ...backedUp,
      FILES: { list: async () => ({ objects: [{ key }], truncated: false }), get: lost },
    } as unknown as WorkerEnv),
    fileBackup({ ...backedUp, FILES: { list: lost } } as unknown as WorkerEnv),
  ]);

  expect(lines).toEqual([
    `file backup: failed. Stopped after 0 files. The read of ${key} from R2 failed: Error: Network connection lost.`,
    "file backup: failed. The list of the files in R2 failed: Error: Network connection lost.",
  ]);
});
