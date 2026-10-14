import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { nightlyCron } from "../alchemy.run.ts";
import { ACCESS_KEY, BACKUP_ON, bucket } from "./support/backup.ts";
import {
  beforeAll,
  cloudflare,
  deployWith,
  eventually,
  EXPORT_TOKEN,
  stack,
  test,
} from "./support/harness.ts";
import { runNightly } from "./support/nightly.ts";
import { dateIn, timeZoneOnAnotherDate } from "./support/timezones.ts";

// The nightly run, through the real Worker on the local simulators. Alchemy's local runtime
// fires the Worker's `scheduled` handler when asked, as a Cron Trigger does at night.
// Cloudflare's API and the backup bucket are stood in for on this machine, the way Google is.
// What holds for a run whatever its chores are is in nightly-chores.test.ts.

// A Cron Trigger is in UTC. The run is at 3 in the morning by the timezone's standard time,
// the time its clocks keep in winter, so that a deploy plans the same trigger whether or not
// the clocks have changed. Where they change, the run is at 4 in the summer.
test(
  "the nightly run is at 3 in the morning by the timezone's standard time",
  Effect.sync(() => {
    expect(nightlyCron("UTC", 2026)).toBe("0 3 * * *");
    // Five hours behind UTC in winter, and four in summer.
    expect(nightlyCron("America/New_York", 2026)).toBe("0 8 * * *");
    // South of the equator the summer is in January, and standard time is ten hours ahead,
    // not eleven. So the run is on the evening before in UTC.
    expect(nightlyCron("Australia/Sydney", 2026)).toBe("0 17 * * *");
    // Not every timezone is a whole number of hours from UTC.
    expect(nightlyCron("Asia/Kolkata", 2026)).toBe("30 21 * * *");
    expect(nightlyCron("Asia/Kathmandu", 2026)).toBe("15 21 * * *");
    expect(nightlyCron("America/St_Johns", 2026)).toBe("30 6 * * *");
    expect(nightlyCron("Pacific/Kiritimati", 2026)).toBe("0 13 * * *");
    // Morocco's clocks go back for Ramadan, which is not in the same months from year to year.
    // The run is by the time they keep then, in a year where Ramadan is over the new year and
    // in a year where it is not.
    expect(nightlyCron("Africa/Casablanca", 2026)).toBe("0 3 * * *");
    expect(nightlyCron("Africa/Casablanca", 2030)).toBe("0 3 * * *");
  }),
);

// Any SQL will do for an export: the Worker is to pass it on as it came. It is long enough to
// arrive in more than one piece, and has a character that takes more than one byte.
const SQL = "CREATE TABLE cellar (shelf TEXT);\nINSERT INTO cellar VALUES ('crème de cassis');\n";
const EXPORT = SQL.repeat(4000);

// The Worker with a backup bucket configured, for every test down to the ones that change its
// settings again. A run on the Worker that was there before never reaches Cloudflare, which is
// how the wait can tell the two apart.
const withBackup = beforeAll(
  deployWith(BACKUP_ON).pipe(
    Effect.andThen(
      eventually(async (url) => {
        cloudflare.exportsWill({ sql: EXPORT });
        await runNightly(url);
        expect(cloudflare.calls).not.toHaveLength(0);
      }),
    ),
  ),
);

// A test body that runs against the Worker that has a backup bucket, which starts out empty.
// It is given the Worker's address, and the id of the database the Worker is to export.
const onBackedUpWorker = (body: (url: string, databaseId: string) => Promise<void>) =>
  Effect.gen(function* () {
    yield* withBackup;
    const { url, databaseId } = yield* stack;
    bucket.empty();
    yield* Effect.promise(() => body(url!, databaseId));
  });

test(
  "a run leaves the export in the bucket under today's date, byte for byte",
  onBackedUpWorker(async (url) => {
    cloudflare.exportsWill({ sql: EXPORT });
    // The tests leave the timezone unset, which is UTC. The date is read on both sides of the
    // run, in case it runs across midnight.
    const dates = [dateIn("UTC")];
    const { outcome, log } = await runNightly(url);
    dates.push(dateIn("UTC"));

    expect(outcome).toBe("ok");
    const [[key, object] = [], ...others] = [...bucket.objects];
    expect(others).toEqual([]);
    expect(dates.map((date) => `database/${date}.sql`)).toContain(key);
    expect(object?.body.equals(Buffer.from(EXPORT, "utf8"))).toBe(true);

    // Three subrequests: the call that starts the export, the read of the signed address,
    // and the PUT.
    expect([cloudflare.calls.length, cloudflare.downloads(), bucket.requests.length]).toEqual([
      1, 1, 1,
    ]);

    // The line says what was exported, its size in bytes, and how long it took.
    expect(log).toMatch(
      new RegExp(`^database backup: exported ${key}, 328000 bytes, in \\d+\\.\\d s\\.\\n$`),
    );
  }),
);

// The stand-in checks the signature as S3 would, and takes nothing that is not signed with the
// key it knows. So an object that arrived was signed. This pins the rest of what S3 asks.
test(
  "the request to the bucket is signed over its headers, not its body, and says how long it is",
  onBackedUpWorker(async (url) => {
    cloudflare.exportsWill({ sql: EXPORT });
    await runNightly(url);

    expect(bucket.requests).toHaveLength(1);
    const [{ method, headers }] = bucket.requests as [(typeof bucket.requests)[number]];
    expect(method).toBe("PUT");
    expect(headers.authorization).toMatch(
      new RegExp(
        `^AWS4-HMAC-SHA256 Credential=${ACCESS_KEY.accessKeyId}/\\d{8}/${BACKUP_ON.BACKUP_REGION}/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$`,
      ),
    );
    // The body is streamed, so it is never hashed for the signature.
    expect(headers["x-amz-content-sha256"]).toBe("UNSIGNED-PAYLOAD");
    expect(headers["content-length"]).toBe("328000");
    expect(headers["transfer-encoding"]).toBeUndefined();
    expect(headers["content-type"]).toBe("application/sql");
  }),
);

test(
  "an export that is not done the first two times still ends in one object",
  onBackedUpWorker(async (url, databaseId) => {
    cloudflare.exportsWill({ sql: EXPORT, notYet: 2 });
    const { outcome, log } = await runNightly(url);

    expect(outcome).toBe("ok");
    expect(log).toMatch(/^database backup: exported database\/\S+\.sql, 328000 bytes, /);
    expect([...bucket.objects.values()].map(({ body }) => body.toString("utf8"))).toEqual([EXPORT]);
    // One call starts the export, and each one after it carries the bookmark the first was
    // given, which is how Cloudflare knows it is the same export.
    expect(cloudflare.calls.map(({ database }) => database)).toEqual(Array(3).fill(databaseId));
    // The account's id comes from the stack too. On a machine with no Cloudflare account it
    // is Alchemy's made-up one.
    expect(cloudflare.calls.map(({ account }) => account)).toEqual(
      Array(3).fill(expect.stringMatching(/^[0-9a-f]{32}$/)),
    );
    expect(cloudflare.calls.map(({ body }) => typeof body.current_bookmark)).toEqual([
      "undefined",
      "string",
      "string",
    ]);
    expect(cloudflare.downloads()).toBe(1);
  }),
);

// A cron run on Workers Free gets 50 subrequests (ADR 0012). The export may use 22 of them at
// the most: 20 calls about it, one read of the signed address, and one PUT.
test(
  "an export that is never done stops after 20 calls, with a logged failure and no object",
  onBackedUpWorker(async (url) => {
    cloudflare.exportsWill({ sql: EXPORT, notYet: Infinity });
    const { outcome, log } = await runNightly(url);

    expect(outcome).toBe("ok");
    expect(log).toBe(
      "database backup: failed. Cloudflare had not finished the export after 20 calls.\n",
    );
    expect(cloudflare.calls).toHaveLength(20);
    expect(cloudflare.downloads()).toBe(0);
    expect(bucket.requests).toHaveLength(0);
  }),
);

// Asking again with no bookmark would start a second export, and a third.
test(
  "an export that is not done and has no bookmark to ask again with is not asked about twice",
  onBackedUpWorker(async (url) => {
    cloudflare.exportsWill({ sql: EXPORT, notYet: 1, withoutBookmark: true });
    const { outcome, log } = await runNightly(url);

    expect(outcome).toBe("ok");
    expect(log).toBe(
      "database backup: failed. Cloudflare answered the call for an export with neither a signed address nor a bookmark to ask again with.\n",
    );
    expect(cloudflare.calls).toHaveLength(1);
    expect(bucket.requests).toHaveLength(0);
  }),
);

test(
  "a second run on the same day replaces that day's export",
  onBackedUpWorker(async (url) => {
    cloudflare.exportsWill({ sql: EXPORT });
    await runNightly(url);
    const later = `${EXPORT}INSERT INTO cellar VALUES ('one more jar');\n`;
    cloudflare.exportsWill({ sql: later });
    await runNightly(url);

    expect([...bucket.objects.values()].map(({ body }) => body.toString("utf8"))).toEqual([later]);
  }),
);

// A night that fails only shows in the log. The run itself does not throw, so the next chore
// still runs: `outcome` is "ok" whatever happened. The line has the status and the answer of
// whoever said no.
test(
  "an export that Cloudflare fails ends in a logged failure and no object",
  onBackedUpWorker(async (url) => {
    cloudflare.exportsWill({
      sql: EXPORT,
      error: "D1_ERROR: the cellar flooded,\n  up to the shelf",
    });
    const { outcome, log } = await runNightly(url);

    expect(outcome).toBe("ok");
    expect(log).toBe(
      "database backup: failed. Cloudflare could not make the export: D1_ERROR: the cellar flooded, up to the shelf\n",
    );
    expect(cloudflare.calls).toHaveLength(1);
    expect(bucket.requests).toHaveLength(0);
  }),
);

test(
  "a token that Cloudflare turns away ends in a logged failure, with the token left out",
  onBackedUpWorker(async (url) => {
    cloudflare.exportsWill({ sql: EXPORT, refusesToken: true });
    const { outcome, log } = await runNightly(url);

    expect(outcome).toBe("ok");
    // The stand-in sends the token back in its answer, which is logged with the token hidden.
    expect(log).toBe(
      'database backup: failed. The call to Cloudflare for an export was answered with 403: {"success":false,"errors":[{"code":10000,"message":"Authentication error for Bearer [hidden]"}],"messages":[],"result":null}\n',
    );
    expect(log).not.toContain(EXPORT_TOKEN);
    expect(bucket.requests).toHaveLength(0);
  }),
);

test(
  "a signed address that answers 500 ends in a logged failure, with the address left out",
  onBackedUpWorker(async (url) => {
    cloudflare.exportsWill({ sql: EXPORT, signedAddressAnswers: 500 });
    const { outcome, log } = await runNightly(url);

    expect(outcome).toBe("ok");
    // The stand-in sends its own address back, as S3 does in an error.
    expect(log).toBe(
      "database backup: failed. The read of the export's signed address was answered with 500: <Error><Code>InternalError</Code><Resource>[hidden]</Resource><SignatureProvided>[hidden]</SignatureProvided></Error>\n",
    );
    const signedAddress = new URL(cloudflare.signedAddress()!);
    expect(log).not.toContain(signedAddress.pathname);
    expect(log).not.toContain(signedAddress.searchParams.get("X-Amz-Signature"));
    expect(bucket.requests).toHaveLength(0);
  }),
);

test(
  "an export that comes without its length ends in a logged failure and no object",
  onBackedUpWorker(async (url) => {
    cloudflare.exportsWill({ sql: EXPORT, withoutLength: true });
    const { outcome, log } = await runNightly(url);

    expect(outcome).toBe("ok");
    expect(log).toBe(
      "database backup: failed. The signed address of the export did not say how long the file is, and a bucket has to be told before the first byte.\n",
    );
    expect(bucket.requests).toHaveLength(0);
  }),
);

test(
  "a bucket that refuses the key ends in a logged failure and no object, with the secret left out",
  onBackedUpWorker(async (url) => {
    cloudflare.exportsWill({ sql: EXPORT });
    // The provider has another secret for the key than the one the Worker signs with.
    bucket.knows({ ...ACCESS_KEY, secretAccessKey: "a-newer-secret-key" });
    try {
      const { outcome, log } = await runNightly(url);

      expect(outcome).toBe("ok");
      // The stand-in says the Worker's secret back, which is logged with the secret hidden.
      expect(log).toMatch(
        /^database backup: failed\. The PUT of database\/\d{4}-\d{2}-\d{2}\.sql to the backup bucket was answered with 403: <\?xml version="1\.0" encoding="UTF-8"\?> <Error><Code>SignatureDoesNotMatch<\/Code><Message>The request signature we calculated does not match the signature you provided\.<\/Message><Expected>\[hidden\]<\/Expected><\/Error>\n$/,
      );
      expect(log).not.toContain(ACCESS_KEY.secretAccessKey);
      expect(bucket.requests).toHaveLength(1);
      expect(bucket.objects.size).toBe(0);
    } finally {
      bucket.knows(ACCESS_KEY);
    }
  }),
);

// A call that gets no answer at all says which call it was, as one that is refused does.
test(
  "a call that nobody answers ends in a logged failure that says which call it was",
  onBackedUpWorker(async (url) => {
    cloudflare.exportsWill({ sql: EXPORT, hangsUpOn: "call" });
    const unreached = await runNightly(url);
    expect(unreached.outcome).toBe("ok");
    expect(unreached.log).toMatch(
      /^database backup: failed\. The call to Cloudflare for an export got no answer: \S.*\n$/,
    );

    cloudflare.exportsWill({ sql: EXPORT, hangsUpOn: "download" });
    const unread = await runNightly(url);
    expect(unread.log).toMatch(
      /^database backup: failed\. The read of the export's signed address got no answer: \S.*\n$/,
    );
    // The line holds no part of the address that nobody answered at.
    expect(unread.log).not.toContain("/signed/");

    cloudflare.exportsWill({ sql: EXPORT });
    bucket.hangsUp(true);
    try {
      const unput = await runNightly(url);
      expect(unput.outcome).toBe("ok");
      expect(unput.log).toMatch(
        /^database backup: failed\. The PUT of database\/\d{4}-\d{2}-\d{2}\.sql to the backup bucket got no answer: \S.*\n$/,
      );
      expect(bucket.objects.size).toBe(0);
    } finally {
      bucket.hangsUp(false);
    }
  }),
);

// These change the Worker's settings, so they sit at the end of the file.
test(
  "an export is named by the date in the configured timezone, on the Worker's own clock",
  Effect.gen(function* () {
    yield* withBackup;
    const elsewhere = timeZoneOnAnotherDate();
    // Whether the Worker that answers a run names an export by the date in a timezone.
    const namesBy = (timeZone: string) => async (url: string) => {
      cloudflare.exportsWill({ sql: EXPORT });
      bucket.empty();
      const dates = [dateIn(timeZone)];
      await runNightly(url);
      dates.push(dateIn(timeZone));
      expect(dates.map((date) => `database/${date}.sql`)).toContain([...bucket.objects.keys()][0]);
    };

    // The date is another one in the two timezones right now, which is how the wait can tell
    // the Worker that was there before from the one that took over.
    yield* deployWith({ ...BACKUP_ON, ATTIC_TIMEZONE: elsewhere }).pipe(
      Effect.andThen(eventually(namesBy(elsewhere))),
      Effect.ensuring(
        deployWith(BACKUP_ON).pipe(Effect.andThen(eventually(namesBy("UTC"))), Effect.orDie),
      ),
    );
  }),
);

// This one also puts the settings back for whatever runs next.
test(
  "with no backup bucket configured, a run reaches nobody and says in one line that the backup is off",
  Effect.gen(function* () {
    yield* withBackup;
    yield* deployWith();

    // The Worker that was there before still has the backup, and its run reaches Cloudflare.
    let last = { outcome: "", log: "" };
    yield* eventually(async (url) => {
      cloudflare.exportsWill({ sql: EXPORT });
      bucket.empty();
      last = await runNightly(url);
      expect(cloudflare.calls).toHaveLength(0);
    });
    expect(last).toEqual({
      outcome: "ok",
      log: "database backup: off, because no backup bucket is configured.\n",
    });
    expect(bucket.requests).toHaveLength(0);
  }).pipe(Effect.ensuring(Effect.orDie(deployWith()))),
);

test(
  "with some of the backup's settings and not all, a deploy stops and names the ones that are missing",
  Effect.gen(function* () {
    const { BACKUP_REGION: _region, CLOUDFLARE_EXPORT_TOKEN: _token, ...some } = BACKUP_ON;
    const stopped = yield* Effect.flip(deployWith({ ...some, BACKUP_ENDPOINT: "  " }));
    expect(String(stopped)).toContain(
      "The backup is set up in part. Missing: BACKUP_ENDPOINT, BACKUP_REGION, CLOUDFLARE_EXPORT_TOKEN. Set all six, or none of them for no backup.",
    );

    // Nothing was deployed, so the Worker that was there still answers, with the backup off.
    const { url } = yield* stack;
    const { log } = yield* Effect.promise(() => runNightly(url!));
    expect(log).toBe("database backup: off, because no backup bucket is configured.\n");
  }).pipe(Effect.ensuring(Effect.orDie(deployWith()))),
);

// A provider lists its endpoint as a bare name as often as not. And an export is the whole
// database, so it only goes over plain http to a stand-in on this machine.
test(
  "an endpoint that is not an https address stops a deploy",
  Effect.gen(function* () {
    for (const given of ["s3.eu-central-9.example.com", "http://s3.eu-central-9.example.com"]) {
      const stopped = yield* Effect.flip(deployWith({ ...BACKUP_ON, BACKUP_ENDPOINT: given }));
      expect(String(stopped)).toContain(
        `BACKUP_ENDPOINT is "${given}", which is not an https address. Give the address of the provider's S3 API with https:// in front, such as https://s3.example.com.`,
      );
    }
  }).pipe(Effect.ensuring(Effect.orDie(deployWith()))),
);
