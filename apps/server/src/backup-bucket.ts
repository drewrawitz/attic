import { AwsClient } from "aws4fetch";
import type { WorkerEnv } from "../../../alchemy.run.ts";
import { refusal, type NightlyRun } from "./chore.ts";

// The backup bucket: an S3-compatible bucket at another provider, and a key to it.
export interface BackupBucket {
  readonly endpoint: string;
  readonly region: string;
  readonly name: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

// The backup bucket the Worker is bound to. Nothing when the backup is off. The stack binds
// every setting of the backup or none of them (alchemy.run.ts), which the type of the bindings
// cannot say, so each one is looked at.
export const backupBucketOf = (env: WorkerEnv): BackupBucket | undefined => {
  const {
    BACKUP_ENDPOINT: endpoint,
    BACKUP_REGION: region,
    BACKUP_BUCKET: name,
    BACKUP_ACCESS_KEY_ID: accessKeyId,
    BACKUP_SECRET_ACCESS_KEY: secretAccessKey,
  } = env;
  if (
    endpoint === undefined ||
    region === undefined ||
    name === undefined ||
    accessKeyId === undefined ||
    secretAccessKey === undefined
  ) {
    return undefined;
  }
  return { endpoint, region, name, accessKeyId, secretAccessKey };
};

// What a chore of the backup logs when the Worker is bound to no backup bucket.
export const BACKUP_OFF = "off, because no backup bucket is configured.";

// The keys that requests are signed with. A signer works one out from the secret, the day, and
// the region, and keeps it here. Without this each request would work its key out again, which
// is four hashes more for every file, in a run that gets 10 ms of CPU (ADR 0012).
const signingKeys = new Map<string, ArrayBuffer>();

// Signs a request to the bucket. Signature Version 4 is not written by hand here (ADR 0016).
const signerOf = (bucket: BackupBucket) =>
  new AwsClient({
    accessKeyId: bucket.accessKeyId,
    secretAccessKey: bucket.secretAccessKey,
    service: "s3",
    region: bucket.region,
    cache: signingKeys,
  });

// Where an object is: the bucket's name and the object's key, after the endpoint.
const objectAddress = (bucket: BackupBucket, key: string) =>
  `${bucket.endpoint}/${bucket.name}/${key.split("/").map(encodeURIComponent).join("/")}`;

// An object on its way to the bucket: a stream, and how many bytes it will be.
export interface StreamedObject {
  readonly body: ReadableStream<Uint8Array>;
  readonly length: number;
  readonly contentType: string;
  // The MD5 of its bytes, when whoever has the object was given one with it. It goes along as
  // `Content-MD5`, and the bucket then turns the object away unless the bytes it was sent
  // have that MD5. The Worker never works one out itself (ADR 0012).
  readonly md5?: ArrayBuffer;
}

const base64Of = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)));

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
  const { readable, writable } = new FixedLengthStream(object.length);
  const stop = new AbortController();
  // Whether the body got there is the bucket's to say, in its answer.
  object.body.pipeTo(writable, { signal: stop.signal }).catch(() => {});

  // `sign` and not the client's own `fetch`, which tries again on a 5xx. A stream cannot be
  // sent twice, and every try is a subrequest.
  const request = await signerOf(bucket).sign(objectAddress(bucket, key), {
    method: "PUT",
    headers: {
      "content-type": object.contentType,
      "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
      ...(object.md5 === undefined ? {} : { "content-md5": base64Of(object.md5) }),
    },
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

// Reads one object out of the backup bucket, whole, as text. So it is for a small one. Nothing
// when the bucket has no object under the key.
export const readObject = async (
  bucket: BackupBucket,
  key: string,
  night: NightlyRun,
): Promise<string | undefined> => {
  const request = await signerOf(bucket).sign(objectAddress(bucket, key));
  const what = `The read of ${key} from the backup bucket`;
  const answer = await night.ask(what, request);
  if (answer.status === 404) {
    await answer.body?.cancel();
    return undefined;
  }
  if (!answer.ok) throw await refusal(what, answer);
  return answer.text();
};
