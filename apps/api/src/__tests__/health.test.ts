import { describe, it, expect } from "vitest";
import { createApp } from "../app.js";

const app = createApp(null, null);

describe("health endpoints", () => {
  it("GET /health returns status ok", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body).toHaveProperty("timestamp");
    expect(body).toHaveProperty("version");
  });

  it("GET /health/live returns status ok", async () => {
    const res = await app.request("/health/live");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("GET /health/ready returns status ok", async () => {
    const res = await app.request("/health/ready");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
