import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import type { Tool } from "../../src/tool.ts";
import { getSchema } from "../../src/tools/get-schema.ts";
import { saveCategory } from "../../src/tools/save-category.ts";
import { saveProperty } from "../../src/tools/save-property.ts";
import { saveSpace } from "../../src/tools/save-space.ts";
import { saveVendor } from "../../src/tools/save-vendor.ts";
import { call } from "../call.ts";
import { TestDatabase } from "../TestDatabase.ts";

// Each tool that takes `data`, with the kind of record it saves.
const SAVES: ReadonlyArray<readonly [tool: Tool, kind: string]> = [
  [saveProperty, "property"],
  [saveSpace, "space"],
  [saveVendor, "vendor"],
  [saveCategory, "category"],
];

// What a client reads about a tool's `data` field.
const dataDescription = (tool: Tool) => {
  const { jsonSchema } = Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(tool.input))[
    "~standard"
  ];
  const input = jsonSchema.input({ target: "draft-2020-12" }) as {
    properties: { data: { anyOf: [{ description: string }] } };
  };
  return input.properties.data.anyOf[0].description;
};

// A client told to use a list that is not there looks for it and finds nothing.
it.effect("a `data` field points at get_schema's well-known keys only where it lists some", () =>
  Effect.gen(function* () {
    const { text } = yield* call(getSchema, {});
    const listed = Object.keys((JSON.parse(text) as { data_keys: object }).data_keys);
    expect(listed).toEqual(["item", "space", "property", "work"]);

    for (const [tool, kind] of SAVES) {
      const pointsAtTheList = dataDescription(tool).includes("well-known keys that get_schema");
      expect(pointsAtTheList, tool.name).toBe(listed.includes(kind));
    }
  }).pipe(Effect.provide(TestDatabase)),
);
