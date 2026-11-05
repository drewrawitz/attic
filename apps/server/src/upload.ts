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

// What the Worker says when the bytes that arrived are not the ones the SHA-256 was worked out
// from. Sending the file again can work, so the page knows these words and offers to.
const NOT_THE_HASHED_BYTES = `The file that arrived does not match the SHA-256 in ${SHA256_HEADER}, so nothing was stored. Send it again.`;

// The paths this answers: the upload path, then a request id.
const UPLOAD_PATHS = linkPaths(UPLOAD_PATH);

/** Whether a path is one this answers. */
export const isUploadPath = UPLOAD_PATHS.is;

// How the upload page looks. One large button picks the files, and a panel above it says when
// they are all in, so nobody is left wondering whether the page is done.
const UPLOAD_STYLE = `
  [hidden] { display: none !important; }
  h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 1rem; }
  .what { border: 1px solid #d9d9d9; border-radius: 12px; padding: 1rem; margin: 0 0 1rem; }
  .what p { margin: 0; }
  .what .kind { font-size: 0.8125rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: #666; }
  .what .title { font-size: 1.125rem; font-weight: 600; margin: 0.125rem 0 0.375rem; overflow-wrap: anywhere; }
  .what .onto { color: #444; }
  .panel { border-radius: 12px; padding: 1rem; margin: 0 0 1rem; }
  .panel strong { display: block; font-size: 1.125rem; }
  .done { background: #e3f5e9; color: #0d4a2a; }
  .not-all { background: #fdf0dc; color: #5c3b00; }
  .pick { position: relative; display: block; box-sizing: border-box; width: 100%; padding: 0.875rem 1rem; border: 2px solid #1a1a1a; border-radius: 12px; background: #1a1a1a; color: #fff; font-weight: 600; text-align: center; cursor: pointer; }
  .pick input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
  .pick:focus-within { outline: 3px solid #2f6fdb; outline-offset: 2px; }
  .pick.again { background: transparent; color: #1a1a1a; }
  .pick.busy { opacity: 0.55; cursor: default; }
  .pick.busy input { cursor: default; }
  .note { font-size: 0.875rem; color: #666; margin: 0.625rem 0 1.25rem; }
  .sent { list-style: none; margin: 0; padding: 0; }
  .sent li { display: grid; grid-template-columns: 1fr auto; gap: 0.25rem 0.75rem; align-items: center; padding: 0.75rem 0; border-top: 1px solid #e6e6e6; }
  .sent .name { overflow-wrap: anywhere; }
  .sent .size { font-size: 0.875rem; color: #666; }
  .sent .state, .sent progress, .sent button { grid-column: 1 / -1; }
  .sent .state { font-size: 0.9375rem; color: #555; }
  .sent li[data-state="in"] .state { color: #0d6b3a; font-weight: 600; }
  .sent li[data-state="failed"] .state { color: #b3261e; }
  .sent progress { width: 100%; height: 0.5rem; }
  .sent button { justify-self: start; margin: 0.25rem 0 0; }
  .read-out { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }`;

// The page that takes the files. It sends each one on its own, with its SHA-256, to the
// address it was opened at, which has the signature in it, and says for each how far it got.
// What the model gave is put on the page as text, never as markup, and the script is handed
// none of it.
const uploadPage = (shown: { title: string; kind: string; attach_to: ReadonlyArray<string> }) => {
  const onto = shown.attach_to.map(escapeHtml).join(", ");
  const kind = escapeHtml(shown.kind.charAt(0).toUpperCase() + shown.kind.slice(1));
  return page(
    "Add a file to Attic",
    `<h1>Add a file to Attic</h1>
<section class="what" aria-label="What each file becomes">
  <p class="kind">${kind}</p>
  <p class="title">${escapeHtml(shown.title)}</p>
  <p class="onto">${onto === "" ? "Attached to nothing yet." : `Goes on ${onto}.`}</p>
</section>
<div id="done" class="panel done" hidden><strong>Done.</strong> <span id="done-what"></span>${onto === "" ? "" : ` <span id="done-on">It is</span> on ${onto}.`} You can close this page and go back to the chat.</div>
<div id="not-all" class="panel not-all" hidden><strong>Not everything went in.</strong> What went wrong is under each file.</div>
<label class="pick" id="pick"><input type="file" id="files" multiple accept="${TYPES.join(",")}"><span id="pick-text">Choose a photo or file</span></label>
<p class="note">Each file becomes a Document of its own. Images and PDFs, up to ${MOST_FILE_MEGABYTES} MB each. <span id="until"></span></p>
<ul id="sent" class="sent"></ul>
<p id="read-out" class="read-out" role="status"></p>
<script>
const MOST_BYTES = ${MOST_FILE_BYTES};
const BY_ENDING = ${JSON.stringify(BY_ENDING)};
const NOT_THE_HASHED_BYTES = ${JSON.stringify(NOT_THE_HASHED_BYTES)};
const hex = (bytes) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const byId = (id) => document.getElementById(id);
const files = byId("files");
const pick = byId("pick");
const sent = byId("sent");

// The time the link stops working is in the link, and is shown in this device's own time.
const until = Number(new URL(location.href).searchParams.get("until"));
if (until > 0) {
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(until);
  byId("until").textContent = "This link works until " + time + ".";
}

const sizeOf = (bytes) =>
  bytes < 1024 * 1024 ? Math.max(1, Math.round(bytes / 1024)) + " KB" : (bytes / 1024 / 1024).toFixed(1) + " MB";

// Sends one file, and says how much of it has gone. fetch cannot say that, so this is XHR.
// Status 0 is a file that never reached Attic.
const post = (file, type, sha256, sending) =>
  new Promise((resolve) => {
    const request = new XMLHttpRequest();
    request.open("POST", location.href);
    request.setRequestHeader("content-type", type);
    request.setRequestHeader("${SHA256_HEADER}", sha256);
    request.upload.onprogress = (event) => { if (event.lengthComputable) sending(event.loaded / event.total); };
    request.onload = () => {
      let answer = {};
      try { answer = JSON.parse(request.responseText); } catch {}
      resolve({ status: request.status, error: answer.error });
    };
    request.onerror = () => resolve({ status: 0 });
    request.send(file);
  });

// Every file picked on this page, with how far it got.
const rows = [];
// Why the Worker said the link no longer works, in its words, or nothing while it works. A
// link that stopped takes no more files.
let stopped = "";

// Sets the button and the panels from the files: the button waits while any file is on its
// way, and a panel says so once none is. Gives back what that panel says, or nothing.
const showAll = () => {
  const linkWorks = stopped === "";
  const busy = rows.some((row) => ["waiting", "sending", "saving"].includes(row.state));
  const settled = rows.length > 0 && !busy;
  const allIn = settled && rows.every((row) => row.state === "in");
  files.disabled = busy || !linkWorks;
  pick.hidden = !linkWorks;
  byId("until").hidden = !linkWorks;
  pick.classList.toggle("busy", busy);
  pick.classList.toggle("again", settled);
  byId("pick-text").textContent = busy ? "Sending…" : settled ? "Add another file" : "Choose a photo or file";
  for (const row of rows) {
    row.again.disabled = busy;
    if (!linkWorks) row.again.hidden = true;
  }
  byId("done").hidden = !allIn;
  byId("not-all").hidden = !settled || allIn;
  const count = rows.length;
  byId("done-what").textContent =
    count === 1 ? "The file is in Attic." : (count === 2 ? "Both" : "All " + count) + " files are in Attic.";
  // Only there when the files go on something.
  const doneOn = byId("done-on");
  if (doneOn) doneOn.textContent = count === 1 ? "It is" : "They are";
  return allIn ? byId("done").textContent : settled ? byId("not-all").textContent : "";
};

// A file's row, and what sends it.
const rowFor = (file) => {
  const line = document.createElement("li");
  const name = document.createElement("span");
  const size = document.createElement("span");
  const state = document.createElement("span");
  const bar = document.createElement("progress");
  const again = document.createElement("button");
  name.className = "name";
  name.textContent = file.name;
  size.className = "size";
  size.textContent = sizeOf(file.size);
  state.className = "state";
  bar.max = 1;
  bar.setAttribute("aria-label", "How much of " + file.name + " has gone");
  again.type = "button";
  again.textContent = "Try again";
  line.append(name, size, state, bar, again);
  sent.append(line);

  const row = { again };
  rows.push(row);
  // A state that is read out as well as shown, with the panel when there is one. How much has
  // gone is only shown.
  const set = (next, text, { going = false, retry = false } = {}) => {
    row.state = next;
    line.dataset.state = next;
    state.textContent = text;
    bar.hidden = !going;
    again.hidden = !retry;
    const sentence = /[.…]$/.test(text) ? text : text + ".";
    byId("read-out").textContent = (file.name + ": " + sentence + " " + showAll()).trim();
  };
  set("waiting", "Waiting");

  row.send = async () => {
    if (file.size > MOST_BYTES) return set("failed", "Too big. ${TOO_BIG}");
    if (stopped !== "") return set("failed", stopped);
    set("sending", "Getting it ready", { going: true });
    bar.removeAttribute("value");
    try {
      const type = file.type || BY_ENDING[file.name.split(".").pop().toLowerCase()] || "";
      const sha256 = hex(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
      set("sending", "Sending", { going: true });
      bar.value = 0;
      // How much has gone is only shown. Once all of it has, Attic is saving it, and that is
      // read out, once.
      const answer = await post(file, type, sha256, (part) => {
        bar.value = part;
        if (part < 1) state.textContent = "Sending, " + Math.round(part * 100) + "%";
        else if (row.state === "sending") set("saving", "Saving", { going: true });
      });
      if (answer.status === 200) return set("in", "In Attic");
      if (answer.status === 0) {
        return set("failed", "It did not reach Attic. Check the connection, then try again.", { retry: true });
      }
      // A link that has run out, or was changed, takes no other file either. The files still
      // waiting are turned away in its words, without being sent.
      if (answer.status === 403 || answer.status === 410) {
        stopped = answer.error || "This link no longer works. Ask for a new one.";
      }
      // The bytes that arrived were not the ones that were hashed, which a second try can fix.
      if (answer.error === NOT_THE_HASHED_BYTES) {
        return set("failed", "The file changed on its way to Attic, so it was not saved. Try again.", { retry: true });
      }
      // An error in Attic may pass. Anything else is the same on a second try.
      const broke = answer.status >= 500;
      const why = answer.error || (broke ? "Attic hit an error. Try again in a moment." : "Attic did not take it.");
      set("failed", why, { retry: broke });
    } catch (error) {
      set("failed", "It could not be sent. " + error.message, { retry: true });
    }
  };
  again.addEventListener("click", () => row.send());
  return row;
};

files.addEventListener("change", async () => {
  const picked = [...files.files].map(rowFor);
  files.value = "";
  for (const row of picked) await row.send();
});
</script>`,
    UPLOAD_STYLE,
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
        ? Effect.fail(new ToolError({ message: NOT_THE_HASHED_BYTES }))
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
