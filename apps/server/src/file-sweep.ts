import { DAYS_A_FILE_IS_KEPT, filesPastKeeping, type ListedFile } from "@attic/core";
import { D1Client } from "@effect/sql-d1";
import { Effect } from "effect";
import type { WorkerEnv } from "../../../alchemy.run.ts";
import { ChoreFailure, type Chore } from "./chore.ts";

// The second chore of the nightly run: it removes from FILES each file that no Document has had
// for DAYS_A_FILE_IS_KEPT days, which `filesPastKeeping` in packages/core decides. A removed file
// has no copy anywhere while the backup of files is parked (ADR 0011). Its calls are to R2 and
// D1, which count against the 1,000 calls a run gets to Cloudflare's own services and not the
// 50 subrequests, so none goes through `ask` (ADR 0012). It never touches the backup bucket
// (ADR 0016), and logs no key, title, or text of a Document.

// The most files one list of a bucket gives, and the most keys one delete takes. R2's reference
// for its Workers API gives 1,000 for each (read on 2026-11-05).
const MOST_LISTED = 1000;
const MOST_DELETED = 1000;

// How many there are of something, in words for the log: 1 file, 2 files.
const counted = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

export const fileSweep = (env: WorkerEnv): Chore => ({
  name: "file sweep",
  run: async () => {
    // Each call that fails stops the chore, in words that say which call it was.
    const stopping = (what: string) => (error: unknown) => {
      throw new ChoreFailure(`${what} failed: ${String(error)}`);
    };
    const database = D1Client.layer({ db: env.DB });

    // The bucket is listed a page at a time, and each page is judged as it comes. A list can
    // give fewer files than it was asked for and still not be the last, so only `truncated`
    // says whether there are more. Nothing is removed until the whole bucket has been listed.
    const removable: ListedFile[] = [];
    let waiting = 0;
    let cursor: string | undefined;
    do {
      const listed = await env.FILES.list({
        limit: MOST_LISTED,
        ...(cursor === undefined ? {} : { cursor }),
      }).catch(stopping("The list of FILES"));
      const files = listed.objects.map(({ key, size, uploaded }) => ({ key, size, uploaded }));
      if (files.length > 0) {
        const judged = await Effect.runPromise(
          filesPastKeeping(files).pipe(Effect.provide(database)),
        ).catch(stopping("The read of which files no Document has"));
        removable.push(...judged.removable);
        waiting += judged.waiting;
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor !== undefined);

    let removed = 0;
    for (let at = 0; at < removable.length; at += MOST_DELETED) {
      const part = removable.slice(at, at + MOST_DELETED);
      await env.FILES.delete(part.map(({ key }) => key)).catch(
        stopping(
          `The delete of ${counted(part.length, "file")} from FILES, with ${removed} removed before it,`,
        ),
      );
      removed += part.length;
    }
    const bytes = removable.reduce((sum, { size }) => sum + size, 0);
    return `removed ${counted(removed, "file")}, ${bytes} bytes. ${waiting} more ${waiting === 1 ? "is" : "are"} waiting out their ${DAYS_A_FILE_IS_KEPT} days.`;
  },
});
