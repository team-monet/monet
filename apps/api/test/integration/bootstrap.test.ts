import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getTestApp, getTestDb, cleanupTestData, closeTestDb } from "./helpers/setup";
import { platformInstallations } from "@monet/db";
import { ensureBootstrapToken } from "../../src/services/bootstrap.service";

describe("bootstrap routes", () => {
  beforeEach(async () => {
    await cleanupTestData();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("reports setup required for uninitialized installs", async () => {
    const app = getTestApp();
    const res = await app.request("/api/bootstrap/status");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      initialized: false,
      setupRequired: true,
    });
  });

  it("reports initialized once platform initialization is complete", async () => {
    const db = getTestDb();
    await db.insert(platformInstallations).values({
      initializedAt: new Date(),
    });

    const app = getTestApp();
    const res = await app.request("/api/bootstrap/status");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      initialized: true,
      setupRequired: false,
    });
  });

  it("exchanges a valid bootstrap token exactly once", async () => {
    const db = getTestDb();
    const bootstrapToken = await ensureBootstrapToken(db);
    expect(bootstrapToken).not.toBeNull();

    const app = getTestApp();
    const firstRes = await app.request("/api/bootstrap/exchange", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token: bootstrapToken!.rawToken }),
    });

    expect(firstRes.status).toBe(200);
    const firstBody = await firstRes.json();
    expect(firstBody).toHaveProperty("setupSessionToken");
    expect(firstBody).toHaveProperty("expiresAt");

    const secondRes = await app.request("/api/bootstrap/exchange", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token: bootstrapToken!.rawToken }),
    });

    expect(secondRes.status).toBe(401);
    expect(await secondRes.json()).toEqual({
      error: "bootstrap_error",
      message: "Invalid or expired bootstrap token",
    });
  });
});
