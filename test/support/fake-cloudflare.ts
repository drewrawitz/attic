import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { serve } from "./stand-in.ts";

/** What the stand-in does with the exports it is asked for, until it is told otherwise. */
export interface ExportBehavior {
  /** The SQL an export holds. */
  readonly sql: string;
  /** How many times it says an export is not done yet, before it is. Never done at Infinity. */
  readonly notYet?: number;
  /** An answer that the export is not done leaves out the bookmark to ask again with. */
  readonly withoutBookmark?: boolean;
  /** The export fails, and this is the reason Cloudflare gives. */
  readonly error?: string;
  /** The token is turned away, as one without the permission is. */
  readonly refusesToken?: boolean;
  /** What the signed address answers with. It serves the SQL unless this is given. */
  readonly signedAddressAnswers?: number;
  /** The signed address serves the SQL in chunks, and does not say how long it is. */
  readonly withoutLength?: boolean;
}

const MALFORMED = {
  success: false,
  errors: [{ code: 7400, message: "The request is malformed" }],
  messages: [],
  result: null,
};

const bodyOf = async (request: IncomingMessage) => {
  let text = "";
  for await (const chunk of request) text += String(chunk);
  return JSON.parse(text) as Record<string, unknown>;
};

/**
 * Stands in for Cloudflare at the one call the Worker makes to its API, the export of a D1
 * database, and at the signed address that call hands back. Alchemy's local simulators have
 * no such call: local D1 can dump itself, but only through its own binding. So the stand-in
 * holds the Worker to what Cloudflare would: the token, a body that asks to poll, and on every
 * call after the first the bookmark the first one was given. The answers are in the words of
 * Cloudflare's API reference for the call.
 */
export const startFakeCloudflare = async (token: string) => {
  let behavior: ExportBehavior = { sql: "" };
  // The export that is running: its bookmark, and how many more times it is not done.
  let running: { bookmark: string; notYet: number } | undefined;
  let signedAddress: string | undefined;
  const calls: { account: string; database: string; body: Record<string, unknown> }[] = [];
  let downloads = 0;

  const { origin, close } = await serve((request, response) => {
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    const url = new URL(request.url ?? "/", origin);

    void (async () => {
      const exportOf = /^\/client\/v4\/accounts\/([^/]+)\/d1\/database\/([^/]+)\/export$/.exec(
        url.pathname,
      );
      if (request.method === "POST" && exportOf !== null) {
        const body = await bodyOf(request);
        calls.push({
          account: decodeURIComponent(exportOf[1]!),
          database: decodeURIComponent(exportOf[2]!),
          body,
        });
        const authorization = request.headers.authorization ?? "";
        if (authorization !== `Bearer ${token}` || behavior.refusesToken) {
          // Cloudflare does not send a token back. This does, so that a test can tell
          // whether the Worker logs an answer as it came.
          return send(403, {
            success: false,
            errors: [{ code: 10000, message: `Authentication error for ${authorization}` }],
            messages: [],
            result: null,
          });
        }
        if (body.current_bookmark === undefined) {
          // A call with no bookmark starts an export.
          running = { bookmark: randomUUID(), notYet: behavior.notYet ?? 0 };
        }
        // A call with one looks at the export that is running, and at no other.
        if (body.output_format !== "polling" || running?.bookmark === undefined) {
          return send(400, MALFORMED);
        }
        if (body.current_bookmark !== undefined && body.current_bookmark !== running.bookmark) {
          return send(400, MALFORMED);
        }
        const bookmark = behavior.withoutBookmark ? {} : { at_bookmark: running.bookmark };
        const sendExport = (state: Record<string, unknown>) =>
          send(200, {
            success: true,
            errors: [],
            messages: [],
            result: { success: true, type: "export", ...bookmark, ...state },
          });

        if (behavior.error !== undefined) {
          return sendExport({ success: false, status: "error", error: behavior.error });
        }
        if (running.notYet > 0) {
          running.notYet -= 1;
          return sendExport({ status: "active", messages: ["Uploading part 1"] });
        }
        running = undefined;
        signedAddress = `${origin}/signed/${randomUUID()}.sql?X-Amz-Expires=3600&X-Amz-Signature=${randomUUID().replaceAll("-", "")}`;
        return sendExport({
          status: "complete",
          messages: [],
          result: { filename: "attic.sql", signed_url: signedAddress },
        });
      }

      if (request.method === "GET" && `${origin}${request.url}` === signedAddress) {
        downloads += 1;
        if (behavior.signedAddressAnswers !== undefined) {
          // The address is in the answer for the same reason the token is in the one above,
          // and its signature again by itself, which is how S3 words an error.
          response.writeHead(behavior.signedAddressAnswers, { "content-type": "application/xml" });
          return response.end(
            `<Error><Code>InternalError</Code><Resource>${signedAddress}</Resource><SignatureProvided>${url.searchParams.get("X-Amz-Signature")}</SignatureProvided></Error>`,
          );
        }
        const sql = Buffer.from(behavior.sql, "utf8");
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          ...(behavior.withoutLength
            ? { "transfer-encoding": "chunked" }
            : { "content-length": String(sql.length) }),
        });
        return response.end(sql);
      }

      return send(404, { success: false, errors: [{ code: 7003, message: "Not found" }] });
    })();
  });

  return {
    apiUrl: `${origin}/client/v4`,
    /** Sets what exports do from here on, and forgets the calls and the downloads so far. */
    exportsWill: (next: ExportBehavior) => {
      behavior = next;
      running = undefined;
      signedAddress = undefined;
      calls.length = 0;
      downloads = 0;
    },
    /** Every call for an export since `exportsWill`, in order. */
    calls: calls as ReadonlyArray<(typeof calls)[number]>,
    /** How many times the signed address was read since `exportsWill`. */
    downloads: () => downloads,
    /** The signed address the last finished export handed back. */
    signedAddress: () => signedAddress,
    close,
  };
};
