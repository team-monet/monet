import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app";

describe("health endpoints", () => {
  const originalProvider = process.env.ENRICHMENT_PROVIDER;

  beforeEach(() => {
    process.env.ENRICHMENT_PROVIDER = "ollama";
  });

  afterEach(() => {
    if (originalProvider === undefined) {
      delete process.env.ENRICHMENT_PROVIDER;
    } else {
      process.env.ENRICHMENT_PROVIDER = originalProvider;
    }
  });

  it("GET /health returns status ok", async () => {
    const app = createApp(null, null);
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body).toHaveProperty("timestamp");
    expect(body).toHaveProperty("version");
  });

  it("GET /health/live returns status ok", async () => {
    const app = createApp(null, null);
    const res = await app.request("/health/live");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("GET /health/ready returns status ok when database is reachable", async () => {
    const sql = vi.fn(async () => [{ "?column?": 1 }]);
    const app = createApp(null, sql as never);
    const res = await app.request("/health/ready");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ok",
      db: "connected",
      enrichment: "configured",
    });
  });

  it("GET /health/ready returns 503 when database is unreachable", async () => {
    const sql = vi.fn(async () => {
      throw new Error("db down");
    });
    const app = createApp(null, sql as never);
    const res = await app.request("/health/ready");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      status: "not_ready",
      db: "disconnected",
      enrichment: "configured",
    });
  });

  it("GET /health/ready returns 503 when enrichment provider is not configured", async () => {
    delete process.env.ENRICHMENT_PROVIDER;
    const sql = vi.fn(async () => [{ "?column?": 1 }]);
    const app = createApp(null, sql as never);
    const res = await app.request("/health/ready");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      status: "not_ready",
      db: "connected",
      enrichment: "not_configured",
    });
  });
});
