import { expect } from "@effect/vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import Stack from "../alchemy.run.ts";

// Runs the whole stack on Alchemy's local simulators: the Worker in workerd, with local D1,
// R2, and KV behind its bindings. Nothing here touches a Cloudflare account.
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
  // In 2.0.0-beta.81 `destroy` never returns when the local providers run behind the
  // harness's sidecar process, so they run in this process instead.
  sidecar: false,
});

const stack = beforeAll(deploy(Stack));
afterAll(destroy(Stack));

test(
  "the stack comes up on the local simulators",
  Effect.gen(function* () {
    const { url, databaseId } = yield* stack;
    expect(url).toMatch(/^http:\/\/localhost:/);
    // A dev: id is Alchemy's mark for a local simulator.
    expect(databaseId).toMatch(/^dev:/);
  }),
);

test(
  "the hello-world answers from local D1",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const response = yield* Test.getWhenReady(`${url}/?batches=2`);
    expect(response.status).toBe(200);
    // The migration seeds the starter Categories, so a count above zero means it was applied.
    expect(yield* response.json).toEqual({
      message: "Hello from Attic",
      categories: expect.toSatisfy((count: number) => count > 0),
      batches: 2,
      statementsPerBatch: 3,
    });
  }),
);
