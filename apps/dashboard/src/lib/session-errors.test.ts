import { describe, expect, it } from "vitest";
import {
  buildSessionRecoveryGuardKey,
  clearActiveSessionRecoveryGuard,
  hasActiveSessionRecoveryGuard,
  isExcludedFromSessionRecovery,
  normalizeInternalCallbackUrl,
  setActiveSessionRecoveryGuard,
} from "./session-errors";

function createStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

describe("session recovery helpers", () => {
  it("normalizes callback URLs to internal paths only", () => {
    expect(normalizeInternalCallbackUrl("/tenants/acme?tab=agents")).toBe(
      "/tenants/acme?tab=agents",
    );
    expect(normalizeInternalCallbackUrl("https://evil.example.com")).toBe("/");
    expect(normalizeInternalCallbackUrl("//evil.example.com/path")).toBe("/");
    expect(normalizeInternalCallbackUrl("", "/platform")).toBe("/platform");
  });

  it("tracks one bounded recovery attempt in session storage", () => {
    const storage = createStorage();
    const key = buildSessionRecoveryGuardKey("tenant", "/agents?view=active#section");

    setActiveSessionRecoveryGuard(storage, key, 1_000, 2_000);
    expect(hasActiveSessionRecoveryGuard(storage, key, 2_500)).toBe(true);
    expect(hasActiveSessionRecoveryGuard(storage, key, 3_500)).toBe(false);
  });

  it("clears active recovery guard after successful auth", () => {
    const storage = createStorage();
    const key = buildSessionRecoveryGuardKey("platform", "/platform");
    setActiveSessionRecoveryGuard(storage, key, 5_000, 2_000);

    clearActiveSessionRecoveryGuard(storage);
    expect(hasActiveSessionRecoveryGuard(storage, key, 5_100)).toBe(false);
  });

  it("excludes auth-sensitive paths from recovery loops", () => {
    expect(isExcludedFromSessionRecovery("/login")).toBe(true);
    expect(isExcludedFromSessionRecovery("/platform/login")).toBe(true);
    expect(isExcludedFromSessionRecovery("/setup")).toBe(true);
    expect(isExcludedFromSessionRecovery("/signout")).toBe(true);
    expect(isExcludedFromSessionRecovery("/auth/session-recovery")).toBe(true);
    expect(isExcludedFromSessionRecovery("/api/auth/callback/tenant-oauth")).toBe(
      true,
    );
    expect(isExcludedFromSessionRecovery("/agents")).toBe(false);
  });
});
