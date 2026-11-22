import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessExpiredError, apiFetch, isAccessChallenge, REAUTH_PATH, reauthenticate } from "./api";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

function fakeLocation(path = "/finds/abc", search = "?from=scan", hash = "") {
  return { pathname: path, search, hash, assign: vi.fn() };
}

describe("isAccessChallenge", () => {
  it("treats opaque redirects and 401s as an Access challenge", () => {
    expect(isAccessChallenge({ type: "opaqueredirect", status: 0 })).toBe(true);
    expect(isAccessChallenge({ type: "basic", status: 401 })).toBe(true);
  });

  it("passes through normal API responses, including errors", () => {
    expect(isAccessChallenge({ type: "basic", status: 200 })).toBe(false);
    expect(isAccessChallenge({ type: "basic", status: 503 })).toBe(false);
  });
});

describe("reauthenticate", () => {
  it("navigates to the refresh path with the current location as the return target", () => {
    const location = fakeLocation();
    expect(reauthenticate(location, memoryStorage(), 1_000_000)).toBe(true);
    expect(location.assign).toHaveBeenCalledWith(`${REAUTH_PATH}?return=${encodeURIComponent("/finds/abc?from=scan")}`);
  });

  it("does not loop when Access keeps challenging right after a sign-in", () => {
    const storage = memoryStorage();
    const location = fakeLocation();
    expect(reauthenticate(location, storage, 1_000_000)).toBe(true);
    expect(reauthenticate(location, storage, 1_030_000)).toBe(false);
    expect(location.assign).toHaveBeenCalledTimes(1);
    expect(reauthenticate(location, storage, 1_061_000)).toBe(true);
  });
});

describe("apiFetch", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks fetch not to follow redirects and returns normal responses", async () => {
    const response = { type: "basic", status: 200 } as Response;
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiFetch("/api/stats", { method: "GET" })).resolves.toBe(response);
    expect(fetchMock).toHaveBeenCalledWith("/api/stats", { method: "GET", redirect: "manual" });
  });

  it("starts sign-in and throws a readable error when Access redirects the call", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ type: "opaqueredirect", status: 0 }));
    const location = fakeLocation("/scan", "");
    vi.stubGlobal("window", { location, sessionStorage: memoryStorage() });

    const error = await apiFetch("/api/sessions", { method: "POST" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AccessExpiredError);
    expect((error as Error).message).toMatch(/Signing you back in/);
    expect(location.assign).toHaveBeenCalledWith(`${REAUTH_PATH}?return=%2Fscan`);
  });
});
