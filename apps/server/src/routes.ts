// The paths the Worker answers at. The OAuth provider serves the token and registration
// endpoints itself, so the rate limits have to sit on the very paths it is given here.
export const MCP_PATH = "/mcp";
export const AUTHORIZE_PATH = "/authorize";
export const CALLBACK_PATH = "/callback";
export const TOKEN_PATH = "/token";
export const REGISTER_PATH = "/register";
