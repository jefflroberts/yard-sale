// The deployed app sits behind Cloudflare Access. When the Access session expires,
// every /api request is redirected to the Access login page on another origin, which
// fetch() cannot follow usefully. The installed PWA serves its shell from the service
// worker cache, so the browser never sees the login redirect on its own. apiFetch
// detects the Access challenge and sends the browser through a top-level navigation to
// REAUTH_PATH, which Access intercepts, signs the user in, and the Worker bounces back.

export const REAUTH_PATH = "/api/auth/refresh";
const REAUTH_STORAGE_KEY = "yard-sale-gold:reauth-at";
const REAUTH_COOLDOWN_MS = 60_000;

export class AccessExpiredError extends Error {
  constructor(redirecting: boolean) {
    super(
      redirecting
        ? "Your sign-in expired. Signing you back in…"
        : "Your sign-in expired and signing back in did not work. Close and reopen the app, then try again.",
    );
    this.name = "AccessExpiredError";
  }
}

export function isAccessChallenge(response: Pick<Response, "type" | "status">): boolean {
  // redirect: "manual" turns any redirect into an opaque one. The Worker never
  // redirects /api calls and never returns 401, so either means Access intervened.
  return response.type === "opaqueredirect" || response.status === 401;
}

type ReauthLocation = Pick<Location, "pathname" | "search" | "hash" | "assign">;
type ReauthStorage = Pick<Storage, "getItem" | "setItem">;

export function reauthenticate(
  location: ReauthLocation = window.location,
  storage: ReauthStorage = window.sessionStorage,
  now: number = Date.now(),
): boolean {
  const lastAttempt = Number(storage.getItem(REAUTH_STORAGE_KEY) ?? 0);
  if (now - lastAttempt < REAUTH_COOLDOWN_MS) return false;
  storage.setItem(REAUTH_STORAGE_KEY, String(now));
  const returnTo = `${location.pathname}${location.search}${location.hash}`;
  location.assign(`${REAUTH_PATH}?return=${encodeURIComponent(returnTo)}`);
  return true;
}

export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, { ...init, redirect: "manual" });
  if (isAccessChallenge(response)) {
    throw new AccessExpiredError(reauthenticate());
  }
  return response;
}
