import {
  agentGroups,
  tenantUsers,
  userGroupAgentGroupPermissions,
  userGroupMembers,
  userGroups,
  type SqlClient,
} from "@monet/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { drizzleMock } = vi.hoisted(() => ({
  drizzleMock: vi.fn(),
}));

vi.mock("drizzle-orm/postgres-js", () => ({
  drizzle: (...args: unknown[]) => drizzleMock(...args),
}));

import {
  createUserGroup,
  getUserGroupDetail,
  listAllowedAgentGroupIdsForUser,
  listUserGroups,
  addUserGroupMember,
  removeUserGroupMember,
  saveUserGroupAgentGroupPermissions,
  updateUserGroup,
  userCanSelectAgentGroup,
} from "../services/user-group.service";

const TENANT_ID = "00000000-0000-0000-0000-000000000010";
const USER_ID = "00000000-0000-0000-0000-000000000099";
const GROUP_ID = "00000000-0000-0000-0000-000000000088";
const USER_GROUP_ID = "00000000-0000-0000-0000-000000000200";

function makeSqlClient(): SqlClient {
  return {} as SqlClient;
}

describe("user group service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists allowed agent groups for a user through Drizzle", async () => {
    const whereMock = vi.fn().mockResolvedValue([
      { id: GROUP_ID },
      { id: "00000000-0000-0000-0000-000000000089" },
    ]);
    const innerJoinThirdMock = vi.fn(() => ({
      where: whereMock,
    }));
    const innerJoinSecondMock = vi.fn(() => ({
      innerJoin: innerJoinThirdMock,
    }));
    const innerJoinFirstMock = vi.fn(() => ({
      innerJoin: innerJoinSecondMock,
    }));
    const fromMock = vi.fn(() => ({
      innerJoin: innerJoinFirstMock,
    }));
    const selectDistinctMock = vi.fn(() => ({
      from: fromMock,
    }));

    drizzleMock.mockReturnValue({
      selectDistinct: selectDistinctMock,
    });

    const result = await listAllowedAgentGroupIdsForUser(
      makeSqlClient(),
      TENANT_ID,
      USER_ID,
    );

    expect(selectDistinctMock).toHaveBeenCalledWith({ id: agentGroups.id });
    expect(result).toEqual([
      GROUP_ID,
      "00000000-0000-0000-0000-000000000089",
    ]);
  });

  it("returns false when the target agent group is outside the tenant", async () => {
    const limitMock = vi.fn().mockResolvedValue([]);
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

    await expect(
      userCanSelectAgentGroup(makeSqlClient(), TENANT_ID, USER_ID, GROUP_ID),
    ).resolves.toBe(false);
  });

  it("returns true when the user is explicitly permitted for the agent group", async () => {
    const limitMock = vi.fn().mockResolvedValue([{ id: GROUP_ID }]);
    const whereSelectMock = vi.fn(() => ({
      limit: limitMock,
    }));
    const fromSelectMock = vi.fn(() => ({
      where: whereSelectMock,
    }));
    const selectMock = vi.fn(() => ({
      from: fromSelectMock,
    }));

    const allowedWhereMock = vi.fn().mockResolvedValue([{ id: GROUP_ID }]);
    const allowedInnerJoinThirdMock = vi.fn(() => ({
      where: allowedWhereMock,
    }));
    const allowedInnerJoinSecondMock = vi.fn(() => ({
      innerJoin: allowedInnerJoinThirdMock,
    }));
    const allowedInnerJoinFirstMock = vi.fn(() => ({
      innerJoin: allowedInnerJoinSecondMock,
    }));
    const allowedFromMock = vi.fn(() => ({
      innerJoin: allowedInnerJoinFirstMock,
    }));
    const selectDistinctMock = vi.fn(() => ({
      from: allowedFromMock,
    }));

    drizzleMock.mockReturnValue({
      select: selectMock,
      selectDistinct: selectDistinctMock,
    });

    await expect(
      userCanSelectAgentGroup(makeSqlClient(), TENANT_ID, USER_ID, GROUP_ID),
    ).resolves.toBe(true);
  });

  it("lists user groups with aggregated member and permission counts", async () => {
    const orderByMock = vi.fn().mockResolvedValue([
      {
        id: USER_GROUP_ID,
        tenantId: TENANT_ID,
        name: "Everyone",
        description: null,
        createdAt: new Date("2026-03-09T00:00:00.000Z"),
      },
    ]);
    const whereMock = vi.fn(() => ({
      orderBy: orderByMock,
    }));
    const fromGroupsMock = vi.fn(() => ({
      where: whereMock,
    }));

    const groupByMembersMock = vi.fn().mockResolvedValue([
      { userGroupId: USER_GROUP_ID, count: 3 },
    ]);
    const fromMembersMock = vi.fn(() => ({
      groupBy: groupByMembersMock,
    }));

    const groupByPermissionsMock = vi.fn().mockResolvedValue([
      { userGroupId: USER_GROUP_ID, count: 2 },
    ]);
    const fromPermissionsMock = vi.fn(() => ({
      groupBy: groupByPermissionsMock,
    }));

    const selectMock = vi.fn()
      .mockReturnValueOnce({ from: fromGroupsMock })
      .mockReturnValueOnce({ from: fromMembersMock })
      .mockReturnValueOnce({ from: fromPermissionsMock });

    drizzleMock.mockReturnValue({
      select: selectMock,
    });

    const result = await listUserGroups(makeSqlClient(), TENANT_ID);

    expect(result).toEqual([
      {
        id: USER_GROUP_ID,
        name: "Everyone",
        description: "",
        createdAt: new Date("2026-03-09T00:00:00.000Z"),
        memberCount: 3,
        allowedAgentGroupCount: 2,
      },
    ]);
  });

  it("creates user groups through Drizzle", async () => {
    const returningMock = vi.fn().mockResolvedValue([
      {
        id: USER_GROUP_ID,
        name: "Support",
        description: "",
        createdAt: new Date("2026-03-10T00:00:00.000Z"),
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

    const result = await createUserGroup(makeSqlClient(), TENANT_ID, {
      name: "Support",
    });

    expect(insertMock).toHaveBeenCalledWith(userGroups);
    expect(valuesMock).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      name: "Support",
      description: "",
    });
    expect(result).toEqual({
      id: USER_GROUP_ID,
      name: "Support",
      description: "",
      createdAt: new Date("2026-03-10T00:00:00.000Z"),
    });
  });

  it("returns not_found when updating a missing user group", async () => {
    const limitMock = vi.fn().mockResolvedValue([]);
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

    const result = await updateUserGroup(makeSqlClient(), TENANT_ID, USER_GROUP_ID, {
      name: "Renamed",
    });

    expect(result).toEqual({
      error: "not_found",
      message: "User group not found",
    });
  });

  it("updates user groups while preserving unspecified fields", async () => {
    const existingGroup = {
      id: USER_GROUP_ID,
      tenantId: TENANT_ID,
      name: "Everyone",
      description: "Existing description",
      createdAt: new Date("2026-03-09T00:00:00.000Z"),
    };

    const limitMock = vi.fn().mockResolvedValue([existingGroup]);
    const whereSelectMock = vi.fn(() => ({
      limit: limitMock,
    }));
    const fromSelectMock = vi.fn(() => ({
      where: whereSelectMock,
    }));
    const selectMock = vi.fn(() => ({
      from: fromSelectMock,
    }));

    const returningMock = vi.fn().mockResolvedValue([
      {
        id: USER_GROUP_ID,
        name: "Renamed",
        description: "Existing description",
        createdAt: new Date("2026-03-11T00:00:00.000Z"),
      },
    ]);
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

    const result = await updateUserGroup(makeSqlClient(), TENANT_ID, USER_GROUP_ID, {
      name: "Renamed",
    });

    expect(setMock).toHaveBeenCalledWith({
      name: "Renamed",
      description: "Existing description",
    });
    expect(result).toEqual({
      id: USER_GROUP_ID,
      name: "Renamed",
      description: "Existing description",
      createdAt: new Date("2026-03-11T00:00:00.000Z"),
    });
  });

  it("returns null for missing user-group detail", async () => {
    const limitMock = vi.fn().mockResolvedValue([]);
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

    await expect(
      getUserGroupDetail(makeSqlClient(), TENANT_ID, USER_GROUP_ID),
    ).resolves.toBeNull();
  });

  it("loads user-group detail through Drizzle", async () => {
    const groupLimitMock = vi.fn().mockResolvedValue([
      {
        id: USER_GROUP_ID,
        name: "Everyone",
        description: "",
        createdAt: new Date("2026-03-09T00:00:00.000Z"),
      },
    ]);
    const groupWhereMock = vi.fn(() => ({
      limit: groupLimitMock,
    }));
    const groupFromMock = vi.fn(() => ({
      where: groupWhereMock,
    }));

    const membersOrderByMock = vi.fn().mockResolvedValue([
      {
        id: USER_ID,
        externalId: "user-1",
        displayName: "Test User",
        email: "test@example.com",
        role: "group_admin",
        joinedAt: new Date("2026-03-10T00:00:00.000Z"),
      },
    ]);
    const membersWhereMock = vi.fn(() => ({
      orderBy: membersOrderByMock,
    }));
    const membersInnerJoinMock = vi.fn(() => ({
      where: membersWhereMock,
    }));
    const membersFromMock = vi.fn(() => ({
      innerJoin: membersInnerJoinMock,
    }));

    const tenantUsersOrderByMock = vi.fn().mockResolvedValue([
      {
        id: USER_ID,
        externalId: "user-1",
        displayName: "Test User",
        email: "test@example.com",
        role: "group_admin",
      },
    ]);
    const tenantUsersWhereMock = vi.fn(() => ({
      orderBy: tenantUsersOrderByMock,
    }));
    const tenantUsersFromMock = vi.fn(() => ({
      where: tenantUsersWhereMock,
    }));

    const agentGroupsOrderByMock = vi.fn().mockResolvedValue([
      {
        id: GROUP_ID,
        name: "General",
        description: "",
      },
    ]);
    const agentGroupsWhereMock = vi.fn(() => ({
      orderBy: agentGroupsOrderByMock,
    }));
    const agentGroupsFromMock = vi.fn(() => ({
      where: agentGroupsWhereMock,
    }));

    const permissionsWhereMock = vi.fn().mockResolvedValue([
      { agentGroupId: GROUP_ID },
    ]);
    const permissionsFromMock = vi.fn(() => ({
      where: permissionsWhereMock,
    }));

    const selectMock = vi.fn()
      .mockReturnValueOnce({ from: groupFromMock })
      .mockReturnValueOnce({ from: membersFromMock })
      .mockReturnValueOnce({ from: tenantUsersFromMock })
      .mockReturnValueOnce({ from: agentGroupsFromMock })
      .mockReturnValueOnce({ from: permissionsFromMock });

    drizzleMock.mockReturnValue({
      select: selectMock,
    });

    const result = await getUserGroupDetail(makeSqlClient(), TENANT_ID, USER_GROUP_ID);

    expect(result).toEqual({
      group: {
        id: USER_GROUP_ID,
        name: "Everyone",
        description: "",
        createdAt: new Date("2026-03-09T00:00:00.000Z"),
      },
      members: [
        {
          id: USER_ID,
          externalId: "user-1",
          displayName: "Test User",
          email: "test@example.com",
          role: "group_admin",
          joinedAt: new Date("2026-03-10T00:00:00.000Z"),
        },
      ],
      tenantUsers: [
        {
          id: USER_ID,
          externalId: "user-1",
          displayName: "Test User",
          email: "test@example.com",
          role: "group_admin",
        },
      ],
      tenantAgentGroups: [
        {
          id: GROUP_ID,
          name: "General",
          description: "",
        },
      ],
      allowedAgentGroupIds: [GROUP_ID],
    });
  });

  it("adds a user-group member after validating tenant ownership", async () => {
    const groupLimitMock = vi.fn().mockResolvedValue([{ id: USER_GROUP_ID }]);
    const groupWhereMock = vi.fn(() => ({
      limit: groupLimitMock,
    }));
    const groupFromMock = vi.fn(() => ({
      where: groupWhereMock,
    }));

    const userLimitMock = vi.fn().mockResolvedValue([{ id: USER_ID }]);
    const userWhereMock = vi.fn(() => ({
      limit: userLimitMock,
    }));
    const userFromMock = vi.fn(() => ({
      where: userWhereMock,
    }));

    const selectMock = vi.fn()
      .mockReturnValueOnce({ from: groupFromMock })
      .mockReturnValueOnce({ from: userFromMock });

    const onConflictDoNothingMock = vi.fn().mockResolvedValue(undefined);
    const valuesMock = vi.fn(() => ({
      onConflictDoNothing: onConflictDoNothingMock,
    }));
    const insertMock = vi.fn(() => ({
      values: valuesMock,
    }));

    drizzleMock.mockReturnValue({
      select: selectMock,
      insert: insertMock,
    });

    const result = await addUserGroupMember(makeSqlClient(), TENANT_ID, USER_GROUP_ID, USER_ID);

    expect(insertMock).toHaveBeenCalledWith(userGroupMembers);
    expect(valuesMock).toHaveBeenCalledWith({
      userGroupId: USER_GROUP_ID,
      userId: USER_ID,
    });
    expect(result).toEqual({ success: true });
  });

  it("returns not_found when removing a member from a missing user group", async () => {
    const limitMock = vi.fn().mockResolvedValue([]);
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

    const result = await removeUserGroupMember(makeSqlClient(), TENANT_ID, USER_GROUP_ID, USER_ID);

    expect(result).toEqual({
      error: "not_found",
      message: "User group not found",
    });
  });

  it("replaces user-group agent permissions in a transaction", async () => {
    const selectLimitMock = vi.fn().mockResolvedValue([{ id: USER_GROUP_ID }]);
    const selectWhereMock = vi.fn(() => ({
      limit: selectLimitMock,
    }));
    const selectFromMock = vi.fn(() => ({
      where: selectWhereMock,
    }));

    const validGroupsWhereMock = vi.fn().mockResolvedValue([
      { id: GROUP_ID },
      { id: "00000000-0000-0000-0000-000000000089" },
    ]);
    const validGroupsFromMock = vi.fn(() => ({
      where: validGroupsWhereMock,
    }));

    const selectMock = vi.fn()
      .mockReturnValueOnce({ from: selectFromMock })
      .mockReturnValueOnce({ from: validGroupsFromMock });

    const deleteWhereMock = vi.fn().mockResolvedValue(undefined);
    const deleteMock = vi.fn(() => ({
      where: deleteWhereMock,
    }));
    const insertValuesMock = vi.fn().mockResolvedValue(undefined);
    const insertMock = vi.fn(() => ({
      values: insertValuesMock,
    }));

    let callCount = 0;
    drizzleMock.mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return {
          select: selectMock,
        };
      }

      return {
        delete: deleteMock,
        insert: insertMock,
      };
    });

    const tx = {} as never;
    const begin = vi.fn(async (fn: (txSql: typeof tx) => Promise<unknown>) => fn(tx));
    const sql = {
      begin,
      options: { parsers: {}, serializers: {} },
    } as unknown as SqlClient;

    const result = await saveUserGroupAgentGroupPermissions(sql, TENANT_ID, USER_GROUP_ID, [
      GROUP_ID,
      "00000000-0000-0000-0000-000000000089",
    ]);

    expect(begin).toHaveBeenCalledTimes(1);
    expect(deleteMock).toHaveBeenCalledWith(userGroupAgentGroupPermissions);
    expect(insertMock).toHaveBeenCalledWith(userGroupAgentGroupPermissions);
    expect(insertValuesMock).toHaveBeenCalledWith([
      {
        userGroupId: USER_GROUP_ID,
        agentGroupId: GROUP_ID,
      },
      {
        userGroupId: USER_GROUP_ID,
        agentGroupId: "00000000-0000-0000-0000-000000000089",
      },
    ]);
    expect(result).toEqual({ success: true });
  });

  it("rejects invalid agent-group permissions when any target group is missing", async () => {
    const groupLimitMock = vi.fn().mockResolvedValue([{ id: USER_GROUP_ID }]);
    const groupWhereMock = vi.fn(() => ({
      limit: groupLimitMock,
    }));
    const groupFromMock = vi.fn(() => ({
      where: groupWhereMock,
    }));

    const validGroupsWhereMock = vi.fn().mockResolvedValue([{ id: GROUP_ID }]);
    const validGroupsFromMock = vi.fn(() => ({
      where: validGroupsWhereMock,
    }));

    const selectMock = vi.fn()
      .mockReturnValueOnce({ from: groupFromMock })
      .mockReturnValueOnce({ from: validGroupsFromMock });

    drizzleMock.mockReturnValue({
      select: selectMock,
    });

    const result = await saveUserGroupAgentGroupPermissions(
      makeSqlClient(),
      TENANT_ID,
      USER_GROUP_ID,
      [GROUP_ID, "00000000-0000-0000-0000-000000000089"],
    );

    expect(result).toEqual({
      error: "validation",
      message: "One or more agent groups were invalid",
    });
  });
});
