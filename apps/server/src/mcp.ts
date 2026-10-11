import { AtomicBatch, callTool, Ids, tools, type Tool, type ToolResult } from "@attic/core";
import { D1Client } from "@effect/sql-d1";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { DateTime, Effect, Layer } from "effect";
import type { WorkerEnv } from "../../../alchemy.run.ts";
import { isAllowed } from "./allowlist.ts";

// Every tool as the MCP SDK registers it. A new server is built for each request (ADR 0001),
// so whatever is the same for every request is done here, once, when the module loads. A
// tool's input is already what the SDK takes: a Standard Schema that checks a call and
// describes itself as JSON Schema, made in `defineTool`.
const registrations = tools.map((tool) => ({
  tool,
  config: {
    description: tool.description,
    inputSchema: tool.input,
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

// D1 has no interactive transactions (ADR 0006). Its batch is the atomic write: every
// statement in it happens, or none does.
const D1Batch = Layer.effect(
  AtomicBatch,
  Effect.map(D1Client.D1Client, (d1) =>
    AtomicBatch.of({ run: (statements) => Effect.asVoid(d1.batch(statements)) }),
  ),
);

// What a tool runs on in the Worker: the D1 database, its batch, ULIDs for new records, and
// the configured timezone, which is where a tool reads today's date. Effect keeps each timezone
// it has made, so only the first call of an isolate pays for making it.
const services = (env: WorkerEnv) =>
  Layer.mergeAll(D1Batch, Ids.layer, DateTime.layerCurrentZoneNamed(env.ATTIC_TIMEZONE)).pipe(
    Layer.provideMerge(D1Client.layer({ db: env.DB })),
  );

// Runs a tool for the signed-in caller, on the Worker's database, and puts what it sends back
// in the shape MCP expects. The caller is checked here, before anything starts, because the
// MCP handler only keeps it within reach for the length of this call.
const runTool = async (env: WorkerEnv, tool: Tool, input: unknown): Promise<CallToolResult> => {
  const { text, isError } = callerIsAllowed(env)
    ? await Effect.runPromise(callTool(tool, input, services(env)))
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
