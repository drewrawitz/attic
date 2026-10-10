// What an MCP client does around the browser part of sign-in: it registers itself, builds
// the address of the sign-in page, trades the code it gets back for a token, and then calls
// /mcp with that token.

// Where the client asks to be sent back to. Nothing listens there. The tests only read the
// redirect.
export const REDIRECT_URI = "http://localhost:8976/callback";

// The PKCE pair from RFC 7636, appendix B.
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

// Registration is open to anyone, so the name is whatever the client says it is. `address`
// is the internet address the client registers from.
export const register = (url: string, clientName: string, address: string) =>
  fetch(`${url}/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": address },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
    }),
  });

export const authorizeUrl = (url: string, clientId: string) =>
  `${url}/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    state: "client-state",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    resource: `${url}/mcp`,
  }).toString()}`;

export const exchange = (url: string, clientId: string, code: string) =>
  fetch(`${url}/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code,
      code_verifier: VERIFIER,
      resource: `${url}/mcp`,
    }),
  });

// One JSON-RPC request to /mcp. The answer comes back as plain JSON or as a one-message
// event stream, and either way this returns the message.
export const mcp = async (
  url: string,
  message: { method: string; params?: unknown },
  token?: string,
) => {
  const response = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...message }),
  });
  const text = await response.text();
  const data = /^data: (.*)$/m.exec(text)?.[1] ?? text;
  return { response, message: data === "" ? undefined : (JSON.parse(data) as unknown) };
};
