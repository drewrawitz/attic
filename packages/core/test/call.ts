import { Cause, DateTime, Effect, Layer, Logger, Schema } from "effect";
import { TestClock } from "effect/testing";
import { callTool, type Tool, type ToolResult, type ToolServices } from "../src/tool.ts";
import { AtomicBatch, Ids } from "../src/write.ts";

/**
 * Calls a tool on the database the test is already running on, so a test can fill the
 * database first and then see what the client is sent.
 */
export const call = (tool: Tool, input: unknown) =>
  Effect.flatMap(Effect.context<ToolServices>(), (services) =>
    callTool(tool, input, Layer.succeedContext(services)),
  );

/**
 * Sets what day it is: the clock reads noon UTC on this date. A test's clock starts at the
 * first day of 1970, so a test of anything that goes by today's date sets the day first.
 */
export const todayIs = (date: string) => TestClock.setTime(Date.parse(`${date}T12:00:00Z`));

/** What a tool sends back to a test: what it returned, or the text of a refusal. */
export type Answer<Returned = Record<string, unknown>> = Partial<Returned> & {
  readonly refused?: string;
};

/** Reads what a call sent the client. */
export const answer = <Returned = Record<string, unknown>>({ text, isError }: ToolResult) =>
  (isError ? { refused: text } : JSON.parse(text)) as Answer<Returned>;

/** All a client hears of a failure nobody planned for. */
export const UNEXPECTED = {
  text: "Attic hit an error it did not expect. The details are in the Worker's log.",
  isError: true,
};

/**
 * Runs a call with the log kept in memory. Returns what the client was sent and what was
 * logged, each line with the cause it carried.
 */
export const readingLog = <A, R>(called: Effect.Effect<A, never, R>) =>
  Effect.gen(function* () {
    const logged: string[] = [];
    const keep = Logger.make(({ message, cause }) => {
      logged.push(`${String(message)} ${Cause.pretty(cause)}`);
    });
    const result = yield* called.pipe(Effect.provide(Logger.layer([keep])));
    return { result, logged };
  });

/** The timezone the tests read today's date in, unless a test brings another. */
export const InUtc = Layer.orDie(DateTime.layerCurrentZoneNamed("UTC"));

/**
 * What a tool is handed beside the database, for a test that brings a database of its own to
 * a tool that only reads. Such a tool asks for none of it.
 */
export const NoWrites = Layer.mergeAll(
  Layer.succeed(AtomicBatch, AtomicBatch.of({ run: () => Effect.die("this tool only reads") })),
  Layer.succeed(Ids, Ids.of({ next: Effect.die("this tool only reads") })),
  InUtc,
);

/**
 * Calls a tool the way the MCP layer does: the input is checked against the tool's schema
 * first, and the tool is handed what the check returns. Input the check turns away never
 * reaches the tool, and what comes back is what the check said.
 */
export const callAsClient = (tool: Tool, input: unknown) =>
  Effect.gen(function* () {
    const { validate } = Schema.toStandardSchemaV1(tool.input)["~standard"];
    const checked = yield* Effect.promise(async () => validate(input));
    if (checked.issues !== undefined) {
      const text = checked.issues.map(({ message }) => message).join("\n");
      return { text, isError: true } satisfies ToolResult;
    }
    return yield* call(tool, checked.value);
  });
