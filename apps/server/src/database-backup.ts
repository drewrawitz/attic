import { today } from "@attic/core";
import { DateTime, Effect } from "effect";
import type { WorkerEnv } from "../../../alchemy.run.ts";
import { putObject, type BackupBucket } from "./backup-bucket.ts";
import type { Chore } from "./chore.ts";
import { exportDatabase, type ExportAccess } from "./d1-export.ts";

// What the Worker is bound to for the backup: the backup bucket, and what it takes to ask
// Cloudflare for an export. Nothing when the backup is off. The stack binds every setting of
// the backup or none of them (alchemy.run.ts), which the type of the bindings cannot say, so
// each one is looked at.
const backupOf = (env: WorkerEnv): { bucket: BackupBucket; access: ExportAccess } | undefined => {
  const {
    BACKUP_ENDPOINT: endpoint,
    BACKUP_REGION: region,
    BACKUP_BUCKET: name,
    BACKUP_ACCESS_KEY_ID: accessKeyId,
    BACKUP_SECRET_ACCESS_KEY: secretAccessKey,
    CLOUDFLARE_EXPORT_TOKEN: token,
  } = env;
  if (
    endpoint === undefined ||
    region === undefined ||
    name === undefined ||
    accessKeyId === undefined ||
    secretAccessKey === undefined ||
    token === undefined
  ) {
    return undefined;
  }
  return {
    bucket: { endpoint, region, name, accessKeyId, secretAccessKey },
    access: {
      apiUrl: env.CLOUDFLARE_API_URL,
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      databaseId: env.DATABASE_ID,
      token,
    },
  };
};

// The first chore of the nightly run: a dated export of the database, in the backup bucket.
export const databaseBackup = (env: WorkerEnv): Chore => ({
  name: "database backup",
  run: async (night) => {
    const backup = backupOf(env);
    if (backup === undefined) return "off, because no backup bucket is configured.";
    night.keepOut(backup.access.token);
    night.keepOut(backup.bucket.secretAccessKey);

    const started = Date.now();
    // An export is named by its date on the User's calendar, so a second run on the same day
    // replaces the first.
    const date = await Effect.runPromise(
      today.pipe(Effect.provide(DateTime.layerCurrentZoneNamed(env.ATTIC_TIMEZONE))),
    );
    const key = `database/${date}.sql`;
    const exported = await exportDatabase(
      backup.access,
      night,
      // Only the tests bind another wait (alchemy.run.ts).
      env.EXPORT_WAIT_MS === undefined ? undefined : Number(env.EXPORT_WAIT_MS),
    );
    await putObject(backup.bucket, key, { ...exported, contentType: "application/sql" }, night);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    return `exported ${key}, ${exported.length} bytes, in ${seconds} s.`;
  },
});
