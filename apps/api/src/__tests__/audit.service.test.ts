import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAuditHealth,
  getConsecutiveAuditFailureCount,
  logAuditEvent,
  resetAuditCounters,
} from "../services/audit.service";

const withTenantScopeMock = vi.fn();

vi.mock("@monet/db", () => ({
  withTenantScope: (...args: unknown[]) => withTenantScopeMock(...args),
}));

const ENTRY = {
  tenantId: "00000000-0000-0000-0000-000000000001",
  actorId: "00000000-0000-0000-0000-000000000002",
  actorType: "agent" as const,
  action: "rule.create",
  outcome: "success" as const,
};

function mockSuccess() {
  const txMock = vi.fn().mockResolvedValue([]);
  withTenantScopeMock.mockImplementation(async (_sql, _schemaName, fn) =>
    fn(txMock),
  );
  return txMock;
}

describe("audit service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAuditCounters();
  });

  it("inserts an audit log record and returns success", async () => {
    const txMock = mockSuccess();

    const result = await logAuditEvent({} as never, "tenant_test", {
      ...ENTRY,
      targetId: "00000000-0000-0000-0000-000000000003",
      reason: "ok",
    });

    expect(result).toEqual({ success: true });
    expect(withTenantScopeMock).toHaveBeenCalledTimes(1);
    expect(txMock).toHaveBeenCalledTimes(1);
    expect(getConsecutiveAuditFailureCount()).toBe(0);
  });

  it("returns failure result when audit write fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    withTenantScopeMock.mockRejectedValueOnce(new Error("db down"));

    const result = await logAuditEvent({} as never, "tenant_test", ENTRY);

    expect(result).toEqual({ success: false, error: "db down" });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(getConsecutiveAuditFailureCount()).toBe(1);
    errorSpy.mockRestore();
  });

  it("reports healthy status when no failures have occurred", async () => {
    mockSuccess();
    await logAuditEvent({} as never, "tenant_test", ENTRY);

    const health = getAuditHealth();
    expect(health.status).toBe("healthy");
    expect(health.consecutiveFailures).toBe(0);
  });

  it("reports degraded status after a failure", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    withTenantScopeMock.mockRejectedValueOnce(new Error("db down"));

    await logAuditEvent({} as never, "tenant_test", ENTRY);

    const health = getAuditHealth();
    expect(health.status).toBe("degraded");
    expect(health.consecutiveFailures).toBe(1);
    expect(health.totalFailures).toBe(1);
    errorSpy.mockRestore();
  });

  it("resets consecutive failures on success after failure, keeps total", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // trigger failure
    withTenantScopeMock.mockRejectedValueOnce(new Error("db down"));
    await logAuditEvent({} as never, "tenant_test", ENTRY);
    expect(getAuditHealth().consecutiveFailures).toBe(1);
    expect(getAuditHealth().totalFailures).toBe(1);

    // trigger success — consecutive resets, total stays
    mockSuccess();
    await logAuditEvent({} as never, "tenant_test", ENTRY);

    const health = getAuditHealth();
    expect(health.consecutiveFailures).toBe(0);
    expect(health.totalFailures).toBe(1);
    expect(health.status).toBe("healthy");
    errorSpy.mockRestore();
  });
});
