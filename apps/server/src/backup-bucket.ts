import { AwsClient } from "aws4fetch";
import { refusal, type NightlyRun } from "./chore.ts";

// The backup bucket: an S3-compatible bucket at another provider, and a key to it.
export interface BackupBucket {
  readonly endpoint: string;
  readonly region: string;
  readonly name: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

// An object on its way to the bucket: a stream, and how many bytes it will be.
export interface StreamedObject {
  readonly body: ReadableStream<Uint8Array>;
  readonly length: number;
  readonly contentType: string;
}

// Puts one object in the backup bucket, replacing any that has the key. The body is streamed:
// it is never held in memory, and never hashed (ADR 0012). S3 wants a PUT to say how long its
// body is, which a stream of a fixed length does, and to be signed, which here covers the
// headers and not the body.
export const putObject = async (
  bucket: BackupBucket,
  key: string,
  object: StreamedObject,
  night: NightlyRun,
): Promise<void> => {
  const signer = new AwsClient({
    accessKeyId: bucket.accessKeyId,
    secretAccessKey: bucket.secretAccessKey,
    service: "s3",
    region: bucket.region,
  });
  const { readable, writable } = new FixedLengthStream(object.length);
  const stop = new AbortController();
  // Whether the body got there is the bucket's to say, in its answer.
  object.body.pipeTo(writable, { signal: stop.signal }).catch(() => {});

  const path = key.split("/").map(encodeURIComponent).join("/");
  // `sign` and not the client's own `fetch`, which tries again on a 5xx. A stream cannot be
  // sent twice, and every try is a subrequest.
  const request = await signer.sign(`${bucket.endpoint}/${bucket.name}/${path}`, {
    method: "PUT",
    headers: { "content-type": object.contentType, "x-amz-content-sha256": "UNSIGNED-PAYLOAD" },
    body: readable,
  });
  const what = `The PUT of ${key} to the backup bucket`;
  try {
    const answer = await night.ask(what, request);
    if (!answer.ok) throw await refusal(what, answer);
    await answer.body?.cancel();
  } finally {
    // The bucket has the whole body by now, or it did not take it and gets no more of it.
    stop.abort();
  }
};
