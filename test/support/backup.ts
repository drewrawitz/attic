import * as Effect from "effect/Effect";
import { startFakeBucket } from "./fake-bucket.ts";
import { afterAll, EXPORT_TOKEN } from "./harness.ts";

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

afterAll(Effect.promise(() => bucket.close()));
