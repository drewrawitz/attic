import { createHash, createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { serve } from "./stand-in.ts";

/** An access key at the stand-in. */
export interface AccessKey {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/** A request the stand-in was sent, whether or not it took it. */
export interface BucketRequest {
  readonly method: string;
  readonly key: string;
  readonly headers: IncomingMessage["headers"];
}

const hmac = (key: string | Buffer, text: string) =>
  createHmac("sha256", key).update(text).digest();

// The signature a request should carry, worked out from the request as it arrived, by the
// steps of AWS Signature Version 4. This is written from AWS's description of them and shares
// no code with the Worker, so the two agreeing means something.
const signatureFor = (
  request: IncomingMessage,
  signed: { headers: ReadonlyArray<string>; date: string; region: string },
  secretAccessKey: string,
) => {
  const [path, query = ""] = (request.url ?? "").split("?");
  const canonical = [
    request.method,
    path,
    query.split("&").sort().join("&"),
    signed.headers.map((name) => `${name}:${String(request.headers[name]).trim()}\n`).join(""),
    signed.headers.join(";"),
    request.headers["x-amz-content-sha256"],
  ].join("\n");
  const toSign = [
    "AWS4-HMAC-SHA256",
    request.headers["x-amz-date"],
    `${signed.date}/${signed.region}/s3/aws4_request`,
    createHash("sha256").update(canonical).digest("hex"),
  ].join("\n");
  const signingKey = [signed.date, signed.region, "s3", "aws4_request"].reduce<string | Buffer>(
    hmac,
    `AWS4${secretAccessKey}`,
  );
  return hmac(signingKey, toSign).toString("hex");
};

// What the request's Authorization header says: who signed it, for which day and region, and
// which headers the signature covers.
const AUTHORIZATION =
  /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, ?SignedHeaders=([^,]+), ?Signature=([0-9a-f]{64})$/;

/**
 * Stands in for the backup bucket: an S3-compatible bucket at another provider. It takes a
 * PUT of an object, and holds the Worker to what such a bucket would: the request is for this
 * bucket, it says how long its body is, and it is signed with an access key the bucket knows,
 * for the bucket's region, over the headers S3 asks for. A request that falls short gets the
 * error S3 would give, and nothing is kept.
 *
 * Alchemy's local runtime has an S3 endpoint of its own, for a local R2 bucket. It is not used
 * here. It serves only a bucket that is bound to the Worker, and the one bound bucket is
 * `FILES`, which the backup copies from. It also cannot show a test the request it was sent,
 * or be made to say no.
 */
export const startFakeBucket = async (bucket: {
  name: string;
  region: string;
  accessKey: AccessKey;
}) => {
  // The access key the bucket knows. A test changes it, so that the Worker's no longer fits.
  let known = bucket.accessKey;
  const objects = new Map<string, { body: Buffer; contentType: string | undefined }>();
  const requests: BucketRequest[] = [];

  const { origin, close } = await serve((request, response) => {
    const refuse = (status: number, code: string, message: string) => {
      response.writeHead(status, { "content-type": "application/xml" });
      response.end(
        `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${message}</Message></Error>`,
      );
    };

    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);

      const [, name, ...rest] = (request.url ?? "").split("?")[0]!.split("/");
      const key = rest.map(decodeURIComponent).join("/");
      requests.push({ method: request.method ?? "", key, headers: request.headers });

      if (name !== bucket.name) {
        return refuse(404, "NoSuchBucket", "The specified bucket does not exist.");
      }
      const authorization = AUTHORIZATION.exec(request.headers.authorization ?? "");
      if (authorization === null) {
        return refuse(403, "AccessDenied", "The request is not signed.");
      }
      const [, accessKeyId, date, region, signedHeaders, signature] = authorization;
      const headers = signedHeaders!.split(";");
      if (accessKeyId !== known.accessKeyId) {
        return refuse(403, "InvalidAccessKeyId", "The key id you provided does not exist.");
      }
      if (
        region !== bucket.region ||
        !["host", "x-amz-content-sha256", "x-amz-date"].every((name) => headers.includes(name)) ||
        !String(request.headers["x-amz-date"]).startsWith(date!) ||
        signature !== signatureFor(request, { headers, date: date!, region }, known.secretAccessKey)
      ) {
        return refuse(
          403,
          "SignatureDoesNotMatch",
          "The request signature we calculated does not match the signature you provided.",
        );
      }
      if (request.method !== "PUT") {
        return refuse(405, "MethodNotAllowed", "The stand-in only takes a PUT.");
      }
      if (request.headers["content-length"] === undefined) {
        return refuse(411, "MissingContentLength", "You must provide the Content-Length header.");
      }

      objects.set(key, { body, contentType: request.headers["content-type"] });
      response.writeHead(200, { etag: `"${createHash("md5").update(body).digest("hex")}"` });
      response.end();
    })();
  });

  return {
    /** The address of the stand-in's S3 API, which the bucket's name goes after. */
    endpoint: origin,
    /** Every object the bucket holds, by its key. */
    objects: objects as ReadonlyMap<string, { body: Buffer; contentType: string | undefined }>,
    /** Every request since the bucket was last emptied, in order. */
    requests: requests as ReadonlyArray<BucketRequest>,
    /** Takes every object out, and forgets the requests. */
    empty: () => {
      objects.clear();
      requests.length = 0;
    },
    /** The bucket knows only this access key from here on. */
    knows: (accessKey: AccessKey) => {
      known = accessKey;
    },
    close,
  };
};
