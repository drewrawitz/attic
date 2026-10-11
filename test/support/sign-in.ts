import { browser, type Browser } from "./browser.ts";
import type { GoogleAccount } from "./fake-google.ts";
import { google } from "./harness.ts";
import { authorizeUrl, exchange, register } from "./mcp-client.ts";

// The browser part of sign-in, one step at a time, and the whole of it for a test that only
// wants a token.

// A Google account whose email is on the allowlist. The setting spells it
// " Allowed@Example.com " and Google spells it another way again, so a sign-in only works
// if both sides are compared ignoring case and the spaces around them.
export const ALLOWED_ACCOUNT: GoogleAccount = {
  sub: "1001",
  email: "ALLOWED@example.COM",
  email_verified: true,
  name: "Pat Example",
};

export const consentHandle = (html: string) => /name="handle" value="([^"]+)"/.exec(html)![1]!;

// A new client registers and sends a person to the sign-in page, from the same address.
export const openSignIn = async (url: string) => {
  const person = browser();
  const registered = await register(url, "Test client", person.address);
  const client = (await registered.json()) as { client_id: string };
  const page = await person.get(authorizeUrl(url, client.client_id));
  return { person, client, page };
};

// The person answers the consent page. Returns where the Worker sends the browser next.
export const answerConsent = async (
  url: string,
  person: Browser,
  page: Response,
  decision: string,
) => person.post(`${url}/authorize`, { handle: consentHandle(await page.text()), decision });

// A new client registers, and a person allows it on the consent page. `atGoogle` is where
// the Worker sends the browser next, which is Google's sign-in page.
export const allowNewClient = async (url: string) => {
  const { person, client, page } = await openSignIn(url);
  const allowed = await answerConsent(url, person, page, "approve");
  return { person, client, allowed, atGoogle: new URL(allowed.headers.get("location")!) };
};

// Google sends the browser back to the Worker's callback with `answer`, plus the state the
// Worker gave it.
export const comeBack = (
  url: string,
  person: Browser,
  atGoogle: URL,
  answer: Record<string, string>,
) =>
  person.get(
    `${url}/callback?${new URLSearchParams({
      ...answer,
      state: atGoogle.searchParams.get("state")!,
    }).toString()}`,
  );

// The whole browser part of sign-in: allow the client, sign in to Google as `account`, and
// come back to the Worker's callback. `back` is where the Worker sends the browser last.
export const signInAs = async (url: string, account: GoogleAccount) => {
  const { person, client, atGoogle } = await allowNewClient(url);
  const back = await comeBack(url, person, atGoogle, { code: google.signIn(atGoogle, account) });
  return { client, back };
};

// Where a redirect sends the client, and what it carries.
export const sentToClient = (redirect: Response) => {
  const toClient = new URL(redirect.headers.get("location")!);
  return {
    status: redirect.status,
    address: `${toClient.origin}${toClient.pathname}`,
    error: toClient.searchParams.get("error"),
    state: toClient.searchParams.get("state"),
    code: toClient.searchParams.get("code"),
  };
};

// Signs in as `account` and returns the token the client ends up holding.
export const tokenFor = async (url: string, account: GoogleAccount) => {
  const { client, back } = await signInAs(url, account);
  const token = (await (
    await exchange(url, client.client_id, sentToClient(back).code!)
  ).json()) as {
    access_token: string;
  };
  return token.access_token;
};
