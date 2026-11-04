import { Clock, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { nameInTable, SHAPES, term, type Listed } from "./records.ts";
import { insertRow, runSave, updatedNow, type SaveStep } from "./save.ts";
import { SIGNED_FOR_MINUTES } from "./signed-address.ts";
import { callAs, ToolError, type ToolServices } from "./tool.ts";
import { vendorOrNew } from "./vendor.ts";
import { Ids } from "./write.ts";

// A Document goes into Attic through a link the User opens (ADR 0008). `request_upload_link`
// keeps what the model read from the file, and the Document is made when the file arrives.

/** The kinds of Document there are, as the `documents` table has them. */
export const KINDS = ["photo", "receipt", "quote", "manual", "warranty", "other"] as const;

export type Kind = (typeof KINDS)[number];

/**
 * The types a Document's file can be, each with the endings of a file name that has it: images
 * and PDFs. HEIF is the name some systems give a HEIC photo. Not SVG, which is a page that can
 * run script, and a Document's file is to be opened from Attic's own address.
 */
export const FILE_TYPES: Readonly<Record<string, ReadonlyArray<string>>> = {
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/webp": ["webp"],
  "image/heic": ["heic"],
  "image/heif": ["heif"],
  "image/gif": ["gif"],
  "application/pdf": ["pdf"],
};

/** The most a file can be, in megabytes, and in bytes. */
export const MOST_FILE_MEGABYTES = 25;
export const MOST_FILE_BYTES = MOST_FILE_MEGABYTES * 1024 * 1024;

// The one set of a Document: the records it is attached to.
const ATTACHED = SHAPES.document.links[0];

/** The types of record a Document can be attached to. */
export const ATTACHABLE = ATTACHED.of;

export type AttachableType = (typeof ATTACHABLE)[number];

/** A record a Document is attached to, by its type and its id. */
export interface AttachedTo {
  readonly type: AttachableType;
  readonly id: string;
}

/** Where the Worker takes a file: this, then the id of the request. */
export const UPLOAD_PATH = "/upload";

/** The path of the page and the address a file is posted to, for one request. */
export const uploadPath = (requestId: string) => `${UPLOAD_PATH}/${requestId}`;

/** What a link that has run out says, to the User on the page and to a client that posts. */
export const LINK_RAN_OUT = `This link has run out. Links last ${SIGNED_FOR_MINUTES} minutes. Ask for a new one, and pick the file again.`;

/**
 * What a request holds until its link runs out: what the Document will say, and where it will
 * be. A Vendor is kept by name, and is created when the file arrives if it is not there then.
 */
export interface UploadRequest {
  readonly title: string;
  readonly kind: Kind;
  readonly doc_date?: string;
  readonly total_cents?: number;
  readonly vendor?: string;
  readonly text?: string;
  readonly attach_to: ReadonlyArray<AttachedTo>;
  readonly property_id: string | null;
}

// The records a list asks for, each with the name it has now, or null when it is not there.
// A Document can be attached to six types, and D1 takes at most five SELECTs in one UNION
// (ADR 0006), so the name is found by a CASE over the type.
const ATTACHED_TO_NOW = (() => {
  const type = "json_extract(wanted.value, '$.type')";
  const id = "json_extract(wanted.value, '$.id')";
  const names = ATTACHABLE.map((each) => `WHEN '${each}' THEN ${nameInTable(each, id)}`);
  return `SELECT ${type} AS type, ${id} AS id, CASE ${type} ${names.join(" ")} END AS name
            FROM json_each(?) AS wanted
           ORDER BY wanted.key`;
})();

/** Each record among these once, with its name, or null for one that is not there now. */
export const attachedToNow = Effect.fnUntraced(function* (wanted: ReadonlyArray<AttachedTo>) {
  const sql = yield* SqlClient.SqlClient;
  const once = [...new Map(wanted.map((each) => [`${each.type} ${each.id}`, each])).values()];
  if (once.length === 0) return [];
  return yield* sql.unsafe<{ type: AttachableType; id: string; name: string | null }>(
    ATTACHED_TO_NOW,
    [JSON.stringify(once)],
  );
});

/** The request with this id, while its link still works. */
export const uploadRequest = Effect.fnUntraced(function* (requestId: string) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  const [row] = yield* sql<{ request: string }>`
    SELECT request FROM upload_requests WHERE id = ${requestId} AND until > ${now}`;
  return row === undefined ? undefined : (JSON.parse(row.request) as UploadRequest);
});

/**
 * Keeps a request until its link runs out, and lets go of the ones that have. It is the one
 * thing `request_upload_link` writes, and it is no record, so no Change has it.
 */
export const keepUploadRequest = Effect.fnUntraced(function* (
  requestId: string,
  request: UploadRequest,
  until: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  yield* sql`DELETE FROM upload_requests WHERE until <= ${now}`;
  yield* sql`
    INSERT INTO upload_requests (id, request, until)
    VALUES (${requestId}, ${JSON.stringify(request)}, ${until})`;
});

/** What the upload page shows of a request: what the Document is, and what it goes on. */
export const shownRequest = Effect.fnUntraced(function* (requestId: string) {
  const request = yield* uploadRequest(requestId);
  if (request === undefined) return undefined;
  const attached = yield* attachedToNow(request.attach_to);
  return {
    title: request.title,
    kind: request.kind,
    attach_to: attached.map(({ type, name }) => `${term(type)} "${name ?? "not there now"}"`),
  };
});

/** A file as it arrived: its SHA-256 as the sender worked it out, its type, and its size. */
export interface ArrivedFile {
  readonly sha256: string;
  readonly mimeType: string;
  readonly size: number;
}

// The statement that attaches a Document to each record in a JSON list, keeping one it is
// attached to already once.
const ATTACHING = `
  INSERT OR IGNORE INTO ${ATTACHED.table} (${ATTACHED.from}, ${ATTACHED.typeColumn}, ${ATTACHED.to})
  SELECT ?, json_extract(value, '$.type'), json_extract(value, '$.id') FROM json_each(?)`;

// What a request names that is not there now: each record it is to be attached to that was
// deleted, and its Property, which an undo can take out. Each is said as an error says it.
const goneSince = Effect.fnUntraced(function* (request: UploadRequest) {
  const sql = yield* SqlClient.SqlClient;
  const attached = yield* attachedToNow(request.attach_to);
  const records = attached
    .filter(({ name }) => name === null)
    .map(({ type, id }) => `the ${term(type)} with the id "${id}"`);
  if (request.property_id === null) return records;
  const [property] = yield* sql`SELECT id FROM properties WHERE id = ${request.property_id}`;
  return property === undefined
    ? [...records, `the Property with the id "${request.property_id}"`]
    : records;
});

/**
 * Makes the Document a file that arrived is, from the request it arrived for. Reads come
 * first. Then `store` puts the bytes in the bucket under the key it is given, and only then is
 * the Document written, as one Change: a file that could not be stored leaves no Document. A
 * file Attic has already, by its hash, is not stored again: its Document is attached to the
 * request's records too. What comes back is the Document's id, and the id of the Change, which
 * is null when the file was there already with all of those.
 */
const receiving = Effect.fnUntraced(function* (
  requestId: string,
  file: ArrivedFile,
  store: (key: string) => Effect.Effect<void, ToolError>,
) {
  const sql = yield* SqlClient.SqlClient;
  const request = yield* uploadRequest(requestId);
  if (request === undefined) return yield* new ToolError({ message: LINK_RAN_OUT });

  // A record can be deleted in the minutes the link lasts.
  const gone = yield* goneSince(request);
  if (gone.length > 0) {
    return yield* new ToolError({
      message: `Nothing was stored, because ${gone.join(", ")} was deleted after this link was made. Ask for a new link.`,
    });
  }
  const records = request.attach_to;

  const [had] = yield* sql<{ id: string; title: string; attached_to: string }>`
    SELECT document.id, document.title,
           (SELECT json_group_array(json_object('type', entity_type, 'id', entity_id))
              FROM document_links WHERE document_id = document.id) AS attached_to
      FROM documents AS document
     WHERE document.sha256 = ${file.sha256}`;

  if (had !== undefined) {
    const known = new Set(
      (JSON.parse(had.attached_to) as AttachedTo[]).map(({ type, id }) => `${type} ${id}`),
    );
    const more = records.filter(({ type, id }) => !known.has(`${type} ${id}`));
    if (more.length === 0) return { document_id: had.id, change_id: null };
    const document: Listed = { type: "document", id: had.id, name: had.title };
    const steps: ReadonlyArray<SaveStep> = [
      sql.unsafe(ATTACHING, [had.id, JSON.stringify(more)]),
      // A Document is `filed` once it is attached to a record.
      sql.unsafe(
        `UPDATE documents
            SET ${["status = CASE status WHEN 'pending' THEN 'filed' ELSE status END", ...updatedNow(SHAPES.document)].join(", ")}
          WHERE id = ?`,
        [had.id],
      ),
    ].map((statement) => ({ ...document, created: false, statement }));
    const saved = yield* runSave(steps);
    return { document_id: had.id, change_id: saved.change_id };
  }

  // A key starts with a ULID, so keys sort by when they were written. The Document's own id
  // is one.
  const id = yield* (yield* Ids).next;
  const vendor = request.vendor === undefined ? undefined : yield* vendorOrNew(request.vendor);
  yield* store(id);

  const document: Listed = { type: "document", id, name: request.title };
  const row = insertRow(sql, document, {
    property_id: request.property_id,
    status: records.length > 0 ? "filed" : "pending",
    kind: request.kind,
    title: request.title,
    doc_date: request.doc_date ?? null,
    total_cents: request.total_cents ?? null,
    vendor_id: vendor?.id ?? null,
    source: "upload",
    r2_key: id,
    mime_type: file.mimeType,
    size_bytes: file.size,
    sha256: file.sha256,
    text: request.text ?? null,
  });
  const attaching: ReadonlyArray<SaveStep> =
    records.length === 0
      ? []
      : [{ ...row, statement: sql.unsafe(ATTACHING, [id, JSON.stringify(records)]) }];
  const saved = yield* runSave([...(vendor?.steps ?? []), row, ...attaching]);
  return { document_id: id, change_id: saved.change_id };
});

/** How a file that arrived ended: the Document it is, or why nothing was stored. */
export type Arrival =
  | { readonly ok: true; readonly document_id: string; readonly change_id: string | null }
  | { readonly ok: false; readonly refused: string };

// The tool whose Change a file that arrives is. It is the tool that asked for the link.
const REQUESTED_BY = "request_upload_link";

/**
 * Makes a Document of a file that arrived, on what a tool runs on, and says how it ended. A
 * refusal is the message the sender is shown. Anything nobody planned for is logged, and the
 * sender is told only that there was a failure, as a client is by `callTool`.
 */
export const receiveFile = (
  requestId: string,
  file: ArrivedFile,
  store: (key: string) => Effect.Effect<void, ToolError>,
  services: Layer.Layer<ToolServices, unknown>,
): Effect.Effect<Arrival> =>
  Effect.map(
    callAs(REQUESTED_BY, receiving(requestId, file, store), services),
    ({ text, isError }): Arrival =>
      isError ? { ok: false, refused: text } : { ok: true, ...JSON.parse(text) },
  );
