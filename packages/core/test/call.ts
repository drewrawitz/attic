import { Cause, Effect, Layer, Logger, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { callTool, type Tool, type ToolResult } from "../src/tool.ts";
import { AtomicBatch, Ids } from "../src/write.ts";

/**
 * Calls a tool on the database the test is already running on, so a test can fill the
 * database first and then see what the client is sent.
 */
export const call = (tool: Tool, input: unknown) =>
  Effect.flatMap(Effect.context<SqlClient.SqlClient | AtomicBatch | Ids>(), (services) =>
    callTool(tool, input, Layer.succeedContext(services)),
  );

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

/**
 * What a write needs beside the database, for a test that brings a database of its own to a
 * tool that only reads. Such a tool asks for neither.
 */
export const NoWrites = Layer.merge(
  Layer.succeed(AtomicBatch, AtomicBatch.of({ run: () => Effect.die("this tool only reads") })),
  Layer.succeed(Ids, Ids.of({ next: Effect.die("this tool only reads") })),
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
