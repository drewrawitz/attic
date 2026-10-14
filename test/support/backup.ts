import * as Effect from "effect/Effect";
import { startFakeBucket } from "./fake-bucket.ts";
import { filesAre } from "./files.ts";
import {
  afterAll,
  beforeAll,
  cloudflare,
  deployWith,
  eventually,
  EXPORT_TOKEN,
  stack,
} from "./harness.ts";
import { runNightly } from "./nightly.ts";

// What a test of the backup starts from, on top of the harness: a stand-in for the backup
// bucket on this machine, and the six settings that turn the backup on and point the Worker at
// it. Nothing here touches a real bucket, and every value is made up.

export const ACCESS_KEY = {
  accessKeyId: "test-backup-key-id",
  secretAccessKey: "test-backup-secret-key",
};
const BUCKET = { name: "attic-backup", region: "test-region-1" };

export const bucket = await startFakeBucket({ ...BUCKET, accessKey: ACCESS_KEY });

// The backup's six settings, as the User would write them in .env.
export const BACKUP_ON = {
  BACKUP_ENDPOINT: bucket.endpoint,
  BACKUP_REGION: BUCKET.region,
  BACKUP_BUCKET: BUCKET.name,
  BACKUP_ACCESS_KEY_ID: ACCESS_KEY.accessKeyId,
  BACKUP_SECRET_ACCESS_KEY: ACCESS_KEY.secretAccessKey,
  CLOUDFLARE_EXPORT_TOKEN: EXPORT_TOKEN,
};

// Any SQL will do for an export that no test reads.
const ANY_SQL = "SELECT 1;\n";

// A second deploy returns a moment before the restarted Worker takes over (harness.ts). So a
// change that turns the backup on or off is waited for with a run. A Worker that has the
// backup asks Cloudflare for an export, and one that has it off reaches nobody, which is how
// the wait can tell the Worker that was there before from the one that took over.
export const untilBackupIsOn = eventually(async (url) => {
  cloudflare.exportsWill({ sql: ANY_SQL });
  await runNightly(url);
  if (cloudflare.calls.length === 0) {
    throw new Error("The Worker that answered the run has the backup off.");
  }
});

// The same wait the other way. The bucket is emptied before each run, and what comes back is
// the run that was answered with the backup off.
export const untilBackupIsOff = Effect.suspend(() => {
  let last = { outcome: "", log: "" };
  return eventually(async (url) => {
    cloudflare.exportsWill({ sql: ANY_SQL });
    bucket.empty();
    last = await runNightly(url);
    if (cloudflare.calls.length > 0) {
      throw new Error("The Worker that answered the run has the backup on.");
    }
  }).pipe(Effect.map(() => last));
});

// The Worker with a backup bucket configured, and with nothing in `FILES`, whatever an earlier
// run left there. A file that imports this has it before its first test, and puts the settings
// back in its last one.
export const withBackup = beforeAll(
  filesAre().pipe(Effect.andThen(deployWith(BACKUP_ON)), Effect.andThen(untilBackupIsOn)),
);

// Where a test of the backup starts: on the Worker that has a backup bucket, with the bucket
// empty. It gives the Worker's address, and the id of the database the Worker is to export.
export const backedUpWorker = Effect.gen(function* () {
  yield* withBackup;
  const { url, databaseId } = yield* stack;
  bucket.empty();
  return { url: url!, databaseId };
});

afterAll(Effect.promise(() => bucket.close()));
