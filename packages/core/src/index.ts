import type { Tool } from "./tool.ts";
import { addNote } from "./tools/add-note.ts";
import { getRecord } from "./tools/get-record.ts";
import { getSchema } from "./tools/get-schema.ts";
import { logWork } from "./tools/log-work.ts";
import { query } from "./tools/query.ts";
import { saveCategory } from "./tools/save-category.ts";
import { saveItem } from "./tools/save-item.ts";
import { saveProject } from "./tools/save-project.ts";
import { saveProperty } from "./tools/save-property.ts";
import { saveQuote } from "./tools/save-quote.ts";
import { saveSpace } from "./tools/save-space.ts";
import { saveVendor } from "./tools/save-vendor.ts";
import { search } from "./tools/search.ts";
import { undo } from "./tools/undo.ts";

export { Currency } from "./money.ts";
export { callTool, type Tool, type ToolResult } from "./tool.ts";
export { AtomicBatch, Ids } from "./write.ts";

/** Every tool Attic has. The server registers each one. */
export const tools: ReadonlyArray<Tool> = [
  getSchema,
  query,
  search,
  getRecord,
  saveProperty,
  saveSpace,
  saveVendor,
  saveCategory,
  saveItem,
  logWork,
  saveProject,
  saveQuote,
  addNote,
  undo,
];
