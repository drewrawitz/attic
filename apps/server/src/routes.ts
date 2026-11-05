// The paths the Worker answers at. The OAuth provider serves the token and registration
// endpoints itself, so the rate limits have to sit on the very paths it is given here.
export const MCP_PATH = "/mcp";
export const AUTHORIZE_PATH = "/authorize";
export const CALLBACK_PATH = "/callback";
export const TOKEN_PATH = "/token";
export const REGISTER_PATH = "/register";

// The links the User taps to put a file in Attic, then the id of its request, and to open a
// Document's file, then the Document's id. Each is signed and needs no token, so each is
// outside the OAuth provider. Core signs them, so core says where they are.
export { DOCUMENT_PATH, UPLOAD_PATH } from "@attic/core";
