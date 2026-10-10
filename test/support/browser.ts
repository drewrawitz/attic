import { randomBytes } from "node:crypto";

// An internet address nobody else in the suite is using, from the range kept for examples.
// Cloudflare reports the caller's address in the `cf-connecting-ip` header, and the Worker
// counts its rate limits by it. Giving each visitor its own keeps one test's requests from
// using up another's.
export const newAddress = () =>
  `2001:db8:${randomBytes(2).toString("hex")}::${randomBytes(2).toString("hex")}`;

// A stand-in for the browser of the person signing in. It keeps cookies between requests and
// never follows a redirect, so a test can look at where each step sends it.
export const browser = (address = newAddress()) => {
  const cookies = new Map<string, string>();

  const send = async (url: string, init: { method?: string; body?: URLSearchParams } = {}) => {
    const response = await fetch(url, {
      ...init,
      redirect: "manual",
      headers: {
        "cf-connecting-ip": address,
        cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
      },
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";", 1)[0]!;
      const name = pair.slice(0, pair.indexOf("="));
      const value = pair.slice(pair.indexOf("=") + 1);
      if (value === "" || /max-age=0/i.test(cookie)) cookies.delete(name);
      else cookies.set(name, value);
    }
    return response;
  };

  return {
    address,
    get: (url: string) => send(url),
    post: (url: string, form: Record<string, string>) =>
      send(url, { method: "POST", body: new URLSearchParams(form) }),
  };
};

export type Browser = ReturnType<typeof browser>;
