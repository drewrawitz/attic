import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { callTool, type Tool } from "../src/tool.ts";

/**
 * Calls a tool on the database the test is already running on, so a test can fill the
 * database first and then see what the client is sent.
 */
export const call = (tool: Tool, input: unknown) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    callTool(tool, input, Layer.succeed(SqlClient.SqlClient, sql)),
  );
