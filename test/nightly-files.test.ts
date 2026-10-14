import { createHash } from "node:crypto";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  ACCESS_KEY,
  backedUpWorker,
  BACKUP_ON,
  bucket,
  untilBackupIsOff,
  withBackup,
} from "./support/backup.ts";
import { addFiles, filesAre, type TestFile } from "./support/files.ts";
import type { ExportBehavior } from "./support/fake-cloudflare.ts";
import { cloudflare, deployWith, test } from "./support/harness.ts";
import { lineOf, runNightly } from "./support/nightly.ts";

// The second chore of the nightly run, through the real Worker on the local simulators: the
// files in R2 that are not yet in the backup bucket are copied there, a batch a night. No tool
// stores a file until step 6 of the `v1` route, so each test puts its own objects in `FILES`.
// The backup bucket is the stand-in the tests of the export use (nightly.test.ts).

// Where the copy keeps how far it got, in the backup bucket.
const CURSOR_KEY = "state/files-cursor.json";

// A file as step 6 will store one: under a key that starts with a ULID, so that the keys sort
// by when they were written. `place` is where it comes in that order.
const fileOf = (place: number, name: string, contentType: string, body: Buffer): TestFile => ({
  key: `01K7C3Q9ZV${String(place).padStart(16, "0")}/${name}`,
  body,
  contentType,
});

// Bytes that are no text in any encoding, and enough of them to arrive in more than one piece.
const PHOTO = Buffer.from(Array.from({ length: 200_000 }, (_, index) => (index * 31 + 7) % 256));

const RECEIPT = fileOf(
  1,
  "fridge receipt.pdf",
  "application/pdf",
  Buffer.from("%PDF-1.7\n\xff\x00", "latin1"),
);
const TAP = fileOf(2, "kitchen-tap.jpg", "image/jpeg", PHOTO);
const MANUAL = fileOf(
  3,
  "manual.txt",
  "text/plain; charset=utf-8",
  Buffer.from("Entkalken: täglich.\n"),
);
const WARRANTY = fileOf(4, "warranty.png", "image/png", Buffer.from("\x89PNG\r\n\x1a\n", "latin1"));

// Any SQL will do for the export, which runs before the files are copied.
const QUICK_EXPORT: ExportBehavior = { sql: "CREATE TABLE cellar (shelf TEXT);\n" };

// One nightly run, read for the files: the line their copy logged, every request the bucket
// was sent for anything but the export, as "PUT files/...", and how many subrequests the whole
// run made.
const runForFiles = (url: string, theExport = QUICK_EXPORT) =>
  Effect.promise(async () => {
    cloudflare.exportsWill(theExport);
    const sentBefore = bucket.requests.length;
    const { outcome, log } = await runNightly(url);
    const requests = bucket.requests.slice(sentBefore);
    return {
      outcome,
      log,
      line: lineOf("file backup", log),
      sent: requests
        .filter(({ key }) => !key.startsWith("database/"))
        .map(({ method, key }) => `${method} ${key}`),
      subrequests: cloudflare.calls.length + cloudflare.downloads() + requests.length,
    };
  });

// What the bucket holds under `files/`, by the key each has in `FILES`.
const copies = () =>
  new Map(
    [...bucket.objects]
      .filter(([key]) => key.startsWith("files/"))
      .map(([key, object]) => [key.slice("files/".length), object]),
  );

// What the cursor in the bucket holds, or nothing when the bucket has none.
const storedCursor = () => {
  const held = bucket.objects.get(CURSOR_KEY);
  return held === undefined ? undefined : (JSON.parse(held.body.toString("utf8")) as unknown);
};

test(
  "a run copies every file under files/, byte for byte, with its content type, and keeps the last key",
  Effect.gen(function* () {
    const { url } = yield* backedUpWorker;
    yield* filesAre(RECEIPT, TAP, MANUAL);

    const { outcome, line, sent } = yield* runForFiles(url);

    expect(outcome).toBe("ok");
    expect([...copies().keys()]).toEqual([RECEIPT.key, TAP.key, MANUAL.key]);
    for (const file of [RECEIPT, TAP, MANUAL]) {
      const copy = copies().get(file.key);
      expect(copy?.body.equals(file.body)).toBe(true);
      expect(copy?.contentType).toBe(file.contentType);
    }
    expect(storedCursor()).toEqual({ last_copied: MANUAL.key });

    // The cursor is read, the files go over in the order of their keys, and the cursor is
    // written back.
    expect(sent).toEqual([
      `GET ${CURSOR_KEY}`,
      `PUT files/${RECEIPT.key}`,
      `PUT files/${TAP.key}`,
      `PUT files/${MANUAL.key}`,
      `PUT ${CURSOR_KEY}`,
    ]);
    // The line says how many were copied, their size in bytes, and how long it took.
    expect(line).toMatch(/^file backup: copied 3 files, 200032 bytes, in \d+\.\d s\.\n$/);
  }),
);

test(
  "a file that is stored after a run is copied alone by the next, and a run with nothing new writes nothing",
  Effect.gen(function* () {
    const { url } = yield* backedUpWorker;
    yield* filesAre(RECEIPT, TAP, MANUAL);
    yield* runForFiles(url);

    yield* addFiles(WARRANTY);
    const next = yield* runForFiles(url);

    expect(next.sent).toEqual([
      `GET ${CURSOR_KEY}`,
      `PUT files/${WARRANTY.key}`,
      `PUT ${CURSOR_KEY}`,
    ]);
    expect(copies().get(WARRANTY.key)?.body.equals(WARRANTY.body)).toBe(true);
    expect(storedCursor()).toEqual({ last_copied: WARRANTY.key });
    expect(next.line).toMatch(/^file backup: copied 1 file, 8 bytes, in \d+\.\d s\.\n$/);

    const idle = yield* runForFiles(url);

    expect(idle.sent).toEqual([`GET ${CURSOR_KEY}`]);
    expect(idle.line).toBe("file backup: nothing new to copy.\n");
  }),
);

// A cron run on Workers Free gets 50 subrequests (ADR 0012). The run stops at 45, and its
// chores share them. An export that is done at the first call takes 3. The copy reads its
// cursor and writes it back, which is 2. So 40 are left, and each is one file.
test(
  "a run copies as many files as its subrequests allow, says more are waiting, and the next run finishes",
  Effect.gen(function* () {
    const { url } = yield* backedUpWorker;
    const files = Array.from({ length: 46 }, (_, index) =>
      fileOf(index + 1, "photo.jpg", "image/jpeg", Buffer.from(`photo ${index + 1}`)),
    );
    yield* filesAre(...files);

    const first = yield* runForFiles(url);

    expect(first.sent).toEqual([
      `GET ${CURSOR_KEY}`,
      ...files.slice(0, 40).map(({ key }) => `PUT files/${key}`),
      `PUT ${CURSOR_KEY}`,
    ]);
    expect(first.subrequests).toBe(45);
    expect(storedCursor()).toEqual({ last_copied: files[39]!.key });
    expect(first.line).toMatch(
      /^file backup: copied 40 files, 311 bytes, in \d+\.\d s\. More are waiting for the next night\.\n$/,
    );

    const second = yield* runForFiles(url);

    expect(second.sent).toEqual([
      `GET ${CURSOR_KEY}`,
      ...files.slice(40).map(({ key }) => `PUT files/${key}`),
      `PUT ${CURSOR_KEY}`,
    ]);
    expect(second.line).toMatch(/^file backup: copied 6 files, 48 bytes, in \d+\.\d s\.\n$/);
    // Every file is in the bucket, and was sent there once.
    expect([...copies()].map(([key, { body }]) => [key, body.toString("utf8")])).toEqual(
      files.map(({ key, body }) => [key, body.toString("utf8")]),
    );
  }),
);

// The slowest export there is takes 22: 20 calls about it, the read of the signed address, and
// its PUT. With the 2 for the cursor, 21 are left for files.
test(
  "a run of the slowest export and as many files as fit stays under the 50 subrequests a cron run gets",
  Effect.gen(function* () {
    const { url } = yield* backedUpWorker;
    const files = Array.from({ length: 30 }, (_, index) =>
      fileOf(index + 1, "photo.jpg", "image/jpeg", Buffer.from(`photo ${index + 1}`)),
    );
    yield* filesAre(...files);

    const { sent, subrequests, line } = yield* runForFiles(url, { ...QUICK_EXPORT, notYet: 19 });

    expect(cloudflare.calls).toHaveLength(20);
    expect(sent).toEqual([
      `GET ${CURSOR_KEY}`,
      ...files.slice(0, 21).map(({ key }) => `PUT files/${key}`),
      `PUT ${CURSOR_KEY}`,
    ]);
    expect(subrequests).toBe(45);
    expect(line).toMatch(
      /^file backup: copied 21 files, .* More are waiting for the next night\.\n$/,
    );
  }),
);

// A failure stops the batch. The cursor is written at the last file that got there, so the one
// that failed is tried again the next night. The line names the key and the answer.
test(
  "a bucket that refuses a file stops the batch there, and the next run takes it up from that file",
  Effect.gen(function* () {
    const { url } = yield* backedUpWorker;
    yield* filesAre(RECEIPT, TAP, MANUAL);
    bucket.refuses(`files/${TAP.key}`);

    const first = yield* runForFiles(url);

    expect(first.outcome).toBe("ok");
    expect(first.sent).toEqual([
      `GET ${CURSOR_KEY}`,
      `PUT files/${RECEIPT.key}`,
      `PUT files/${TAP.key}`,
      `PUT ${CURSOR_KEY}`,
    ]);
    expect([...copies().keys()]).toEqual([RECEIPT.key]);
    expect(storedCursor()).toEqual({ last_copied: RECEIPT.key });
    expect(first.line).toBe(
      `file backup: failed. Stopped after 1 file. The PUT of files/${TAP.key} to the backup bucket was answered with 500: <?xml version="1.0" encoding="UTF-8"?> <Error><Code>InternalError</Code><Message>We encountered an internal error. Please try again.</Message></Error>\n`,
    );

    bucket.refuses(undefined);
    const next = yield* runForFiles(url);

    expect(next.sent).toEqual([
      `GET ${CURSOR_KEY}`,
      `PUT files/${TAP.key}`,
      `PUT files/${MANUAL.key}`,
      `PUT ${CURSOR_KEY}`,
    ]);
    expect([...copies().keys()]).toEqual([RECEIPT.key, TAP.key, MANUAL.key]);
    expect(storedCursor()).toEqual({ last_copied: MANUAL.key });
  }).pipe(Effect.ensuring(Effect.sync(() => bucket.refuses(undefined)))),
);

// The files are in the bucket by then, so nothing is lost. The next run copies them again,
// each over itself, and that is all it costs.
test(
  "a cursor that the bucket refuses is a logged failure, and the next run copies the same files again",
  Effect.gen(function* () {
    const { url } = yield* backedUpWorker;
    yield* filesAre(RECEIPT, TAP);
    bucket.refuses(CURSOR_KEY);

    const first = yield* runForFiles(url);

    expect(first.line).toBe(
      `file backup: failed. Stopped after 2 files. The PUT of ${CURSOR_KEY} to the backup bucket was answered with 500: <?xml version="1.0" encoding="UTF-8"?> <Error><Code>InternalError</Code><Message>We encountered an internal error. Please try again.</Message></Error>\n`,
    );
    expect([...copies().keys()]).toEqual([RECEIPT.key, TAP.key]);
    expect(storedCursor()).toBeUndefined();

    bucket.refuses(undefined);
    const next = yield* runForFiles(url);

    expect(next.sent).toEqual([
      `GET ${CURSOR_KEY}`,
      `PUT files/${RECEIPT.key}`,
      `PUT files/${TAP.key}`,
      `PUT ${CURSOR_KEY}`,
    ]);
    expect(storedCursor()).toEqual({ last_copied: TAP.key });
  }).pipe(Effect.ensuring(Effect.sync(() => bucket.refuses(undefined)))),
);

// The cursor is in the bucket, and not in D1 or KV, for this: a bucket that is new or was
// emptied is filled from the beginning, with nothing reset by hand (ADR 0016).
test(
  "a bucket that was emptied is filled again from the first file",
  Effect.gen(function* () {
    const { url } = yield* backedUpWorker;
    yield* filesAre(RECEIPT, TAP, MANUAL);
    yield* runForFiles(url);
    bucket.empty();

    const { sent } = yield* runForFiles(url);

    expect(sent).toEqual([
      `GET ${CURSOR_KEY}`,
      `PUT files/${RECEIPT.key}`,
      `PUT files/${TAP.key}`,
      `PUT files/${MANUAL.key}`,
      `PUT ${CURSOR_KEY}`,
    ]);
    expect([...copies().keys()]).toEqual([RECEIPT.key, TAP.key, MANUAL.key]);
    expect(storedCursor()).toEqual({ last_copied: MANUAL.key });
  }),
);

test(
  "an export that fails does not stop the files, and a file that fails does not stop the export",
  Effect.gen(function* () {
    const { url } = yield* backedUpWorker;
    yield* filesAre(RECEIPT, TAP, MANUAL);

    const noExport = yield* runForFiles(url, {
      ...QUICK_EXPORT,
      error: "D1_ERROR: the cellar flooded",
    });

    expect(noExport.log.split("\n")).toEqual([
      "database backup: failed. Cloudflare could not make the export: D1_ERROR: the cellar flooded",
      expect.stringMatching(/^file backup: copied 3 files, 200032 bytes, in \d+\.\d s\.$/),
      "",
    ]);
    expect([...bucket.objects.keys()]).toEqual([
      `files/${RECEIPT.key}`,
      `files/${TAP.key}`,
      `files/${MANUAL.key}`,
      CURSOR_KEY,
    ]);

    bucket.empty();
    bucket.refuses(`files/${RECEIPT.key}`);
    const noFiles = yield* runForFiles(url);

    expect(noFiles.outcome).toBe("ok");
    expect(noFiles.log.split("\n")).toEqual([
      expect.stringMatching(
        /^database backup: exported database\/\S+\.sql, 34 bytes, in \d+\.\d s\.$/,
      ),
      expect.stringContaining(
        `file backup: failed. Stopped after 0 files. The PUT of files/${RECEIPT.key} to the backup bucket was answered with 500: `,
      ),
      "",
    ]);
    expect([...bucket.objects.keys()]).toEqual([
      expect.stringMatching(/^database\/\d{4}-\d{2}-\d{2}\.sql$/),
    ]);
  }).pipe(Effect.ensuring(Effect.sync(() => bucket.refuses(undefined)))),
);

// The stand-in checks the signature as S3 would, and takes nothing that is not signed with the
// key it knows. This pins the rest of what S3 asks, for every request of a run: the export's,
// the files', and the cursor's.
test(
  "every request to the bucket is signed over its headers, not its body, and a PUT says how long its body is",
  Effect.gen(function* () {
    const { url } = yield* backedUpWorker;
    yield* filesAre(RECEIPT, TAP);

    yield* runForFiles(url);

    const asked = bucket.requests.map(({ method, key, headers }) => ({
      request: `${method} ${key.replace(/^database\/.*/, "database/")}`,
      signed:
        /^AWS4-HMAC-SHA256 Credential=(\S+)\/\d{8}\/(\S+)\/s3\/aws4_request, SignedHeaders=\S*host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/
          .exec(headers.authorization ?? "")
          ?.slice(1),
      bodyHash: headers["x-amz-content-sha256"],
      length: headers["content-length"],
      chunked: headers["transfer-encoding"],
    }));
    const signed = [ACCESS_KEY.accessKeyId, BACKUP_ON.BACKUP_REGION];
    const cursorLength = String(JSON.stringify({ last_copied: TAP.key }).length);
    expect(asked).toEqual([
      { request: "PUT database/", signed, bodyHash: "UNSIGNED-PAYLOAD", length: "34" },
      { request: `GET ${CURSOR_KEY}`, signed, bodyHash: "UNSIGNED-PAYLOAD" },
      { request: `PUT files/${RECEIPT.key}`, signed, bodyHash: "UNSIGNED-PAYLOAD", length: "11" },
      { request: `PUT files/${TAP.key}`, signed, bodyHash: "UNSIGNED-PAYLOAD", length: "200000" },
      { request: `PUT ${CURSOR_KEY}`, signed, bodyHash: "UNSIGNED-PAYLOAD", length: cursorLength },
    ]);
  }),
);

// R2 keeps the MD5 of a file that was stored in one piece. The Worker hashes nothing itself
// (ADR 0012), so it sends that one along, and the bucket checks the bytes it was sent against
// it. The stand-in does too, as S3 does: a file that arrived whole is in the tests above.
test(
  "a file goes to the bucket with the MD5 that R2 keeps for it, under the signature",
  Effect.gen(function* () {
    const { url } = yield* backedUpWorker;
    yield* filesAre(RECEIPT, TAP);

    yield* runForFiles(url);

    const md5Sent = Object.fromEntries(
      bucket.requests
        .filter(({ method }) => method === "PUT")
        .map(({ key, headers }) => [
          key.replace(/^database\/.*/, "database/"),
          [headers["content-md5"], /SignedHeaders=([^,]+)/.exec(headers.authorization ?? "")?.[1]],
        ]),
    );
    const md5Of = (body: Buffer) => createHash("md5").update(body).digest("base64");
    const withMd5 = "content-md5;host;x-amz-content-sha256;x-amz-date";
    const withNone = "host;x-amz-content-sha256;x-amz-date";
    expect(md5Sent).toEqual({
      // Nobody has hashed the export or the cursor.
      "database/": [undefined, withNone],
      [`files/${RECEIPT.key}`]: [md5Of(RECEIPT.body), withMd5],
      [`files/${TAP.key}`]: [md5Of(TAP.body), withMd5],
      [CURSOR_KEY]: [undefined, withNone],
    });
  }),
);

// Attic never deletes from the backup bucket (ADR 0016).
test(
  "a file that is deleted from R2 stays in the backup bucket",
  Effect.gen(function* () {
    const { url } = yield* backedUpWorker;
    yield* filesAre(RECEIPT, TAP, MANUAL);
    yield* runForFiles(url);

    yield* filesAre(RECEIPT, MANUAL);
    const { sent, line } = yield* runForFiles(url);

    expect(sent).toEqual([`GET ${CURSOR_KEY}`]);
    expect(line).toBe("file backup: nothing new to copy.\n");
    expect(copies().get(TAP.key)?.body.equals(TAP.body)).toBe(true);
  }),
);

// Only a 404 says there is no cursor. A bucket that will not say what it holds is not an
// empty one, and a copy that took it for one would start from the first file every night.
test(
  "a read of the cursor that the bucket refuses stops the copy before any file is sent",
  Effect.gen(function* () {
    const { url } = yield* backedUpWorker;
    yield* filesAre(RECEIPT, TAP);
    // The provider has another secret for the key than the one the Worker signs with.
    bucket.knows({ ...ACCESS_KEY, secretAccessKey: "a-newer-secret-key" });

    const { sent, line } = yield* runForFiles(url);

    expect(sent).toEqual([`GET ${CURSOR_KEY}`]);
    expect(line).toBe(
      `file backup: failed. The read of ${CURSOR_KEY} from the backup bucket was answered with 403: <?xml version="1.0" encoding="UTF-8"?> <Error><Code>SignatureDoesNotMatch</Code><Message>The request signature we calculated does not match the signature you provided.</Message><Expected>[hidden]</Expected></Error>\n`,
    );
    expect(copies().size).toBe(0);
  }).pipe(Effect.ensuring(Effect.sync(() => bucket.knows(ACCESS_KEY)))),
);

// Starting over by itself would copy every file again, night after night, with nothing in the
// log to say why.
test(
  "a cursor that does not hold a key stops the copy, and the line says what to do",
  Effect.gen(function* () {
    const { url } = yield* backedUpWorker;
    yield* filesAre(RECEIPT);

    for (const held of ["<html>Not what the copy wrote.</html>", '{"last_copied":7}', "null"]) {
      bucket.holds(CURSOR_KEY, held);
      const { sent, line } = yield* runForFiles(url);

      expect(sent).toEqual([`GET ${CURSOR_KEY}`]);
      expect(line).toBe(
        "file backup: failed. state/files-cursor.json in the backup bucket does not hold the key of the last file that was copied. Take it out of the bucket, and the next night copies every file again.\n",
      );
    }
    expect(copies().size).toBe(0);
  }),
);

// This one changes the Worker's settings, so it sits at the end of the file, and it puts them
// back for whatever runs next. It leaves `FILES` empty too.
test(
  "with no backup bucket configured, a run sends nothing anywhere, whatever is in FILES",
  Effect.gen(function* () {
    yield* withBackup;
    yield* filesAre(RECEIPT, TAP);
    yield* deployWith();

    // The Worker that was there before still has the backup, and its run reaches Cloudflare.
    const last = yield* untilBackupIsOff;
    expect(lineOf("file backup", last.log)).toBe(
      "file backup: off, because no backup bucket is configured.\n",
    );
    expect(bucket.requests).toHaveLength(0);
  }).pipe(Effect.ensuring(Effect.orDie(Effect.andThen(deployWith(), filesAre())))),
);
