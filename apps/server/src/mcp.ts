import { hello } from "@attic/core";
import { D1Client } from "@effect/sql-d1";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { Data, Effect, Schema } from "effect";
import type { WorkerEnv } from "../../../alchemy.run.ts";
import { isAllowed } from "./allowlist.ts";

// A tool's input is an Effect Schema. The MCP SDK takes it as a Standard Schema that can
// also describe itself as JSON Schema.
const toolInput = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema));

class NotAllowed extends Data.TaggedError("NotAllowed") {}

// The email of whoever is calling, from what sign-in stored with the token. Sign-in already
// checked the allowlist. Checking again on every call means an email taken off the list is
// locked out at once, not when its token runs out.
const signedInEmail = (env: WorkerEnv) => {
  const email = getMcpAuthContext()?.props.email;
  return typeof email === "string" && isAllowed(env.ALLOWED_EMAILS, email)
    ? Effect.succeed(email)
    : Effect.fail(new NotAllowed());
};

const text = (value: string, isError = false): CallToolResult => ({
  content: [{ type: "text", text: value }],
  isError,
});

// Runs a tool's program for the signed-in caller and turns its result into what MCP sends
// back. The caller is read here, before the program starts, because the MCP handler only
// keeps it within reach for the length of this call.
const runTool = <A, E>(
  env: WorkerEnv,
  tool: (email: string) => Effect.Effect<A, E, D1Client.D1Client>,
) =>
  Effect.runPromise(
    signedInEmail(env).pipe(
      Effect.flatMap(tool),
      Effect.map((result) => text(JSON.stringify(result))),
      Effect.catchTag("NotAllowed", () =>
        Effect.succeed(text("This Google account is not allowed to use this Attic.", true)),
      ),
      Effect.provide(D1Client.layer({ db: env.DB })),
    ),
  );

// The placeholder tool. It makes one query, so a call goes through everything a real tool
// will: the token, the MCP layer, Effect, and D1.
const sayHello = (email: string) =>
  Effect.gen(function* () {
    const sql = yield* D1Client.D1Client;
    const [categories] = yield* sql<{
      count: number;
    }>`SELECT count(*) AS count FROM categories`;

    return { message: yield* hello, email, categories: categories?.count ?? 0 };
  });

const createServer = (env: WorkerEnv) => {
  const server = new McpServer({ name: "attic", version: "0.0.0" });

  server.registerTool(
    "hello",
    {
      description:
        "Placeholder until the real tools land. Returns a greeting, the email of the signed-in Google account, and how many Categories the database holds, which shows that sign-in and the database both work.",
      inputSchema: toolInput(Schema.Struct({})),
      annotations: { readOnlyHint: true },
    },
    () => runTool(env, sayHello),
  );

  return server;
};

// POST /mcp, reached only with a token the OAuth provider issued. A new MCP server is built
// for each request and nothing is kept between them (ADR 0001).
export const mcp = {
  fetch: (request, env, ctx) => createMcpHandler(() => createServer(env))(request, env, ctx),
} satisfies ExportedHandler<WorkerEnv>;
