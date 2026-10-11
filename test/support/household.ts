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

// Calls one tool as a signed-in client, and reads what it sent back.
export const answerFrom = async <Returned>(
  { url, token }: { readonly url: string; readonly token: string },
  tool: string,
  input: unknown,
) => {
  const { result } = await callOnWorker(url, token, tool, input);
  const text = result!.content[0].text;
  return (result!.isError === true ? { refused: text } : JSON.parse(text)) as Answer<Returned>;
};

// What a tool sent back, for a test that has no closer type for it.
export type Fields = Record<string, unknown>;

// A record as a save's reply lists it.
export interface Listed {
  readonly type: string;
  readonly id: string;
  readonly name: string;
}

// A ULID: 26 characters of Crockford's base 32.
export const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// Calls a tool as a signed-in client, and reads what it sent back.
export type Call = (tool: string, input: unknown) => Effect.Effect<Answer<Fields>>;

// A test body that calls tools as a signed-in client, with the made-up household loaded. No
// tool deletes a record yet, and the database is kept between runs. So a test of a tool that
// writes brings a `cleanUp` that takes its own rows out, and this runs it before the body and
// after it, however the body ends.
export const asClientWith =
  <CleanUpError, CleanUpNeeds>(cleanUp: Effect.Effect<unknown, CleanUpError, CleanUpNeeds>) =>
  <E, R>(body: (call: Call) => Effect.Effect<void, E, R>) =>
    Effect.gen(function* () {
      const client = yield* householdClient;
      yield* cleanUp;
      yield* body((tool, input) =>
        Effect.promise(() => answerFrom<Fields>(client, tool, input)),
      ).pipe(Effect.ensuring(Effect.orDie(cleanUp)));
    });

// A test body that calls one tool, as a signed-in client, with the made-up household loaded.
export const calling =
  <Returned>(tool: string) =>
  (body: (call: (input: unknown) => Promise<Answer<Returned>>) => Promise<void>) =>
    Effect.flatMap(householdClient, (client) =>
      Effect.promise(() => body((input) => answerFrom<Returned>(client, tool, input))),
    );
