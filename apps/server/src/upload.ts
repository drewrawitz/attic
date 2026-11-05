import {
  checkSignature,
  FILE_TYPES,
  MOST_FILE_BYTES,
  MOST_FILE_MEGABYTES,
  receiveFile,
  shownRequest,
  ToolError,
  UPLOAD_LINK_RAN_OUT,
  type ArrivedFile,
} from "@attic/core";
import { Effect } from "effect";
import type { WorkerEnv } from "../../../alchemy.run.ts";
import { escapeHtml, page } from "./consent-page.ts";
import { UPLOAD_PATH } from "./routes.ts";
import { html, json, linkPaths, readForPage, turnedAway, unexpectedPage } from "./signed-link.ts";
import { toolServices } from "./tool-services.ts";

// The link `request_upload_link` makes, which the User taps to put a file in Attic (ADR 0008).
// GET is the page, and POST takes one file.

// The types a Document's file can be, and each type by the ending of a file name, for a file
// the browser gives no type.
const TYPES = Object.keys(FILE_TYPES);
const BY_ENDING = Object.fromEntries(
  Object.entries(FILE_TYPES).flatMap(([type, endings]) => endings.map((ending) => [ending, type])),
);

const TOO_BIG = `A file can be up to ${MOST_FILE_MEGABYTES} MB.`;

// The header a file's SHA-256 comes in, worked out by whoever sends it, so the Worker never
// hashes a file (ADR 0012). R2 checks the bytes against it.
const SHA256_HEADER = "x-content-sha256";

// The paths this answers: the upload path, then a request id.
const UPLOAD_PATHS = linkPaths(UPLOAD_PATH);

/** Whether a path is one this answers. */
export const isUploadPath = UPLOAD_PATHS.is;

// The page that takes the files. The page sends each one on its own, with its SHA-256, to the
// address it was opened at, which has the signature in it. File names are put on the page as
// text, never as markup.
const uploadPage = (shown: { title: string; kind: string; attach_to: ReadonlyArray<string> }) => {
  const onto =
    shown.attach_to.length === 0
      ? "It is attached to nothing yet."
      : `It goes on: ${shown.attach_to.map(escapeHtml).join(", ")}.`;
  return page(
    "Add a file to Attic",
    `<h1>Add a file to Attic</h1>
<p>Each file you pick becomes a Document: the ${escapeHtml(shown.kind)} "${escapeHtml(shown.title)}". ${onto}</p>
<p><input type="file" id="files" multiple accept="${TYPES.join(",")}"></p>
<ul id="sent"></ul>
<script>
const MOST_BYTES = ${MOST_FILE_BYTES};
const BY_ENDING = ${JSON.stringify(BY_ENDING)};
const hex = (bytes) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const files = document.getElementById("files");
const sent = document.getElementById("sent");
files.addEventListener("change", async () => {
  for (const file of [...files.files]) {
    const line = document.createElement("li");
    const say = (what) => { line.textContent = file.name + ": " + what; };
    sent.append(line);
    if (file.size > MOST_BYTES) { say("too big. ${TOO_BIG}"); continue; }
    say("sending");
    try {
      const type = file.type || BY_ENDING[file.name.split(".").pop().toLowerCase()] || "";
      const sha256 = hex(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
      const response = await fetch(location.href, {
        method: "POST",
        headers: { "content-type": type, "${SHA256_HEADER}": sha256 },
        body: file,
      });
      const answer = await response.json();
      say(response.ok ? "in Attic" : answer.error);
    } catch (error) {
      say("did not send. " + error.message);
    }
  }
  files.value = "";
});
</script>`,
  );
};

// Stores the body of a request under a key, with R2 checking it against its SHA-256. R2 refuses
// one that does not match with its error 10037, which is the sender's to fix. Any other
// failure is nobody's plan, and is logged.
const storing = (env: WorkerEnv, request: Request, file: ArrivedFile) => (key: string) =>
  Effect.tryPromise({
    try: () =>
      env.FILES.put(key, request.body, {
        sha256: file.sha256,
        httpMetadata: { contentType: file.mimeType },
      }),
    catch: (cause) => cause,
  }).pipe(
    Effect.asVoid,
    Effect.catch((cause) =>
      /did not match|10037/.test(String(cause))
        ? Effect.fail(
            new ToolError({
              message: `The file that arrived does not match the SHA-256 in ${SHA256_HEADER}, so nothing was stored. Send it again.`,
            }),
          )
        : Effect.die(cause),
    ),
  );

// A file that is turned away before anything is read, with the status that says why.
interface NotTaken {
  readonly status: number;
  readonly error: string;
}

// What a file that is sent has to come with, before anything is read: its length, a type a
// Document can be, and its SHA-256.
const fileOf = (request: Request): ArrivedFile | NotTaken => {
  const length = Number(request.headers.get("content-length"));
  if (request.body === null || !Number.isSafeInteger(length) || length <= 0) {
    return { status: 411, error: "Send the file as the body, with its length in content-length." };
  }
  if (length > MOST_FILE_BYTES) return { status: 413, error: TOO_BIG };
  const type = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!TYPES.includes(type)) {
    return {
      status: 415,
      error: `A Document is an image or a PDF. content-type was "${type}", and it can be one of: ${TYPES.join(", ")}.`,
    };
  }
  const sha256 = (request.headers.get(SHA256_HEADER) ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    return {
      status: 400,
      error: `Send the file's SHA-256, as 64 hexadecimal characters, in ${SHA256_HEADER}.`,
    };
  }
  return { sha256, mimeType: type, size: length };
};

/** GET and POST at the upload path, with a request id after it. */
export const upload = {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const asPage = request.method === "GET";
    if (!asPage && request.method !== "POST") {
      return new Response("Only GET and POST.", { status: 405, headers: { allow: "GET, POST" } });
    }
    const checked = await checkSignature(env.SIGNING_KEY, url, Date.now());
    if (checked !== "signed") return turnedAway(checked, asPage, UPLOAD_LINK_RAN_OUT);
    const requestId = UPLOAD_PATHS.idIn(url.pathname);

    if (asPage) {
      const shown = await readForPage(
        env,
        url.origin,
        shownRequest(requestId),
        "The upload page could not read its request.",
      );
      if (shown === null) return unexpectedPage();
      return shown === undefined
        ? turnedAway("ran out", true, UPLOAD_LINK_RAN_OUT)
        : html(uploadPage(shown));
    }

    const file = fileOf(request);
    if ("error" in file) return json({ error: file.error }, file.status);
    const arrival = await Effect.runPromise(
      receiveFile(requestId, file, storing(env, request, file), toolServices(env, url.origin)),
    );
    return arrival.ok
      ? json({ document_id: arrival.document_id, change_id: arrival.change_id })
      : json({ error: arrival.refused }, 400);
  },
} satisfies ExportedHandler<WorkerEnv>;
