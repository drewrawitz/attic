import { expect } from "@effect/vitest";
import { onWorker, test } from "./support/harness.ts";
import { callOnWorker, mcp } from "./support/mcp-client.ts";
import { ALLOWED_ACCOUNT, tokenFor } from "./support/sign-in.ts";

// What the script says is tested on Node SQLite, in packages/core. These go through the real
// Worker, because the MCP layer is what registers a prompt, and this is the first one it has.
// The script reads no record, so nothing is loaded for it.

test(
  "a signed-in client is told that walk_the_house takes nothing and only reads",
  onWorker(async (url) => {
    const token = await tokenFor(url, ALLOWED_ACCOUNT);
    const { message } = await mcp(url, { method: "tools/list" }, token);
    const { result } = message as { result: { tools: unknown[] } };

    expect(result.tools).toContainEqual(
      expect.objectContaining({
        name: "walk_the_house",
        description: expect.stringContaining(
          "Call it when the User wants to set up a Property, or to go through one",
        ),
        inputSchema: { type: "object", additionalProperties: false },
        annotations: { readOnlyHint: true },
      }),
    );
  }),
);

// It takes nothing, so a client is told of no arguments to fill in.
test(
  "a client that shows prompts finds walk_the_house among them, with a description of one line",
  onWorker(async (url) => {
    const token = await tokenFor(url, ALLOWED_ACCOUNT);
    const { message } = await mcp(url, { method: "prompts/list" }, token);
    const { result } = message as { result: { prompts: unknown[] } };

    expect(result.prompts).toStrictEqual([
      {
        name: "walk_the_house",
        description: expect.stringMatching(/^Go through a Property with the User.*\.$/),
      },
    ]);
  }),
);

// Many clients do not show prompts, so the tool has to say all that the prompt does (ADR 0007).
test(
  "the prompt and the tool give the same script, as it was written",
  onWorker(async (url) => {
    const token = await tokenFor(url, ALLOWED_ACCOUNT);
    const called = await callOnWorker(url, token, "walk_the_house");
    expect(called.result?.isError).not.toBe(true);
    const [{ text }] = called.result!.content;

    // Not in the quotes JSON would put it in, and with its line breaks as line breaks.
    expect(text).toMatch(/^This is the script for going through a Property with the User/);
    expect(text).toContain("\n1. Settle which Property this is.");

    const asked = { method: "prompts/get", params: { name: "walk_the_house" } };
    const { message } = await mcp(url, asked, token);
    const { result } = message as { result: { messages: unknown[] } };
    expect(result.messages).toStrictEqual([{ role: "user", content: { type: "text", text } }]);
  }),
);
