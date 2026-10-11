import type { Tool } from "./tool.ts";
import { getRecord } from "./tools/get-record.ts";
import { getSchema } from "./tools/get-schema.ts";
import { query } from "./tools/query.ts";
import { saveProperty } from "./tools/save-property.ts";
import { search } from "./tools/search.ts";

export { callTool, type Tool, type ToolResult } from "./tool.ts";
export { AtomicBatch, Ids } from "./write.ts";

/** Every tool Attic has. The server registers each one. */
export const tools: ReadonlyArray<Tool> = [getSchema, query, search, getRecord, saveProperty];
