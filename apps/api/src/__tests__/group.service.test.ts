import {
  agentGroupMembers,
  agentGroups,
  agents,
  tenantUsers,
  type SqlClient,
} from "@monet/db";
import { beforeEach, describe, it, expect, vi } from "vitest";

const { drizzleMock } = vi.hoisted(() => ({
  drizzleMock: vi.fn(),
}));

vi.mock("drizzle-orm/postgres-js", () => ({
  drizzle: (...args: unknown[]) => drizzleMock(...args),
}));

import {
  addMember,
  createGroup,
  isTenantAdmin,
  isGroupAdminOrAbove,
  listGroupMembers,
  listGroups,
  removeMember,
  resolveAgentRole,
  updateGroup,
} from "../services/group.service";

const TENANT_ID = "00000000-0000-0000-0000-000000000010";
const GROUP_ID = "00000000-0000-0000-0000-000000000020";
const AGENT_ID = "00000000-0000-0000-0000-000000000030";

function makeSqlClient(): SqlClient {
  return {} as SqlClient;
}

describe("group CRUD", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates groups through Drizzle and normalizes the response shape", async () => {
    const returningMock = vi.fn().mockResolvedValue([
      {
        id: GROUP_ID,
        tenantId: TENANT_ID,
        name: "General",
        description: null,
        memoryQuota: null,
        createdAt: new Date("2026-03-22T00:00:00.000Z"),
      },
    ]);
    const valuesMock = vi.fn(() => ({
      returning: returningMock,
    }));
    const insertMock = vi.fn(() => ({
      values: valuesMock,
    }));

    drizzleMock.mockReturnValue({
      insert: insertMock,
    });

    const sql = makeSqlClient();
    const result = await createGroup(sql, TENANT_ID, {
      name: "General",
    });

    expect(drizzleMock).toHaveBeenCalledWith(sql);
    expect(insertMock).toHaveBeenCalledWith(agentGroups);
    expect(valuesMock).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      name: "General",
      description: "",
      memoryQuota: null,
    });
    expect(result).toEqual({
      id: GROUP_ID,
      tenantId: TENANT_ID,
      name: "General",
      description: "",
      memoryQuota: null,
      createdAt: "2026-03-22T00:00:00.000Z",
    });
  });

  it("returns not_found when updating a missing group", async () => {
    const limitMock = vi.fn().mockResolvedValue([]);
    const whereSelectMock = vi.fn(() => ({
      limit: limitMock,
    }));
    const fromMock = vi.fn(() => ({
      where: whereSelectMock,
    }));
    const selectMock = vi.fn(() => ({
      from: fromMock,
    }));

    drizzleMock.mockReturnValue({
      select: selectMock,
    });

    const result = await updateGroup(makeSqlClient(), TENANT_ID, GROUP_ID, {
      name: "Renamed",
    });

    expect(result).toEqual({ error: "not_found", message: "Group not found" });
  });

  it("updates groups through Drizzle while preserving unspecified fields", async () => {
    const existingGroup = {
      id: GROUP_ID,
      tenantId: TENANT_ID,
      name: "General",
      description: "Existing description",
      memoryQuota: 100,
      createdAt: new Date("2026-03-20T00:00:00.000Z"),
    };
    const updatedGroup = {
      ...existingGroup,
      name: "Renamed",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    };

    const limitMock = vi.fn().mockResolvedValue([existingGroup]);
    const whereSelectMock = vi.fn(() => ({
      limit: limitMock,
    }));
    const fromMock = vi.fn(() => ({
      where: whereSelectMock,
    }));
    const selectMock = vi.fn(() => ({
      from: fromMock,
    }));

    const returningMock = vi.fn().mockResolvedValue([updatedGroup]);
    const whereUpdateMock = vi.fn(() => ({
      returning: returningMock,
    }));
    const setMock = vi.fn(() => ({
      where: whereUpdateMock,
    }));
    const updateMock = vi.fn(() => ({
      set: setMock,
    }));

    drizzleMock.mockReturnValue({
      select: selectMock,
      update: updateMock,
    });

    const result = await updateGroup(makeSqlClient(), TENANT_ID, GROUP_ID, {
      name: "Renamed",
    });

    expect(setMock).toHaveBeenCalledWith({
      name: "Renamed",
      description: "Existing description",
      memoryQuota: 100,
    });
    expect(result).toEqual({
      id: GROUP_ID,
      tenantId: TENANT_ID,
      name: "Renamed",
      description: "Existing description",
      memoryQuota: 100,
      createdAt: "2026-03-22T00:00:00.000Z",
    });
  });

  it("lists groups in creation order with normalized fields", async () => {
    const orderByMock = vi.fn().mockResolvedValue([
      {
        id: GROUP_ID,
        tenantId: TENANT_ID,
        name: "General",
        description: null,
        memoryQuota: 100,
        createdAt: new Date("2026-03-21T00:00:00.000Z"),
      },
      {
        id: "00000000-0000-0000-0000-000000000021",
        tenantId: TENANT_ID,
        name: "Ops",
        description: "Operations",
        memoryQuota: null,
        createdAt: new Date("2026-03-22T00:00:00.000Z"),
      },
    ]);
    const whereMock = vi.fn(() => ({
      orderBy: orderByMock,
    }));
    const fromMock = vi.fn(() => ({
      where: whereMock,
    }));
    const selectMock = vi.fn(() => ({
      from: fromMock,
    }));

    drizzleMock.mockReturnValue({
      select: selectMock,
    });

    const result = await listGroups(makeSqlClient(), TENANT_ID);

    expect(result).toEqual([
      {
        id: GROUP_ID,
        tenantId: TENANT_ID,
        name: "General",
        description: "",
        memoryQuota: 100,
        createdAt: "2026-03-21T00:00:00.000Z",
      },
      {
        id: "00000000-0000-0000-0000-000000000021",
        tenantId: TENANT_ID,
        name: "Ops",
        description: "Operations",
        memoryQuota: null,
        createdAt: "2026-03-22T00:00:00.000Z",
      },
    ]);
  });
});

describe("role helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("isTenantAdmin", () => {
    it("returns true for tenant_admin", () => {
      expect(isTenantAdmin("tenant_admin")).toBe(true);
    });

    it("returns false for group_admin", () => {
      expect(isTenantAdmin("group_admin")).toBe(false);
    });

    it("returns false for null", () => {
      expect(isTenantAdmin(null)).toBe(false);
    });

    it("returns false for user", () => {
      expect(isTenantAdmin("user")).toBe(false);
    });
  });

  describe("isGroupAdminOrAbove", () => {
    it("returns true for tenant_admin", () => {
      expect(isGroupAdminOrAbove("tenant_admin")).toBe(true);
    });

    it("returns true for group_admin", () => {
      expect(isGroupAdminOrAbove("group_admin")).toBe(true);
    });

    it("returns false for user", () => {
      expect(isGroupAdminOrAbove("user")).toBe(false);
    });

    it("returns false for null", () => {
      expect(isGroupAdminOrAbove(null)).toBe(false);
    });
  });

  it("falls back to the linked user role through Drizzle", async () => {
    const limitMock = vi.fn().mockResolvedValue([{ role: "group_admin" }]);
    const whereMock = vi.fn(() => ({
      limit: limitMock,
    }));
    const fromMock = vi.fn(() => ({
      where: whereMock,
    }));
    const selectMock = vi.fn(() => ({
      from: fromMock,
    }));

    drizzleMock.mockReturnValue({
      select: selectMock,
    });

    const result = await resolveAgentRole(makeSqlClient(), {
      id: AGENT_ID,
      externalId: "worker",
      tenantId: TENANT_ID,
      isAutonomous: false,
      userId: "00000000-0000-0000-0000-000000000099",
      role: null,
    });

    expect(selectMock).toHaveBeenCalledWith({ role: tenantUsers.role });
    expect(result).toBe("group_admin");
  });
});

describe("group membership helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("moves an agent between groups inside a transaction", async () => {
    const limitGroupMock = vi.fn().mockResolvedValue([{ id: GROUP_ID }]);
    const whereGroupMock = vi.fn(() => ({
      limit: limitGroupMock,
    }));
    const fromGroupMock = vi.fn(() => ({
      where: whereGroupMock,
    }));

    const limitAgentMock = vi.fn().mockResolvedValue([{ id: AGENT_ID }]);
    const whereAgentMock = vi.fn(() => ({
      limit: limitAgentMock,
    }));
    const fromAgentMock = vi.fn(() => ({
      where: whereAgentMock,
    }));

    const orderByMembershipMock = vi.fn().mockResolvedValue([
      { groupId: "00000000-0000-0000-0000-000000000099" },
    ]);
    const whereMembershipMock = vi.fn(() => ({
      orderBy: orderByMembershipMock,
    }));
    const fromMembershipMock = vi.fn(() => ({
      where: whereMembershipMock,
    }));

    const selectMock = vi.fn()
      .mockReturnValueOnce({ from: fromGroupMock })
      .mockReturnValueOnce({ from: fromAgentMock })
      .mockReturnValueOnce({ from: fromMembershipMock });

    const deleteWhereMock = vi.fn().mockResolvedValue([]);
    const deleteMock = vi.fn(() => ({
      where: deleteWhereMock,
    }));

    const insertValuesMock = vi.fn().mockResolvedValue([]);
    const insertMock = vi.fn(() => ({
      values: insertValuesMock,
    }));

    drizzleMock.mockReturnValue({
      select: selectMock,
      delete: deleteMock,
      insert: insertMock,
    });

    const tx = {} as never;
    const begin = vi.fn(async (fn: (txSql: typeof tx) => Promise<unknown>) => fn(tx));
    const sql = {
      begin,
      options: { parsers: {}, serializers: {} },
    } as unknown as SqlClient;

    const result = await addMember(sql, TENANT_ID, GROUP_ID, AGENT_ID);

    expect(begin).toHaveBeenCalledTimes(1);
    expect(deleteMock).toHaveBeenCalledWith(agentGroupMembers);
    expect(insertMock).toHaveBeenCalledWith(agentGroupMembers);
    expect(insertValuesMock).toHaveBeenCalledWith({
      agentId: AGENT_ID,
      groupId: GROUP_ID,
    });
    expect(result).toEqual({ success: true, operation: "moved" });
  });

  it("blocks removing an agent from its final group", async () => {
    const limitGroupMock = vi.fn().mockResolvedValue([{ id: GROUP_ID }]);
    const whereGroupMock = vi.fn(() => ({
      limit: limitGroupMock,
    }));
    const fromGroupMock = vi.fn(() => ({
      where: whereGroupMock,
    }));

    const limitMembershipMock = vi.fn().mockResolvedValue([{ agentId: AGENT_ID }]);
    const whereMembershipLookupMock = vi.fn(() => ({
      limit: limitMembershipMock,
    }));
    const fromMembershipLookupMock = vi.fn(() => ({
      where: whereMembershipLookupMock,
    }));

    const whereMembershipsMock = vi.fn().mockResolvedValue([{ groupId: GROUP_ID }]);
    const fromMembershipsMock = vi.fn(() => ({
      where: whereMembershipsMock,
    }));

    const selectMock = vi.fn()
      .mockReturnValueOnce({ from: fromGroupMock })
      .mockReturnValueOnce({ from: fromMembershipLookupMock })
      .mockReturnValueOnce({ from: fromMembershipsMock });

    drizzleMock.mockReturnValue({
      select: selectMock,
      delete: vi.fn(),
    });

    const result = await removeMember(makeSqlClient(), TENANT_ID, GROUP_ID, AGENT_ID);

    expect(result).toEqual({
      error: "conflict",
      message: "Agents must remain assigned to a group. Move the agent to a new group instead.",
    });
  });

  it("includes owner identities in admin group member payloads", async () => {
    const limitGroupMock = vi.fn().mockResolvedValue([{ id: GROUP_ID }]);
    const whereGroupMock = vi.fn(() => ({
      limit: limitGroupMock,
    }));
    const fromGroupMock = vi.fn(() => ({
      where: whereGroupMock,
    }));

    const orderByMembersMock = vi.fn().mockResolvedValue([
      {
        id: AGENT_ID,
        externalId: "Claude",
        tenantId: TENANT_ID,
        userId: "00000000-0000-0000-0000-000000000099",
        role: "user",
        isAutonomous: false,
        revokedAt: null,
        createdAt: new Date("2026-03-03T00:00:00.000Z"),
        ownerId: "00000000-0000-0000-0000-000000000099",
        ownerExternalId: "bound-user",
        ownerDisplayName: "Bound User",
        ownerEmail: "bound@example.com",
      },
    ]);
    const whereMembersMock = vi.fn(() => ({
      orderBy: orderByMembersMock,
    }));
    const leftJoinMock = vi.fn(() => ({
      where: whereMembersMock,
    }));
    const innerJoinMock = vi.fn(() => ({
      leftJoin: leftJoinMock,
    }));
    const fromMembersMock = vi.fn(() => ({
      innerJoin: innerJoinMock,
    }));

    const selectMock = vi.fn()
      .mockReturnValueOnce({ from: fromGroupMock })
      .mockReturnValueOnce({ from: fromMembersMock });

    drizzleMock.mockReturnValue({
      select: selectMock,
    });

    const sql = makeSqlClient();

    const result = await listGroupMembers(sql, TENANT_ID, GROUP_ID);

    if ("error" in result) {
      throw new Error("Expected a successful group member response");
    }

    expect(result.members).toHaveLength(1);
    expect(result.members[0]).toMatchObject({
      id: AGENT_ID,
      externalId: "Claude",
      createdAt: "2026-03-03T00:00:00.000Z",
      displayName: "Claude · Bound User",
      owner: {
        id: "00000000-0000-0000-0000-000000000099",
        externalId: "bound-user",
        displayName: "Bound User",
        email: "bound@example.com",
        label: "Bound User",
      },
    });
  });
});
