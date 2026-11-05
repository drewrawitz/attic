import { expect } from "@effect/vitest";
import { AwsClient } from "aws4fetch";
import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import { stack } from "./harness.ts";
import type { Call, Fields } from "./household.ts";

// Files of Documents, through the real Worker: a link from request_upload_link, a file posted
// to it the way the upload page posts one, and what the FILES bucket on local R2 holds.

// A PNG's first bytes, then something of this run's own, so that two tests never send the same
// file by chance.
export const aFile = (text: string) =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(text)]);

export const sha256Of = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export const asking = (call: Call, input: Fields) =>
  Effect.map(call("request_upload_link", { kind: "receipt", ...input }), (answer) => {
    expect(answer.refused).toBeUndefined();
    return answer.link as string;
  });

// A file posted the way the page posts it.
export const posting = (
  link: string,
  bytes: Buffer,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Fields }> =>
  fetch(link, {
    method: "POST",
    headers: {
      "content-type": "image/png",
      "x-content-sha256": sha256Of(bytes),
      ...headers,
    },
    body: bytes,
  }).then(async (response) => ({
    status: response.status,
    body: (await response.json()) as Fields,
  }));

// A file of a Document posted to a new link, and the Document's id.
export const stored = (call: Call, bytes: Buffer, input: Fields, type = "image/png") =>
  Effect.gen(function* () {
    const link = yield* asking(call, input);
    const posted = yield* Effect.promise(() => posting(link, bytes, { "content-type": type }));
    expect(posted.status).toBe(200);
    return posted.body.document_id as string;
  });

// Asks the FILES bucket through the S3 endpoint Alchemy's local runtime serves for it, with the
// fixed key that guards it on this machine (`LocalS3.ts` in Alchemy). `path` follows the
// bucket's name.
export const askFiles = (path: string, init?: RequestInit) =>
  Effect.flatMap(stack, ({ url, filesBucket }) =>
    Effect.promise(() =>
      new AwsClient({
        accessKeyId: "alchemy-local-r2",
        secretAccessKey: "alchemy-local-r2-secret",
        service: "s3",
        region: "auto",
      }).fetch(`${url}/cdn-cgi/local/r2/s3/${filesBucket}${path}`, init),
    ),
  );

// The bytes stored under a key, or the status the bucket answered with when there are none.
export const storedObject = (key: string) =>
  Effect.flatMap(askFiles(`/${key}`), (response) =>
    Effect.promise(async () =>
      response.ok ? Buffer.from(await response.arrayBuffer()) : response.status,
    ),
  );

// The time a ULID starts with, in Crockford's base 32, for a time in milliseconds.
export const ulidTime = (time: number) => {
  const digits = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let text = "";
  for (let left = time, at = 0; at < 10; at++, left = Math.floor(left / 32)) {
    text = digits[left % 32]! + text;
  }
  return text;
};
