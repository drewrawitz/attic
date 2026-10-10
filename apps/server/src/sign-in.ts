import {
  AuthorizationError,
  authorizationErrorRedirect,
  type AuthRequest,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import type { WorkerEnv } from "../../../alchemy.run.ts";
import { allowedEmails, isAllowed } from "./allowlist.ts";
import { consentPage, messagePage } from "./consent-page.ts";
import { fetchProfile, newVerifier, signInUrl, type GoogleClient } from "./google.ts";
import { AUTHORIZE_PATH, CALLBACK_PATH } from "./routes.ts";

// The provider adds its helpers to the env it hands to this handler.
const helpers = (env: WorkerEnv) =>
  (env as WorkerEnv & { readonly OAUTH_PROVIDER: OAuthHelpers }).OAUTH_PROVIDER;

const googleClient = (env: WorkerEnv): GoogleClient => ({
  clientId: env.GOOGLE_CLIENT_ID,
  clientSecret: env.GOOGLE_CLIENT_SECRET,
  tokenUrl: env.GOOGLE_TOKEN_URL,
  userinfoUrl: env.GOOGLE_USERINFO_URL,
});

const html = (body: string, init: { status?: number; headers?: Headers } = {}) => {
  const headers = init.headers ?? new Headers();
  headers.set("content-type", "text/html; charset=utf-8");
  return new Response(body, { status: init.status ?? 200, headers });
};

// Sends the browser on. `headers` carries the cookies the provider wants set on the way.
const redirect = (headers: Headers, location?: string) => {
  if (location !== undefined) headers.set("location", location);
  return new Response(null, { status: 302, headers });
};

// What is kept on this side while the person is away at Google.
interface AtGoogle {
  readonly verifier: string;
}

// Where Google sends the person back to.
const callbackUrl = (request: Request) => `${new URL(request.url).origin}${CALLBACK_PATH}`;

// Send the browser to Google. Only call this once the client has been allowed.
const toGoogle = async (
  request: Request,
  env: WorkerEnv,
  authRequest: AuthRequest,
  headers: Headers,
) => {
  const verifier = newVerifier();
  const upstream = await helpers(env).beginUpstream(authRequest, {
    data: { verifier } satisfies AtGoogle,
    headers,
  });
  return redirect(
    upstream.headers,
    await signInUrl(googleClient(env), {
      redirectUri: callbackUrl(request),
      state: upstream.state,
      verifier,
    }),
  );
};

// GET /authorize: show the consent page for the client that asked.
const showConsent = async (request: Request, env: WorkerEnv) => {
  const oauth = helpers(env);
  const authRequest = await oauth.parseAuthRequest(request);
  // A client this browser already allowed is not asked about again.
  if (await oauth.isConsentRemembered(request, authRequest, { secret: env.CONSENT_SECRET })) {
    return toGoogle(request, env, authRequest, new Headers());
  }
  // Described first, so a client that cannot be looked up leaves nothing in KV.
  const details = await oauth.describeConsent(authRequest);
  const consent = await oauth.beginConsent(authRequest);
  return html(consentPage(details, consent.handle), { headers: consent.headers });
};

// POST /authorize: the person pressed Allow or Deny.
const decide = async (request: Request, env: WorkerEnv) => {
  const oauth = helpers(env);
  const form = await request.formData();
  const posted = form.get("handle");
  const handle = typeof posted === "string" ? posted : "";

  if (form.get("decision") !== "approve") {
    // The provider's headers already say where to send the client its refusal.
    return redirect((await oauth.denyConsent(request, handle)).headers);
  }
  // The approval is remembered for this browser, not for a person. Who they are is only
  // known once Google sends them back.
  const approved = await oauth.approveConsent(request, handle, {
    remember: { secret: env.CONSENT_SECRET },
  });
  return toGoogle(request, env, approved.request, approved.headers);
};

// GET /callback: Google sent the person back.
const finish = async (request: Request, env: WorkerEnv) => {
  const oauth = helpers(env);
  const resumed = await oauth.finishUpstream<AtGoogle>(request);
  const refuse = (error: "access_denied" | "server_error") =>
    redirect(resumed.headers, authorizationErrorRedirect(resumed.request, error));

  // Google reports a cancelled or failed sign-in with `error`. The client is told it was
  // denied, whatever else came back.
  const answer = new URL(request.url).searchParams;
  const code = answer.get("code");
  if (answer.has("error") || code === null) return refuse("access_denied");

  const profile = await fetchProfile(googleClient(env), {
    code,
    verifier: resumed.data.verifier,
    redirectUri: callbackUrl(request),
  });
  if (profile === undefined) return refuse("server_error");

  // An email Google has not verified could be anyone's, so it never counts.
  if (!profile.emailVerified || !isAllowed(env.ALLOWED_EMAILS, profile.email)) {
    console.warn(
      profile.emailVerified
        ? "Sign-in denied: the Google account is not on the allowlist"
        : "Sign-in denied: Google has not verified the account's email",
    );
    return refuse("access_denied");
  }

  const { redirectTo } = await oauth.completeAuthorization({
    request: resumed.request,
    userId: profile.sub,
    metadata: { label: profile.email },
    scope: resumed.request.scope,
    // Google's tokens are not kept. Nothing needs them once the email is known.
    props: { email: profile.email, name: profile.name },
  });
  return redirect(resumed.headers, redirectTo);
};

// The settings the User supplies before anyone can sign in. `alchemy dev` starts without
// them, so this is where the User finds out which ones are still missing.
const missingSettings = (env: WorkerEnv) => [
  ...(env.GOOGLE_CLIENT_ID === "" ? ["GOOGLE_CLIENT_ID"] : []),
  ...(env.GOOGLE_CLIENT_SECRET === "" ? ["GOOGLE_CLIENT_SECRET"] : []),
  ...(allowedEmails(env.ALLOWED_EMAILS).length === 0 ? ["ALLOWED_EMAILS"] : []),
];

// The step of sign-in that a request is for, if it is for one.
const stepFor = (request: Request) => {
  const { pathname } = new URL(request.url);
  if (pathname === AUTHORIZE_PATH && request.method === "GET") return showConsent;
  if (pathname === AUTHORIZE_PATH && request.method === "POST") return decide;
  if (pathname === CALLBACK_PATH && request.method === "GET") return finish;
  return undefined;
};

const route = (request: Request, env: WorkerEnv) => {
  const step = stepFor(request);
  if (step === undefined) return new Response(null, { status: 404 });

  const missing = missingSettings(env);
  if (missing.length > 0) {
    return html(
      messagePage(
        "Sign-in is not set up yet",
        `Missing: ${missing.join(", ")}. Add them to .env and start Attic again. The README says where each one comes from.`,
      ),
      { status: 503 },
    );
  }
  return step(request, env);
};

// The pages a person sees while signing in. Everything that is not an OAuth endpoint or /mcp
// lands here.
export const signIn = {
  async fetch(request, env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      if (!(error instanceof AuthorizationError)) throw error;
      // The error carries a redirect only once the client and its redirect address have been
      // checked. Without one, the browser must not be sent anywhere.
      if (error.redirectTo !== undefined) return Response.redirect(error.redirectTo, 302);
      return html(messagePage("Sign-in did not finish", error.description), { status: 400 });
    }
  },
} satisfies ExportedHandler<WorkerEnv>;
