// The paths the Worker answers at. The OAuth provider serves the token and registration
// endpoints itself, so the rate limits have to sit on the very paths it is given here.
export const MCP = "/mcp";
export const AUTHORIZE = "/authorize";
export const CALLBACK = "/callback";
export const TOKEN = "/token";
export const REGISTER = "/register";
