import { ChoreFailure, refusal, type NightlyRun } from "./chore.ts";

// An export of the D1 database, through Cloudflare's API. The Worker cannot ask its own
// binding for one: an export is only there over the API, with a token.
// https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/

// What the Worker needs to ask Cloudflare for an export of its own database.
export interface ExportAccess {
  readonly apiUrl: string;
  readonly accountId: string;
  readonly databaseId: string;
  readonly token: string;
}

// A finished export: the SQL file as a stream, and how many bytes it is.
export interface ExportedFile {
  readonly body: ReadableStream<Uint8Array>;
  readonly length: number;
}

// How long the Worker waits between two calls about one export, in milliseconds. Cloudflare
// cancels an export that nobody asks about: its docs say one "must be continually polled or
// will automatically cancel", and not how long it waits. So the wait is kept short.
const EXPORT_WAIT_MS = 1000;

// How many times the Worker asks about one export at the most, the call that starts it
// included. Every call is one of the 50 subrequests a cron run gets on Workers Free (ADR 0012),
// which every chore of the run shares. With the wait, this gives an export 19 seconds and the
// time the calls themselves take.
const MAX_EXPORT_CALLS = 20;

// A part of a signed address's query that is at least this long is taken for a part of its
// signature, and kept out of the log.
const MIN_SECRET_LENGTH = 16;

// The two calls an export takes, in the words a failure of one is logged with.
const CALL = "The call to Cloudflare for an export";
const DOWNLOAD = "The read of the export's signed address";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// What Cloudflare's answer to a call holds, as far as the Worker reads it. `status` is
// "complete" once the SQL file is ready and "error" when there will be none. Anything else is
// not done yet.
interface AnswerBody {
  readonly result?: {
    readonly at_bookmark?: string | null;
    readonly status?: string | null;
    readonly error?: string | null;
    readonly result?: { readonly signed_url?: string | null } | null;
  } | null;
}

// Asks Cloudflare for an export until it is done, and gives back the signed address of the SQL
// file. The first call starts the export. Every call after it carries the bookmark the first
// one was given, which is how Cloudflare knows it is the same export. The answer of a finished
// export holds the signed address, so no answer is logged whole.
const pollExport = async (access: ExportAccess, night: NightlyRun, waitMs: number) => {
  let bookmark: string | undefined;
  for (let asked = 1; asked <= MAX_EXPORT_CALLS; asked++) {
    if (asked > 1) await pause(waitMs);
    const answer = await night.ask(
      CALL,
      `${access.apiUrl}/accounts/${access.accountId}/d1/database/${encodeURIComponent(access.databaseId)}/export`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${access.token}`, "content-type": "application/json" },
        body: JSON.stringify({ output_format: "polling", current_bookmark: bookmark }),
      },
    );
    if (!answer.ok) throw await refusal(CALL, answer);

    // An answer that cannot be read has no bookmark either, which stops the export below.
    const { result }: AnswerBody = await answer.json<AnswerBody>().catch(() => ({}));
    if (result?.status === "error") {
      throw new ChoreFailure(
        `Cloudflare could not make the export: ${result.error ?? "it gave no reason"}`,
      );
    }
    const done = result?.status === "complete";
    const signedAddress = result?.result?.signed_url;
    if (done && typeof signedAddress === "string" && URL.canParse(signedAddress)) {
      return signedAddress;
    }
    // Asking again with no bookmark would start another export.
    if (done || typeof result?.at_bookmark !== "string") {
      throw new ChoreFailure(
        "Cloudflare answered the call for an export with neither a signed address nor a bookmark to ask again with.",
      );
    }
    bookmark = result.at_bookmark;
  }
  throw new ChoreFailure(`Cloudflare had not finished the export after ${MAX_EXPORT_CALLS} calls.`);
};

// Asks Cloudflare for an export of the database, and opens the SQL file at the signed address
// it hands back. The file is not read here. Whoever takes the stream reads it.
export const exportDatabase = async (
  access: ExportAccess,
  night: NightlyRun,
  waitMs = EXPORT_WAIT_MS,
): Promise<ExportedFile> => {
  const signedAddress = await pollExport(access, night, waitMs);
  // Whoever has the address can read the whole database for an hour. So neither it nor any
  // part of its query, which is where its signature is, may be logged.
  night.keepOut(signedAddress);
  for (const part of new URL(signedAddress).searchParams.values()) {
    if (part.length >= MIN_SECRET_LENGTH) night.keepOut(part);
  }

  const download = await night.ask(DOWNLOAD, signedAddress);
  if (!download.ok) throw await refusal(DOWNLOAD, download);
  const length = download.headers.get("content-length");
  if (download.body === null || length === null || !/^\d+$/.test(length)) {
    await download.body?.cancel();
    throw new ChoreFailure(
      "The signed address of the export did not say how long the file is, and a bucket has to be told before the first byte.",
    );
  }
  return { body: download.body, length: Number(length) };
};
