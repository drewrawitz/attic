import {
  Data,
  Effect,
  Layer,
  Option,
  Predicate,
  Schema,
  SchemaAST,
  SchemaIssue,
  SchemaTransformation,
  type DateTime,
  type StandardSchema,
} from "effect";
import type { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { Write, type AtomicBatch, type Ids } from "./write.ts";

/**
 * A failure the caller can act on, such as a record that does not exist. The message goes to
 * the client as written, so it says what to do next.
 */
export class ToolError extends Data.TaggedError("ToolError")<{ readonly message: string }> {}

/**
 * The input of a tool that takes nothing. An empty `Schema.Struct({})` will not do: it means
 * any value that is not null, and describes itself with a `not`, which some clients turn away.
 */
export const NoInput = Schema.Record(
  Schema.String,
  Schema.Never.annotate({ message: "This tool takes no input." }),
);

/**
 * An optional field of a tool's input. `Schema.optional` will not do: it publishes the field
 * as nullable and then refuses null, so a client that sends what it was told it could is
 * turned away. This one takes null, a value, or nothing. The tool is handed one form of "not
 * given", whichever way the client said it: the key is left out.
 */
export const optional = <Field extends Schema.Constraint>(field: Field) =>
  Schema.optionalKey(Schema.NullOr(field)).pipe(
    Schema.decodeTo(
      Schema.optionalKey(Schema.toType(field)),
      SchemaTransformation.transformOptional<Field["Type"], Field["Type"] | null>({
        decode: Option.filter(Predicate.isNotNull),
        encode: (given) => given,
      }),
    ),
  );

/**
 * What a tool runs on, which whoever calls one brings: a database, that database's atomic
 * batch, a maker of ids for the records a tool creates, and the configured timezone, which is
 * where a tool reads today's date.
 */
export type ToolServices = SqlClient.SqlClient | AtomicBatch | Ids | DateTime.CurrentTimeZone;

// What a tool does once its input has been checked: a program over the database. It has all
// of the above but the atomic batch. In its place it has the one write its call makes.
type Program = Effect.Effect<
  unknown,
  ToolError | SqlError,
  Exclude<ToolServices, AtomicBatch> | Write
>;

export interface ToolAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
}

/**
 * A tool's input as the MCP layer registers it: a Standard Schema that checks a call's input,
 * and describes itself as JSON Schema for the client.
 */
export interface ToolInput {
  readonly "~standard": StandardSchema.StandardSchemaV1.Props &
    StandardSchema.StandardJSONSchemaV1.Props;
}

// A key the schema does not declare is an error. Effect drops one unless it is told this, and
// a model is the only writer: a fact it put in a field that is not there would be lost, and the
// call would look as if it had worked. The check and the JSON Schema are told the same thing,
// so what a client reads is what the check does (ADR 0014). A record's `data` is a
// `Schema.Record`, which declares every key, so it still takes any.
const NO_OTHER_KEYS = { onExcessProperty: "error" } as const;

// The JSON Schema dialect the MCP SDK asks every tool to describe its input in.
const DIALECT = "draft-2020-12";

// What a client is told of a key that is not declared: the fields there are. The MCP SDK puts
// the key in front. The struct Effect hands over is the one the key was sent in, which may be
// one inside a field.
const explainIssue: SchemaIssue.LeafHook = (issue) => {
  if (issue._tag !== "UnexpectedKey" || !SchemaAST.isObjects(issue.ast)) {
    return SchemaIssue.defaultLeafHook(issue);
  }
  const fields = issue.ast.propertySignatures.map(({ name }) => String(name));
  const goesInData = fields.includes("data")
    ? " A fact with no field of its own goes inside data."
    : "";
  return `There is no field with this name. The fields are: ${fields.join(", ")}.${goesInData}`;
};

// Converts a tool's schema, once, when the tool is declared. Effect keeps the first check it
// builds on a schema and hands that one back whatever options come later, so no other code
// converts a tool's schema. It also works the JSON Schema out afresh each time it is asked,
// and the MCP SDK asks whenever a tool is registered, which is on every request. So that is
// worked out here too, and handed back from then on.
const toolInput = (schema: Schema.ConstraintDecoder<unknown>): ToolInput => {
  const { "~standard": standard } = Schema.toStandardJSONSchemaV1(
    Schema.toStandardSchemaV1(schema, { parseOptions: NO_OTHER_KEYS, leafHook: explainIssue }),
  );
  const document = Schema.toJsonSchemaDocument(schema, NO_OTHER_KEYS);
  const described =
    Object.keys(document.definitions).length === 0
      ? document.schema
      : { ...document.schema, $defs: document.definitions };
  return {
    "~standard": {
      ...standard,
      jsonSchema: {
        ...standard.jsonSchema,
        input: ({ target }) => {
          if (target === DIALECT) return described;
          throw new Error(`A tool's input is described in ${DIALECT} only, not in ${target}.`);
        },
      },
    },
  };
};

/** A tool as the server registers it. Declare one with `defineTool`. */
export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly input: ToolInput;
  readonly annotations: ToolAnnotations;
  readonly run: (input: unknown) => Program;
}

/**
 * The one way to declare a tool: its name, its description, an Effect Schema for its input,
 * its annotations, and the program that does the work. The schema is turned here into what
 * the MCP layer registers, so every tool checks a call the same way: a key the schema does not
 * declare is turned away by name, and is never dropped.
 */
export const defineTool = <Input extends Schema.ConstraintDecoder<unknown>>(
  tool: Omit<Tool, "input" | "run"> & {
    readonly input: Input;
    readonly run: (input: Input["Type"]) => Program;
  },
): Tool => ({
  ...tool,
  input: toolInput(tool.input),
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
 * Runs a tool and turns how it ended into what the client is sent. It is given what the tool
 * runs on. To that it adds the one write of this call, which records a Change under the
 * tool's name. A `ToolError` goes out as the tool wrote it.
 * Anything else is logged, and the client is told only that there was a failure: a query or a
 * batch the database turned down, a tool that threw, a database that could not be opened.
 * Nothing gets past this as a thrown error, because the MCP SDK would send the client its
 * message.
 */
export const callTool = (
  tool: Tool,
  input: unknown,
  services: Layer.Layer<ToolServices, unknown>,
): Effect.Effect<ToolResult> =>
  Effect.suspend(() => tool.run(input)).pipe(
    Effect.map((result) => ({ text: JSON.stringify(result), isError: false })),
    Effect.catchTag("ToolError", ({ message }) => Effect.succeed({ text: message, isError: true })),
    Effect.provide(Write.layer(tool.name).pipe(Layer.provideMerge(services))),
    Effect.catchCause((cause) =>
      Effect.logError(`The ${tool.name} tool failed.`, cause).pipe(
        Effect.as({ text: UNEXPECTED, isError: true }),
      ),
    ),
  );
