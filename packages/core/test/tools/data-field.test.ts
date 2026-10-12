import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { Tool } from "../../src/tool.ts";
import { getSchema } from "../../src/tools/get-schema.ts";
import { logWork } from "../../src/tools/log-work.ts";
import { saveCategory } from "../../src/tools/save-category.ts";
import { saveItem } from "../../src/tools/save-item.ts";
import { saveProject } from "../../src/tools/save-project.ts";
import { saveProperty } from "../../src/tools/save-property.ts";
import { saveQuote } from "../../src/tools/save-quote.ts";
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
  [saveItem, "item"],
  [logWork, "work"],
  [saveProject, "project"],
  [saveQuote, "quote"],
];

// What a client reads about a tool's `data` field.
const dataDescription = (tool: Tool) => {
  const input = tool.input["~standard"].jsonSchema.input({ target: "draft-2020-12" }) as {
    properties: { data: { anyOf: [{ description: string }] } };
  };
  return input.properties.data.anyOf[0].description;
};

// A client told to use a list that is not there looks for it and finds nothing. So a tool that
// takes `data` for a kind of record has a list for that kind in get_schema to point at.
it.effect("every `data` field points at well-known keys that get_schema lists for its kind", () =>
  Effect.gen(function* () {
    const { text } = yield* call(getSchema, {});
    const listed = Object.keys((JSON.parse(text) as { data_keys: object }).data_keys);

    for (const [tool, kind] of SAVES) {
      expect(listed, tool.name).toContain(kind);
      expect(dataDescription(tool), tool.name).toContain("well-known keys that get_schema lists");
    }
  }).pipe(Effect.provide(TestDatabase)),
);
