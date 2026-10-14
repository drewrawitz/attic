# The Worker pushes its own backup every night, and never deletes from it

What Cloudflare keeps does not outlive the account. D1 Time Travel reaches back 7 days on Workers Free, covers no file in R2, and is gone with the database (ADR 0012). Filling an Attic takes hours of interviews, so a copy of the data has to leave Cloudflare. Three things about that copy are hard to change once there are backups that follow them:

- **The Worker pushes the backup itself, every night.** A Cron Trigger fires the Worker's `scheduled` handler. It asks Cloudflare's API for an export of the database and streams the SQL file into the backup bucket: any S3-compatible bucket at another provider, which the User sets up and names in the settings. Nothing outside Cloudflare has to run, be awake, or hold a Cloudflare token.
- **Attic never deletes from the backup bucket.** It only writes there. An export is named by its date, as in `database/2026-10-14.sql`, so a second run on the same day replaces that day's export and no run touches another day's. How long an export is kept is a lifecycle rule at the provider. So the access key can be one that cannot delete, and neither a bug in Attic nor a key that leaks can empty the backup.
- **What the backup knows about the bucket is kept in the bucket.** The copy of the files has to remember how far it got (issue 60). It remembers that in the backup bucket and not in D1 or KV, so a bucket that is new or was emptied is filled from the beginning with nothing reset by hand.

## Considered options

- **Pull from outside:** a scheduled GitHub Action, or a machine of the User's own, that runs `wrangler d1 export` and uploads the result. No Workers limit would apply to it. But it is a second thing to set up and watch, it needs a Cloudflare token and the bucket's key kept somewhere else, and a machine of the User's own has to be on. Everyone who hosts an Attic would have to build the same.
- **A bucket in the same Cloudflare account:** R2 needs no signing and no second provider. It is lost with the account, and that is the loss the backup is for.
- **Let the Worker prune old exports:** it could keep the newest thirty. Then the key must be able to delete, and the worst a bug can do gets much worse. A lifecycle rule does the same at the provider.

## Consequences

- The run has to fit a cron run on Workers Free (ADR 0012): 10 ms of CPU, 15 minutes, and 50 subrequests. The export is streamed from Cloudflare into the bucket. It is never held in memory and never hashed, so its size costs no CPU. An S3 `PUT` has to say how long its body is before the first byte, which is the length the signed address gave, and its signature covers the headers and not the body (`UNSIGNED-PAYLOAD`).
- The chores of one run share the 50 subrequests. The run counts them in code and stops at 45. The export takes 22 at the most: up to 20 calls about the export, one read of the signed address, and one `PUT`. An export that is done at the first call takes 3. The files get what is left.
- An export blocks the database's other requests while it runs, so the run is at 3 in the morning in the configured timezone. A Cron Trigger is in UTC, so the hour is worked out at deploy from the timezone's standard time, and a deploy plans the same trigger in any season. Where the clocks change, the run is at 4 in the summer.
- The export is asked for with a Cloudflare API token of its own, which the User makes by hand. It is not the deploy token. Alchemy could make it, but the deploy token would then need the permission to create tokens.
- A night that fails only shows in the log: one line for each chore, with what it did, or with the status and the answer of whoever said no. Nothing is tried again before the next night, and a chore that fails does not stop the next. No secret and no signed address is logged.
- The backup is off unless it is configured. A deploy with none of its settings still has the trigger, and its run says the backup is off. A deploy with some of them and not all stops.
- A request to the bucket is signed with `aws4fetch`, pinned. Signature Version 4 is not written by hand in the Worker.
- The trigger is one of the five an account gets on Workers Free. Every nightly chore hangs on it, so step 6 needs no second one.
- A backup is only as good as the restore that was run from it, and none has been run yet. That is issues 61 and 62.

Checked against Cloudflare's API reference for the D1 export and alchemy 2.0.0-beta.81 on 2026-10-13.
