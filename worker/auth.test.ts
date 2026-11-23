import { describe, expect, it } from "vitest";
import { reauthRedirect, safeReturnPath } from "./auth";

describe("safeReturnPath", () => {
  it("keeps same-origin app paths", () => {
    expect(safeReturnPath("/scan")).toBe("/scan");
    expect(safeReturnPath("/finds/abc?from=history#top")).toBe("/finds/abc?from=history#top");
  });

  it("falls back to /scan for missing, external, or API targets", () => {
    for (const value of [null, "", "scan", "https://evil.example/", "//evil.example", "/\\evil.example", "/api", "/api/stats", "/api?x=1", "/scan\n"]) {
      expect(safeReturnPath(value)).toBe("/scan");
    }
  });
});

describe("reauthRedirect", () => {
  it("redirects back to the return path on the same origin without caching", () => {
    const response = reauthRedirect(new URL("https://sales.example.test/api/auth/refresh?return=%2Fhistory"));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://sales.example.test/history");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("ignores an off-site return target", () => {
    const response = reauthRedirect(new URL("https://sales.example.test/api/auth/refresh?return=https%3A%2F%2Fevil.example"));
    expect(response.headers.get("location")).toBe("https://sales.example.test/scan");
  });
});
