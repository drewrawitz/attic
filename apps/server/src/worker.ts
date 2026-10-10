import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { WorkerEnv } from "../../../alchemy.run.ts";
import { mcp } from "./mcp.ts";
import { AUTHORIZE, MCP, REGISTER, TOKEN } from "./routes.ts";
import { signIn } from "./sign-in.ts";

// Every request goes through Cloudflare's OAuth provider. It answers the OAuth endpoints
// itself, lets a request for /mcp through only with a token it issued, and hands everything
// else to the sign-in pages.
const provider = (origin: string) =>
  new OAuthProvider<WorkerEnv>({
    apiRoute: MCP,
    apiHandler: mcp,
    defaultHandler: signIn,
    authorizeEndpoint: AUTHORIZE,
    tokenEndpoint: TOKEN,
    clientRegistrationEndpoint: REGISTER,
    // The address a client connects to, which every token is bound to.
    resourceMetadata: { resource: `${origin}${MCP}` },
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

// The provider only accepts plain http for an address on this machine, which is what dev
// uses.
const THIS_MACHINE = new Set(["localhost", "127.0.0.1", "[::1]"]);

// What a caller's rate limits are counted by. One network can hand itself any number of
// IPv6 addresses, so those are counted by their first half, which names the network. An
// IPv4 address is counted whole.
const network = (address: string) => {
  if (!address.includes(":")) return address;
  const [head = "", tail] = address.split("::");
  const start = head === "" ? [] : head.split(":");
  const end = tail === undefined || tail === "" ? [] : tail.split(":");
  const groups =
    tail === undefined
      ? start
      : [...start, ...Array.from({ length: 8 - start.length - end.length }, () => "0"), ...end];
  return groups
    .slice(0, 4)
    .map((group) => parseInt(group, 16).toString(16))
    .join(":");
};

// Registration and the sign-in page answer anyone, and each use writes to KV. So one
// caller only gets so many of each in a minute. Cloudflare sets `cf-connecting-ip` itself,
// and a caller cannot choose it. A browser's preflight check writes nothing and is not
// counted.
const overLimit = async (request: Request, env: WorkerEnv, pathname: string) => {
  const limit =
    pathname === REGISTER
      ? env.REGISTER_LIMIT
      : pathname === AUTHORIZE
        ? env.AUTHORIZE_LIMIT
        : undefined;
  if (limit === undefined || request.method === "OPTIONS") return false;
  const { success } = await limit.limit({
    key: network(request.headers.get("cf-connecting-ip") ?? "unknown"),
  });
  return !success;
};

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
