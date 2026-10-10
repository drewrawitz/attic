import type { Tool } from "./tool.ts";
import { getSchema } from "./tools/get-schema.ts";
import { query } from "./tools/query.ts";

export { callTool, type Tool, type ToolResult } from "./tool.ts";

/** Every tool Attic has. The server registers each one. */
export const tools: ReadonlyArray<Tool> = [getSchema, query];
