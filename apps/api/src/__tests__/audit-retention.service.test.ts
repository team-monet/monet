import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  currentAuditRetentionDays,
  purgeExpiredAuditEntries,
  purgeExpiredAuditEntriesAcrossTenants,
  startAuditRetentionJob,
  stopAuditRetentionJob,
} from "../services/audit-retention.service";

const { withTenantDrizzleScopeMock, auditLogMock } = vi.hoisted(() => ({
  withTenantDrizzleScopeMock: vi.fn(),
  auditLogMock: { __name: "auditLog" },
}));

vi.mock("@monet/db", () => ({
  auditLog: auditLogMock,
  withTenantDrizzleScope: (...args: unknown[]) => withTenantDrizzleScopeMock(...args),
}));

const VALID_SCHEMA_ONE = "tenant_00000000_0000_0000_0000_000000000001";
const VALID_SCHEMA_TWO = "tenant_00000000_0000_0000_0000_000000000002";

function mockDeleteCount(count: number) {
  const whereMock = vi.fn().mockResolvedValue({ count });
  const deleteMock = vi.fn(() => ({
    where: whereMock,
  }));

  withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) =>
    fn({
      delete: deleteMock,
    }),
  );

  return { deleteMock, whereMock };
}

describe("audit retention service", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    delete process.env.AUDIT_RETENTION_DAYS;
    await stopAuditRetentionJob();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    delete process.env.AUDIT_RETENTION_DAYS;
    await stopAuditRetentionJob();
  });

  it("uses the default retention window when the env var is absent or invalid", () => {
    expect(currentAuditRetentionDays()).toBe(90);

    process.env.AUDIT_RETENTION_DAYS = "0";
    expect(currentAuditRetentionDays()).toBe(90);

    process.env.AUDIT_RETENTION_DAYS = "-1";
    expect(currentAuditRetentionDays()).toBe(90);

    process.env.AUDIT_RETENTION_DAYS = "abc";
    expect(currentAuditRetentionDays()).toBe(90);

    process.env.AUDIT_RETENTION_DAYS = "Infinity";
    expect(currentAuditRetentionDays()).toBe(90);

    process.env.AUDIT_RETENTION_DAYS = "14.9";
    expect(currentAuditRetentionDays()).toBe(14);
  });

  it("does not run purge when AUDIT_PURGE_ENABLED is unset", () => {
    vi.stubEnv("AUDIT_PURGE_ENABLED", "");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const sqlMock = vi.fn().mockResolvedValue([]);

    startAuditRetentionJob(sqlMock as never);

    expect(logSpy).toHaveBeenCalledWith(
      "[audit-retention] Purge disabled (set AUDIT_PURGE_ENABLED=true to enable)",
    );
    expect(sqlMock).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("does not run purge when AUDIT_PURGE_ENABLED is set to a non-true value", () => {
    vi.stubEnv("AUDIT_PURGE_ENABLED", "false");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const sqlMock = vi.fn().mockResolvedValue([]);

    startAuditRetentionJob(sqlMock as never);

    expect(logSpy).toHaveBeenCalledWith(
      "[audit-retention] Purge disabled (set AUDIT_PURGE_ENABLED=true to enable)",
    );
    expect(sqlMock).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("enters the purge path when AUDIT_PURGE_ENABLED=true", async () => {
    vi.stubEnv("AUDIT_PURGE_ENABLED", "true");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const sqlMock = vi.fn().mockResolvedValue([]);

    startAuditRetentionJob(sqlMock as never);
    await Promise.resolve();
    await Promise.resolve();

    expect(sqlMock).toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalledWith(
      "[audit-retention] Purge disabled (set AUDIT_PURGE_ENABLED=true to enable)",
    );
    logSpy.mockRestore();
  });

  it("purges expired audit entries through the tenant-scoped Drizzle helper", async () => {
    const { deleteMock, whereMock } = mockDeleteCount(3);

    const purged = await purgeExpiredAuditEntries(
      {} as never,
      VALID_SCHEMA_ONE,
      7.8,
    );

    expect(purged).toBe(3);
    expect(withTenantDrizzleScopeMock).toHaveBeenCalledTimes(1);
    expect(withTenantDrizzleScopeMock).toHaveBeenCalledWith(
      expect.anything(),
      VALID_SCHEMA_ONE,
      expect.any(Function),
    );
    expect(deleteMock).toHaveBeenCalledWith(auditLogMock);
    expect(whereMock).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid tenant schema names before opening a scoped DB", async () => {
    await expect(
      purgeExpiredAuditEntries({} as never, "public", 30),
    ).rejects.toThrow("Invalid tenant schema name: public");

    expect(withTenantDrizzleScopeMock).not.toHaveBeenCalled();
  });

  it("purges only valid tenant schemas when running across tenants", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const sqlMock = vi.fn().mockResolvedValue([
      { schema_name: VALID_SCHEMA_ONE },
      { schema_name: "public" },
      { schema_name: "tenant_invalid" },
      { schema_name: VALID_SCHEMA_TWO },
    ]);

    withTenantDrizzleScopeMock.mockImplementation(async (_sql, schemaName, fn) => {
      const count = schemaName === VALID_SCHEMA_ONE ? 2 : 5;
      return fn({
        delete: vi.fn(() => ({
          where: vi.fn().mockResolvedValue({ count }),
        })),
      });
    });

    const purged = await purgeExpiredAuditEntriesAcrossTenants(
      sqlMock as never,
      30,
    );

    expect(purged).toBe(7);
    expect(sqlMock).toHaveBeenCalledTimes(1);
    expect(withTenantDrizzleScopeMock).toHaveBeenCalledTimes(2);
    expect(withTenantDrizzleScopeMock).toHaveBeenNthCalledWith(
      1,
      sqlMock,
      VALID_SCHEMA_ONE,
      expect.any(Function),
    );
    expect(withTenantDrizzleScopeMock).toHaveBeenNthCalledWith(
      2,
      sqlMock,
      VALID_SCHEMA_TWO,
      expect.any(Function),
    );
    expect(logSpy).toHaveBeenCalledWith(
      `[audit-retention] Purged 2 entries from schema ${VALID_SCHEMA_ONE}`,
    );
    expect(logSpy).toHaveBeenCalledWith(
      `[audit-retention] Purged 5 entries from schema ${VALID_SCHEMA_TWO}`,
    );
    logSpy.mockRestore();
  });

  it("does not log schemas with zero deletions", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const sqlMock = vi.fn().mockResolvedValue([
      { schema_name: VALID_SCHEMA_ONE },
    ]);

    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) =>
      fn({
        delete: vi.fn(() => ({
          where: vi.fn().mockResolvedValue({ count: 0 }),
        })),
      }),
    );

    await purgeExpiredAuditEntriesAcrossTenants(sqlMock as never, 30);

    expect(logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("[audit-retention] Purged"),
    );
    logSpy.mockRestore();
  });

  it("continues purging other tenants when one tenant purge fails", async () => {
    const sqlMock = vi.fn().mockResolvedValue([
      { schema_name: VALID_SCHEMA_ONE },
      { schema_name: VALID_SCHEMA_TWO },
    ]);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    withTenantDrizzleScopeMock.mockImplementation(async (_sql, schemaName, fn) => {
      if (schemaName === VALID_SCHEMA_ONE) {
        throw new Error("tenant purge failed");
      }

      return fn({
        delete: vi.fn(() => ({
          where: vi.fn().mockResolvedValue({ count: 4 }),
        })),
      });
    });

    const purged = await purgeExpiredAuditEntriesAcrossTenants(
      sqlMock as never,
      30,
    );

    expect(purged).toBe(4);
    expect(withTenantDrizzleScopeMock).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledWith(
      `[audit-retention] Failed to purge ${VALID_SCHEMA_ONE}:`,
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it("replaces an existing interval when the audit retention job is started twice", async () => {
    vi.useFakeTimers();
    vi.stubEnv("AUDIT_PURGE_ENABLED", "true");

    const sqlMock = vi.fn().mockResolvedValue([
      { schema_name: VALID_SCHEMA_ONE },
    ]);

    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) =>
      fn({
        delete: vi.fn(() => ({
          where: vi.fn().mockResolvedValue({ count: 0 }),
        })),
      }),
    );

    startAuditRetentionJob(sqlMock as never, 30);
    await Promise.resolve();
    await Promise.resolve();

    startAuditRetentionJob(sqlMock as never, 30);
    await Promise.resolve();
    await Promise.resolve();

    expect(withTenantDrizzleScopeMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

    expect(withTenantDrizzleScopeMock).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});
