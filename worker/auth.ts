const DEFAULT_RETURN_PATH = "/scan";

// Only same-origin app paths are allowed, so /api/auth/refresh can't be used as an
// open redirect or bounce the browser back into an API endpoint.
export function safeReturnPath(value: string | null): string {
  if (!value || !value.startsWith("/")) return DEFAULT_RETURN_PATH;
  if (value.startsWith("//") || value.startsWith("/\\")) return DEFAULT_RETURN_PATH;
  if (/[\u0000-\u001f]/.test(value)) return DEFAULT_RETURN_PATH;
  if (value === "/api" || value.startsWith("/api/") || value.startsWith("/api?")) return DEFAULT_RETURN_PATH;
  return value;
}

// Reaching the Worker means Access has already accepted the session (or signed the
// user in on the way here), so send the browser back to where it was.
export function reauthRedirect(url: URL): Response {
  const target = new URL(safeReturnPath(url.searchParams.get("return")), url.origin);
  return new Response(null, {
    status: 302,
    headers: { location: target.toString(), "cache-control": "no-store" },
  });
}
