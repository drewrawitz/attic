import { Clock, Context, Effect, Layer } from "effect";

// The addresses the User opens outside MCP, such as the page that takes a Document's file. A
// phone that opens one has no token, so each is signed, and works for a short while.

/** How long a signed address works, in minutes (ADR 0008), and in milliseconds. */
export const SIGNED_FOR_MINUTES = 15;
export const SIGNED_FOR = SIGNED_FOR_MINUTES * 60 * 1000;

/** What a link that has run out says, to the User on a page and to a client that sends to it. */
export const LINK_RAN_OUT = `This link has run out. Links last ${SIGNED_FOR_MINUTES} minutes. Ask for a new one.`;

// The two parts of the query that a signature adds to an address.
const UNTIL = "until";
const SIGNATURE = "signature";

// The HMAC key, made once for each key text and kept.
const keys = new Map<string, ReturnType<typeof crypto.subtle.importKey>>();

const hmacKey = (secret: string) => {
  let known = keys.get(secret);
  if (known === undefined) {
    known = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    keys.set(secret, known);
  }
  return known;
};

// What is signed: the path, and when the address runs out. The path says what the address is
// for, so one made for a page cannot stand in for one made for a file.
const signedText = (path: string, until: number) => new TextEncoder().encode(`${path}\n${until}`);

const toBase64Url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const fromBase64Url = (text: string) => {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
};

/**
 * Makes addresses on this Worker that work for a while, signed with the Worker's key. The
 * Worker hands one to the tools that need it, so nothing in `packages/core` reads its
 * environment, and a test hands one that knows a key of its own.
 */
export class SignedAddresses extends Context.Service<
  SignedAddresses,
  {
    /**
     * The address of a path on this Worker, signed so that it works for `SIGNED_FOR` from now.
     * Returns it with when it runs out, in milliseconds since 1970.
     */
    readonly sign: (
      path: string,
    ) => Effect.Effect<{ readonly address: string; readonly until: number }>;
  }
>()("@attic/core/SignedAddresses") {
  /** Addresses on the Worker at `origin`, signed with `secret`. The time is Effect's clock. */
  static readonly layer = (origin: string, secret: string) =>
    Layer.succeed(
      SignedAddresses,
      SignedAddresses.of({
        sign: (path) =>
          Effect.gen(function* () {
            const until = (yield* Clock.currentTimeMillis) + SIGNED_FOR;
            const signature = yield* Effect.promise(async () =>
              crypto.subtle.sign("HMAC", await hmacKey(secret), signedText(path, until)),
            );
            const query = new URLSearchParams({
              [UNTIL]: String(until),
              [SIGNATURE]: toBase64Url(signature),
            });
            return { address: `${origin}${path}?${query.toString()}`, until };
          }),
      }),
    );
}

/**
 * Whether an address the Worker was asked for is one it signed, and still works at `now`:
 * `signed`, `ran out`, or `not signed`, which is also what an address that was changed is. It
 * reads only the address, so a request that fails it is turned away before anything is read.
 */
export const checkSignature = async (secret: string, address: URL, now: number) => {
  const until = Number(address.searchParams.get(UNTIL));
  const signature = address.searchParams.get(SIGNATURE);
  if (!Number.isSafeInteger(until) || signature === null) return "not signed";
  let given: Uint8Array;
  try {
    given = fromBase64Url(signature);
  } catch {
    return "not signed";
  }
  // `verify` compares in a time that does not depend on where the two first differ.
  const good = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    given,
    signedText(address.pathname, until),
  );
  if (!good) return "not signed";
  return now < until ? "signed" : "ran out";
};
