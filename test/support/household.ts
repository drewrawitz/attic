import * as Effect from "effect/Effect";
import { householdStack, type Operation } from "../../household/stack.ts";
import { beforeAll, deploy, stack } from "./harness.ts";
import { callOnWorker } from "./mcp-client.ts";
import { ALLOWED_ACCOUNT, tokenFor } from "./sign-in.ts";

// Runs one of the two commands the way `vp run household:load` and `vp run household:remove`
// run them: by deploying the stack in household/, which finds the Worker's database and runs
// one batch on it. `force` makes it run even when its last run did the same thing.
export const householdCommand = (operation: Operation) =>
  deploy(householdStack(operation), { force: true });

// A client that has signed in, with the made-up household loaded. A file that imports this
// loads the set before its first test, whatever an earlier file or run left in the database.
export const householdClient = beforeAll(
  Effect.gen(function* () {
    const { url } = yield* stack;
    yield* householdCommand("load");
    return { url: url!, token: yield* Effect.promise(() => tokenFor(url!, ALLOWED_ACCOUNT)) };
  }),
);

// What a tool sends back to a test: what it returned, or the text of a refusal.
export type Answer<Returned> = Partial<Returned> & { readonly refused?: string };

// A test body that calls one tool, as a signed-in client, with the made-up household loaded.
export const calling =
  <Returned>(tool: string) =>
  (body: (call: (input: unknown) => Promise<Answer<Returned>>) => Promise<void>) =>
    Effect.flatMap(householdClient, ({ url, token }) =>
      Effect.promise(() =>
        body(async (input) => {
          const { result } = await callOnWorker(url, token, tool, input);
          const text = result!.content[0].text;
          return (
            result!.isError === true ? { refused: text } : JSON.parse(text)
          ) as Answer<Returned>;
        }),
      ),
    );
