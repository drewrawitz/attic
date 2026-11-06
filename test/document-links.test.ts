import { expect } from "@effect/vitest";
import { createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";
import * as Effect from "effect/Effect";
import { onDatabase } from "./support/database.ts";
import {
  aFile,
  askFiles,
  asking,
  posting,
  sha256Of,
  stored,
  storedObject,
  ulidTime,
} from "./support/files.ts";
import { SIGNING_KEY, stack, test } from "./support/harness.ts";
import { asClientWith, type Call, type Fields } from "./support/household.ts";

// The links request_upload_link and get_document_link make, tried through the real Worker: the
// upload page, a file posted to it, what local R2 holds then, and the file opened again. What a
// Document is and how it is undone are tested on Node SQLite, in packages/core. These hold what
// only the Worker does: the signature, the limits, the stream into R2 and R2's check of its
// hash, the Change on D1, and the stream back out with its headers.

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

// A link to a Document's file, from get_document_link.
const opening = (call: Call, id: string) =>
  Effect.map(call("get_document_link", { id }), (answer) => {
    expect(answer.refused).toBeUndefined();
    return answer.link as string;
  });

// A link the test signs itself, with the key the Worker signs with in the tests, so that it can
// make one that has run out without waiting 15 minutes. It signs the way SignedAddresses in
// packages/core/src/signed-address.ts does, so a change there shows up here.
const signedLink = (path: string, until: number) =>
  Effect.map(stack, ({ url }) => {
    const signature = createHmac("sha256", SIGNING_KEY)
      .update(`${path}\n${until}`)
      .digest("base64url");
    return `${url}${path}?until=${until}&signature=${signature}`;
  });

// What a link opens: its status, its headers, and its body.
const opened = (link: string) =>
  Effect.promise(async () => {
    const response = await fetch(link);
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: Buffer.from(await response.arrayBuffer()),
    };
  });

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
      expect(body).toContain("Goes on Item &quot;Fridge&quot;.");
      expect(body).toContain(">Receipt<");
      expect(body).toContain('type="file"');
      expect(body).toContain("Choose a photo or file");
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

test(
  "a link from get_document_link opens the file that was stored, shown under its title",
  asClient((call) =>
    Effect.gen(function* () {
      const bytes = aFile(`opened ${Date.now()}`);
      const id = yield* stored(call, bytes, { title: 'Upload test Café "receipt" \\ 50%' });

      const file = yield* opened(yield* opening(call, id));

      expect(file.status).toBe(200);
      expect(file.body).toEqual(bytes);
      expect(file.headers).toEqual(
        expect.objectContaining({
          "content-type": "image/png",
          "content-disposition": `inline; filename="Upload test Cafe _receipt_ _ 50_.png"; filename*=UTF-8''Upload%20test%20Caf%C3%A9%20%22receipt%22%20%5C%2050%25.png`,
          "x-content-type-options": "nosniff",
          "cache-control": "private",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        }),
      );

      const pdf = Buffer.from(`%PDF-1.4\n% Upload test ${Date.now()}\n%%EOF\n`);
      const manual = yield* stored(
        call,
        pdf,
        { title: "Upload test manual.PDF", kind: "manual" },
        "application/pdf",
      );
      const manualFile = yield* opened(yield* opening(call, manual));
      expect(manualFile.body).toEqual(pdf);
      expect(manualFile.headers).toEqual(
        expect.objectContaining({
          "content-type": "application/pdf",
          "content-security-policy": "sandbox",
          "content-disposition": `inline; filename="Upload test manual.PDF"; filename*=UTF-8''Upload%20test%20manual.PDF`,
        }),
      );

      // Some systems call a HEIC photo HEIF, so its HEIC ending is kept, and no other is added.
      const photo = yield* stored(
        call,
        aFile(`photo ${Date.now()}`),
        { title: "Upload test IMG_1234.HEIC", kind: "photo" },
        "image/heif",
      );
      const photoFile = yield* opened(yield* opening(call, photo));
      expect(photoFile.headers["content-disposition"]).toBe(
        `inline; filename="Upload test IMG_1234.HEIC"; filename*=UTF-8''Upload%20test%20IMG_1234.HEIC`,
      );
    }),
  ),
);

test(
  "a link to a file that was changed, has run out, or was made for an upload is turned away",
  asClient((call) =>
    Effect.gen(function* () {
      const id = yield* stored(call, aFile(`turned away ${Date.now()}`), {
        title: "Upload test turned away",
      });
      const path = `/document/${id}`;

      // The key and the path are right, so only the time turns the second one away.
      expect((yield* opened(yield* signedLink(path, Date.now() + 60_000))).status).toBe(200);
      const ranOut = yield* opened(yield* signedLink(path, Date.now() - 1));
      expect(ranOut.status).toBe(410);
      expect(ranOut.body.toString()).toContain("run out");
      expect(ranOut.body.toString()).not.toContain("pick the file");

      const changed = new URL(yield* opening(call, id));
      changed.searchParams.set("until", String(Date.now() + 60 * 60 * 1000));
      const tampered = yield* opened(changed.toString());
      expect(tampered.status).toBe(403);
      expect(tampered.body.toString()).toContain("not a link Attic made");

      // An upload link's signature holds for its own path only.
      const upload = new URL(yield* asking(call, { title: "Upload test not a file" }));
      upload.pathname = `/document/${upload.pathname.split("/").at(-1)}`;
      expect((yield* opened(upload.toString())).status).toBe(403);
    }),
  ),
);

test(
  "a Document with no file in the bucket, or no longer in Attic, gets a 404 that says so",
  asClient((call) =>
    Effect.gen(function* () {
      // No file sits behind the made-up household's Documents.
      const missing = yield* opened(yield* opening(call, "seed-doc-faucet-receipt"));
      expect(missing.status).toBe(404);
      expect(missing.body.toString()).toBe("The file of this Document is not in Attic's bucket.");

      const gone = yield* opened(
        yield* signedLink("/document/no-such-document", Date.now() + 60_000),
      );
      expect(gone.status).toBe(404);
      expect(gone.body.toString()).toBe("This Document is not in Attic now.");

      const refused = yield* call("get_document_link", { id: "no-such-document" });
      expect(refused.refused).toContain('There is no Document with the id "no-such-document".');
    }),
  ),
);
