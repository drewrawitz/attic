import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { WorkerEnv } from "../../../alchemy.run.ts";
import { mcp } from "./mcp.ts";
import { signIn } from "./sign-in.ts";

// Every request goes through Cloudflare's OAuth provider. It answers the OAuth endpoints
// itself, lets a request for /mcp through only with a token it issued, and hands everything
// else to the sign-in pages.
const provider = (origin: string) =>
  new OAuthProvider<WorkerEnv>({
    apiRoute: "/mcp",
    apiHandler: mcp,
    defaultHandler: signIn,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    // The address a client connects to, which every token is bound to.
    resourceMetadata: { resource: `${origin}/mcp` },
  });

// The provider has to be told its own address when it is built, and that address is only
// known from a request: the workers.dev address, a custom domain, or localhost in dev. So
// there is one provider for each address the Worker is reached at. Cloudflare only routes a
// request here for a hostname the Worker is deployed on, so this stays at one or two.
const providers = new Map<string, OAuthProvider<WorkerEnv>>();

const providerFor = (origin: string) => {
  let known = providers.get(origin);
  if (known === undefined) {
    known = provider(origin);
    providers.set(origin, known);
  }
  return known;
};

// Registration and the sign-in page answer anyone, and each use writes to KV. So one
// address only gets so many of each in a minute. Cloudflare sets `cf-connecting-ip` itself,
// and a caller cannot choose it. A browser's preflight check writes nothing and is not
// counted.
const overLimit = async (request: Request, env: WorkerEnv, pathname: string) => {
  const limit =
    pathname === "/register"
      ? env.REGISTER_LIMIT
      : pathname === "/authorize"
        ? env.AUTHORIZE_LIMIT
        : undefined;
  if (limit === undefined || request.method === "OPTIONS") return false;
  const { success } = await limit.limit({
    key: request.headers.get("cf-connecting-ip") ?? "unknown",
  });
  return !success;
};

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
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
