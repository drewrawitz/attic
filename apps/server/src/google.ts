// Google is only asked who the person is. Nothing here keeps a Google token: once the email
// has been read, the token is dropped.

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";

const base64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

// A PKCE verifier. It stays on this side, and Google is sent only its hash.
export const newVerifier = () => base64Url(crypto.getRandomValues(new Uint8Array(32)));

const challenge = async (verifier: string) =>
  base64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );

// The address of Google's sign-in page for one sign-in attempt.
export const authorizeUrl = async (attempt: {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly verifier: string;
}) =>
  `${AUTHORIZE_URL}?${new URLSearchParams({
    client_id: attempt.clientId,
    redirect_uri: attempt.redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state: attempt.state,
    code_challenge: await challenge(attempt.verifier),
    code_challenge_method: "S256",
  }).toString()}`;

// How the Worker reaches Google as the OAuth client the host created.
export interface GoogleClient {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly tokenUrl: string;
  readonly userinfoUrl: string;
}

// What Google says about the account that signed in.
export interface GoogleProfile {
  readonly sub: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly name: string;
}

const json = async (response: Response): Promise<Record<string, unknown>> => {
  const value: unknown = await response.json().catch(() => undefined);
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
};

// Trade the code Google sent back for a token, and use the token once to read who signed
// in. Returns nothing when Google refuses either call or its answer cannot be read.
export const fetchProfile = async (
  google: GoogleClient,
  attempt: { readonly code: string; readonly verifier: string; readonly redirectUri: string },
): Promise<GoogleProfile | undefined> => {
  const exchanged = await fetch(google.tokenUrl, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: attempt.code,
      code_verifier: attempt.verifier,
      redirect_uri: attempt.redirectUri,
      client_id: google.clientId,
      client_secret: google.clientSecret,
    }),
  });
  const token = await json(exchanged);
  if (!exchanged.ok || typeof token.access_token !== "string") {
    console.error("Google refused the code", exchanged.status, token.error);
    return undefined;
  }

  const answered = await fetch(google.userinfoUrl, {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  const info = await json(answered);
  if (!answered.ok || typeof info.sub !== "string" || typeof info.email !== "string") {
    console.error("Google did not say who signed in", answered.status);
    return undefined;
  }

  return {
    sub: info.sub,
    email: info.email,
    emailVerified: info.email_verified === true,
    name: typeof info.name === "string" ? info.name : info.email,
  };
};
