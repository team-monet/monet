import { afterEach, describe, expect, it, vi } from "vitest";
import { logRequest, writeStructuredLog } from "../lib/log";

function restoreEnv(name: string, previous: string | undefined) {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

describe("structured logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs request entries to stdout by default", () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousForceLogs = process.env.FORCE_REQUEST_LOGS;
    const previousLogLevel = process.env.LOG_LEVEL;

    process.env.NODE_ENV = "test";
    process.env.FORCE_REQUEST_LOGS = "true";
    delete process.env.LOG_LEVEL;

    const infoSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    logRequest({
      requestId: "req-1",
      method: "GET",
      path: "/health",
      statusCode: 200,
      latencyMs: 12.34,
      tenantId: "tenant-1",
      agentId: "agent-1",
      message: "http_request",
    });

    expect(infoSpy).toHaveBeenCalledOnce();
    expect(String(infoSpy.mock.calls[0]?.[0])).toContain("\"message\":\"http_request\"");

    restoreEnv("NODE_ENV", previousNodeEnv);
    restoreEnv("FORCE_REQUEST_LOGS", previousForceLogs);
    restoreEnv("LOG_LEVEL", previousLogLevel);
  });

  it("suppresses info request logs when LOG_LEVEL=warn", () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousForceLogs = process.env.FORCE_REQUEST_LOGS;
    const previousLogLevel = process.env.LOG_LEVEL;

    process.env.NODE_ENV = "test";
    process.env.FORCE_REQUEST_LOGS = "true";
    process.env.LOG_LEVEL = "warn";

    const infoSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    logRequest({
      requestId: "req-1",
      method: "GET",
      path: "/health",
      statusCode: 200,
      latencyMs: 12.34,
    });

    expect(infoSpy).not.toHaveBeenCalled();

    restoreEnv("NODE_ENV", previousNodeEnv);
    restoreEnv("FORCE_REQUEST_LOGS", previousForceLogs);
    restoreEnv("LOG_LEVEL", previousLogLevel);
  });

  it("routes info structured logs to stdout by default", () => {
    const previousLogLevel = process.env.LOG_LEVEL;
    delete process.env.LOG_LEVEL;

    const infoSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    writeStructuredLog({ level: "info", message: "info_event" });

    expect(infoSpy).toHaveBeenCalledOnce();
    expect(String(infoSpy.mock.calls[0]?.[0])).toContain("\"message\":\"info_event\"");

    restoreEnv("LOG_LEVEL", previousLogLevel);
  });

  it("routes warn/error structured logs to the matching console stream", () => {
    const previousLogLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "info";

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    writeStructuredLog({ level: "warn", message: "warn_event" });
    writeStructuredLog({ level: "error", message: "error_event" });

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("\"message\":\"warn_event\"");
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("\"message\":\"error_event\"");

    restoreEnv("LOG_LEVEL", previousLogLevel);
  });
});
