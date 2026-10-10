import { Data, Effect, type Layer, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";

/**
 * A failure the caller can act on, such as a record that does not exist. The message goes to
 * the client as written, so it says what to do next.
 */
export class ToolError extends Data.TaggedError("ToolError")<{ readonly message: string }> {}

/**
 * The input of a tool that takes nothing. An empty `Schema.Struct({})` will not do: it means
 * any value that is not null, and describes itself with a `not`, which some clients turn away.
 */
export const NoInput = Schema.Record(Schema.String, Schema.Never);

// What a tool does once its input has been checked: a program over the database.
type Program = Effect.Effect<unknown, ToolError | SqlError, SqlClient.SqlClient>;

export interface ToolAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
}

/** A tool as the server registers it. Declare one with `defineTool`. */
export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly input: Schema.ConstraintDecoder<unknown>;
  readonly annotations: ToolAnnotations;
  readonly run: (input: unknown) => Program;
}

/**
 * The one way to declare a tool: its name, its description, an Effect Schema for its input,
 * its annotations, and the program that does the work.
 */
export const defineTool = <Input extends Schema.ConstraintDecoder<unknown>>(
  tool: Omit<Tool, "input" | "run"> & {
    readonly input: Input;
    readonly run: (input: Input["Type"]) => Program;
  },
): Tool => ({
  ...tool,
  // The MCP layer checks a call's input against the schema before the tool runs, so what
  // arrives here is what the schema describes.
  run: (input) => tool.run(input as Input["Type"]),
});

/** What a call sends back to the client. */
export interface ToolResult {
  readonly text: string;
  readonly isError: boolean;
}

// All the client hears of a failure nobody planned for. The rest goes to the log.
const UNEXPECTED = "Attic hit an error it did not expect. The details are in the Worker's log.";

/**
 * Runs a tool on a database and turns how it ended into what the client is sent. A
 * `ToolError` goes out as the tool wrote it. Anything else is logged, and the client is told
 * only that there was a failure: a query the database turned down, a tool that threw, a
 * database that could not be opened. Nothing gets past this as a thrown error, because the
 * MCP SDK would send the client its message.
 */
export const callTool = (
  tool: Tool,
  input: unknown,
  database: Layer.Layer<SqlClient.SqlClient, unknown>,
): Effect.Effect<ToolResult> =>
  Effect.suspend(() => tool.run(input)).pipe(
    Effect.map((result) => ({ text: JSON.stringify(result), isError: false })),
    Effect.catchTag("ToolError", ({ message }) => Effect.succeed({ text: message, isError: true })),
    Effect.provide(database),
    Effect.catchCause((cause) =>
      Effect.logError(`The ${tool.name} tool failed.`, cause).pipe(
        Effect.as({ text: UNEXPECTED, isError: true }),
      ),
    ),
  );
