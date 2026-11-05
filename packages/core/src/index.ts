import type { Prompt } from "./prompt.ts";
import type { Tool } from "./tool.ts";
import { addNote } from "./tools/add-note.ts";
import { deleteRecord } from "./tools/delete-record.ts";
import { gaps } from "./tools/gaps.ts";
import { getRecord } from "./tools/get-record.ts";
import { getSchema } from "./tools/get-schema.ts";
import { logWork } from "./tools/log-work.ts";
import { query } from "./tools/query.ts";
import { requestUploadLink } from "./tools/request-upload-link.ts";
import { saveCategory } from "./tools/save-category.ts";
import { saveItem } from "./tools/save-item.ts";
import { saveProject } from "./tools/save-project.ts";
import { saveProperty } from "./tools/save-property.ts";
import { saveQuote } from "./tools/save-quote.ts";
import { saveSpace } from "./tools/save-space.ts";
import { saveVendor } from "./tools/save-vendor.ts";
import { search } from "./tools/search.ts";
import { undo } from "./tools/undo.ts";
import { walkTheHouse, walkTheHousePrompt } from "./tools/walk-the-house.ts";

export { today } from "./dates.ts";
export {
  FILE_TYPES,
  LINK_RAN_OUT,
  MOST_FILE_BYTES,
  MOST_FILE_MEGABYTES,
  shownRequest,
  UPLOAD_PATH,
  type ArrivedFile,
} from "./document.ts";
export { receiveFile, type Arrival } from "./tools/request-upload-link.ts";
export { Currency } from "./money.ts";
export { checkSignature, SignedAddresses } from "./signed-address.ts";
export { callTool, ToolError, type Tool, type ToolResult, type ToolServices } from "./tool.ts";
export { AtomicBatch, Ids } from "./write.ts";

/** Every tool Attic has. The server registers each one. */
export const tools: ReadonlyArray<Tool> = [
  getSchema,
  query,
  search,
  getRecord,
  gaps,
  walkTheHouse,
  saveProperty,
  saveSpace,
  saveVendor,
  saveCategory,
  saveItem,
  logWork,
  saveProject,
  saveQuote,
  addNote,
  requestUploadLink,
  deleteRecord,
  undo,
];

/** Every prompt Attic has. The server registers each one. */
export const prompts: ReadonlyArray<Prompt> = [walkTheHousePrompt];
