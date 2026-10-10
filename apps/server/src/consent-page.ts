import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";

const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ENTITIES[char]!);

const page = (title: string, body: string) => `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem; }
  button { font: inherit; padding: 0.5rem 1rem; margin-right: 0.5rem; }
</style>
${body}
</html>`;

// The page that asks whether a client may connect. A client registers itself, so its name,
// its redirect address, and its scopes are whatever it chose to send. Every one of them is
// escaped here.
export const consentPage = (details: ConsentDescription, handle: string) => {
  const name = escapeHtml(details.clientName);
  const scopes =
    details.scope.length > 0
      ? `<p>It asked for: ${details.scope.map(escapeHtml).join(", ")}.</p>`
      : "";
  const loopback = details.redirectIsLoopback
    ? `<p><strong>That is an app on this computer.</strong> Continue only if you just started connecting from it.</p>`
    : "";

  return page(
    "Connect to Attic",
    `<h1>Allow ${name} to use this Attic?</h1>
<p>This app registered itself, so its name is not verified. If you allow it, access is sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${loopback}
${scopes}
<p>Next you sign in with Google. Only an account on this Attic's list gets in.</p>
<form method="post" action="/authorize">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  <button name="decision" value="approve">Allow</button>
  <button name="decision" value="deny">Deny</button>
</form>`,
  );
};

// Shown when sign-in cannot go on and there is no client it is safe to send the browser
// back to.
export const messagePage = (heading: string, message: string) =>
  page("Attic", `<h1>${escapeHtml(heading)}</h1>\n<p>${escapeHtml(message)}</p>`);
