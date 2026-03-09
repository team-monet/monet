import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  encodeAuditCursor,
  queryAuditLogs,
} from "../services/audit-query.service.js";

const withTenantScopeMock = vi.fn();

vi.mock("@monet/db", async () => {
  const actual = await vi.importActual("@monet/db");
  return {
    ...actual,
    withTenantScope: (...args: unknown[]) => withTenantScopeMock(...args),
  };
});

describe("audit query service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("selects enriched actor display data and paginates with a cursor", async () => {
    const rows = [
      {
        id: "00000000-0000-0000-0000-000000000010",
        actor_id: "00000000-0000-0000-0000-000000000020",
        actor_type: "agent",
        actor_display_name: "Claude · owner@example.com",
        action: "agent.revoke",
        target_id: "00000000-0000-0000-0000-000000000030",
        outcome: "success",
        created_at: new Date("2026-03-09T10:00:00.000Z"),
      },
      {
        id: "00000000-0000-0000-0000-000000000011",
        actor_id: "00000000-0000-0000-0000-000000000021",
        actor_type: "human_user",
        actor_display_name: "owner@example.com",
        action: "agent.unrevoke",
        target_id: "00000000-0000-0000-0000-000000000031",
        outcome: "success",
        created_at: new Date("2026-03-09T09:00:00.000Z"),
      },
    ];
    const unsafeMock = vi.fn().mockResolvedValue(rows);
    withTenantScopeMock.mockImplementation(async (_sql, _schemaName, fn) =>
      fn({ unsafe: unsafeMock }),
    );

    const result = await queryAuditLogs({} as never, "00000000-0000-0000-0000-000000000001", {
      actorId: "00000000-0000-0000-0000-000000000020",
      action: "agent.revoke",
      cursor: encodeAuditCursor("2026-03-09T11:00:00.000Z", "00000000-0000-0000-0000-000000000099"),
      limit: 1,
    });

    expect(unsafeMock).toHaveBeenCalledTimes(1);
    const [queryText, queryParams] = unsafeMock.mock.calls[0];
    expect(queryText).toContain("AS actor_display_name");
    expect(queryText).toContain("LEFT JOIN public.agents actor_agent");
    expect(queryText).toContain("LEFT JOIN public.human_users actor_user");
    expect(queryText).toContain("ORDER BY al.created_at DESC, al.id DESC LIMIT 2");
    expect(queryParams).toEqual([
      "00000000-0000-0000-0000-000000000020",
      "agent.revoke",
      "2026-03-09T11:00:00.000Z",
      "00000000-0000-0000-0000-000000000099",
    ]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].actor_display_name).toBe("Claude · owner@example.com");
    expect(result.nextCursor).toBeTruthy();
  });
});
