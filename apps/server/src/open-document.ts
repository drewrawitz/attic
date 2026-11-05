import { checkSignature, documentToOpen, FILE_TYPES, type DocumentToOpen } from "@attic/core";
import type { WorkerEnv } from "../../../alchemy.run.ts";
import { DOCUMENT_PATH } from "./routes.ts";
import { linkPaths, readForPage, turnedAway, unexpectedPage } from "./signed-link.ts";

// The link `get_document_link` makes, which the User taps to open a Document's file (ADR 0008).
// The file is streamed from the bucket and shown in the browser. It is never sent to a model.

// The paths this answers: the document path, then a Document's id.
const DOCUMENT_PATHS = linkPaths(DOCUMENT_PATH);

/** Whether a path is one this answers. */
export const isDocumentPath = DOCUMENT_PATHS.is;

// What a file is called when its Document has no title.
const UNTITLED = "Document";

// A HEIF file is a HEIC photo under the name some systems give it, so either ending will do for
// either type.
const SAME_FORMAT: Readonly<Record<string, ReadonlyArray<string>>> = {
  "image/heic": ["heif"],
  "image/heif": ["heic"],
};

// The endings a file of this type can have, its own first.
const endingsOf = (type: string) => [...(FILE_TYPES[type] ?? []), ...(SAME_FORMAT[type] ?? [])];

// The name a browser saves a Document's file under: its title, then an ending of its type when
// the title has none of them.
const fileName = ({ title, mime_type }: DocumentToOpen) => {
  const name = (title ?? "").trim() || UNTITLED;
  const endings = mime_type === null ? [] : endingsOf(mime_type);
  const [ending] = endings;
  const hasOne = endings.some((each) => name.toLowerCase().endsWith(`.${each}`));
  return ending === undefined || hasOne ? name : `${name}.${ending}`;
};

// A file name as `filename*` holds it (RFC 8187): UTF-8, with every byte that is not an
// attr-char written as %XX. encodeURIComponent leaves four that are not attr-chars, so those
// are written out too.
const utf8Name = (name: string) =>
  encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

// The same name as `filename` holds it, for a browser that reads only that (RFC 6266, Appendix
// D): letters without their accents, then printable ASCII only. Not a quote or a backslash,
// which would end or escape the quoted name, nor a percent sign, which some read as %XX, nor a
// semicolon, at which WebKit's own reading of the header stops.
const asciiName = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]|["\\%;]/g, "_");

// `content-disposition` for a file shown in the browser, saved under this name.
const shownUnder = (fileName: string) => {
  // A lone half of a surrogate pair cannot be written in UTF-8.
  const name = fileName.toWellFormed().normalize("NFC");
  return `inline; filename="${asciiName(name)}"; filename*=UTF-8''${utf8Name(name)}`;
};

// Should a file turn out to be more than an image, nothing in it may run, load, or send
// anything. It is a second fence: SVG and HTML are never taken in the first place. The browser
// writes the page an image is shown on, and styles it inline, so inline styles are allowed.
const IMAGE_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

// A PDF opens in the browser's own viewer. Chrome and Firefox take every directive but
// frame-ancestors off a PDF's policy, so there the fence is its type, which was checked when
// the file came in, and nosniff. Safari keeps the policy: `sandbox` alone shows a PDF since
// Safari 18.4, and a policy that blocks loading can grey the viewer out (ADR 0008).
const PDF_POLICY = "sandbox";

// The headers a Document's file goes out with.
const headersFor = (document: DocumentToOpen) => {
  const type = document.mime_type ?? "application/octet-stream";
  return new Headers({
    "content-type": type,
    "content-disposition": shownUnder(fileName(document)),
    "x-content-type-options": "nosniff",
    "cache-control": "private",
    "content-security-policy": type === "application/pdf" ? PDF_POLICY : IMAGE_POLICY,
  });
};

const notFound = (message: string) =>
  new Response(message, { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });

/** GET at the document path, with a Document's id after it. */
export const openDocument = {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET") {
      return new Response("Only GET.", { status: 405, headers: { allow: "GET" } });
    }
    const checked = await checkSignature(env.SIGNING_KEY, url, Date.now());
    if (checked !== "signed") return turnedAway(checked, true);
    const documentId = DOCUMENT_PATHS.idIn(url.pathname);

    const document = await readForPage(
      env,
      url.origin,
      documentToOpen(documentId),
      `The Document ${documentId} could not be read.`,
    );
    if (document === null) return unexpectedPage();
    // An undo can take a Document out after its link was made.
    if (document === undefined) return notFound("This Document is not in Attic now.");

    const file = await env.FILES.get(document.r2_key).catch((error: unknown) => {
      console.error(`The file of the Document ${documentId} could not be read from FILES.`, error);
      return undefined;
    });
    if (file === undefined) return unexpectedPage();
    if (file === null) {
      console.error(
        `The file of the Document ${documentId} is not in FILES, under ${document.r2_key}.`,
      );
      return notFound("The file of this Document is not in Attic's bucket.");
    }
    return new Response(file.body, { headers: headersFor(document) });
  },
} satisfies ExportedHandler<WorkerEnv>;
