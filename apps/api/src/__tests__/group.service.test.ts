import { describe, it, expect, vi } from "vitest";
import {
  addMember,
  isTenantAdmin,
  isGroupAdminOrAbove,
  listGroupMembers,
} from "../services/group.service";

const TENANT_ID = "00000000-0000-0000-0000-000000000010";
const GROUP_ID = "00000000-0000-0000-0000-000000000020";
const AGENT_ID = "00000000-0000-0000-0000-000000000030";

function makeTaggedSql(sequence: unknown[]) {
  const sql = vi.fn();
  for (const value of sequence) {
    sql.mockResolvedValueOnce(value);
  }
  return sql;
}

describe("role helpers", () => {
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
});

describe("group membership helpers", () => {
  it("moves an agent between groups inside a transaction", async () => {
    const tx = makeTaggedSql([
      [{ id: GROUP_ID }],
      [{ id: AGENT_ID }],
      [{ group_id: "00000000-0000-0000-0000-000000000099" }],
      [],
      [],
    ]);
    const begin = vi.fn(async (fn: (txSql: typeof tx) => Promise<unknown>) => fn(tx));
    const sql = { begin } as unknown as import("postgres").Sql;

    const result = await addMember(sql, TENANT_ID, GROUP_ID, AGENT_ID);

    expect(begin).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true, operation: "moved" });
  });

  it("includes owner identities in admin group member payloads", async () => {
    const sql = makeTaggedSql([
      [{ id: GROUP_ID }],
      [
        {
          id: AGENT_ID,
          external_id: "Claude",
          tenant_id: TENANT_ID,
          user_id: "00000000-0000-0000-0000-000000000099",
          role: "user",
          is_autonomous: false,
          revoked_at: null,
          created_at: "2026-03-03T00:00:00.000Z",
          owner_id: "00000000-0000-0000-0000-000000000099",
          owner_external_id: "bound-user",
          owner_display_name: "Bound User",
          owner_email: "bound@example.com",
        },
      ],
    ]) as unknown as import("postgres").Sql;

    const result = await listGroupMembers(sql, TENANT_ID, GROUP_ID);

    if ("error" in result) {
      throw new Error("Expected a successful group member response");
    }

    expect(result.members).toHaveLength(1);
    expect(result.members[0]).toMatchObject({
      id: AGENT_ID,
      externalId: "Claude",
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
