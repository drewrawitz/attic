import { LINK_RAN_OUT, type ToolServices } from "@attic/core";
import type { Effect } from "effect";
import type { WorkerEnv } from "../../../alchemy.run.ts";
import { messagePage } from "./consent-page.ts";
import { withToolServices } from "./tool-services.ts";

// What the routes a signed link opens have in common (ADR 0008). A phone that opens one has no
// token, so each is outside the OAuth provider, and its signature is the one check.

/** The paths of a route a signed link opens: its base, then one id. */
export const linkPaths = (base: string) => ({
  is: (pathname: string) =>
    pathname.startsWith(`${base}/`) && !pathname.slice(base.length + 1).includes("/"),
  idIn: (pathname: string) => pathname.slice(base.length + 1),
});

export const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

export const json = (body: unknown, status = 200) => Response.json(body, { status });

const UNEXPECTED = "Attic hit an error it did not expect. The details are in the Worker's log.";

/** The page a failure nobody planned for gets. The details are in the log. */
export const unexpectedPage = () => html(messagePage("Attic hit an error", UNEXPECTED), 500);

/**
 * Runs a read a page needs, on what a tool runs on. A failure nobody planned for is logged
 * with `failed`, and comes back as null, for the page to say there was one.
 */
export const readForPage = <A, E>(
  env: WorkerEnv,
  origin: string,
  program: Effect.Effect<A, E, ToolServices>,
  failed: string,
) =>
  withToolServices(env, origin, program).catch((error: unknown) => {
    console.error(failed, error);
    return null;
  });

const NOT_SIGNED = "This is not a link Attic made, or part of it was changed. Ask for a new one.";

/**
 * What a link that does not work gets, as a page or as JSON. `ranOut` is what a link that has
 * run out says, when there is more to do than ask for a new one.
 */
export const turnedAway = (
  checked: "ran out" | "not signed",
  asPage: boolean,
  ranOut = LINK_RAN_OUT,
) => {
  const [status, message] = checked === "ran out" ? [410, ranOut] : [403, NOT_SIGNED];
  return asPage
    ? html(messagePage("This link does not work", message), status)
    : json({ error: message }, status);
};
