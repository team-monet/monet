import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeAuditCursor,
  encodeAuditCursor,
  queryAuditLogs,
} from "../services/audit-query.service";

const withTenantDrizzleScopeMock = vi.fn();

vi.mock("@monet/db", async () => {
  const actual = await vi.importActual("@monet/db");
  return {
    ...actual,
    withTenantDrizzleScope: (...args: unknown[]) => withTenantDrizzleScopeMock(...args),
  };
});

function createQueryBuilderMock(rows: unknown[]) {
  const limitMock = vi.fn().mockResolvedValue(rows);
  const orderByMock = vi.fn(() => ({
    limit: limitMock,
  }));
  const whereMock = vi.fn(() => ({
    orderBy: orderByMock,
    limit: limitMock,
  }));
  const thirdLeftJoinMock = vi.fn(() => ({
    where: whereMock,
    orderBy: orderByMock,
    limit: limitMock,
  }));
  const secondLeftJoinMock = vi.fn(() => ({
    leftJoin: thirdLeftJoinMock,
    where: whereMock,
    orderBy: orderByMock,
    limit: limitMock,
  }));
  const firstLeftJoinMock = vi.fn(() => ({
    leftJoin: secondLeftJoinMock,
    where: whereMock,
    orderBy: orderByMock,
    limit: limitMock,
  }));
  const fromMock = vi.fn(() => ({
    leftJoin: firstLeftJoinMock,
    where: whereMock,
    orderBy: orderByMock,
    limit: limitMock,
  }));
  const selectMock = vi.fn(() => ({
    from: fromMock,
  }));

  return {
    db: {
      select: selectMock,
    },
    selectMock,
    fromMock,
    firstLeftJoinMock,
    secondLeftJoinMock,
    thirdLeftJoinMock,
    whereMock,
    orderByMock,
    limitMock,
  };
}

describe("audit query service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("selects enriched actor display data and paginates with a cursor", async () => {
    const rows = [
      {
        id: "00000000-0000-0000-0000-000000000010",
        tenant_id: "00000000-0000-0000-0000-000000000001",
        actor_id: "00000000-0000-0000-0000-000000000020",
        actor_type: "agent",
        actor_display_name: "Claude · Owner Name",
        action: "agent.revoke",
        target_id: "00000000-0000-0000-0000-000000000030",
        outcome: "success",
        reason: null,
        metadata: null,
        created_at: new Date("2026-03-09T10:00:00.000Z"),
      },
      {
        id: "00000000-0000-0000-0000-000000000011",
        tenant_id: "00000000-0000-0000-0000-000000000001",
        actor_id: "00000000-0000-0000-0000-000000000021",
        actor_type: "user",
        actor_display_name: "Owner Name",
        action: "agent.unrevoke",
        target_id: "00000000-0000-0000-0000-000000000031",
        outcome: "success",
        reason: null,
        metadata: null,
        created_at: new Date("2026-03-09T09:00:00.000Z"),
      },
    ];
    const builder = createQueryBuilderMock(rows);
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) =>
      fn(builder.db),
    );

    const result = await queryAuditLogs({} as never, "00000000-0000-0000-0000-000000000001", {
      actorId: "00000000-0000-0000-0000-000000000020",
      action: "agent.revoke",
      cursor: encodeAuditCursor("2026-03-09T11:00:00.000Z", "00000000-0000-0000-0000-000000000099"),
      limit: 1,
    });

    expect(withTenantDrizzleScopeMock).toHaveBeenCalledWith(
      expect.anything(),
      "tenant_00000000_0000_0000_0000_000000000001",
      expect.any(Function),
    );
    expect(builder.selectMock).toHaveBeenCalledTimes(1);
    expect(builder.fromMock).toHaveBeenCalledTimes(1);
    expect(builder.firstLeftJoinMock).toHaveBeenCalledTimes(1);
    expect(builder.secondLeftJoinMock).toHaveBeenCalledTimes(1);
    expect(builder.thirdLeftJoinMock).toHaveBeenCalledTimes(1);
    expect(builder.whereMock).toHaveBeenCalledTimes(1);
    expect(builder.orderByMock).toHaveBeenCalledTimes(1);
    expect(builder.limitMock).toHaveBeenCalledWith(2);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].actor_display_name).toBe("Claude · Owner Name");
    expect(result.nextCursor).toBeTruthy();
    expect(decodeAuditCursor(result.nextCursor!)).toEqual({
      createdAt: "2026-03-09T10:00:00.000Z",
      id: "00000000-0000-0000-0000-000000000010",
    });
  });

  it("ignores an invalid cursor and returns no next cursor when under the limit", async () => {
    const rows = [
      {
        id: "00000000-0000-0000-0000-000000000010",
        tenant_id: "00000000-0000-0000-0000-000000000001",
        actor_id: "00000000-0000-0000-0000-000000000020",
        actor_type: "system",
        actor_display_name: "System",
        action: "rule.create",
        target_id: "00000000-0000-0000-0000-000000000030",
        outcome: "success",
        reason: null,
        metadata: null,
        created_at: new Date("2026-03-09T10:00:00.000Z"),
      },
    ];
    const builder = createQueryBuilderMock(rows);
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) =>
      fn(builder.db),
    );

    const result = await queryAuditLogs(
      {} as never,
      "00000000-0000-0000-0000-000000000001",
      { cursor: "not-a-valid-cursor" },
    );

    expect(builder.limitMock).toHaveBeenCalledWith(101);
    expect(result.items).toEqual(rows);
    expect(result.nextCursor).toBeNull();
  });

  it("returns null for base64-decodable cursors with invalid payload fields", () => {
    expect(
      decodeAuditCursor(encodeAuditCursor("not-a-date", "not-a-uuid")),
    ).toBeNull();
  });

  it("accepts offset-formatted timestamps in persisted cursors", () => {
    expect(
      decodeAuditCursor(
        encodeAuditCursor(
          "2026-03-09T10:00:00.000+00:00",
          "00000000-0000-0000-0000-000000000010",
        ),
      ),
    ).toEqual({
      createdAt: "2026-03-09T10:00:00.000+00:00",
      id: "00000000-0000-0000-0000-000000000010",
    });
  });

  it("returns an empty page cleanly when no audit rows match", async () => {
    const builder = createQueryBuilderMock([]);
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) =>
      fn(builder.db),
    );

    const result = await queryAuditLogs(
      {} as never,
      "00000000-0000-0000-0000-000000000001",
      { limit: 0 },
    );

    expect(builder.limitMock).toHaveBeenCalledWith(1);
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });
});
