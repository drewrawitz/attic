import type { WorkerEnv } from "../../../alchemy.run.ts";
import { AUTHORIZE_PATH, REGISTER_PATH } from "./routes.ts";

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

// Registration and the sign-in page answer anyone, and each use writes to KV. So a caller
// that keeps hitting one of them is slowed down. Cloudflare sets `cf-connecting-ip` itself,
// and a caller cannot choose it. A browser's preflight check writes nothing and is not
// counted.
export const overLimit = async (request: Request, env: WorkerEnv, pathname: string) => {
  const limit =
    pathname === REGISTER_PATH
      ? env.REGISTER_LIMIT
      : pathname === AUTHORIZE_PATH
        ? env.AUTHORIZE_LIMIT
        : undefined;
  if (limit === undefined || request.method === "OPTIONS") return false;
  const { success } = await limit.limit({
    key: network(request.headers.get("cf-connecting-ip") ?? "unknown"),
  });
  return !success;
};
