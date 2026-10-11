import * as Effect from "effect/Effect";
import { householdStack, type Operation } from "../../household/stack.ts";
import { beforeAll, deploy, stack } from "./harness.ts";
import { ALLOWED_ACCOUNT, tokenFor } from "./sign-in.ts";

// Runs one of the two commands the way `vp run household:load` and `vp run household:remove`
// run them: by deploying the stack in household/, which finds the Worker's database and runs
// one batch on it. `force` makes it run even when its last run did the same thing.
export const command = (operation: Operation) => deploy(householdStack(operation), { force: true });

// A client that has signed in, with the made-up household loaded. A file that imports this
// loads the set before its first test, whatever an earlier file or run left in the database.
export const signedIn = beforeAll(
  Effect.gen(function* () {
    const { url } = yield* stack;
    yield* command("load");
    return { url: url!, token: yield* Effect.promise(() => tokenFor(url!, ALLOWED_ACCOUNT)) };
  }),
);
