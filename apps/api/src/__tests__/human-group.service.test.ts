import { describe, expect, it, vi } from "vitest";
import { userCanSelectAgentGroup } from "../services/human-group.service.js";

const TENANT_ID = "00000000-0000-0000-0000-000000000010";
const USER_ID = "00000000-0000-0000-0000-000000000099";
const GROUP_ID = "00000000-0000-0000-0000-000000000088";

describe("user group agent access", () => {
  it("returns false when the target agent group is outside the tenant", async () => {
    const sql = vi
      .fn()
      .mockResolvedValueOnce([]) as unknown as Parameters<
      typeof userCanSelectAgentGroup
    >[0];

    await expect(
      userCanSelectAgentGroup(sql, TENANT_ID, USER_ID, GROUP_ID),
    ).resolves.toBe(false);
    expect(sql).toHaveBeenCalledTimes(1);
  });

  it("returns false when the user has no allowed agent groups", async () => {
    const sql = vi
      .fn()
      .mockResolvedValueOnce([{ id: GROUP_ID }])
      .mockResolvedValueOnce([]) as unknown as Parameters<
      typeof userCanSelectAgentGroup
    >[0];

    await expect(
      userCanSelectAgentGroup(sql, TENANT_ID, USER_ID, GROUP_ID),
    ).resolves.toBe(false);
    expect(sql).toHaveBeenCalledTimes(2);
  });

  it("returns true when the user is explicitly permitted for the agent group", async () => {
    const sql = vi
      .fn()
      .mockResolvedValueOnce([{ id: GROUP_ID }])
      .mockResolvedValueOnce([{ id: GROUP_ID }]) as unknown as Parameters<
      typeof userCanSelectAgentGroup
    >[0];

    await expect(
      userCanSelectAgentGroup(sql, TENANT_ID, USER_ID, GROUP_ID),
    ).resolves.toBe(true);
    expect(sql).toHaveBeenCalledTimes(2);
  });
});
