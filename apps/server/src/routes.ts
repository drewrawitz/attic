// The paths the Worker answers at. The OAuth provider serves the token and registration
// endpoints itself, so the rate limits have to sit on the very paths it is given here.
export const MCP_PATH = "/mcp";
export const AUTHORIZE_PATH = "/authorize";
export const CALLBACK_PATH = "/callback";
export const TOKEN_PATH = "/token";
export const REGISTER_PATH = "/register";

// The link the User taps to put a file in Attic, then the id of its request. It is signed and
// needs no token, so it is outside the OAuth provider. Core signs it, so core says where it is.
export { UPLOAD_PATH } from "@attic/core";
