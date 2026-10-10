import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

// An account at the stand-in, in the words Google's userinfo answer uses.
export interface GoogleAccount {
  readonly sub: string;
  readonly email: string;
  readonly email_verified: boolean;
  readonly name: string;
}

const body = async (request: IncomingMessage) => {
  let text = "";
  for await (const chunk of request) text += String(chunk);
  return new URLSearchParams(text);
};

// Stands in for Google at the two calls the Worker makes to it: trading a code for a token,
// and reading the profile behind that token. It holds the Worker to what Google would: the
// right client id and secret, the redirect address the sign-in started with, a code that
// works once, and a PKCE verifier that matches the challenge sent earlier.
export const startFakeGoogle = async (client: { id: string; secret: string }) => {
  const codes = new Map<
    string,
    { account: GoogleAccount; challenge: string | null; redirectUri: string | null }
  >();
  const tokens = new Map<string, GoogleAccount>();

  const server = createServer((request, response) => {
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };

    void (async () => {
      if (request.method === "POST" && request.url === "/token") {
        const form = await body(request);
        const issued = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        const verifier = createHash("sha256")
          .update(form.get("code_verifier") ?? "")
          .digest("base64url");
        if (form.get("client_id") !== client.id || form.get("client_secret") !== client.secret) {
          return json(401, { error: "invalid_client" });
        }
        if (
          form.get("grant_type") !== "authorization_code" ||
          issued === undefined ||
          issued.redirectUri !== form.get("redirect_uri") ||
          issued.challenge !== verifier
        ) {
          return json(400, { error: "invalid_grant" });
        }
        const token = randomUUID();
        tokens.set(token, issued.account);
        return json(200, { access_token: token, token_type: "Bearer", expires_in: 3599 });
      }

      if (request.method === "GET" && request.url === "/userinfo") {
        const account = tokens.get((request.headers.authorization ?? "").replace("Bearer ", ""));
        return account === undefined ? json(401, { error: "invalid_token" }) : json(200, account);
      }

      return json(404, { error: "not_found" });
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    tokenUrl: `${origin}/token`,
    userinfoUrl: `${origin}/userinfo`,
    // What Google's own sign-in page does. `authorizeUrl` is where the Worker sent the
    // browser. The person signs in there as `account`, and Google hands back a code.
    signIn: (authorizeUrl: URL, account: GoogleAccount) => {
      const code = randomUUID();
      codes.set(code, {
        account,
        challenge: authorizeUrl.searchParams.get("code_challenge"),
        redirectUri: authorizeUrl.searchParams.get("redirect_uri"),
      });
      return code;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};
