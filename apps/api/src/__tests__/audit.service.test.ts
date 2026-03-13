import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getConsecutiveAuditFailureCount,
  logAuditEvent,
} from "../services/audit.service";

const withTenantScopeMock = vi.fn();

vi.mock("@monet/db", () => ({
  withTenantScope: (...args: unknown[]) => withTenantScopeMock(...args),
}));

describe("audit service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("inserts an audit log record with expected fields", async () => {
    const txMock = vi.fn().mockResolvedValue([]);
    withTenantScopeMock.mockImplementation(async (_sql, _schemaName, fn) =>
      fn(txMock),
    );

    await logAuditEvent({} as never, "tenant_test", {
      tenantId: "00000000-0000-0000-0000-000000000001",
      actorId: "00000000-0000-0000-0000-000000000002",
      actorType: "agent",
      action: "rule.create",
      targetId: "00000000-0000-0000-0000-000000000003",
      outcome: "success",
      reason: "ok",
    });

    expect(withTenantScopeMock).toHaveBeenCalledTimes(1);
    expect(txMock).toHaveBeenCalledTimes(1);
    expect(getConsecutiveAuditFailureCount()).toBe(0);
  });

  it("does not throw when audit write fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    withTenantScopeMock.mockRejectedValueOnce(new Error("db down"));

    await expect(
      logAuditEvent({} as never, "tenant_test", {
        tenantId: "00000000-0000-0000-0000-000000000001",
        actorId: "00000000-0000-0000-0000-000000000002",
        actorType: "agent",
        action: "rule.create",
        outcome: "success",
      }),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(getConsecutiveAuditFailureCount()).toBeGreaterThan(0);
    errorSpy.mockRestore();
  });
});
