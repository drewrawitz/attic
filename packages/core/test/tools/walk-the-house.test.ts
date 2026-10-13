import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { prompts, tools } from "../../src/index.ts";
import { gaps } from "../../src/tools/gaps.ts";
import { getRecord } from "../../src/tools/get-record.ts";
import { DATA_KEYS, getSchema } from "../../src/tools/get-schema.ts";
import { saveItem } from "../../src/tools/save-item.ts";
import { saveSpace } from "../../src/tools/save-space.ts";
import { undo } from "../../src/tools/undo.ts";
import { walkTheHouse } from "../../src/tools/walk-the-house.ts";
import { call, callAsClient } from "../call.ts";
import { TestDatabase } from "../TestDatabase.ts";

// A client is to follow the script, so it comes as it was written: not in the quotes JSON
// would put it in, and with its line breaks as line breaks.
it.effect("walk_the_house returns the script as written", () =>
  Effect.gen(function* () {
    expect(tools).toContain(walkTheHouse);
    expect(walkTheHouse.name).toBe("walk_the_house");

    const { text, isError } = yield* call(walkTheHouse, {});

    expect(isError).toBe(false);
    expect(text).toMatch(/^This is the script for going through a Property with the User/);
    expect(text).toContain("\n1. Settle which Property this is.");
  }).pipe(Effect.provide(TestDatabase)),
);

// It takes nothing, so a key it is sent is a mistake, and the client is told so (ADR 0014).
it.effect("walk_the_house turns away any key it is given", () =>
  Effect.gen(function* () {
    const result = yield* callAsClient(walkTheHouse, { property: "Maple Street house" });

    expect(result).toEqual({ text: "property: This tool takes no input.", isError: true });
  }).pipe(Effect.provide(TestDatabase)),
);

// The script, as a client is sent it.
const script = call(walkTheHouse, {}).pipe(Effect.map(({ text }) => text));

// What the script sets in backticks, in the order it comes. Each is the name of a tool, or
// `data`, or a key of `data` written as `data.model`.
const inBackticks = (text: string) => [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);

// The key that is written as `data.model`, which is model. Anything else is no key.
const dataKey = (word: string) => /^data\.(.+)$/.exec(word)?.[1];

// A script that names a tool that is not there sends the client to call nothing. So the names
// are read out of the text and held to the list of tools: one that is renamed fails here.
it.effect(
  "every tool the script names is a tool there is, and they come in the order of an interview",
  () =>
    Effect.gen(function* () {
      const inScript = [
        ...new Set(
          inBackticks(yield* script).filter(
            (word) => word !== "data" && dataKey(word) === undefined,
          ),
        ),
      ];

      const onList = tools.map(({ name }) => name);
      expect(inScript.filter((name) => !onList.includes(name))).toEqual([]);

      // The Property and what its records are expected to have first, then what is missing,
      // then a Space and its Items, and last the way back from a wrong save.
      const inOrder = [getRecord, getSchema, gaps, saveSpace, saveItem, undo].map(
        ({ name }) => name,
      );
      expect(inScript.filter((name) => inOrder.includes(name))).toEqual(inOrder);
    }).pipe(Effect.provide(TestDatabase)),
);

// The Spaces and the Items are what the script fills in, so a key it names is one of theirs.
it.effect("every key of `data` the script names is a well-known key of a Space or an Item", () =>
  Effect.gen(function* () {
    const keys = inBackticks(yield* script).flatMap((word) => dataKey(word) ?? []);

    const wellKnown = [...Object.keys(DATA_KEYS.space), ...Object.keys(DATA_KEYS.item)];
    expect(keys.filter((key) => !wellKnown.includes(key))).toEqual([]);
    expect(keys).toEqual(expect.arrayContaining(["sqft", "paint", "model", "serial"]));
  }).pipe(Effect.provide(TestDatabase)),
);

// Many clients do not show prompts, which is why there is a tool (ADR 0007). One that does
// show them gets the same script, under the same name.
it.effect("the prompt is the same script under the same name, with a description of one line", () =>
  Effect.gen(function* () {
    expect(prompts.map(({ name }) => name)).toEqual(["walk_the_house"]);
    const [prompt] = prompts;

    expect(prompt?.text).toBe(yield* script);
    expect(prompt?.description).toMatch(
      /^Go through a Property with the User, one Space at a time/,
    );
    expect(prompt?.description).not.toContain("\n");
  }).pipe(Effect.provide(TestDatabase)),
);

// What a client does unless it is told not to. A photo and a Receipt are Documents, and no tool
// takes one yet.
it.effect("the script says what not to do", () =>
  Effect.gen(function* () {
    const text = yield* script;

    for (const said of [
      "Guess a model, a serial number, a Price, or a date.",
      "Make a new Category where one in the tree fits.",
      "Ask for photos or Receipts.",
    ]) {
      expect(text, said).toContain(said);
    }
  }).pipe(Effect.provide(TestDatabase)),
);

it("walk_the_house says when to call it, and only reads", () => {
  expect(walkTheHouse.annotations).toEqual({ readOnlyHint: true });
  expect(walkTheHouse.description).toContain(
    "Call it when the User wants to set up a Property, or to go through one",
  );
});
