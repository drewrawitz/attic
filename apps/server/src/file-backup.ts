import type { WorkerEnv } from "../../../alchemy.run.ts";
import {
  BACKUP_OFF,
  backupBucketOf,
  putObject,
  readObject,
  type BackupBucket,
} from "./backup-bucket.ts";
import { ChoreFailure, reasonOf, secondsSince, type Chore, type NightlyRun } from "./chore.ts";

// Where a file is in the backup bucket: under this, by the key it has in R2.
const FILES_PREFIX = "files/";

// Where the copy keeps how far it got: the key of the last file it copied, in one small object
// in the backup bucket itself, outside `files/`. A bucket that is new or was emptied has none,
// so the copy starts from the beginning by itself (ADR 0016).
const CURSOR_KEY = "state/files-cursor.json";

// The key of the last file that was copied, or nothing when the bucket has no cursor. A cursor
// that holds no key stops the copy. Starting over by itself would copy every file again, night
// after night, with nothing in the log to say why.
const readCursor = async (bucket: BackupBucket, night: NightlyRun) => {
  const held = await readObject(bucket, CURSOR_KEY, night);
  if (held === undefined) return undefined;
  let lastCopied: unknown;
  try {
    lastCopied = (JSON.parse(held) as { last_copied?: unknown } | null)?.last_copied;
  } catch {
    // It is not JSON, so it holds no key either.
  }
  if (typeof lastCopied !== "string") {
    throw new ChoreFailure(
      `${CURSOR_KEY} in the backup bucket does not hold the key of the last file that was copied. Take it out of the bucket, and the next night copies every file again.`,
    );
  }
  return lastCopied;
};

// Keeps the key of the last file that was copied, in place of the one the bucket had.
const writeCursor = (bucket: BackupBucket, lastCopied: string, night: NightlyRun) => {
  const json = new Blob([JSON.stringify({ last_copied: lastCopied })]);
  return putObject(
    bucket,
    CURSOR_KEY,
    { body: json.stream(), length: json.size, contentType: "application/json" },
    night,
  );
};

// A read from R2, which is not a subrequest and so does not go through the run's `ask`. One
// that throws is the chore's failure, in words that say what was read, as a call through
// `ask` is.
const fromR2 = async <A>(what: string, read: () => Promise<A>) => {
  try {
    return await read();
  } catch (error) {
    throw new ChoreFailure(`${what} failed: ${String(error)}`);
  }
};

// Copies one file to the bucket, streamed, under the key it has in R2. It gives back how many
// bytes the file is, or nothing for a file that was deleted since it was listed.
const copyFile = async (
  r2: WorkerEnv["FILES"],
  key: string,
  bucket: BackupBucket,
  night: NightlyRun,
) => {
  const file = await fromR2(`The read of ${key} from R2`, () => r2.get(key));
  if (file === null) return undefined;
  await putObject(
    bucket,
    `${FILES_PREFIX}${key}`,
    {
      body: file.body,
      length: file.size,
      contentType: file.httpMetadata?.contentType ?? "application/octet-stream",
      // R2 keeps one for a file that was stored in one piece.
      md5: file.checksums.md5,
    },
    night,
  );
  return file.size;
};

// The second chore of the nightly run: the files in R2 that are not yet in the backup bucket
// are copied there, a batch a night, in the order of their keys. It never deletes one there
// (ADR 0016).
export const fileBackup = (env: WorkerEnv): Chore => ({
  name: "file backup",
  run: async (night) => {
    const bucket = backupBucketOf(env);
    if (bucket === undefined) return BACKUP_OFF;
    night.keepOut(bucket.secretAccessKey);

    const started = Date.now();
    // Each subrequest the run has left is one file, but for two: the read of the cursor, and
    // the write of it. A read from `FILES` is not a subrequest: Cloudflare counts a call to
    // its own D1, R2, and KV apart, up to 1,000 of them (ADR 0012).
    const left = night.asksLeft();
    const batchSize = left - 2;
    if (batchSize < 1) {
      throw new ChoreFailure(
        `The run has ${left} of its subrequests left, and the first file takes 3: the cursor is read, the file is sent, and the cursor is written. The files wait for the next night.`,
      );
    }
    const lastCopied = await readCursor(bucket, night);
    // R2 lists by key, so the files after the cursor are the ones that were stored since.
    const waiting = await fromR2("The list of the files in R2", () =>
      env.FILES.list({
        limit: batchSize,
        ...(lastCopied === undefined ? {} : { startAfter: lastCopied }),
      }),
    );
    if (waiting.objects.length === 0) return "nothing new to copy.";

    let copied = 0;
    let bytes = 0;
    let reached = lastCopied;
    // Why the batch stopped short, when it did.
    let whyStopped: string | undefined;
    try {
      for (const { key } of waiting.objects) {
        const size = await copyFile(env.FILES, key, bucket, night);
        if (size !== undefined) {
          copied += 1;
          bytes += size;
        }
        reached = key;
      }
    } catch (error) {
      // A file that fails stops the batch.
      whyStopped = reasonOf(error);
    }
    // The cursor is written at the last file that got there, also when the one after it did
    // not. So the one that failed is tried again the next night.
    if (reached !== undefined && reached !== lastCopied) {
      try {
        await writeCursor(bucket, reached, night);
      } catch (error) {
        // The log names what went wrong first.
        whyStopped ??= reasonOf(error);
      }
    }
    const howMany = copied === 1 ? "1 file" : `${copied} files`;
    if (whyStopped !== undefined) {
      throw new ChoreFailure(`Stopped after ${howMany}. ${whyStopped}`);
    }

    const more = waiting.truncated ? " More are waiting for the next night." : "";
    return `copied ${howMany}, ${bytes} bytes, in ${secondsSince(started)} s.${more}`;
  },
});
