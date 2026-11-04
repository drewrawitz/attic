import { callTool, prompts, tools, type Tool, type ToolResult } from "@attic/core";
import { McpServer, type CallToolResult, type GetPromptResult } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { Effect } from "effect";
import type { WorkerEnv } from "../../../alchemy.run.ts";
import { isAllowed } from "./allowlist.ts";
import { toolServices } from "./tool-services.ts";

// Every tool as the MCP SDK registers it. A new server is built for each request (ADR 0001),
// so whatever is the same for every request is done here, once, when the module loads. A
// tool's input is already what the SDK takes: a Standard Schema that checks a call and
// describes itself as JSON Schema, made in `defineTool`.
const toolRegistrations = tools.map((tool) => ({
  tool,
  config: {
    description: tool.description,
    inputSchema: tool.input,
    annotations: tool.annotations,
  },
}));

// Every prompt as the MCP SDK registers it, made once in the same way. A prompt takes nothing
// and is a fixed text, so what a client is sent when it asks for one is made here too. The text
// goes out as a message from the User, which is how a client puts a prompt in a conversation.
const promptRegistrations = prompts.map(({ name, description, text }) => ({
  name,
  config: { description },
  result: {
    messages: [{ role: "user", content: { type: "text", text } }],
  } satisfies GetPromptResult,
}));

// Whether whoever is calling may use this Attic, from the email sign-in stored with the
// token. Sign-in already checked the allowlist. Checking again on every call means an email
// taken off the list is locked out at once, not when its token runs out.
const callerIsAllowed = (env: WorkerEnv) => {
  const email = getMcpAuthContext()?.props.email;
  return typeof email === "string" && isAllowed(env.ALLOWED_EMAILS, email);
};

const NOT_ALLOWED: ToolResult = {
  text: "This Google account is not allowed to use this Attic.",
  isError: true,
};

// Runs a tool for the signed-in caller, on the Worker's database, and puts what it sends back
// in the shape MCP expects. The caller is checked here, before anything starts, because the
// MCP handler only keeps it within reach for the length of this call.
// A link a tool makes is to the address the client reached the Worker at.
const runTool = async (
  env: WorkerEnv,
  origin: string,
  tool: Tool,
  input: unknown,
): Promise<CallToolResult> => {
  const { text, isError } = callerIsAllowed(env)
    ? await Effect.runPromise(callTool(tool, input, toolServices(env, origin)))
    : NOT_ALLOWED;
  return { content: [{ type: "text", text }], isError };
};

const createServer = (env: WorkerEnv, origin: string) => {
  const server = new McpServer({ name: "attic", version: "0.0.0" });
  for (const { tool, config } of toolRegistrations) {
    server.registerTool(tool.name, config, (input) => runTool(env, origin, tool, input));
  }
  // A prompt is not held to the allowlist as a call to a tool is. Its text is in the repo, with
  // nothing of the User's in it, and the tools it sends a client to are each checked.
  for (const { name, config, result } of promptRegistrations) {
    server.registerPrompt(name, config, () => result);
  }
  return server;
};

// POST /mcp, reached only with a token the OAuth provider issued. A new MCP server is built
// for each request and nothing is kept between them (ADR 0001).
export const mcp = {
  fetch: (request, env, ctx) =>
    createMcpHandler(() => createServer(env, new URL(request.url).origin))(request, env, ctx),
} satisfies ExportedHandler<WorkerEnv>;
