import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const withTenantScopeMock = vi.fn();

vi.mock("@monet/db", () => ({
  withTenantScope: (...args: unknown[]) => withTenantScopeMock(...args),
}));

import {
  startAuditRetentionJob,
  stopAuditRetentionJob,
  purgeExpiredAuditEntriesAcrossTenants,
} from "../services/audit-retention.service";

function makeSql(schemas: string[] = []) {
  const rows = schemas.map((s) => ({ schema_name: s }));
  return Object.assign(vi.fn().mockResolvedValue(rows), {
    begin: vi.fn(),
  }) as unknown as Parameters<typeof startAuditRetentionJob>[0];
}

describe("audit-retention service", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    stopAuditRetentionJob();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  describe("env var guard (AUDIT_PURGE_ENABLED)", () => {
    it("does NOT run purge when AUDIT_PURGE_ENABLED is unset", () => {
      vi.stubEnv("AUDIT_PURGE_ENABLED", "");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const sql = makeSql();

      startAuditRetentionJob(sql);

      expect(logSpy).toHaveBeenCalledWith(
        "[audit-retention] Purge disabled (set AUDIT_PURGE_ENABLED=true to enable)",
      );
      // sql should never be called — no purge was attempted
      expect(sql).not.toHaveBeenCalled();

      logSpy.mockRestore();
    });

    it("does NOT run purge when AUDIT_PURGE_ENABLED is set to a non-true value", () => {
      vi.stubEnv("AUDIT_PURGE_ENABLED", "false");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const sql = makeSql();

      startAuditRetentionJob(sql);

      expect(logSpy).toHaveBeenCalledWith(
        "[audit-retention] Purge disabled (set AUDIT_PURGE_ENABLED=true to enable)",
      );
      expect(sql).not.toHaveBeenCalled();

      logSpy.mockRestore();
    });

    it("DOES run purge when AUDIT_PURGE_ENABLED=true", () => {
      vi.stubEnv("AUDIT_PURGE_ENABLED", "true");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const sql = makeSql();

      startAuditRetentionJob(sql);

      // The sql tagged template function should have been called for the
      // schema query, proving the purge path was entered.
      expect(sql).toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalledWith(
        "[audit-retention] Purge disabled (set AUDIT_PURGE_ENABLED=true to enable)",
      );

      logSpy.mockRestore();
    });
  });

  describe("per-schema purge logging", () => {
    it("logs each schema with its deleted count when purge runs", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const txMock = vi.fn().mockResolvedValue({ count: 5 });
      withTenantScopeMock.mockImplementation(async (_sql, _schema, fn) =>
        fn(txMock),
      );

      const sql = makeSql([
        "tenant_00000000_0000_0000_0000_000000000001",
        "tenant_00000000_0000_0000_0000_000000000002",
      ]);

      await purgeExpiredAuditEntriesAcrossTenants(sql, 90);

      expect(logSpy).toHaveBeenCalledWith(
        "[audit-retention] Purged 5 entries from schema tenant_00000000_0000_0000_0000_000000000001",
      );
      expect(logSpy).toHaveBeenCalledWith(
        "[audit-retention] Purged 5 entries from schema tenant_00000000_0000_0000_0000_000000000002",
      );

      logSpy.mockRestore();
    });

    it("does not log schemas with zero deletions", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const txMock = vi.fn().mockResolvedValue({ count: 0 });
      withTenantScopeMock.mockImplementation(async (_sql, _schema, fn) =>
        fn(txMock),
      );

      const sql = makeSql([
        "tenant_00000000_0000_0000_0000_000000000001",
      ]);

      await purgeExpiredAuditEntriesAcrossTenants(sql, 90);

      expect(logSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("[audit-retention] Purged"),
      );

      logSpy.mockRestore();
    });
  });
});
