import {
  agentGroupMembers,
  agentGroups,
  tenants,
  userGroupAgentGroupPermissions,
  userGroups,
  type Database,
  type SqlClient,
  type TransactionClient,
} from "@monet/db";
import {
  DEFAULT_AGENT_GROUP_DESCRIPTION,
  DEFAULT_AGENT_GROUP_NAME,
  DEFAULT_USER_GROUP_DESCRIPTION,
  DEFAULT_USER_GROUP_NAME,
} from "@monet/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  drizzleMock,
  createTenantSchemaMock,
  ensureVectorExtensionMock,
  provisionAgentWithApiKeyMock,
  seedDefaultGeneralGuidanceMock,
} = vi.hoisted(() => ({
  drizzleMock: vi.fn(),
  createTenantSchemaMock: vi.fn(),
  ensureVectorExtensionMock: vi.fn(),
  provisionAgentWithApiKeyMock: vi.fn(),
  seedDefaultGeneralGuidanceMock: vi.fn(),
}));

vi.mock("drizzle-orm/postgres-js", () => ({
  drizzle: (...args: unknown[]) => drizzleMock(...args),
}));

vi.mock("@monet/db", async () => {
  const actual = await vi.importActual<typeof import("@monet/db")>("@monet/db");
  return {
    ...actual,
    createTenantSchema: createTenantSchemaMock,
    ensureVectorExtension: ensureVectorExtensionMock,
  };
});

vi.mock("../services/agent-provisioning.service", () => ({
  provisionAgentWithApiKey: provisionAgentWithApiKeyMock,
}));

vi.mock("../services/default-rule-seed.service", () => ({
  seedDefaultGeneralGuidance: seedDefaultGeneralGuidanceMock,
}));

import {
  ensureTenantSchemasCurrent,
  provisionTenant,
} from "../services/tenant.service";

describe("tenant service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ensures tenant schemas in creation order", async () => {
    const orderByMock = vi.fn().mockResolvedValue([
      { id: "00000000-0000-0000-0000-000000000010" },
      { id: "00000000-0000-0000-0000-000000000011" },
    ]);
    const fromMock = vi.fn(() => ({
      orderBy: orderByMock,
    }));
    const selectMock = vi.fn(() => ({
      from: fromMock,
    }));

    drizzleMock.mockReturnValue({
      select: selectMock,
    });

    const sql = {} as SqlClient;
    createTenantSchemaMock.mockResolvedValue("tenant_schema");

    const result = await ensureTenantSchemasCurrent(sql);

    expect(ensureVectorExtensionMock).toHaveBeenCalledWith(sql);
    expect(ensureVectorExtensionMock.mock.invocationCallOrder[0]).toBeLessThan(
      drizzleMock.mock.invocationCallOrder[0],
    );
    expect(drizzleMock).toHaveBeenCalledWith(sql);
    expect(selectMock).toHaveBeenCalledWith({ id: tenants.id });
    expect(createTenantSchemaMock).toHaveBeenNthCalledWith(
      1,
      sql,
      "00000000-0000-0000-0000-000000000010",
    );
    expect(createTenantSchemaMock).toHaveBeenNthCalledWith(
      2,
      sql,
      "00000000-0000-0000-0000-000000000011",
    );
    expect(result).toBe(2);
  });

  it("provisions a tenant and default groups through Drizzle inside one transaction", async () => {
    const txSql = {} as TransactionClient;
    const beginMock = vi.fn(async (fn: (sql: TransactionClient) => Promise<unknown>) =>
      fn(txSql),
    );
    const sql = {
      begin: beginMock,
      options: {
        parsers: {},
        serializers: {},
      },
    } as unknown as SqlClient;

    const tenantReturningMock = vi.fn().mockResolvedValue([
      {
        id: "00000000-0000-0000-0000-000000000100",
        name: "Acme",
        slug: "acme",
        isolationMode: "logical",
        createdAt: new Date("2026-03-22T00:00:00.000Z"),
      },
    ]);
    const defaultUserGroupReturningMock = vi.fn().mockResolvedValue([
      { id: "00000000-0000-0000-0000-000000000101" },
    ]);
    const defaultAgentGroupReturningMock = vi.fn().mockResolvedValue([
      { id: "00000000-0000-0000-0000-000000000102" },
    ]);
    const tenantValuesMock = vi.fn(() => ({
      returning: tenantReturningMock,
    }));
    const userGroupValuesMock = vi.fn(() => ({
      returning: defaultUserGroupReturningMock,
    }));
    const agentGroupValuesMock = vi.fn(() => ({
      returning: defaultAgentGroupReturningMock,
    }));
    const membershipValuesMock = vi.fn().mockResolvedValue(undefined);
    const permissionValuesMock = vi.fn().mockResolvedValue(undefined);
    const slugLookupLimitMock = vi.fn().mockResolvedValue([]);
    const slugLookupWhereMock = vi.fn(() => ({
      limit: slugLookupLimitMock,
    }));
    const slugLookupFromMock = vi.fn(() => ({
      where: slugLookupWhereMock,
    }));
    const slugLookupSelectMock = vi.fn(() => ({
      from: slugLookupFromMock,
    }));
    const insertMock = vi
      .fn()
      .mockReturnValueOnce({ values: tenantValuesMock })
      .mockReturnValueOnce({ values: userGroupValuesMock })
      .mockReturnValueOnce({ values: agentGroupValuesMock })
      .mockReturnValueOnce({ values: membershipValuesMock })
      .mockReturnValueOnce({ values: permissionValuesMock });

    drizzleMock.mockReturnValue({
      select: slugLookupSelectMock,
      insert: insertMock,
    });
    createTenantSchemaMock.mockResolvedValue(
      "tenant_00000000_0000_0000_0000_000000000100",
    );
    provisionAgentWithApiKeyMock.mockResolvedValue({
      agent: {
        id: "00000000-0000-0000-0000-000000000103",
        externalId: "admin@acme",
      },
      rawApiKey: "mnt_test.key",
    });
    seedDefaultGeneralGuidanceMock.mockResolvedValue({
      ruleSetId: "00000000-0000-0000-0000-000000000104",
      ruleCount: 9,
    });

    const result = await provisionTenant({} as Database, sql, {
      name: "Acme",
      slug: "acme",
    });

    expect(ensureVectorExtensionMock).toHaveBeenCalledWith(sql);
    expect(ensureVectorExtensionMock.mock.invocationCallOrder[0]).toBeLessThan(
      beginMock.mock.invocationCallOrder[0],
    );
    expect(beginMock).toHaveBeenCalledTimes(1);
    const drizzleClient = drizzleMock.mock.calls[0]?.[0] as {
      options?: typeof sql.options;
    };
    expect(drizzleClient).not.toBe(txSql);
    expect(drizzleClient.options).toBe(sql.options);
    expect(insertMock).toHaveBeenNthCalledWith(1, tenants);
    expect(slugLookupSelectMock).toHaveBeenCalledWith({ id: tenants.id });
    expect(tenantValuesMock).toHaveBeenCalledWith({
      name: "Acme",
      slug: "acme",
      isolationMode: "logical",
    });
    expect(createTenantSchemaMock).toHaveBeenCalledWith(
      txSql,
      "00000000-0000-0000-0000-000000000100",
    );
    expect(insertMock).toHaveBeenNthCalledWith(2, userGroups);
    expect(userGroupValuesMock).toHaveBeenCalledWith({
      tenantId: "00000000-0000-0000-0000-000000000100",
      name: DEFAULT_USER_GROUP_NAME,
      description: DEFAULT_USER_GROUP_DESCRIPTION,
    });
    expect(insertMock).toHaveBeenNthCalledWith(3, agentGroups);
    expect(agentGroupValuesMock).toHaveBeenCalledWith({
      tenantId: "00000000-0000-0000-0000-000000000100",
      name: DEFAULT_AGENT_GROUP_NAME,
      description: DEFAULT_AGENT_GROUP_DESCRIPTION,
    });
    expect(provisionAgentWithApiKeyMock).toHaveBeenCalledWith(txSql, {
      externalId: "admin@acme",
      tenantId: "00000000-0000-0000-0000-000000000100",
      isAutonomous: false,
      role: "tenant_admin",
    });
    expect(insertMock).toHaveBeenNthCalledWith(4, agentGroupMembers);
    expect(membershipValuesMock).toHaveBeenCalledWith({
      agentId: "00000000-0000-0000-0000-000000000103",
      groupId: "00000000-0000-0000-0000-000000000102",
    });
    expect(insertMock).toHaveBeenNthCalledWith(
      5,
      userGroupAgentGroupPermissions,
    );
    expect(permissionValuesMock).toHaveBeenCalledWith({
      userGroupId: "00000000-0000-0000-0000-000000000101",
      agentGroupId: "00000000-0000-0000-0000-000000000102",
    });
    expect(seedDefaultGeneralGuidanceMock).toHaveBeenCalledWith(
      txSql,
      "tenant_00000000_0000_0000_0000_000000000100",
      "00000000-0000-0000-0000-000000000102",
    );
    expect(result).toEqual({
      tenant: {
        id: "00000000-0000-0000-0000-000000000100",
        name: "Acme",
        slug: "acme",
        isolationMode: "logical",
        createdAt: new Date("2026-03-22T00:00:00.000Z"),
      },
      agent: {
        id: "00000000-0000-0000-0000-000000000103",
        externalId: "admin@acme",
      },
      rawApiKey: "mnt_test.key",
    });
  });

  it("rejects reserved tenant slugs", async () => {
    const beginMock = vi.fn();
    const sql = {
      begin: beginMock,
    } as unknown as SqlClient;

    await expect(
      provisionTenant({} as Database, sql, {
        name: "Acme",
        slug: "api",
      }),
    ).rejects.toThrow("Slug is reserved. Choose another slug");

    expect(beginMock).not.toHaveBeenCalled();
  });

  it("returns a friendly error when slug already exists", async () => {
    const txSql = {} as TransactionClient;
    const beginMock = vi.fn(async (fn: (sql: TransactionClient) => Promise<unknown>) =>
      fn(txSql),
    );
    const sql = {
      begin: beginMock,
      options: {
        parsers: {},
        serializers: {},
      },
    } as unknown as SqlClient;

    const slugLookupLimitMock = vi.fn().mockResolvedValue([
      { id: "00000000-0000-0000-0000-000000000999" },
    ]);
    const slugLookupWhereMock = vi.fn(() => ({
      limit: slugLookupLimitMock,
    }));
    const slugLookupFromMock = vi.fn(() => ({
      where: slugLookupWhereMock,
    }));
    const slugLookupSelectMock = vi.fn(() => ({
      from: slugLookupFromMock,
    }));
    const insertMock = vi.fn();

    drizzleMock.mockReturnValue({
      select: slugLookupSelectMock,
      insert: insertMock,
    });

    await expect(
      provisionTenant({} as Database, sql, {
        name: "Acme",
        slug: "acme",
      }),
    ).rejects.toThrow("Tenant slug already exists.");

    expect(ensureVectorExtensionMock).toHaveBeenCalledWith(sql);
    expect(insertMock).not.toHaveBeenCalled();
  });
});
