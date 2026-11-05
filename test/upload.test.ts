import { expect } from "@effect/vitest";
import { AwsClient } from "aws4fetch";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import * as Effect from "effect/Effect";
import { onDatabase } from "./support/database.ts";
import { stack, test } from "./support/harness.ts";
import { asClientWith, type Call, type Fields } from "./support/household.ts";

// The link request_upload_link makes, tried through the real Worker: its page, a file posted to
// it, and what local R2 holds then. What a Document is and how it is undone are tested on Node
// SQLite, in packages/core. These hold what only the Worker does: the signature, the limits,
// the stream into R2 and R2's check of its hash, and the Change on D1.

// Takes out what these tests wrote. The database is kept between runs, and so is R2, which no
// test empties. A file whose Document is gone is stored again under a new key, so a run is
// never told a file is there already because an earlier run sent it.
const OURS = `LIKE 'Upload test%'`;
const cleanUp = onDatabase(
  `DELETE FROM changes WHERE id IN (
     SELECT change_id FROM change_records
      WHERE coalesce(json_extract(coalesce(after, before), '$.title'),
                     json_extract(coalesce(after, before), '$.name')) ${OURS})`,
  `DELETE FROM documents WHERE title ${OURS}`,
  `DELETE FROM vendors WHERE name ${OURS}`,
  `DELETE FROM upload_requests WHERE json_extract(request, '$.title') ${OURS}`,
);

const asClient = asClientWith(cleanUp);

// A PNG's first bytes, then something of this run's own, so that two tests never send the same
// file by chance.
const aFile = (text: string) =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(text)]);

const sha256Of = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

const asking = (call: Call, input: Fields) =>
  Effect.map(call("request_upload_link", { kind: "receipt", ...input }), (answer) => {
    expect(answer.refused).toBeUndefined();
    return answer.link as string;
  });

// A file posted the way the page posts it.
const posting = (
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

// What the Worker answers to a POST that says it is this long, before any of the body is sent.
// The Worker turns away one that is too long from its headers alone.
const answerToLength = (link: string, length: number) =>
  new Promise<number>((resolve, reject) => {
    const sending = httpRequest(link, {
      method: "POST",
      headers: {
        "content-type": "image/png",
        "content-length": String(length),
        "x-content-sha256": "0".repeat(64),
      },
    });
    sending.on("response", (response) => {
      resolve(response.statusCode ?? 0);
      response.resume();
      sending.destroy();
    });
    sending.on("error", reject);
    sending.flushHeaders();
  });

// Asks the FILES bucket through the S3 endpoint Alchemy's local runtime serves for it, with the
// fixed key that guards it on this machine (`LocalS3.ts` in Alchemy). `path` follows the
// bucket's name.
const askFiles = (path: string) =>
  Effect.flatMap(stack, ({ url, filesBucket }) =>
    Effect.promise(() =>
      new AwsClient({
        accessKeyId: "alchemy-local-r2",
        secretAccessKey: "alchemy-local-r2-secret",
        service: "s3",
        region: "auto",
      }).fetch(`${url}/cdn-cgi/local/r2/s3/${filesBucket}${path}`),
    ),
  );

// The bytes stored under a key, or the status the bucket answered with when there are none.
const storedObject = (key: string) =>
  Effect.flatMap(askFiles(`/${key}`), (response) =>
    Effect.promise(async () =>
      response.ok ? Buffer.from(await response.arrayBuffer()) : response.status,
    ),
  );

// The time a ULID starts with, in Crockford's base 32, for a time in milliseconds.
const ulidTime = (time: number) => {
  const digits = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let text = "";
  for (let left = time, at = 0; at < 10; at++, left = Math.floor(left / 32)) {
    text = digits[left % 32]! + text;
  }
  return text;
};

// The keys stored since a time. A key is a Document's id, a ULID, so the keys after the time's
// own prefix were written since. These tests run one file at a time, and no other file
// stores a file.
const keysSince = (time: number) =>
  Effect.flatMap(askFiles(`?list-type=2&start-after=${ulidTime(time)}`), (response) =>
    Effect.promise(async () =>
      [...(await response.text()).matchAll(/<Key>([^<]+)<\/Key>/g)].map(([, key]) => key),
    ),
  );

const documentNamed = (call: Call, title: string) =>
  Effect.map(
    call("query", {
      sql: `SELECT id, status, r2_key, sha256, mime_type, size_bytes,
                   (SELECT count(*) FROM document_links WHERE document_id = documents.id) AS attached
              FROM documents WHERE title = '${title}'`,
    }),
    (answer) => answer.rows as Fields[],
  );

test(
  "the link opens a page that shows the request, with what the model gave it shown as text",
  asClient((call) =>
    Effect.gen(function* () {
      const link = yield* asking(call, {
        title: "Upload test <script>alert(1)</script>",
        attach_to: [{ type: "item", id: "seed-item-fridge" }],
      });

      const page = yield* Effect.promise(() => fetch(link));
      const body = yield* Effect.promise(() => page.text());

      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(body).toContain("Upload test &lt;script&gt;alert(1)&lt;/script&gt;");
      expect(body).not.toContain("<script>alert(1)");
      expect(body).toContain("Item &quot;Fridge&quot;");
      expect(body).toContain("the receipt");
      expect(body).toContain('type="file"');
    }),
  ),
);

test(
  "a file posted to the link is streamed to R2 under its Document's id, and written in one Change",
  asClient((call) =>
    Effect.gen(function* () {
      const link = yield* asking(call, {
        title: "Upload test fridge receipt",
        vendor: "Upload test store",
        total: 49.99,
        attach_to: [{ type: "item", id: "seed-item-fridge" }],
      });
      const bytes = aFile(`fridge ${Date.now()}`);

      const posted = yield* Effect.promise(() => posting(link, bytes));

      expect(posted.status).toBe(200);
      const { document_id, change_id } = posted.body as { document_id: string; change_id: string };
      const [document] = yield* documentNamed(call, "Upload test fridge receipt");
      expect(document).toEqual({
        id: document_id,
        status: "filed",
        r2_key: document_id,
        sha256: sha256Of(bytes),
        mime_type: "image/png",
        size_bytes: bytes.length,
        attached: 1,
      });
      expect(yield* storedObject(document_id)).toEqual(bytes);
      const fridge = yield* call("get_record", { type: "item", id: "seed-item-fridge" });
      expect(fridge.documents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: document_id, vendor: "Upload test store" }),
        ]),
      );
      const record = yield* call("get_record", { type: "document", id: document_id });
      expect((record.changes as Fields[])[0]).toEqual(
        expect.objectContaining({ id: change_id, tool: "request_upload_link" }),
      );

      // Undoing the Change takes the Document out, and its file stays where it is.
      const undone = yield* call("undo", { change_id });
      expect(undone.refused).toBeUndefined();
      expect(yield* documentNamed(call, "Upload test fridge receipt")).toEqual([]);
      expect(yield* storedObject(document_id)).toEqual(bytes);
      yield* call("undo", { change_id: undone.change_id });
      expect(yield* documentNamed(call, "Upload test fridge receipt")).toHaveLength(1);
    }),
  ),
);

test(
  "the same file on two links is stored once, and attached to the records of both",
  asClient((call) =>
    Effect.gen(function* () {
      const since = Date.now() - 1;
      const bytes = aFile(`twice ${Date.now()}`);
      const first = yield* asking(call, {
        title: "Upload test twice",
        attach_to: [{ type: "item", id: "seed-item-fridge" }],
      });
      const second = yield* asking(call, {
        title: "Upload test twice, again",
        attach_to: [{ type: "vendor", id: "seed-vendor-filter-depot" }],
      });

      const one = yield* Effect.promise(() => posting(first, bytes));
      const two = yield* Effect.promise(() => posting(second, bytes));

      expect(two.body.document_id).toBe(one.body.document_id);
      expect(yield* keysSince(since)).toEqual([one.body.document_id]);
      const [document] = yield* documentNamed(call, "Upload test twice");
      expect(document).toEqual(expect.objectContaining({ attached: 2 }));
      expect(yield* documentNamed(call, "Upload test twice, again")).toEqual([]);
    }),
  ),
);

test(
  "one link takes several files, each a Document of its own",
  asClient((call) =>
    Effect.gen(function* () {
      const link = yield* asking(call, { title: "Upload test pages" });

      const one = yield* Effect.promise(() => posting(link, aFile(`page 1 ${Date.now()}`)));
      const two = yield* Effect.promise(() => posting(link, aFile(`page 2 ${Date.now()}`)));

      expect([one.status, two.status]).toEqual([200, 200]);
      expect(one.body.document_id).not.toBe(two.body.document_id);
      const documents = yield* documentNamed(call, "Upload test pages");
      expect(documents.map(({ status }) => status)).toEqual(["pending", "pending"]);
    }),
  ),
);

test(
  "a link that was changed, and a file that is too big, of a type a Document is not, or does not match its hash, are turned away with nothing stored",
  asClient((call) =>
    Effect.gen(function* () {
      const since = Date.now() - 1;
      const link = yield* asking(call, { title: "Upload test refused" });
      const bytes = aFile(`refused ${Date.now()}`);

      const changed = new URL(link);
      changed.searchParams.set("until", String(Date.now() + 60 * 60 * 1000));
      const tampered = yield* Effect.promise(() => posting(changed.toString(), bytes));
      expect(tampered.status).toBe(403);
      const page = yield* Effect.promise(() => fetch(changed));
      expect(page.status).toBe(403);
      expect(yield* Effect.promise(() => page.text())).toContain("not a link Attic made");

      expect(yield* Effect.promise(() => answerToLength(link, 25 * 1024 * 1024 + 1))).toBe(413);
      const svg = yield* Effect.promise(() =>
        posting(link, bytes, { "content-type": "image/svg+xml" }),
      );
      expect(svg).toEqual({
        status: 415,
        body: { error: expect.stringContaining("image or a PDF") },
      });
      const noHash = yield* Effect.promise(() =>
        posting(link, bytes, { "x-content-sha256": "abc" }),
      );
      expect(noHash.body.error).toContain("x-content-sha256");
      const wrongHash = yield* Effect.promise(() =>
        posting(link, bytes, { "x-content-sha256": sha256Of(Buffer.from("other")) }),
      );
      expect(wrongHash).toEqual({
        status: 400,
        body: { error: expect.stringContaining("does not match the SHA-256") },
      });

      expect(yield* documentNamed(call, "Upload test refused")).toEqual([]);
      expect(yield* keysSince(since)).toEqual([]);
    }),
  ),
);

test(
  "a file for a record that was deleted after the link was made is turned away by name",
  asClient((call) =>
    Effect.gen(function* () {
      const saved = yield* call("save_vendor", { name: "Upload test gone vendor" });
      const vendorId = (saved.record as Fields).id as string;
      const link = yield* asking(call, {
        title: "Upload test gone",
        attach_to: [{ type: "vendor", id: vendorId }],
      });
      yield* call("delete_record", { type: "vendor", id: vendorId });

      const posted = yield* Effect.promise(() => posting(link, aFile(`gone ${Date.now()}`)));

      expect(posted.status).toBe(400);
      expect(posted.body.error).toContain(`the Vendor with the id "${vendorId}" was deleted`);
      expect(yield* documentNamed(call, "Upload test gone")).toEqual([]);
    }),
  ),
);

// A request that has run out is one whose time in the table has passed. The signature in the
// link holds for 15 minutes, so the test moves the request's time back instead of waiting.
test(
  "a link whose request has run out gets a page that says so, and takes no file",
  asClient((call) =>
    Effect.gen(function* () {
      const since = Date.now() - 1;
      const link = yield* asking(call, { title: "Upload test ran out" });
      yield* onDatabase(
        `UPDATE upload_requests SET until = 0
          WHERE json_extract(request, '$.title') = 'Upload test ran out'`,
      );

      const page = yield* Effect.promise(() => fetch(link));
      expect(page.status).toBe(410);
      expect(yield* Effect.promise(() => page.text())).toContain("run out");
      const posted = yield* Effect.promise(() => posting(link, aFile(`ran out ${Date.now()}`)));
      expect(posted).toEqual({ status: 400, body: { error: expect.stringContaining("run out") } });
      expect(yield* keysSince(since)).toEqual([]);

      // Asking for a link lets go of the requests that have run out.
      yield* asking(call, { title: "Upload test after" });
      const left = yield* call("query", {
        sql: `SELECT json_extract(request, '$.title') AS title FROM upload_requests
               WHERE json_extract(request, '$.title') LIKE 'Upload test%'`,
      });
      expect(left.rows).toEqual([{ title: "Upload test after" }]);
    }),
  ),
);
