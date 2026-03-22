import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAuditHealth,
  getConsecutiveAuditFailureCount,
  logAuditEvent,
  resetAuditCounters,
} from "../services/audit.service";

const { withTenantDrizzleScopeMock, auditLogMock } = vi.hoisted(() => ({
  withTenantDrizzleScopeMock: vi.fn(),
  auditLogMock: { __name: "auditLog" },
}));

vi.mock("@monet/db", () => ({
  auditLog: auditLogMock,
  withTenantDrizzleScope: (...args: unknown[]) => withTenantDrizzleScopeMock(...args),
}));

const ENTRY = {
  tenantId: "00000000-0000-0000-0000-000000000001",
  actorId: "00000000-0000-0000-0000-000000000002",
  actorType: "agent" as const,
  action: "rule.create",
  outcome: "success" as const,
};

function mockSuccess() {
  const valuesMock = vi.fn().mockResolvedValue([]);
  const insertMock = vi.fn(() => ({
    values: valuesMock,
  }));
  withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) =>
    fn({
      insert: insertMock,
    }),
  );
  return { insertMock, valuesMock };
}

describe("audit service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAuditCounters();
  });

  it("inserts an audit log record and returns success", async () => {
    const { insertMock, valuesMock } = mockSuccess();

    const result = await logAuditEvent({} as never, "tenant_test", {
      ...ENTRY,
      targetId: "00000000-0000-0000-0000-000000000003",
      reason: "ok",
    });

    expect(result).toEqual({ success: true });
    expect(withTenantDrizzleScopeMock).toHaveBeenCalledTimes(1);
    expect(insertMock).toHaveBeenCalledWith(auditLogMock);
    expect(valuesMock).toHaveBeenCalledWith({
      tenantId: ENTRY.tenantId,
      actorId: ENTRY.actorId,
      actorType: ENTRY.actorType,
      action: ENTRY.action,
      targetId: "00000000-0000-0000-0000-000000000003",
      outcome: ENTRY.outcome,
      reason: "ok",
      metadata: null,
    });
    expect(getConsecutiveAuditFailureCount()).toBe(0);
  });

  it("returns failure result when audit write fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    withTenantDrizzleScopeMock.mockRejectedValueOnce(new Error("db down"));

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
    withTenantDrizzleScopeMock.mockRejectedValueOnce(new Error("db down"));

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
    withTenantDrizzleScopeMock.mockRejectedValueOnce(new Error("db down"));
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
