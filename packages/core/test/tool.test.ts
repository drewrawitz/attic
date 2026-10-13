import { expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { tools } from "../src/index.ts";
import { dataPatch } from "../src/save.ts";
import { callTool, defineTool, NoInput, optional, ToolError, type Tool } from "../src/tool.ts";
import { call, callAsClient, readingLog, UNEXPECTED } from "./call.ts";
import { TestDatabase } from "./TestDatabase.ts";

// Made-up tools. Each one stands for a kind of ending a real tool can come to.
const categoryName = defineTool({
  name: "category_name",
  description: "Returns the name of one Category.",
  input: Schema.Struct({ id: Schema.String }),
  annotations: { readOnlyHint: true },
  run: ({ id }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const [category] = yield* sql<{ name: string }>`SELECT name FROM categories WHERE id = ${id}`;
      if (category === undefined) {
        return yield* new ToolError({
          message: `There is no Category "${id}". Call get_schema to see the ones there are.`,
        });
      }
      return { id, name: category.name };
    }),
});

it.effect("what a tool returns goes to the client as JSON", () =>
  Effect.gen(function* () {
    const result = yield* call(categoryName, { id: "power-tools" });
    expect(result).toEqual({ text: '{"id":"power-tools","name":"Power tools"}', isError: false });
  }).pipe(Effect.provide(TestDatabase)),
);

// A tool that returns a string: words for the client to follow.
const returnsText = defineTool({
  name: "returns_text",
  description: "Returns what to ask the User.",
  input: NoInput,
  annotations: { readOnlyHint: true },
  run: () => Effect.succeed('Ask about each Space.\nSay "saved" after each one.'),
});

// As JSON it would be in quotes, with each line break written as \n.
it.effect("a string a tool returns goes to the client as written, and not as JSON", () =>
  Effect.gen(function* () {
    const result = yield* call(returnsText, {});
    expect(result).toEqual({
      text: 'Ask about each Space.\nSay "saved" after each one.',
      isError: false,
    });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a failure the caller can act on goes to the client as the tool wrote it", () =>
  Effect.gen(function* () {
    const result = yield* call(categoryName, { id: "gardening" });
    expect(result).toEqual({
      text: 'There is no Category "gardening". Call get_schema to see the ones there are.',
      isError: true,
    });
  }).pipe(Effect.provide(TestDatabase)),
);

// A tool whose query the database turns down, and two that throw: one inside its program and
// one before it has made a program at all.
const badQuery = defineTool({
  name: "bad_query",
  description: "Reads a table that does not exist.",
  input: NoInput,
  annotations: { readOnlyHint: true },
  run: () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql`SELECT secret FROM no_such_table`;
    }),
});

const throws = defineTool({
  name: "throws",
  description: "Throws.",
  input: NoInput,
  annotations: { readOnlyHint: true },
  run: () =>
    Effect.sync(() => {
      throw new Error("the fridge serial is XK-4471");
    }),
});

const throwsFirst = defineTool({
  name: "throws_first",
  description: "Throws before it returns a program.",
  input: NoInput,
  annotations: { readOnlyHint: true },
  run: () => {
    throw new Error("the lease runs until 2027-06");
  },
});

it.effect("a query the database turns down is logged, and the client is told nothing of it", () =>
  Effect.gen(function* () {
    const { result, logged } = yield* readingLog(call(badQuery, {}));

    expect(result).toEqual(UNEXPECTED);
    expect(logged).toEqual([expect.stringContaining("no_such_table")]);
    expect(logged[0]).toContain("bad_query");
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a tool that throws is logged, and the client is told nothing of it", () =>
  Effect.gen(function* () {
    const { result, logged } = yield* readingLog(call(throws, {}));

    expect(result).toEqual(UNEXPECTED);
    expect(logged).toEqual([expect.stringContaining("the fridge serial is XK-4471")]);
  }).pipe(Effect.provide(TestDatabase)),
);

// The MCP SDK sends a client the message of anything that is thrown at it, so nothing may
// get that far.
it.effect("a tool that throws before its program starts ends the same way", () =>
  Effect.gen(function* () {
    const { result, logged } = yield* readingLog(call(throwsFirst, {}));

    expect(result).toEqual(UNEXPECTED);
    expect(logged).toEqual([expect.stringContaining("the lease runs until 2027-06")]);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a database that cannot be opened ends the same way", () =>
  Effect.gen(function* () {
    const unreachable: Parameters<typeof callTool>[2] = Layer.effectContext(
      Effect.fail(new Error("no database is bound as DB")),
    );
    const { result, logged } = yield* readingLog(
      callTool(categoryName, { id: "tools" }, unreachable),
    );

    expect(result).toEqual(UNEXPECTED);
    expect(logged).toEqual([expect.stringContaining("no database is bound as DB")]);
  }),
);

// What the MCP layer does with a tool's input: it publishes the schema as JSON Schema and
// checks every call against it. A tool carries both, made from its schema when it is declared.
// This is a made-up tool that hands back the input it was given.
const handingBack = (input: Schema.ConstraintDecoder<unknown>) =>
  defineTool({
    name: "hands_back",
    description: "Returns the input it was handed.",
    input,
    annotations: { readOnlyHint: true },
    run: (handed) => Effect.succeed(handed),
  });

// The JSON Schema a client is sent, in the dialect the MCP SDK asks for.
const published = ({ input }: Tool) =>
  input["~standard"].jsonSchema.input({ target: "draft-2020-12" });

// `Schema.optional` publishes a field as nullable and then refuses null, so a client that
// sends what it was told it could is turned away.
it("an optional field is published as nullable, and a call may send null, a value, or nothing", async () => {
  const tool = handingBack(
    Schema.Struct({ words: Schema.String, property: optional(Schema.String) }),
  );
  const { validate } = tool.input["~standard"];

  expect(published(tool)).toMatchObject({
    properties: {
      words: { type: "string" },
      property: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
    required: ["words"],
  });

  // The tool is handed one form of "not given", whichever way the client said it.
  expect(await validate({ words: "fridge" })).toStrictEqual({ value: { words: "fridge" } });
  expect(await validate({ words: "fridge", property: null })).toStrictEqual({
    value: { words: "fridge" },
  });
  expect(await validate({ words: "fridge", property: "Maple Street house" })).toEqual({
    value: { words: "fridge", property: "Maple Street house" },
  });
  expect(await validate({ words: "fridge", property: 7 })).toHaveProperty("issues");
});

// A model is the only writer. If a key the tool does not declare were dropped, a fact put in
// the wrong place would be lost, and the call would look as if it had worked. This tool has
// each kind of input a real one has: fields of its own, a field that is itself a struct, and
// a record's `data`.
const savesSpace = handingBack(
  Schema.Struct({
    name: Schema.String,
    data: optional(dataPatch("Facts about the Space, such as its size.")),
    attach_to: optional(
      Schema.Struct({ type: Schema.Literals(["item", "work"]), id: Schema.String }),
    ),
  }),
);

it.effect("a key a tool does not declare is turned away by name, with the fields there are", () =>
  Effect.gen(function* () {
    const result = yield* callAsClient(savesSpace, { name: "Kitchen", sqft: 240, note: "x" });

    // Every such key is named, so one more call puts all of them right.
    const fields =
      "There is no field with this name. The fields are: name, data, attach_to. A fact with no field of its own goes inside data.";
    expect(result).toEqual({ text: `sqft: ${fields}, note: ${fields}`, isError: true });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a key that a struct inside a field does not declare is turned away the same way", () =>
  Effect.gen(function* () {
    const result = yield* callAsClient(savesSpace, {
      name: "Kitchen",
      attach_to: { type: "item", id: "seed-item-fridge", property: "Maple Street house" },
    });

    expect(result).toEqual({
      text: "attach_to.property: There is no field with this name. The fields are: type, id.",
      isError: true,
    });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("`data` takes any key, however deep, and the tool is handed all of it", () =>
  Effect.gen(function* () {
    const input = {
      name: "Kitchen",
      data: { sqft: 240, paint: { walls: { color: "Simply White", code: "OC-117" } }, old: null },
    };

    const result = yield* callAsClient(savesSpace, input);

    expect(result).toEqual({ text: JSON.stringify(input), isError: false });
  }).pipe(Effect.provide(TestDatabase)),
);

// A client that reads `additionalProperties: true` may send keys of its own, and one that
// reads false may leave them out. So what is published has to say what the check does.
it("a tool publishes that it takes no other key, in a struct inside a field too, but not in `data`", () => {
  expect(published(savesSpace)).toEqual({
    type: "object",
    properties: {
      name: { type: "string" },
      data: { anyOf: [{ type: "object", description: expect.any(String) }, { type: "null" }] },
      attach_to: {
        anyOf: [
          {
            type: "object",
            properties: {
              type: { type: "string", enum: ["item", "work"] },
              id: { type: "string" },
            },
            required: ["type", "id"],
            additionalProperties: false,
          },
          { type: "null" },
        ],
      },
    },
    required: ["name"],
    additionalProperties: false,
  });
});

it("a tool that takes nothing says so of any key it is sent", async () => {
  const tool = handingBack(NoInput);

  expect(published(tool)).toEqual({ type: "object", additionalProperties: false });
  expect(await tool.input["~standard"].validate({ property: "Maple Street house" })).toEqual({
    issues: [{ path: ["property"], message: "This tool takes no input." }],
  });
  expect(await tool.input["~standard"].validate({})).toEqual({ value: {} });
});

// Effect keeps the first check it builds on a schema, and hands that one back whatever options
// come later. A tool's check is built when the tool is declared, so nothing that converts the
// same schema afterwards can swap in one that drops keys.
it("every tool Attic has turns away a key it does not declare, and publishes that it does", async () => {
  for (const tool of tools) {
    expect(published(tool), tool.name).toMatchObject({ additionalProperties: false });

    const { issues } = await tool.input["~standard"].validate({ no_such_field: 1 });
    expect(
      issues?.map(({ path }) => path),
      tool.name,
    ).toContainEqual(["no_such_field"]);
  }
});
