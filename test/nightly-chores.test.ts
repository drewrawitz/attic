import { afterAll, afterEach, expect, it, vi } from "@effect/vitest";
import { ChoreFailure, type NightlyRun } from "../apps/server/src/chore.ts";
import { runChores } from "../apps/server/src/nightly.ts";
import { serve } from "./support/stand-in.ts";

// What holds for the nightly run whatever its chores are: one that fails does not stop the
// next, the run stops short of the subrequests it gets, and what a chore keeps out is logged
// nowhere. The run has one chore of its own so far, so none of that shows through the Worker.
// These call the code that runs the chores, with chores of their own, and run no stack.

// Counts the requests it is sent, and answers each with nothing.
let received = 0;
const { origin, close } = await serve((_request, response) => {
  received += 1;
  response.writeHead(204).end();
});
afterAll(close);

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

// A cron run on Workers Free gets 50 subrequests (ADR 0012), and the chores of one run share
// them. The run counts them itself and stops at 45, whichever chore is asking.
it("a run makes 45 subrequests and no more, and says so to the chore that asks for another", async () => {
  const lines = logged();
  received = 0;
  const calls = (count: number) => async (night: NightlyRun) => {
    for (let made = 0; made < count; made++) await night.fetch(origin);
    return `made ${count} calls.`;
  };

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
