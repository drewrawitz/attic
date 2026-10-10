import { callTool, tools, type Tool, type ToolResult } from "@attic/core";
import { D1Client } from "@effect/sql-d1";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { Effect, Schema } from "effect";
import type { WorkerEnv } from "../../../alchemy.run.ts";
import { isAllowed } from "./allowlist.ts";

// The JSON Schema dialect the MCP SDK asks every tool to describe its input in.
const DIALECT = "draft-2020-12";

// A tool's input is an Effect Schema. The MCP SDK takes it as a Standard Schema that can
// also describe itself as JSON Schema. Effect works that description out afresh each time it
// is asked, and the SDK asks whenever a tool is registered, which is on every request. So
// it is worked out here once and handed back from then on.
const toolInput = (schema: Tool["input"]) => {
  const { "~standard": standard } = Schema.toStandardJSONSchemaV1(
    Schema.toStandardSchemaV1(schema),
  );
  const described = standard.jsonSchema.input({ target: DIALECT });
  return {
    "~standard": {
      ...standard,
      jsonSchema: {
        ...standard.jsonSchema,
        input: (options: Parameters<typeof standard.jsonSchema.input>[0]) =>
          options.target === DIALECT ? described : standard.jsonSchema.input(options),
      },
    },
  };
};

// Every tool as the MCP SDK registers it. A new server is built for each request (ADR 0001),
// so whatever is the same for every request is done here, once, when the module loads.
const registrations = tools.map((tool) => ({
  tool,
  config: {
    description: tool.description,
    inputSchema: toolInput(tool.input),
    annotations: tool.annotations,
  },
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
const runTool = async (env: WorkerEnv, tool: Tool, input: unknown): Promise<CallToolResult> => {
  const { text, isError } = callerIsAllowed(env)
    ? await Effect.runPromise(callTool(tool, input, D1Client.layer({ db: env.DB })))
    : NOT_ALLOWED;
  return { content: [{ type: "text", text }], isError };
};

const createServer = (env: WorkerEnv) => {
  const server = new McpServer({ name: "attic", version: "0.0.0" });
  for (const { tool, config } of registrations) {
    server.registerTool(tool.name, config, (input) => runTool(env, tool, input));
  }
  return server;
};

// POST /mcp, reached only with a token the OAuth provider issued. A new MCP server is built
// for each request and nothing is kept between them (ADR 0001).
export const mcp = {
  fetch: (request, env, ctx) => createMcpHandler(() => createServer(env))(request, env, ctx),
} satisfies ExportedHandler<WorkerEnv>;
