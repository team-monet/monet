import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  purgeExpiredEntriesAcrossTenants,
  purgeExpiredEntriesInSchema,
  startTtlExpiryJob,
  stopTtlExpiryJob,
} from "../services/ttl-expiry.service";

const withTenantDrizzleScopeMock = vi.fn();

vi.mock("@monet/db", async () => {
  const actual = await vi.importActual<typeof import("@monet/db")>("@monet/db");
  return {
    ...actual,
    withTenantDrizzleScope: (...args: unknown[]) => withTenantDrizzleScopeMock(...args),
  };
});

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

describe("ttl expiry service", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await stopTtlExpiryJob();
  });

  afterEach(async () => {
    await stopTtlExpiryJob();
    vi.useRealTimers();
  });

  it("purges expired entries through the tenant-scoped Drizzle helper", async () => {
    const { deleteMock, whereMock } = mockDeleteCount(2);

    const deleted = await purgeExpiredEntriesInSchema(
      {} as never,
      VALID_SCHEMA_ONE,
    );

    expect(deleted).toBe(2);
    expect(withTenantDrizzleScopeMock).toHaveBeenCalledTimes(1);
    expect(withTenantDrizzleScopeMock).toHaveBeenCalledWith(
      expect.anything(),
      VALID_SCHEMA_ONE,
      expect.any(Function),
    );
    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(whereMock).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid tenant schema names before opening a scoped DB", async () => {
    await expect(
      purgeExpiredEntriesInSchema({} as never, "public"),
    ).rejects.toThrow("Invalid tenant schema name: public");

    expect(withTenantDrizzleScopeMock).not.toHaveBeenCalled();
  });

  it("purges only valid tenant schemas when running across tenants", async () => {
    const sqlMock = vi.fn().mockResolvedValue([
      { schema_name: VALID_SCHEMA_ONE },
      { schema_name: "public" },
      { schema_name: "tenant_invalid" },
      { schema_name: VALID_SCHEMA_TWO },
    ]);

    withTenantDrizzleScopeMock.mockImplementation(async (_sql, schemaName, fn) => {
      const count = schemaName === VALID_SCHEMA_ONE ? 1 : 3;
      return fn({
        delete: vi.fn(() => ({
          where: vi.fn().mockResolvedValue({ count }),
        })),
      });
    });

    const deleted = await purgeExpiredEntriesAcrossTenants(sqlMock as never);

    expect(deleted).toBe(4);
    expect(sqlMock).toHaveBeenCalledTimes(1);
    expect(withTenantDrizzleScopeMock).toHaveBeenCalledTimes(2);
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
          where: vi.fn().mockResolvedValue({ count: 5 }),
        })),
      });
    });

    const deleted = await purgeExpiredEntriesAcrossTenants(sqlMock as never);

    expect(deleted).toBe(5);
    expect(withTenantDrizzleScopeMock).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledWith(
      `[ttl-expiry] Failed to purge ${VALID_SCHEMA_ONE}:`,
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it("replaces an existing interval when the ttl expiry job is started twice", async () => {
    vi.useFakeTimers();

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

    startTtlExpiryJob(sqlMock as never);
    await Promise.resolve();
    await Promise.resolve();

    startTtlExpiryJob(sqlMock as never);
    await Promise.resolve();
    await Promise.resolve();

    expect(withTenantDrizzleScopeMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(withTenantDrizzleScopeMock).toHaveBeenCalledTimes(3);
  });

  it("waits for in-flight ttl purge work before stopping", async () => {
    const sqlMock = vi.fn().mockResolvedValue([
      { schema_name: VALID_SCHEMA_ONE },
    ]);

    let resolveDelete: ((value: { count: number }) => void) | null = null;
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) =>
      fn({
        delete: vi.fn(() => ({
          where: vi.fn(() => new Promise<{ count: number }>((resolve) => {
            resolveDelete = resolve;
          })),
        })),
      }),
    );

    startTtlExpiryJob(sqlMock as never);
    await Promise.resolve();
    await Promise.resolve();

    let stopped = false;
    const stopPromise = stopTtlExpiryJob().then(() => {
      stopped = true;
    });

    await Promise.resolve();
    expect(stopped).toBe(false);

    expect(resolveDelete).not.toBeNull();
    resolveDelete!({ count: 0 });
    await stopPromise;
    expect(stopped).toBe(true);
  });
});
