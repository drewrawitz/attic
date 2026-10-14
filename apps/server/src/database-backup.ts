import { today } from "@attic/core";
import { DateTime, Effect } from "effect";
import type { WorkerEnv } from "../../../alchemy.run.ts";
import { BACKUP_OFF, backupBucketOf, putObject } from "./backup-bucket.ts";
import { secondsSince, type Chore } from "./chore.ts";
import { exportDatabase, type ExportAccess } from "./d1-export.ts";

// What it takes to ask Cloudflare for an export of the Worker's own database. Nothing when the
// backup is off, which is when the Worker is bound to no token for it.
const exportAccessOf = (env: WorkerEnv): ExportAccess | undefined => {
  const token = env.CLOUDFLARE_EXPORT_TOKEN;
  if (token === undefined) return undefined;
  return {
    apiUrl: env.CLOUDFLARE_API_URL,
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    databaseId: env.DATABASE_ID,
    token,
  };
};

// The first chore of the nightly run: a dated export of the database, in the backup bucket.
export const databaseBackup = (env: WorkerEnv): Chore => ({
  name: "database backup",
  run: async (night) => {
    const bucket = backupBucketOf(env);
    const access = exportAccessOf(env);
    if (bucket === undefined || access === undefined) return BACKUP_OFF;
    night.keepOut(access.token);
    night.keepOut(bucket.secretAccessKey);

    const started = Date.now();
    // An export is named by its date on the User's calendar, so a second run on the same day
    // replaces the first.
    const date = await Effect.runPromise(
      today.pipe(Effect.provide(DateTime.layerCurrentZoneNamed(env.ATTIC_TIMEZONE))),
    );
    const key = `database/${date}.sql`;
    const exported = await exportDatabase(
      access,
      night,
      // Only the tests bind another wait (alchemy.run.ts).
      env.EXPORT_WAIT_MS === undefined ? undefined : Number(env.EXPORT_WAIT_MS),
    );
    await putObject(bucket, key, { ...exported, contentType: "application/sql" }, night);
    return `exported ${key}, ${exported.length} bytes, in ${secondsSince(started)} s.`;
  },
});
