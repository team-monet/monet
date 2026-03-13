import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/bootstrap.service.js", () => {
  class MockBootstrapTokenError extends Error {
    status: 400 | 401 | 409;

    constructor(message: string, status: 400 | 401 | 409 = 400) {
      super(message);
      this.name = "BootstrapTokenError";
      this.status = status;
    }
  }

  return {
    BootstrapTokenError: MockBootstrapTokenError,
    getBootstrapStatus: vi.fn(),
    exchangeBootstrapToken: vi.fn(),
  };
});

import { createApp } from "../app";
import {
  BootstrapTokenError,
  exchangeBootstrapToken,
  getBootstrapStatus,
} from "../services/bootstrap.service";

describe("bootstrap routes", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("GET /api/bootstrap/status returns bootstrap state", async () => {
    vi.mocked(getBootstrapStatus).mockResolvedValue({
      initialized: false,
      setupRequired: true,
    });

    const app = createApp({} as never, null);
    const res = await app.request("/api/bootstrap/status");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      initialized: false,
      setupRequired: true,
    });
  });

  it("POST /api/bootstrap/exchange validates missing token", async () => {
    const app = createApp({} as never, null);
    const res = await app.request("/api/bootstrap/exchange", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "validation_error",
      message: "Bootstrap token is required",
    });
  });

  it("POST /api/bootstrap/exchange returns a setup session token", async () => {
    vi.mocked(exchangeBootstrapToken).mockResolvedValue({
      sessionToken: "mss_test_session",
      expiresAt: new Date("2026-03-08T12:00:00.000Z"),
    });

    const app = createApp({} as never, null);
    const res = await app.request("/api/bootstrap/exchange", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token: "mbt_valid" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      setupSessionToken: "mss_test_session",
      expiresAt: "2026-03-08T12:00:00.000Z",
    });
  });

  it("POST /api/bootstrap/exchange maps bootstrap token errors", async () => {
    vi.mocked(exchangeBootstrapToken).mockRejectedValue(
      new BootstrapTokenError("Invalid or expired bootstrap token", 401),
    );

    const app = createApp({} as never, null);
    const res = await app.request("/api/bootstrap/exchange", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token: "mbt_invalid" }),
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "bootstrap_error",
      message: "Invalid or expired bootstrap token",
    });
  });
});
