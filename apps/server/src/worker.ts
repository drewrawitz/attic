import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { WorkerEnv } from "../../../alchemy.run.ts";
import { mcp } from "./mcp.ts";
import { overLimit } from "./rate-limit.ts";
import { AUTHORIZE_PATH, MCP_PATH, REGISTER_PATH, TOKEN_PATH } from "./routes.ts";
import { signIn } from "./sign-in.ts";

// Every request goes through Cloudflare's OAuth provider. It answers the OAuth endpoints
// itself, lets a request for /mcp through only with a token it issued, and hands everything
// else to the sign-in pages.
const newProvider = (origin: string) =>
  new OAuthProvider<WorkerEnv>({
    apiRoute: MCP_PATH,
    apiHandler: mcp,
    defaultHandler: signIn,
    authorizeEndpoint: AUTHORIZE_PATH,
    tokenEndpoint: TOKEN_PATH,
    clientRegistrationEndpoint: REGISTER_PATH,
    // The address a client connects to, which every token is bound to.
    resourceMetadata: { resource: `${origin}${MCP_PATH}` },
  });

// The provider has to be told its own address when it is built, and that address is only
// known from a request: the workers.dev address, a custom domain, or localhost in dev. So
// there is one provider for each address the Worker is reached at. Cloudflare only routes a
// request here for a hostname the Worker is deployed on, so this stays at one or two.
const providers = new Map<string, OAuthProvider<WorkerEnv>>();

const providerFor = (origin: string) => {
  let known = providers.get(origin);
  if (known === undefined) {
    known = newProvider(origin);
    providers.set(origin, known);
  }
  return known;
};

// The provider only accepts plain http for an address on this machine, which is what dev
// uses.
const THIS_MACHINE = new Set(["localhost", "127.0.0.1", "[::1]"]);

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.protocol !== "https:" && !THIS_MACHINE.has(url.hostname)) {
      return new Response("Attic only answers over https.", { status: 400 });
    }
    if (await overLimit(request, env, url.pathname)) {
      return new Response("Too many requests. Try again in a minute.", {
        status: 429,
        headers: { "retry-after": "60" },
      });
    }
    // The provider attaches its helpers to the env object it is given. A copy for each
    // request keeps two providers from sharing one set.
    return providerFor(url.origin).fetch(request, { ...env }, ctx);
  },
} satisfies ExportedHandler<WorkerEnv>;
