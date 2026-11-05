import { Clock, Effect } from "effect";
import { SqlClient } from "effect/sql";
import { nameInTable, SHAPES, term, type Listed } from "./records.ts";
import { insertRow, runSave, updatedNow, type SaveStep } from "./save.ts";
import { LINK_RAN_OUT } from "./signed-address.ts";
import { ToolError } from "./tool.ts";
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

// The set of a Document that holds the records it is attached to.
const ATTACHED = (() => {
  const set = SHAPES.document.links.find(({ name }) => name === "attached_to");
  if (set === undefined) throw new Error("records.ts gives a Document no attached_to set.");
  return set;
})();

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

/** What an upload link that has run out says: the file has to be picked again on a new one. */
export const UPLOAD_LINK_RAN_OUT = `${LINK_RAN_OUT} Then pick the file again.`;

/** Where the Worker serves a Document's file: this, then the Document's id. */
export const DOCUMENT_PATH = "/document";

/** The path a Document's file is opened at. */
export const documentPath = (documentId: string) => `${DOCUMENT_PATH}/${documentId}`;

/**
 * A Document as a link to its file needs it: what to say of it, and the key its file is under
 * in the bucket. Only an upload makes a Document today, and it sets each of these. A Document
 * from before may lack its title, its type, or its size.
 */
export interface DocumentToOpen {
  readonly title: string | null;
  readonly kind: Kind;
  readonly mime_type: string | null;
  readonly size_bytes: number | null;
  readonly r2_key: string;
}

/** The Document with this id, as a link to its file needs it, or undefined when there is none. */
export const documentToOpen = Effect.fnUntraced(function* (documentId: string) {
  const sql = yield* SqlClient.SqlClient;
  const [found] = yield* sql<DocumentToOpen>`
    SELECT title, kind, mime_type, size_bytes, r2_key FROM documents WHERE id = ${documentId}`;
  return found;
});

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

// What a request can say of a file that the Document of the same file may not say yet. A
// Vendor is said by name, and is filled in apart.
const FILLED_IN = ["doc_date", "total_cents", "text"] as const;

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
 * file Attic has already, by its hash, is not stored again. Its Document is attached to the
 * request's records too, and gets what the request says that it does not say yet. What it
 * says already stays, since it was read from the same file. What comes back is the Document's
 * id, and the id of the Change, which is null when the Document had all of that already.
 */
export const documentFrom = Effect.fnUntraced(function* (
  requestId: string,
  file: ArrivedFile,
  store: (key: string) => Effect.Effect<void, ToolError>,
) {
  const sql = yield* SqlClient.SqlClient;
  const request = yield* uploadRequest(requestId);
  if (request === undefined) return yield* new ToolError({ message: UPLOAD_LINK_RAN_OUT });

  // A record can be deleted in the minutes the link lasts.
  const gone = yield* goneSince(request);
  if (gone.length > 0) {
    return yield* new ToolError({
      message: `Nothing was stored, because ${gone.join(", ")} was deleted after this link was made. Ask for a new link.`,
    });
  }
  const records = request.attach_to;

  const [had] = yield* sql<{
    id: string;
    title: string;
    doc_date: string | null;
    total_cents: number | null;
    vendor_id: string | null;
    text: string | null;
    attached_to: string;
  }>`
    SELECT document.id, document.title, document.doc_date, document.total_cents,
           document.vendor_id, document.text,
           (SELECT json_group_array(json_object('type', entity_type, 'id', entity_id))
              FROM document_links WHERE document_id = document.id) AS attached_to
      FROM documents AS document
     WHERE document.sha256 = ${file.sha256}`;

  if (had !== undefined) {
    const known = new Set(
      (JSON.parse(had.attached_to) as AttachedTo[]).map(({ type, id }) => `${type} ${id}`),
    );
    const more = records.filter(({ type, id }) => !known.has(`${type} ${id}`));
    const empty = FILLED_IN.filter(
      (column) => had[column] === null && request[column] !== undefined,
    );
    const vendor =
      had.vendor_id === null && request.vendor !== undefined
        ? yield* vendorOrNew(request.vendor)
        : undefined;
    if (more.length === 0 && empty.length === 0 && vendor === undefined) {
      return { document_id: had.id, change_id: null };
    }

    const filled = [
      ...empty.map((column) => [column, request[column]] as const),
      ...(vendor === undefined ? [] : [["vendor_id", vendor.id] as const]),
    ];
    const set = [
      ...filled.map(([column]) => `${column} = ?`),
      // A Document is `filed` once it is attached to a record.
      ...(more.length === 0
        ? []
        : ["status = CASE status WHEN 'pending' THEN 'filed' ELSE status END"]),
      ...updatedNow(SHAPES.document),
    ];
    const document: Listed = { type: "document", id: had.id, name: had.title };
    const steps: ReadonlyArray<SaveStep> = [
      ...(more.length === 0 ? [] : [sql.unsafe(ATTACHING, [had.id, JSON.stringify(more)])]),
      sql.unsafe(`UPDATE documents SET ${set.join(", ")} WHERE id = ?`, [
        ...filled.map(([, value]) => value),
        had.id,
      ]),
    ].map((statement) => ({ ...document, created: false, statement }));
    const saved = yield* runSave([...(vendor?.steps ?? []), ...steps]);
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
