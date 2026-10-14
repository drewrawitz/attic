import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Starts a stand-in for an outside service: a server on this machine, on a port of its own.
 * It gives back the address the stand-in is reached at, and a way to stop it.
 */
export const serve = async (answer: RequestListener) => {
  const server = createServer(answer);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};
