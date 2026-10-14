import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

// Attic's infrastructure. Alchemy only declares resources here (ADR 0005). The Worker itself
// is the plain module in apps/server, and it reads these bindings from its `env`.

// The stage that `vp run deploy` targets. Its Worker is named plain `attic`.
const PRODUCTION = "prod";

export const DB = Cloudflare.D1.Database("DB", { migrations: "./migrations" });
export const FILES = Cloudflare.R2.Bucket("FILES");
export const OAUTH_KV = Cloudflare.KV.Namespace("OAUTH_KV");

// Signs the cookie that remembers which clients a browser has already allowed. Alchemy makes
// it once and keeps it in its state, so every deploy binds the same value and nobody has to
// set one by hand.
export const ConsentSecret = Alchemy.Random("ConsentSecret");

// Registration and the sign-in page are open to anyone, and each use writes to KV, which
// Workers Free caps at 1,000 writes a day (ADR 0012). These slow down a caller that keeps
// hitting them. Cloudflare counts loosely, so a burst gets a few dozen requests in before
// the refusals start: it is a brake, not a cap. The binding has no resource behind it.
// `namespaceId` is only a number that keeps a limit's counters apart from every other limit
// in the account.
export const REGISTER_LIMIT = Cloudflare.RateLimit("REGISTER_LIMIT", {
  namespaceId: 1801,
  simple: { limit: 5, period: 60 },
});
export const AUTHORIZE_LIMIT = Cloudflare.RateLimit("AUTHORIZE_LIMIT", {
  namespaceId: 1802,
  simple: { limit: 10, period: 60 },
});

// Where the Worker reaches Google once a person has signed in there.
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

// Where the Worker reaches Cloudflare's own API, which it asks for an export of the database.
const CLOUDFLARE_API_URL = "https://api.cloudflare.com/client/v4";

// A setting that cannot be used stops here, so a deploy stops before it changes anything.
const notUsable = (message: string) =>
  Effect.fail(new Config.ConfigError(new ConfigProvider.SourceError({ message })));

// A setting that may be left out. Unset and empty mean the same.
const optional = (name: string) =>
  Config.String(name).pipe(
    Config.withDefault(""),
    Config.map((given) => given.trim()),
  );

// The timezone the User's day is in, which is what "today" means to a tool: an IANA name such
// as America/New_York. Unset and empty both mean UTC.
const timezone = optional("ATTIC_TIMEZONE").pipe(
  Config.map((given) => given || "UTC"),
  Config.mapEffect((name) =>
    Option.isSome(DateTime.zoneMakeNamed(name))
      ? Effect.succeed(name)
      : notUsable(
          `ATTIC_TIMEZONE is "${name}", which is not a timezone. Give an IANA name such as America/New_York, or leave it empty for UTC.`,
        ),
  ),
);

// The hour of the nightly run, on the User's clock. It is at night because a running export
// blocks the database's other requests, as D1's docs say.
const NIGHTLY_HOUR = 3;

const MINUTES_IN_DAY = 24 * 60;

// When the nightly run is, as a Cron Trigger, which is in UTC: 3 in the morning by the
// timezone's standard time. That is the time its clocks are furthest behind in the year, which
// for most is the time they keep in winter. So a deploy plans the same trigger in any season,
// and where the clocks change, the run is at 4 for the rest of the year. Every day of the year
// is looked at, because not every timezone changes its clocks for a summer: Morocco's go back
// for Ramadan, which moves from year to year. The year says which year's clocks to go by.
export const nightlyCron = (timeZone: string, year = new Date().getUTCFullYear()) => {
  const minutesAhead = (day: number) =>
    DateTime.zonedOffset(DateTime.makeZonedUnsafe(Date.UTC(year, 0, day, 12), { timeZone })) /
    60_000;
  const standard = Math.min(...Array.from({ length: 366 }, (_, index) => minutesAhead(index + 1)));
  const inUtc =
    (((NIGHTLY_HOUR * 60 - standard) % MINUTES_IN_DAY) + MINUTES_IN_DAY) % MINUTES_IN_DAY;
  return `${inUtc % 60} ${Math.floor(inUtc / 60)} * * *`;
};

// The one currency every amount is in: an ISO code such as USD. Unset and empty both mean USD.
// Money is stored as a bare number of cents, so this is only used to write an amount in a Note.
const currency = optional("ATTIC_CURRENCY").pipe(
  Config.map((given) => given || "USD"),
  Config.mapEffect((given) => {
    const code = given.toUpperCase();
    return Intl.supportedValuesOf("currency").includes(code)
      ? Effect.succeed(code)
      : notUsable(
          `ATTIC_CURRENCY is "${given}", which is not a currency. Give an ISO code such as USD or EUR, or leave it empty for USD.`,
        );
  }),
);

// The backup's six settings: the backup bucket, which is any S3-compatible bucket at another
// provider, a key to it, and the Cloudflare API token the Worker exports the database with.
// That token is not the deploy token. It is made by hand, with only the permission an export
// needs. The README says what each setting is.
const backupSettings = {
  BACKUP_ENDPOINT: optional("BACKUP_ENDPOINT"),
  BACKUP_REGION: optional("BACKUP_REGION"),
  BACKUP_BUCKET: optional("BACKUP_BUCKET"),
  BACKUP_ACCESS_KEY_ID: optional("BACKUP_ACCESS_KEY_ID"),
  BACKUP_SECRET_ACCESS_KEY: optional("BACKUP_SECRET_ACCESS_KEY"),
  CLOUDFLARE_EXPORT_TOKEN: optional("CLOUDFLARE_EXPORT_TOKEN"),
};

// The names of the six. The tests leave every one of them unset.
export const BACKUP_SETTINGS = Object.keys(backupSettings);

// Plain http is only for an address on this machine, which is where the tests' stand-in for
// the bucket is. An export is the whole database.
const THIS_MACHINE = new Set(["localhost", "127.0.0.1", "[::1]"]);
const httpsOrThisMachine = (address: string) => {
  if (!URL.canParse(address)) return false;
  const { protocol, hostname } = new URL(address);
  return protocol === "https:" || (protocol === "http:" && THIS_MACHINE.has(hostname));
};

// What the Worker is bound to for the backup: all six, the two that are secrets as secrets, or
// nothing at all. The backup is off unless it is configured. With none of the six, the nightly
// run says the backup is off.
const backup = Config.all(backupSettings).pipe(
  Config.mapEffect((given) => {
    const missing = Object.entries(given)
      .filter(([, text]) => text === "")
      .map(([name]) => name);
    if (missing.length === BACKUP_SETTINGS.length) return Effect.succeed(undefined);
    // A backup that is set up in part would fail every night, where only the log shows it.
    if (missing.length > 0) {
      return notUsable(
        `The backup is set up in part. Missing: ${missing.join(", ")}. Set all six, or none of them for no backup.`,
      );
    }
    // The bucket's name and an object's key go after the endpoint, so it ends without a slash.
    const endpoint = given.BACKUP_ENDPOINT.replace(/\/+$/, "");
    if (!httpsOrThisMachine(endpoint)) {
      return notUsable(
        `BACKUP_ENDPOINT is "${endpoint}", which is not an https address. Give the address of the provider's S3 API with https:// in front, such as https://s3.example.com.`,
      );
    }
    return Effect.succeed({
      ...given,
      BACKUP_ENDPOINT: endpoint,
      BACKUP_SECRET_ACCESS_KEY: Redacted.make(given.BACKUP_SECRET_ACCESS_KEY),
      CLOUDFLARE_EXPORT_TOKEN: Redacted.make(given.CLOUDFLARE_EXPORT_TOKEN),
    });
  }),
);

export const Worker = Cloudflare.Worker(
  "Worker",
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    const { dev } = yield* Alchemy.AlchemyContext;
    // Unset and empty mean the same: the Worker is served from its workers.dev address.
    const domain = yield* optional("ATTIC_DOMAIN");

    // A deploy fails without the sign-in settings, since nobody could get in. `alchemy dev`
    // and the tests start without them, and the sign-in page then says which one is missing.
    const setting = (name: string) =>
      dev ? Config.String(name).pipe(Config.withDefault("")) : Config.NonEmptyString(name);
    const secret = (name: string) => setting(name).pipe(Config.map(Redacted.make));
    // Only dev mode reads another address for Google or for Cloudflare's API, which is how
    // the tests stand in for them. A deploy always binds their own.
    const addressOf = (name: string, url: string) =>
      dev ? Config.String(name).pipe(Config.withDefault(url)) : Config.succeed(url);
    // Only dev mode reads this one, and only the tests set it: how long the Worker waits
    // between two calls about an export, in milliseconds, so that no test sits through the
    // real wait. A deploy binds nothing, and the Worker waits as long as its own code says.
    const exportWaitMs = dev ? yield* optional("EXPORT_WAIT_MS") : "";
    const forTests: { readonly EXPORT_WAIT_MS?: string } =
      exportWaitMs === "" ? {} : { EXPORT_WAIT_MS: exportWaitMs };
    const consentSecret = yield* ConsentSecret;
    const db = yield* DB;
    const timeZone = yield* timezone;

    return {
      // A stage name may hold underscores, which a workers.dev hostname cannot.
      name: stage === PRODUCTION ? "attic" : `attic-${stage.replaceAll("_", "-")}`,
      main: "./apps/server/src/worker.ts",
      // The newest date the workerd inside this Alchemy version accepts, so that
      // `alchemy dev` and a deploy run under the same date. Raise it when Alchemy is upgraded.
      compatibility: { flags: ["nodejs_compat"], date: "2026-09-25" },
      // The one Cron Trigger. It fires the Worker's `scheduled` handler, which runs every
      // nightly chore, so a new chore needs no trigger of its own.
      crons: [nightlyCron(timeZone)],
      // A string binds as plain text and a redacted value as a secret.
      env: {
        DB,
        FILES,
        OAUTH_KV,
        REGISTER_LIMIT,
        AUTHORIZE_LIMIT,
        GOOGLE_CLIENT_ID: yield* setting("GOOGLE_CLIENT_ID"),
        GOOGLE_CLIENT_SECRET: yield* secret("GOOGLE_CLIENT_SECRET"),
        GOOGLE_TOKEN_URL: yield* addressOf("GOOGLE_TOKEN_URL", GOOGLE_TOKEN_URL),
        GOOGLE_USERINFO_URL: yield* addressOf("GOOGLE_USERINFO_URL", GOOGLE_USERINFO_URL),
        ALLOWED_EMAILS: yield* secret("ALLOWED_EMAILS"),
        CONSENT_SECRET: consentSecret.text,
        ATTIC_TIMEZONE: timeZone,
        ATTIC_CURRENCY: yield* currency,
        // What the nightly run asks Cloudflare to export. Both ids come from the stack, so
        // neither is a setting.
        CLOUDFLARE_API_URL: yield* addressOf("CLOUDFLARE_API_URL", CLOUDFLARE_API_URL),
        CLOUDFLARE_ACCOUNT_ID: db.accountId,
        DATABASE_ID: db.databaseId,
        // All six of the backup's bindings, or none of them.
        ...(yield* backup),
        ...forTests,
      },
      // Local dev has no use for a domain.
      ...(domain !== "" && !dev ? { domain } : {}),
    };
  }),
);

export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;

// A deploy keeps its state in the Cloudflare state store, so it does not depend on one
// machine's disk. `alchemy dev` and the tests only describe local simulators, so their state
// stays in .alchemy/ and they need no Cloudflare account (ADR 0013).
const state = Layer.unwrap(
  Alchemy.AlchemyContext.useSync(({ dev }) => (dev ? Alchemy.localState() : Cloudflare.state())),
);

export default Alchemy.Stack(
  "attic",
  { providers: Cloudflare.providers(), state },
  Effect.gen(function* () {
    const db = yield* DB;
    const worker = yield* Worker;

    return { url: worker.url, databaseId: db.databaseId };
  }),
);
