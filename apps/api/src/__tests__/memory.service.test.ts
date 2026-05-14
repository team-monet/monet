import {
  agentGroupMembers,
  agentGroups,
  auditLog,
  memoryEntries,
  memoryVersions,
  type SqlClient,
  type TransactionClient,
} from "@monet/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreateMemoryEntryInput, MemoryEntryTier1 } from "@monet/types";
import { PgDialect } from "drizzle-orm/pg-core";

const { drizzleMock } = vi.hoisted(() => ({
  drizzleMock: vi.fn(),
}));

vi.mock("drizzle-orm/postgres-js", () => ({
  drizzle: (...args: unknown[]) => drizzleMock(...args),
}));

import {
  encodeCursor,
  decodeCursor,
  createMemory,
  deleteMemory,
  fetchMemory,
  buildSummary,
  checkQuota,
  listAgentMemories,
  listTags,
  resolveMemoryWritePreflight,
  searchMemories,
  updateMemory,
} from "../services/memory.service";
import type { AgentContext } from "../middleware/context";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const USER_ID = "00000000-0000-0000-0000-000000000099";

function makeAgent(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    id: AGENT_ID,
    externalId: "test-agent",
    tenantId: "00000000-0000-0000-0000-000000000010",
    isAutonomous: false,
    userId: null,
    role: null,
    ...overrides,
  };
}

function mockGroupIdSelect(groupIds: string[] = ["00000000-0000-0000-0000-000000000300"]) {
  return vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn().mockResolvedValue(groupIds.map((id) => ({ groupId: id }))),
    })),
  }));
}

const GROUP_A = "00000000-0000-0000-0000-000000000300";
const GROUP_B = "00000000-0000-0000-0000-000000000301";

const pgDialect = new PgDialect();

function whereSqlToString(whereArg: unknown): string {
  try {
    return pgDialect.sqlToQuery(whereArg as Parameters<typeof pgDialect.sqlToQuery>[0]).sql;
  } catch {
    return "";
  }
}

function whereSqlParams(whereArg: unknown): unknown[] {
  try {
    return pgDialect.sqlToQuery(whereArg as Parameters<typeof pgDialect.sqlToQuery>[0]).params;
  } catch {
    return [];
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("encodeCursor / decodeCursor", () => {
  it("round-trips correctly", () => {
    const createdAt = "2025-01-01T00:00:00.000Z";
    const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const cursor = encodeCursor(createdAt, id);
    const decoded = decodeCursor(cursor);
    expect(decoded).not.toBeNull();
    expect(decoded!.createdAt).toBe(createdAt);
    expect(decoded!.id).toBe(id);
  });

  it("produces a URL-safe base64 string", () => {
    const cursor = encodeCursor("2025-01-01T00:00:00.000Z", "some-id");
    expect(cursor).not.toMatch(/[+/=]/);
  });
});

describe("CreateMemoryEntryInput schema", () => {
  it("defaults memoryScope to group when not provided", () => {
    const result = CreateMemoryEntryInput.parse({
      content: "test",
      memoryType: "fact",
      tags: ["test"],
    });
    expect(result.memoryScope).toBe("group");
  });

  it("ttlSeconds is null/undefined by default", () => {
    const result = CreateMemoryEntryInput.parse({
      content: "test",
      memoryType: "fact",
      tags: ["test"],
    });
    expect(result.ttlSeconds).toBeUndefined();
  });

  it("computes correct expiry for ttlSeconds", () => {
    const ttlSeconds = 3600;
    const before = Date.now();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const after = Date.now();

    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + ttlSeconds * 1000);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(after + ttlSeconds * 1000);
  });
});

describe("scope promotion validation", () => {
  it("private < user < group ordering", () => {
    const order: Record<string, number> = { private: 0, user: 1, group: 2 };
    expect(order["private"]).toBeLessThan(order["user"]);
    expect(order["user"]).toBeLessThan(order["group"]);
  });
});

describe("createMemory", () => {
  afterEach(() => {
    delete process.env.ENRICHMENT_CHAT_PROVIDER;
  });

  it("rejects autonomous agents storing user-scoped memories", async () => {
    const sql = (() => {
      throw new Error("should not query");
    }) as unknown as SqlClient;

    const result = await createMemory(
      sql as unknown as TransactionClient,
      makeAgent({ isAutonomous: true }),
      {
        content: "test",
        memoryType: "fact",
        memoryScope: "user",
        tags: ["test"],
      },
    );

    expect(result).toEqual({
      error: "validation",
      message: "Autonomous agents cannot store user-scoped memories",
    });
  });

  it("creates a memory, version snapshot, and audit log through Drizzle", async () => {
    const countWhereMock = vi.fn().mockResolvedValue([{ count: 1 }]);
    const countFromMock = vi.fn(() => ({
      where: countWhereMock,
    }));
    const selectMock = vi.fn(() => ({
      from: countFromMock,
    }));

    const memoryReturningMock = vi.fn().mockResolvedValue([
      {
        id: "00000000-0000-0000-0000-000000000200",
        content: "hello world",
        summary: null,
        memory_type: "fact",
        memory_scope: "group",
        tags: ["ops"],
        auto_tags: [],
        related_memory_ids: [],
        usefulness_score: 0,
        outdated: false,
        ttl_seconds: null,
        expires_at: null,
        created_at: new Date("2026-03-22T01:00:00.000Z"),
        last_accessed_at: new Date("2026-03-22T01:00:00.000Z"),
        author_agent_id: AGENT_ID,
        group_id: "00000000-0000-0000-0000-000000000300",
        user_id: USER_ID,
        version: 0,
      },
    ]);
    const memoryValuesMock = vi.fn(() => ({
      returning: memoryReturningMock,
    }));
    const versionValuesMock = vi.fn().mockResolvedValue(undefined);
    const auditValuesMock = vi.fn().mockResolvedValue(undefined);
    const insertMock = vi
      .fn()
      .mockReturnValueOnce({ values: memoryValuesMock })
      .mockReturnValueOnce({ values: versionValuesMock })
      .mockReturnValueOnce({ values: auditValuesMock });

    drizzleMock.mockReturnValue({
      select: selectMock,
      insert: insertMock,
    });

    const result = await createMemory(
      {} as TransactionClient,
      makeAgent({ userId: USER_ID }),
      {
        content: "hello world",
        memoryType: "fact",
        memoryScope: "group",
        tags: ["ops"],
      },
      {
        hasGroupMembership: true,
        memoryQuota: 10,
        groupIds: ["00000000-0000-0000-0000-000000000300"],
      },
    );

    expect(insertMock).toHaveBeenNthCalledWith(1, memoryEntries);
    expect(memoryValuesMock).toHaveBeenCalledWith({
      content: "hello world",
      summary: null,
      memoryType: "fact",
      memoryScope: "group",
      tags: ["ops"],
      ttlSeconds: null,
      expiresAt: null,
      authorAgentId: AGENT_ID,
      userId: USER_ID,
      groupId: "00000000-0000-0000-0000-000000000300",
      version: 0,
    });
    expect(insertMock).toHaveBeenNthCalledWith(2, memoryVersions);
    expect(versionValuesMock).toHaveBeenCalledWith({
      memoryEntryId: "00000000-0000-0000-0000-000000000200",
      content: "hello world",
      version: 0,
      authorAgentId: AGENT_ID,
    });
    expect(insertMock).toHaveBeenNthCalledWith(3, auditLog);
    expect(auditValuesMock).toHaveBeenCalledWith({
      tenantId: "00000000-0000-0000-0000-000000000010",
      actorId: AGENT_ID,
      actorType: "agent",
      action: "memory.create",
      targetId: "00000000-0000-0000-0000-000000000200",
      outcome: "success",
      metadata: null,
    });
    expect(result).toEqual({
      id: "00000000-0000-0000-0000-000000000200",
      content: "hello world",
      summary: null,
      memoryType: "fact",
      memoryScope: "group",
      tags: ["ops"],
      autoTags: [],
      relatedMemoryIds: [],
      usefulnessScore: 0,
      outdated: false,
      ttlSeconds: null,
      expiresAt: null,
      createdAt: "2026-03-22T01:00:00.000Z",
      lastAccessedAt: "2026-03-22T01:00:00.000Z",
      authorAgentId: AGENT_ID,
      authorAgentDisplayName: null,
      groupId: "00000000-0000-0000-0000-000000000300",
      userId: USER_ID,
      version: 0,
    });
  });

  it("sets groupId for user-scoped memories when the agent has one group", async () => {
    const countWhereMock = vi.fn().mockResolvedValue([{ count: 1 }]);
    const selectMock = vi.fn(() => ({
      from: vi.fn(() => ({ where: countWhereMock })),
    }));

    const memoryValuesMock = vi.fn(() => ({
      returning: vi.fn().mockResolvedValue([{
        id: "00000000-0000-0000-0000-000000000201",
        content: "user scoped memory",
        summary: null,
        memory_type: "fact",
        memory_scope: "user",
        tags: ["user"],
        auto_tags: [],
        related_memory_ids: [],
        usefulness_score: 0,
        outdated: false,
        ttl_seconds: null,
        expires_at: null,
        created_at: new Date("2026-03-22T01:00:00.000Z"),
        last_accessed_at: new Date("2026-03-22T01:00:00.000Z"),
        author_agent_id: AGENT_ID,
        group_id: GROUP_A,
        user_id: USER_ID,
        version: 0,
      }]),
    }));
    const insertMock = vi
      .fn()
      .mockReturnValueOnce({ values: memoryValuesMock })
      .mockReturnValueOnce({ values: vi.fn().mockResolvedValue(undefined) })
      .mockReturnValueOnce({ values: vi.fn().mockResolvedValue(undefined) });

    drizzleMock.mockReturnValue({
      select: selectMock,
      insert: insertMock,
    });

    await createMemory(
      {} as TransactionClient,
      makeAgent({ userId: USER_ID }),
      {
        content: "user scoped memory",
        memoryType: "fact",
        memoryScope: "user",
        tags: ["user"],
      },
      { hasGroupMembership: true, memoryQuota: 10, groupIds: [GROUP_A] },
    );

    expect(memoryValuesMock).toHaveBeenCalledWith(expect.objectContaining({
      memoryScope: "user",
      groupId: GROUP_A,
      userId: USER_ID,
    }));
  });

  it("persists caller-provided summary", async () => {
    const countWhereMock = vi.fn().mockResolvedValue([{ count: 1 }]);
    const selectMock = vi.fn(() => ({ from: vi.fn(() => ({ where: countWhereMock })) }));
    const memoryValuesMock = vi.fn(() => ({
      returning: vi.fn().mockResolvedValue([{ id: "m1", content: "c", summary: "provided summary", memory_type: "fact", memory_scope: "group", tags: ["ops"], auto_tags: [], related_memory_ids: [], usefulness_score: 0, outdated: false, ttl_seconds: null, expires_at: null, created_at: new Date("2026-01-01T00:00:00.000Z"), last_accessed_at: new Date("2026-01-01T00:00:00.000Z"), author_agent_id: AGENT_ID, group_id: GROUP_A, user_id: USER_ID, version: 0 }]),
    }));
    const insertMock = vi.fn().mockReturnValueOnce({ values: memoryValuesMock }).mockReturnValueOnce({ values: vi.fn().mockResolvedValue(undefined) }).mockReturnValueOnce({ values: vi.fn().mockResolvedValue(undefined) });
    drizzleMock.mockReturnValue({ select: selectMock, insert: insertMock });

    await createMemory(
      {} as TransactionClient,
      makeAgent({ userId: USER_ID }),
      { content: "c", summary: "  provided summary  ", memoryType: "fact", memoryScope: "group", tags: ["ops"] },
      { hasGroupMembership: true, memoryQuota: 10, groupIds: [GROUP_A] },
    );

    expect(memoryValuesMock).toHaveBeenCalledWith(expect.objectContaining({ summary: "provided summary" }));
  });

  it("rejects missing summary when chat enrichment is disabled", async () => {
    process.env.ENRICHMENT_CHAT_PROVIDER = "none";

    const result = await createMemory(
      {} as TransactionClient,
      makeAgent({ userId: USER_ID }),
      { content: "c", memoryType: "fact", memoryScope: "group", tags: ["ops"] },
      { hasGroupMembership: true, memoryQuota: 10, groupIds: [GROUP_A] },
    );

    expect(result).toEqual({
      error: "validation",
      message: "summary is required when chat enrichment is disabled",
    });
  });

  it("rejects empty or whitespace summary when chat enrichment is disabled", async () => {
    process.env.ENRICHMENT_CHAT_PROVIDER = "none";

    const emptyResult = await createMemory(
      {} as TransactionClient,
      makeAgent({ userId: USER_ID }),
      { content: "c", summary: "", memoryType: "fact", memoryScope: "group", tags: ["ops"] },
      { hasGroupMembership: true, memoryQuota: 10, groupIds: [GROUP_A] },
    );

    const whitespaceResult = await createMemory(
      {} as TransactionClient,
      makeAgent({ userId: USER_ID }),
      { content: "c", summary: "   ", memoryType: "fact", memoryScope: "group", tags: ["ops"] },
      { hasGroupMembership: true, memoryQuota: 10, groupIds: [GROUP_A] },
    );

    expect(emptyResult).toEqual({
      error: "validation",
      message: "summary is required when chat enrichment is disabled",
    });
    expect(whitespaceResult).toEqual({
      error: "validation",
      message: "summary is required when chat enrichment is disabled",
    });
  });

  it("rejects group-scoped memory when agent belongs to multiple groups", async () => {
    const result = await createMemory(
      {} as TransactionClient,
      makeAgent({ userId: USER_ID }),
      {
        content: "c",
        memoryType: "fact",
        memoryScope: "group",
        tags: ["ops"],
      },
      { hasGroupMembership: true, memoryQuota: 10, groupIds: [GROUP_A, GROUP_B] },
    );

    expect(result).toEqual({
      error: "validation",
      message: "Agent must belong to exactly one group to store group-scoped memories",
    });
  });

  it("rejects user-scoped memory when agent belongs to multiple groups", async () => {
    const result = await createMemory(
      {} as TransactionClient,
      makeAgent({ userId: USER_ID }),
      {
        content: "c",
        memoryType: "fact",
        memoryScope: "user",
        tags: ["ops"],
      },
      { hasGroupMembership: true, memoryQuota: 10, groupIds: [GROUP_A, GROUP_B] },
    );

    expect(result).toEqual({
      error: "validation",
      message: "Agent must belong to exactly one group to store user-scoped memories",
    });
  });
});

describe("resolveMemoryWritePreflight", () => {
  it("returns matching group memberships and quota through Drizzle", async () => {
    const whereMock = vi.fn().mockResolvedValue([
      {
        memoryQuota: 250,
        groupId: "00000000-0000-0000-0000-000000000222",
      },
    ]);
    const innerJoinMock = vi.fn(() => ({
      where: whereMock,
    }));
    const fromMock = vi.fn(() => ({
      innerJoin: innerJoinMock,
    }));
    const selectMock = vi.fn(() => ({
      from: fromMock,
    }));

    drizzleMock.mockReturnValue({
      select: selectMock,
    });

    const result = await resolveMemoryWritePreflight(
      {} as SqlClient,
      makeAgent(),
    );

    expect(selectMock).toHaveBeenCalledWith({
      memoryQuota: agentGroups.memoryQuota,
      groupId: agentGroups.id,
    });
    expect(fromMock).toHaveBeenCalledWith(agentGroupMembers);
    expect(result).toEqual({
      hasGroupMembership: true,
      memoryQuota: 250,
      groupIds: ["00000000-0000-0000-0000-000000000222"],
      groupQuotasById: {
        "00000000-0000-0000-0000-000000000222": 250,
      },
    });
  });
});

describe("fetchMemory", () => {
  it("loads the entry with versions and bumps usefulness through Drizzle", async () => {
    const entryLimitMock = vi.fn().mockResolvedValue([
      {
        id: "00000000-0000-0000-0000-000000000401",
        content: "remember this",
        summary: null,
        memory_type: "fact",
        memory_scope: "group",
        tags: ["ops"],
        auto_tags: [],
        related_memory_ids: [],
        usefulness_score: 5,
        outdated: false,
        ttl_seconds: null,
        expires_at: null,
        created_at: new Date("2026-03-22T01:00:00.000Z"),
        last_accessed_at: new Date("2026-03-22T01:10:00.000Z"),
        author_agent_id: AGENT_ID,
        author_agent_display_name: "test-agent · owner@example.com",
        group_id: "00000000-0000-0000-0000-000000000300",
        user_id: USER_ID,
        version: 2,
      },
    ]);
    const entryWhereMock = vi.fn(() => ({
      limit: entryLimitMock,
    }));
    const secondLeftJoinMock = vi.fn(() => ({
      where: entryWhereMock,
    }));
    const firstLeftJoinMock = vi.fn(() => ({
      leftJoin: secondLeftJoinMock,
    }));
    const entryFromMock = vi.fn(() => ({
      leftJoin: firstLeftJoinMock,
    }));

    const versionsOrderByMock = vi.fn().mockResolvedValue([
      {
        id: "00000000-0000-0000-0000-000000000402",
        memory_entry_id: "00000000-0000-0000-0000-000000000401",
        content: "remember this",
        version: 0,
        author_agent_id: AGENT_ID,
        created_at: new Date("2026-03-22T01:00:00.000Z"),
      },
      {
        id: "00000000-0000-0000-0000-000000000403",
        memory_entry_id: "00000000-0000-0000-0000-000000000401",
        content: "remember this, updated",
        version: 2,
        author_agent_id: AGENT_ID,
        created_at: new Date("2026-03-22T01:15:00.000Z"),
      },
    ]);
    const versionsWhereMock = vi.fn(() => ({
      orderBy: versionsOrderByMock,
    }));
    const versionsFromMock = vi.fn(() => ({
      where: versionsWhereMock,
    }));

    const groupIdSelectMock = mockGroupIdSelect();
    const selectMock = vi
      .fn()
      .mockImplementationOnce(groupIdSelectMock)
      .mockImplementationOnce(() => ({ from: entryFromMock }))
      .mockImplementationOnce(() => ({ from: versionsFromMock }));

    const updateWhereMock = vi.fn().mockResolvedValue(undefined);
    const updateSetMock = vi.fn(() => ({
      where: updateWhereMock,
    }));
    const updateMock = vi.fn(() => ({
      set: updateSetMock,
    }));

    drizzleMock.mockReturnValue({
      select: selectMock,
      update: updateMock,
    });

    const result = await fetchMemory(
      {} as TransactionClient,
      makeAgent({ userId: USER_ID }),
      "00000000-0000-0000-0000-000000000401",
    );

    expect(updateMock).toHaveBeenCalledWith(memoryEntries);
    expect(result).toEqual({
      entry: {
        id: "00000000-0000-0000-0000-000000000401",
        content: "remember this",
        summary: null,
        memoryType: "fact",
        memoryScope: "group",
        tags: ["ops"],
        autoTags: [],
        relatedMemoryIds: [],
        usefulnessScore: 5,
        outdated: false,
        ttlSeconds: null,
        expiresAt: null,
        createdAt: "2026-03-22T01:00:00.000Z",
        lastAccessedAt: "2026-03-22T01:10:00.000Z",
        authorAgentId: AGENT_ID,
        authorAgentDisplayName: "test-agent · owner@example.com",
        groupId: "00000000-0000-0000-0000-000000000300",
        userId: USER_ID,
        version: 2,
      },
      versions: [
        {
          id: "00000000-0000-0000-0000-000000000402",
          memoryEntryId: "00000000-0000-0000-0000-000000000401",
          content: "remember this",
          version: 0,
          authorAgentId: AGENT_ID,
          createdAt: "2026-03-22T01:00:00.000Z",
        },
        {
          id: "00000000-0000-0000-0000-000000000403",
          memoryEntryId: "00000000-0000-0000-0000-000000000401",
          content: "remember this, updated",
          version: 2,
          authorAgentId: AGENT_ID,
          createdAt: "2026-03-22T01:15:00.000Z",
        },
      ],
    });
  });
});

describe("updateMemory", () => {
  afterEach(() => {
    delete process.env.ENRICHMENT_CHAT_PROVIDER;
  });

  it("returns a conflict with the current version when optimistic locking fails", async () => {
    const entryLimitMock = vi.fn().mockResolvedValue([
      {
        id: "00000000-0000-0000-0000-000000000501",
        content: "draft",
        summary: null,
        memory_type: "fact",
        memory_scope: "group",
        tags: ["ops"],
        auto_tags: [],
        related_memory_ids: [],
        usefulness_score: 0,
        outdated: false,
        ttl_seconds: null,
        expires_at: null,
        created_at: new Date("2026-03-22T02:00:00.000Z"),
        last_accessed_at: new Date("2026-03-22T02:00:00.000Z"),
        author_agent_id: AGENT_ID,
        group_id: "00000000-0000-0000-0000-000000000300",
        user_id: null,
        version: 3,
      },
    ]);
    const entryWhereMock = vi.fn(() => ({
      limit: entryLimitMock,
    }));
    const entryFromMock = vi.fn(() => ({
      where: entryWhereMock,
    }));
    const versionLimitMock = vi.fn().mockResolvedValue([{ version: 4 }]);
    const versionWhereMock = vi.fn(() => ({
      limit: versionLimitMock,
    }));
    const versionFromMock = vi.fn(() => ({
      where: versionWhereMock,
    }));
    const groupIdSelectMock = mockGroupIdSelect();
    const selectMock = vi
      .fn()
      .mockImplementationOnce(groupIdSelectMock)
      .mockImplementationOnce(() => ({ from: entryFromMock }))
      .mockImplementationOnce(() => ({ from: versionFromMock }));

    const returningMock = vi.fn().mockResolvedValue([]);
    const updateWhereMock = vi.fn(() => ({
      returning: returningMock,
    }));
    const updateSetMock = vi.fn(() => ({
      where: updateWhereMock,
    }));
    const updateMock = vi.fn(() => ({
      set: updateSetMock,
    }));

    drizzleMock.mockReturnValue({
      select: selectMock,
      update: updateMock,
    });

    const result = await updateMemory(
      {} as TransactionClient,
      makeAgent(),
      "00000000-0000-0000-0000-000000000501",
      {
        content: "new draft",
        expectedVersion: 2,
      },
    );

    expect(result).toEqual({
      error: "conflict",
      currentVersion: 4,
    });
  });

  it("does not trigger enrichment for tag reordering only", async () => {
    const entryLimitMock = vi.fn().mockResolvedValue([
      {
        id: "00000000-0000-0000-0000-000000000510",
        content: "stable content",
        summary: "existing summary",
        memory_type: "fact",
        memory_scope: "group",
        tags: ["ops", "docs"],
        auto_tags: ["guide"],
        related_memory_ids: ["00000000-0000-0000-0000-000000000599"],
        usefulness_score: 0,
        outdated: false,
        ttl_seconds: null,
        expires_at: null,
        created_at: new Date("2026-03-22T02:00:00.000Z"),
        last_accessed_at: new Date("2026-03-22T02:00:00.000Z"),
        author_agent_id: AGENT_ID,
        group_id: "00000000-0000-0000-0000-000000000300",
        user_id: null,
        version: 3,
      },
    ]);
    const entryWhereMock = vi.fn(() => ({
      limit: entryLimitMock,
    }));
    const entryFromMock = vi.fn(() => ({
      where: entryWhereMock,
    }));
    const groupIdSelectMock = mockGroupIdSelect();
    const selectMock = vi
      .fn()
      .mockImplementationOnce(groupIdSelectMock)
      .mockImplementationOnce(() => ({ from: entryFromMock }));

    const returningMock = vi.fn().mockResolvedValue([
      {
        id: "00000000-0000-0000-0000-000000000510",
        content: "stable content",
        summary: "existing summary",
        memory_type: "fact",
        memory_scope: "group",
        tags: ["docs", "ops"],
        auto_tags: ["guide"],
        related_memory_ids: ["00000000-0000-0000-0000-000000000599"],
        usefulness_score: 0,
        outdated: false,
        ttl_seconds: null,
        expires_at: null,
        created_at: new Date("2026-03-22T02:00:00.000Z"),
        last_accessed_at: new Date("2026-03-22T02:00:00.000Z"),
        author_agent_id: AGENT_ID,
        group_id: "00000000-0000-0000-0000-000000000300",
        user_id: null,
        version: 4,
      },
    ]);
    const updateWhereMock = vi.fn(() => ({
      returning: returningMock,
    }));
    const updateSetMock = vi.fn(() => ({
      where: updateWhereMock,
    }));
    const updateMock = vi.fn(() => ({
      set: updateSetMock,
    }));

    const memoryVersionInsertMock = vi.fn().mockResolvedValue(undefined);
    const auditInsertMock = vi.fn().mockResolvedValue(undefined);
    const insertMock = vi
      .fn()
      .mockReturnValueOnce({ values: memoryVersionInsertMock })
      .mockReturnValueOnce({ values: auditInsertMock });

    drizzleMock.mockReturnValue({
      select: selectMock,
      update: updateMock,
      insert: insertMock,
    });

    const result = await updateMemory(
      {} as TransactionClient,
      makeAgent(),
      "00000000-0000-0000-0000-000000000510",
      {
        tags: ["docs", "ops"],
        expectedVersion: 3,
      },
    );

    expect(updateSetMock).toHaveBeenCalledWith(
      expect.not.objectContaining({
        enrichmentStatus: "pending",
      }),
    );
    expect(result).toMatchObject({ needsEnrichment: false });
  });

  it("keeps summary and embedding for tag-only updates", async () => {
    const entryLimitMock = vi.fn().mockResolvedValue([
      {
        id: "00000000-0000-0000-0000-000000000511",
        content: "stable content",
        summary: "existing summary",
        memory_type: "fact",
        memory_scope: "group",
        tags: ["ops"],
        auto_tags: ["guide"],
        related_memory_ids: ["00000000-0000-0000-0000-000000000599"],
        usefulness_score: 0,
        outdated: false,
        ttl_seconds: null,
        expires_at: null,
        created_at: new Date("2026-03-22T02:00:00.000Z"),
        last_accessed_at: new Date("2026-03-22T02:00:00.000Z"),
        author_agent_id: AGENT_ID,
        group_id: "00000000-0000-0000-0000-000000000300",
        user_id: null,
        version: 3,
      },
    ]);
    const entryWhereMock = vi.fn(() => ({
      limit: entryLimitMock,
    }));
    const entryFromMock = vi.fn(() => ({
      where: entryWhereMock,
    }));
    const groupIdSelectMock = mockGroupIdSelect();
    const selectMock = vi
      .fn()
      .mockImplementationOnce(groupIdSelectMock)
      .mockImplementationOnce(() => ({ from: entryFromMock }));

    const returningMock = vi.fn().mockResolvedValue([
      {
        id: "00000000-0000-0000-0000-000000000511",
        content: "stable content",
        summary: "existing summary",
        memory_type: "fact",
        memory_scope: "group",
        tags: ["ops", "new"],
        auto_tags: [],
        related_memory_ids: ["00000000-0000-0000-0000-000000000599"],
        usefulness_score: 0,
        outdated: false,
        ttl_seconds: null,
        expires_at: null,
        created_at: new Date("2026-03-22T02:00:00.000Z"),
        last_accessed_at: new Date("2026-03-22T02:00:00.000Z"),
        author_agent_id: AGENT_ID,
        group_id: "00000000-0000-0000-0000-000000000300",
        user_id: null,
        version: 4,
      },
    ]);
    const updateWhereMock = vi.fn(() => ({
      returning: returningMock,
    }));
    const updateSetMock = vi.fn(() => ({
      where: updateWhereMock,
    }));
    const updateMock = vi.fn(() => ({
      set: updateSetMock,
    }));

    const memoryVersionInsertMock = vi.fn().mockResolvedValue(undefined);
    const auditInsertMock = vi.fn().mockResolvedValue(undefined);
    const insertMock = vi
      .fn()
      .mockReturnValueOnce({ values: memoryVersionInsertMock })
      .mockReturnValueOnce({ values: auditInsertMock });

    drizzleMock.mockReturnValue({
      select: selectMock,
      update: updateMock,
      insert: insertMock,
    });

    const result = await updateMemory(
      {} as TransactionClient,
      makeAgent(),
      "00000000-0000-0000-0000-000000000511",
      {
        tags: ["ops", "new"],
        expectedVersion: 3,
      },
    );

    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        autoTags: [],
        enrichmentStatus: "pending",
      }),
    );
    expect(updateSetMock).toHaveBeenCalledWith(
      expect.not.objectContaining({
        summary: null,
        embedding: null,
      }),
    );
    expect(result).toMatchObject({ needsEnrichment: true });
  });

  it("persists summary for summary-only updates", async () => {
    const entryLimitMock = vi.fn().mockResolvedValue([
      {
        id: "00000000-0000-0000-0000-000000000515",
        content: "stable content",
        summary: "existing summary",
        memory_type: "fact",
        memory_scope: "group",
        tags: ["ops"],
        auto_tags: ["guide"],
        related_memory_ids: ["00000000-0000-0000-0000-000000000599"],
        usefulness_score: 0,
        outdated: false,
        ttl_seconds: null,
        expires_at: null,
        created_at: new Date("2026-03-22T02:00:00.000Z"),
        last_accessed_at: new Date("2026-03-22T02:00:00.000Z"),
        author_agent_id: AGENT_ID,
        group_id: GROUP_A,
        user_id: null,
        version: 3,
      },
    ]);
    const selectMock = vi
      .fn()
      .mockImplementationOnce(mockGroupIdSelect())
      .mockImplementationOnce(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: entryLimitMock })) })) }));

    const returningMock = vi.fn().mockResolvedValue([
      {
        id: "00000000-0000-0000-0000-000000000515",
        content: "stable content",
        summary: "new summary",
        memory_type: "fact",
        memory_scope: "group",
        tags: ["ops"],
        auto_tags: ["guide"],
        related_memory_ids: ["00000000-0000-0000-0000-000000000599"],
        usefulness_score: 0,
        outdated: false,
        ttl_seconds: null,
        expires_at: null,
        created_at: new Date("2026-03-22T02:00:00.000Z"),
        last_accessed_at: new Date("2026-03-22T02:00:00.000Z"),
        author_agent_id: AGENT_ID,
        group_id: GROUP_A,
        user_id: null,
        version: 4,
      },
    ]);
    const updateWhereMock = vi.fn(() => ({ returning: returningMock }));
    const updateSetMock = vi.fn(() => ({ where: updateWhereMock }));
    const updateMock = vi.fn(() => ({ set: updateSetMock }));
    const insertMock = vi
      .fn()
      .mockReturnValueOnce({ values: vi.fn().mockResolvedValue(undefined) })
      .mockReturnValueOnce({ values: vi.fn().mockResolvedValue(undefined) });

    drizzleMock.mockReturnValue({
      select: selectMock,
      update: updateMock,
      insert: insertMock,
    });

    const result = await updateMemory(
      {} as TransactionClient,
      makeAgent(),
      "00000000-0000-0000-0000-000000000515",
      {
        summary: "  new summary  ",
        expectedVersion: 3,
      },
    );

    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: "new summary",
      }),
    );
    expect(updateSetMock).toHaveBeenCalledWith(
      expect.not.objectContaining({
        enrichmentStatus: "pending",
      }),
    );
    expect(result).toMatchObject({ needsEnrichment: false });
  });

  it("persists summary for tag-only updates when summary is provided", async () => {
    const entryLimitMock = vi.fn().mockResolvedValue([
      {
        id: "00000000-0000-0000-0000-000000000516",
        content: "stable content",
        summary: "existing summary",
        memory_type: "fact",
        memory_scope: "group",
        tags: ["ops"],
        auto_tags: ["guide"],
        related_memory_ids: ["00000000-0000-0000-0000-000000000599"],
        usefulness_score: 0,
        outdated: false,
        ttl_seconds: null,
        expires_at: null,
        created_at: new Date("2026-03-22T02:00:00.000Z"),
        last_accessed_at: new Date("2026-03-22T02:00:00.000Z"),
        author_agent_id: AGENT_ID,
        group_id: GROUP_A,
        user_id: null,
        version: 3,
      },
    ]);
    const selectMock = vi
      .fn()
      .mockImplementationOnce(mockGroupIdSelect())
      .mockImplementationOnce(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: entryLimitMock })) })) }));

    const returningMock = vi.fn().mockResolvedValue([
      {
        id: "00000000-0000-0000-0000-000000000516",
        content: "stable content",
        summary: "updated summary",
        memory_type: "fact",
        memory_scope: "group",
        tags: ["ops", "new"],
        auto_tags: [],
        related_memory_ids: ["00000000-0000-0000-0000-000000000599"],
        usefulness_score: 0,
        outdated: false,
        ttl_seconds: null,
        expires_at: null,
        created_at: new Date("2026-03-22T02:00:00.000Z"),
        last_accessed_at: new Date("2026-03-22T02:00:00.000Z"),
        author_agent_id: AGENT_ID,
        group_id: GROUP_A,
        user_id: null,
        version: 4,
      },
    ]);
    const updateWhereMock = vi.fn(() => ({ returning: returningMock }));
    const updateSetMock = vi.fn(() => ({ where: updateWhereMock }));
    const updateMock = vi.fn(() => ({ set: updateSetMock }));
    const insertMock = vi
      .fn()
      .mockReturnValueOnce({ values: vi.fn().mockResolvedValue(undefined) })
      .mockReturnValueOnce({ values: vi.fn().mockResolvedValue(undefined) });

    drizzleMock.mockReturnValue({
      select: selectMock,
      update: updateMock,
      insert: insertMock,
    });

    const result = await updateMemory(
      {} as TransactionClient,
      makeAgent(),
      "00000000-0000-0000-0000-000000000516",
      {
        tags: ["ops", "new"],
        summary: "updated summary",
        expectedVersion: 3,
      },
    );

    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: "updated summary",
        autoTags: [],
        enrichmentStatus: "pending",
      }),
    );
    expect(result).toMatchObject({ needsEnrichment: true });
  });

  it("persists summary-only updates when chat provider is none", async () => {
    process.env.ENRICHMENT_CHAT_PROVIDER = "none";

    const entryLimitMock = vi.fn().mockResolvedValue([
      {
        id: "00000000-0000-0000-0000-000000000517",
        content: "stable content",
        summary: "existing summary",
        memory_type: "fact",
        memory_scope: "group",
        tags: ["ops"],
        auto_tags: ["guide"],
        related_memory_ids: ["00000000-0000-0000-0000-000000000599"],
        usefulness_score: 0,
        outdated: false,
        ttl_seconds: null,
        expires_at: null,
        created_at: new Date("2026-03-22T02:00:00.000Z"),
        last_accessed_at: new Date("2026-03-22T02:00:00.000Z"),
        author_agent_id: AGENT_ID,
        group_id: GROUP_A,
        user_id: null,
        version: 3,
      },
    ]);
    const selectMock = vi
      .fn()
      .mockImplementationOnce(mockGroupIdSelect())
      .mockImplementationOnce(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: entryLimitMock })) })) }));

    const returningMock = vi.fn().mockResolvedValue([
      {
        id: "00000000-0000-0000-0000-000000000517",
        content: "stable content",
        summary: "summary from caller",
        memory_type: "fact",
        memory_scope: "group",
        tags: ["ops"],
        auto_tags: ["guide"],
        related_memory_ids: ["00000000-0000-0000-0000-000000000599"],
        usefulness_score: 0,
        outdated: false,
        ttl_seconds: null,
        expires_at: null,
        created_at: new Date("2026-03-22T02:00:00.000Z"),
        last_accessed_at: new Date("2026-03-22T02:00:00.000Z"),
        author_agent_id: AGENT_ID,
        group_id: GROUP_A,
        user_id: null,
        version: 4,
      },
    ]);
    const updateWhereMock = vi.fn(() => ({ returning: returningMock }));
    const updateSetMock = vi.fn(() => ({ where: updateWhereMock }));
    const updateMock = vi.fn(() => ({ set: updateSetMock }));
    const insertMock = vi
      .fn()
      .mockReturnValueOnce({ values: vi.fn().mockResolvedValue(undefined) })
      .mockReturnValueOnce({ values: vi.fn().mockResolvedValue(undefined) });

    drizzleMock.mockReturnValue({
      select: selectMock,
      update: updateMock,
      insert: insertMock,
    });

    await updateMemory(
      {} as TransactionClient,
      makeAgent(),
      "00000000-0000-0000-0000-000000000517",
      {
        summary: "summary from caller",
        expectedVersion: 3,
      },
    );

    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: "summary from caller",
      }),
    );
  });

  it("uses caller-provided summary when chat provider is none", async () => {
    process.env.ENRICHMENT_CHAT_PROVIDER = "none";

    const entryLimitMock = vi.fn().mockResolvedValue([
      {
        id: "00000000-0000-0000-0000-000000000512",
        content: "stable content",
        summary: "existing summary",
        memory_type: "fact",
        memory_scope: "group",
        tags: ["ops"],
        auto_tags: ["guide"],
        related_memory_ids: ["00000000-0000-0000-0000-000000000599"],
        usefulness_score: 0,
        outdated: false,
        ttl_seconds: null,
        expires_at: null,
        created_at: new Date("2026-03-22T02:00:00.000Z"),
        last_accessed_at: new Date("2026-03-22T02:00:00.000Z"),
        author_agent_id: AGENT_ID,
        group_id: GROUP_A,
        user_id: null,
        version: 3,
      },
    ]);
    const selectMock = vi
      .fn()
      .mockImplementationOnce(mockGroupIdSelect())
      .mockImplementationOnce(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: entryLimitMock })) })) }));

    const returningMock = vi.fn().mockResolvedValue([
      {
        id: "00000000-0000-0000-0000-000000000512",
        content: "updated content",
        summary: "updated summary",
        memory_type: "fact",
        memory_scope: "group",
        tags: ["ops"],
        auto_tags: [],
        related_memory_ids: [],
        usefulness_score: 0,
        outdated: false,
        ttl_seconds: null,
        expires_at: null,
        created_at: new Date("2026-03-22T02:00:00.000Z"),
        last_accessed_at: new Date("2026-03-22T02:00:00.000Z"),
        author_agent_id: AGENT_ID,
        group_id: GROUP_A,
        user_id: null,
        version: 4,
      },
    ]);
    const updateWhereMock = vi.fn(() => ({ returning: returningMock }));
    const updateSetMock = vi.fn(() => ({ where: updateWhereMock }));
    const updateMock = vi.fn(() => ({ set: updateSetMock }));

    const insertMock = vi
      .fn()
      .mockReturnValueOnce({ values: vi.fn().mockResolvedValue(undefined) })
      .mockReturnValueOnce({ values: vi.fn().mockResolvedValue(undefined) });

    drizzleMock.mockReturnValue({
      select: selectMock,
      update: updateMock,
      insert: insertMock,
    });

    await updateMemory(
      {} as TransactionClient,
      makeAgent(),
      "00000000-0000-0000-0000-000000000512",
      {
        content: "updated content",
        summary: "  updated summary  ",
        expectedVersion: 3,
      },
    );

    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: "updated summary",
      }),
    );
  });

  it("preserves existing summary on content update when chat provider is none and no summary is provided", async () => {
    process.env.ENRICHMENT_CHAT_PROVIDER = "none";

    const entryLimitMock = vi.fn().mockResolvedValue([
      {
        id: "00000000-0000-0000-0000-000000000513",
        content: "stable content",
        summary: "existing summary",
        memory_type: "fact",
        memory_scope: "group",
        tags: ["ops"],
        auto_tags: ["guide"],
        related_memory_ids: ["00000000-0000-0000-0000-000000000599"],
        usefulness_score: 0,
        outdated: false,
        ttl_seconds: null,
        expires_at: null,
        created_at: new Date("2026-03-22T02:00:00.000Z"),
        last_accessed_at: new Date("2026-03-22T02:00:00.000Z"),
        author_agent_id: AGENT_ID,
        group_id: GROUP_A,
        user_id: null,
        version: 3,
      },
    ]);
    const selectMock = vi
      .fn()
      .mockImplementationOnce(mockGroupIdSelect())
      .mockImplementationOnce(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: entryLimitMock })) })) }));

    const returningMock = vi.fn().mockResolvedValue([
      {
        id: "00000000-0000-0000-0000-000000000513",
        content: "updated content",
        summary: "existing summary",
        memory_type: "fact",
        memory_scope: "group",
        tags: ["ops"],
        auto_tags: [],
        related_memory_ids: [],
        usefulness_score: 0,
        outdated: false,
        ttl_seconds: null,
        expires_at: null,
        created_at: new Date("2026-03-22T02:00:00.000Z"),
        last_accessed_at: new Date("2026-03-22T02:00:00.000Z"),
        author_agent_id: AGENT_ID,
        group_id: GROUP_A,
        user_id: null,
        version: 4,
      },
    ]);
    const updateWhereMock = vi.fn(() => ({ returning: returningMock }));
    const updateSetMock = vi.fn(() => ({ where: updateWhereMock }));
    const updateMock = vi.fn(() => ({ set: updateSetMock }));
    const insertMock = vi
      .fn()
      .mockReturnValueOnce({ values: vi.fn().mockResolvedValue(undefined) })
      .mockReturnValueOnce({ values: vi.fn().mockResolvedValue(undefined) });

    drizzleMock.mockReturnValue({
      select: selectMock,
      update: updateMock,
      insert: insertMock,
    });

    await updateMemory(
      {} as TransactionClient,
      makeAgent(),
      "00000000-0000-0000-0000-000000000513",
      {
        content: "updated content",
        expectedVersion: 3,
      },
    );

    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: "existing summary",
      }),
    );
  });

  it("nulls summary on content update when chat provider can enrich and no summary is provided", async () => {
    process.env.ENRICHMENT_CHAT_PROVIDER = "ollama";

    const entryLimitMock = vi.fn().mockResolvedValue([
      {
        id: "00000000-0000-0000-0000-000000000514",
        content: "stable content",
        summary: "existing summary",
        memory_type: "fact",
        memory_scope: "group",
        tags: ["ops"],
        auto_tags: ["guide"],
        related_memory_ids: ["00000000-0000-0000-0000-000000000599"],
        usefulness_score: 0,
        outdated: false,
        ttl_seconds: null,
        expires_at: null,
        created_at: new Date("2026-03-22T02:00:00.000Z"),
        last_accessed_at: new Date("2026-03-22T02:00:00.000Z"),
        author_agent_id: AGENT_ID,
        group_id: GROUP_A,
        user_id: null,
        version: 3,
      },
    ]);
    const selectMock = vi
      .fn()
      .mockImplementationOnce(mockGroupIdSelect())
      .mockImplementationOnce(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: entryLimitMock })) })) }));

    const returningMock = vi.fn().mockResolvedValue([
      {
        id: "00000000-0000-0000-0000-000000000514",
        content: "updated content",
        summary: null,
        memory_type: "fact",
        memory_scope: "group",
        tags: ["ops"],
        auto_tags: [],
        related_memory_ids: [],
        usefulness_score: 0,
        outdated: false,
        ttl_seconds: null,
        expires_at: null,
        created_at: new Date("2026-03-22T02:00:00.000Z"),
        last_accessed_at: new Date("2026-03-22T02:00:00.000Z"),
        author_agent_id: AGENT_ID,
        group_id: GROUP_A,
        user_id: null,
        version: 4,
      },
    ]);
    const updateWhereMock = vi.fn(() => ({ returning: returningMock }));
    const updateSetMock = vi.fn(() => ({ where: updateWhereMock }));
    const updateMock = vi.fn(() => ({ set: updateSetMock }));
    const insertMock = vi
      .fn()
      .mockReturnValueOnce({ values: vi.fn().mockResolvedValue(undefined) })
      .mockReturnValueOnce({ values: vi.fn().mockResolvedValue(undefined) });

    drizzleMock.mockReturnValue({
      select: selectMock,
      update: updateMock,
      insert: insertMock,
    });

    await updateMemory(
      {} as TransactionClient,
      makeAgent(),
      "00000000-0000-0000-0000-000000000514",
      {
        content: "updated content",
        expectedVersion: 3,
      },
    );

    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: null,
      }),
    );
  });
});

describe("deleteMemory", () => {
  it("deletes author-owned entries and writes an audit record", async () => {
    const entryLimitMock = vi.fn().mockResolvedValue([
      {
        id: "00000000-0000-0000-0000-000000000601",
        content: "cleanup",
        summary: null,
        memory_type: "fact",
        memory_scope: "group",
        tags: [],
        auto_tags: [],
        related_memory_ids: [],
        usefulness_score: 0,
        outdated: false,
        ttl_seconds: null,
        expires_at: null,
        created_at: new Date("2026-03-22T03:00:00.000Z"),
        last_accessed_at: new Date("2026-03-22T03:00:00.000Z"),
        author_agent_id: AGENT_ID,
        group_id: null,
        user_id: null,
        version: 0,
      },
    ]);
    const entryWhereMock = vi.fn(() => ({
      limit: entryLimitMock,
    }));
    const entryFromMock = vi.fn(() => ({
      where: entryWhereMock,
    }));
    const selectMock = vi.fn(() => ({
      from: entryFromMock,
    }));

    const deleteWhereMock = vi.fn().mockResolvedValue(undefined);
    const deleteMock = vi.fn(() => ({
      where: deleteWhereMock,
    }));
    const auditValuesMock = vi.fn().mockResolvedValue(undefined);
    const insertMock = vi.fn(() => ({
      values: auditValuesMock,
    }));

    drizzleMock.mockReturnValue({
      select: selectMock,
      delete: deleteMock,
      insert: insertMock,
    });

    const result = await deleteMemory(
      {} as TransactionClient,
      makeAgent(),
      "00000000-0000-0000-0000-000000000601",
    );

    expect(deleteMock).toHaveBeenCalledWith(memoryEntries);
    expect(insertMock).toHaveBeenCalledWith(auditLog);
    expect(result).toEqual({ success: true });
  });
});

describe("listAgentMemories", () => {
  it("returns paginated group memories with author display names", async () => {
    const limitMock = vi.fn().mockResolvedValue([
      {
        id: "00000000-0000-0000-0000-000000000701",
        content: "alpha memory",
        summary: "alpha",
        memory_type: "fact",
        memory_scope: "group",
        tags: ["ops"],
        auto_tags: [],
        related_memory_ids: [],
        usefulness_score: 2,
        outdated: false,
        ttl_seconds: null,
        expires_at: null,
        created_at: new Date("2026-03-22T04:00:00.000Z"),
        last_accessed_at: new Date("2026-03-22T04:05:00.000Z"),
        author_agent_id: "00000000-0000-0000-0000-000000000777",
        author_agent_display_name: "worker-1 · owner@example.com",
        group_id: null,
        user_id: null,
        version: 0,
      },
      {
        id: "00000000-0000-0000-0000-000000000702",
        content: "beta memory",
        summary: null,
        memory_type: "pattern",
        memory_scope: "group",
        tags: ["docs"],
        auto_tags: [],
        related_memory_ids: [],
        usefulness_score: 3,
        outdated: false,
        ttl_seconds: null,
        expires_at: null,
        created_at: new Date("2026-03-22T03:00:00.000Z"),
        last_accessed_at: new Date("2026-03-22T03:05:00.000Z"),
        author_agent_id: "00000000-0000-0000-0000-000000000777",
        author_agent_display_name: "worker-1 · owner@example.com",
        group_id: null,
        user_id: null,
        version: 1,
      },
      {
        id: "00000000-0000-0000-0000-000000000703",
        content: "gamma memory",
        summary: null,
        memory_type: "procedure",
        memory_scope: "group",
        tags: ["runbook"],
        auto_tags: [],
        related_memory_ids: [],
        usefulness_score: 1,
        outdated: false,
        ttl_seconds: null,
        expires_at: null,
        created_at: new Date("2026-03-22T02:00:00.000Z"),
        last_accessed_at: new Date("2026-03-22T02:05:00.000Z"),
        author_agent_id: "00000000-0000-0000-0000-000000000777",
        author_agent_display_name: "worker-1 · owner@example.com",
        group_id: null,
        user_id: null,
        version: 2,
      },
    ]);
    const orderByMock = vi.fn(() => ({
      limit: limitMock,
    }));
    const whereMock = vi.fn((whereArg: unknown) => {
      void whereArg;
      return {
        orderBy: orderByMock,
      };
    });
    const secondLeftJoinMock = vi.fn(() => ({
      where: whereMock,
    }));
    const firstLeftJoinMock = vi.fn(() => ({
      leftJoin: secondLeftJoinMock,
    }));
    const fromMock = vi.fn(() => ({
      leftJoin: firstLeftJoinMock,
    }));
    const groupIdSelectMock = mockGroupIdSelect();
    const selectMock = vi
      .fn()
      .mockImplementationOnce(groupIdSelectMock)
      .mockImplementationOnce(() => ({ from: fromMock }));

    drizzleMock.mockReturnValue({
      select: selectMock,
    });

    const result = await listAgentMemories(
      {} as TransactionClient,
      makeAgent(),
      "00000000-0000-0000-0000-000000000777",
      { limit: 2 },
    ) as { items: MemoryEntryTier1[]; nextCursor: string | null };

    expect(fromMock).toHaveBeenCalledWith(memoryEntries);
    expect(limitMock).toHaveBeenCalledWith(3);
    expect(result.items).toEqual([
      {
        id: "00000000-0000-0000-0000-000000000701",
        summary: "alpha",
        memoryType: "fact",
        memoryScope: "group",
        tags: ["ops"],
        autoTags: [],
        usefulnessScore: 2,
        outdated: false,
        createdAt: new Date("2026-03-22T04:00:00.000Z"),
        authorAgentId: "00000000-0000-0000-0000-000000000777",
        authorAgentDisplayName: "worker-1 · owner@example.com",
      },
      {
        id: "00000000-0000-0000-0000-000000000702",
        summary: "beta memory",
        memoryType: "pattern",
        memoryScope: "group",
        tags: ["docs"],
        autoTags: [],
        usefulnessScore: 3,
        outdated: false,
        createdAt: new Date("2026-03-22T03:00:00.000Z"),
        authorAgentId: "00000000-0000-0000-0000-000000000777",
        authorAgentDisplayName: "worker-1 · owner@example.com",
      },
    ]);
    expect(decodeCursor(result.nextCursor!)).toEqual({
      createdAt: "2026-03-22T03:00:00.000Z",
      id: "00000000-0000-0000-0000-000000000702",
    });
  });

  it("returns forbidden when groupId is not in agent memberships", async () => {
    const groupIdSelectMock = mockGroupIdSelect([GROUP_A]);
    drizzleMock.mockReturnValue({
      select: groupIdSelectMock,
    });

    const result = await listAgentMemories(
      {} as TransactionClient,
      makeAgent({ userId: USER_ID }),
      "00000000-0000-0000-0000-000000000777",
      { groupId: GROUP_B, limit: 10 },
    );

    expect(result).toEqual({ error: "forbidden" });
  });

  it("restricts query to readable groups when no groupId is supplied", async () => {
    const limitMock = vi.fn().mockResolvedValue([]);
    const orderByMock = vi.fn(() => ({
      limit: limitMock,
    }));
    const whereMock = vi.fn(() => ({
      orderBy: orderByMock,
    }));
    const secondLeftJoinMock = vi.fn(() => ({
      where: whereMock,
    }));
    const firstLeftJoinMock = vi.fn(() => ({
      leftJoin: secondLeftJoinMock,
    }));
    const fromMock = vi.fn(() => ({
      leftJoin: firstLeftJoinMock,
    }));
    const groupIdSelectMock = mockGroupIdSelect([GROUP_A]);
    const selectMock = vi
      .fn()
      .mockImplementationOnce(groupIdSelectMock)
      .mockImplementationOnce(() => ({ from: fromMock }));

    drizzleMock.mockReturnValue({
      select: selectMock,
    });

    await listAgentMemories(
      {} as TransactionClient,
      makeAgent({ userId: USER_ID }),
      "00000000-0000-0000-0000-000000000777",
      { limit: 10 },
    );

    const firstWhereCall = whereMock.mock.calls[0] as unknown[];
    const whereSql = whereSqlToString(firstWhereCall[0]);
    const params = whereSqlParams(firstWhereCall[0]);
    expect(whereSql).toContain(`"memory_entries"."group_id" in (`);
    expect(params).toContain(GROUP_A);
  });
});

describe("listTags", () => {
  it("returns distinct visible tags through Drizzle", async () => {
    const orderByMock = vi.fn().mockResolvedValue([
      { tag: "docs" },
      { tag: "ops" },
      { tag: "runbook" },
    ]);
    const whereMock = vi.fn(() => ({
      orderBy: orderByMock,
    }));
    const fromMock = vi.fn(() => ({
      where: whereMock,
    }));
    const selectDistinctMock = vi.fn(() => ({
      from: fromMock,
    }));

    const groupIdSelectMock = mockGroupIdSelect();
    drizzleMock.mockReturnValue({
      select: groupIdSelectMock,
      selectDistinct: selectDistinctMock,
    });

    const result = await listTags(
      {} as TransactionClient,
      makeAgent({ userId: USER_ID }),
      { includeUser: true, includePrivate: true },
    );

    expect(selectDistinctMock).toHaveBeenCalledWith({
      tag: expect.any(Object),
    });
    expect(fromMock).toHaveBeenCalledWith(memoryEntries);
    expect(result).toEqual(["docs", "ops", "runbook"]);
  });
});

describe("searchMemories", () => {
  it("returns ranked paginated memories through Drizzle for text search", async () => {
    const limitMock = vi.fn().mockResolvedValue([
      {
        id: "00000000-0000-0000-0000-000000000801",
        content: "alpha runbook",
        summary: "alpha summary",
        memory_type: "fact",
        memory_scope: "group",
        tags: ["ops"],
        auto_tags: ["guide"],
        related_memory_ids: [],
        usefulness_score: 5,
        outdated: false,
        created_at: new Date("2026-03-22T05:00:00.000Z"),
        author_agent_id: "00000000-0000-0000-0000-000000000888",
        author_agent_display_name: "worker-2 · owner@example.com",
        search_rank: 5,
      },
      {
        id: "00000000-0000-0000-0000-000000000802",
        content: "beta notes",
        summary: null,
        memory_type: "pattern",
        memory_scope: "user",
        tags: ["docs"],
        auto_tags: [],
        related_memory_ids: [],
        usefulness_score: 3,
        outdated: false,
        created_at: new Date("2026-03-22T04:00:00.000Z"),
        author_agent_id: "00000000-0000-0000-0000-000000000888",
        author_agent_display_name: "worker-2 · owner@example.com",
        search_rank: 3,
      },
      {
        id: "00000000-0000-0000-0000-000000000803",
        content: "gamma draft",
        summary: null,
        memory_type: "procedure",
        memory_scope: "private",
        tags: ["runbook"],
        auto_tags: [],
        related_memory_ids: [],
        usefulness_score: 1,
        outdated: true,
        created_at: new Date("2026-03-22T03:00:00.000Z"),
        author_agent_id: AGENT_ID,
        author_agent_display_name: "test-agent",
        search_rank: 0.5,
      },
    ]);
    const orderByMock = vi.fn(() => ({
      limit: limitMock,
    }));
    const whereMock = vi.fn(() => ({
      orderBy: orderByMock,
    }));
    const secondLeftJoinMock = vi.fn(() => ({
      where: whereMock,
    }));
    const firstLeftJoinMock = vi.fn(() => ({
      leftJoin: secondLeftJoinMock,
    }));
    const fromMock = vi.fn(() => ({
      leftJoin: firstLeftJoinMock,
    }));
    const groupIdSelectMock = mockGroupIdSelect();
    const selectMock = vi
      .fn()
      .mockImplementationOnce(groupIdSelectMock)
      .mockImplementationOnce(() => ({ from: fromMock }));

    drizzleMock.mockReturnValue({
      select: selectMock,
    });

    const result = await searchMemories(
      {} as TransactionClient,
      makeAgent({ userId: USER_ID }),
      {
        query: "notes",
        includeUser: true,
        includePrivate: true,
        limit: 2,
      },
      null,
    ) as { items: MemoryEntryTier1[]; nextCursor: string | null };

    expect(fromMock).toHaveBeenCalledWith(memoryEntries);
    expect(limitMock).toHaveBeenCalledWith(3);
    expect(result.items).toEqual([
      {
        id: "00000000-0000-0000-0000-000000000801",
        summary: "alpha summary",
        memoryType: "fact",
        memoryScope: "group",
        tags: ["ops"],
        autoTags: ["guide"],
        usefulnessScore: 5,
        outdated: false,
        createdAt: new Date("2026-03-22T05:00:00.000Z"),
        authorAgentId: "00000000-0000-0000-0000-000000000888",
        authorAgentDisplayName: "worker-2 · owner@example.com",
      },
      {
        id: "00000000-0000-0000-0000-000000000802",
        summary: "beta notes",
        memoryType: "pattern",
        memoryScope: "user",
        tags: ["docs"],
        autoTags: [],
        usefulnessScore: 3,
        outdated: false,
        createdAt: new Date("2026-03-22T04:00:00.000Z"),
        authorAgentId: "00000000-0000-0000-0000-000000000888",
        authorAgentDisplayName: "worker-2 · owner@example.com",
      },
    ]);
    expect(decodeCursor(result.nextCursor!)).toEqual({
      createdAt: "2026-03-22T04:00:00.000Z",
      id: "00000000-0000-0000-0000-000000000802",
      rank: 3,
    });
  });

  it("runs hybrid search and fuses semantic plus lexical matches", async () => {
    const semanticLimitMock = vi.fn().mockResolvedValue([
      {
        id: "00000000-0000-0000-0000-000000000804",
        content: "vector hit",
        summary: null,
        memory_type: "fact",
        memory_scope: "group",
        tags: ["semantic"],
        auto_tags: [],
        related_memory_ids: [],
        usefulness_score: 4,
        outdated: false,
        created_at: new Date("2026-03-22T06:00:00.000Z"),
        author_agent_id: AGENT_ID,
        author_agent_display_name: "test-agent",
        search_rank: 0.87,
      },
      {
        id: "00000000-0000-0000-0000-000000000806",
        content: "semantic only",
        summary: null,
        memory_type: "fact",
        memory_scope: "group",
        tags: ["semantic"],
        auto_tags: [],
        related_memory_ids: [],
        usefulness_score: 2,
        outdated: false,
        created_at: new Date("2026-03-22T05:00:00.000Z"),
        author_agent_id: AGENT_ID,
        author_agent_display_name: "test-agent",
        search_rank: 0.62,
      },
    ]);
    const semanticOrderByMock = vi.fn(() => ({
      limit: semanticLimitMock,
    }));
    const semanticWhereMock = vi.fn(() => ({
      orderBy: semanticOrderByMock,
    }));
    const semanticSecondLeftJoinMock = vi.fn(() => ({
      where: semanticWhereMock,
    }));
    const semanticFirstLeftJoinMock = vi.fn(() => ({
      leftJoin: semanticSecondLeftJoinMock,
    }));
    const semanticFromMock = vi.fn(() => ({
      leftJoin: semanticFirstLeftJoinMock,
    }));
    const semanticSelectMock = vi.fn(() => ({
      from: semanticFromMock,
    }));

    const lexicalLimitMock = vi.fn().mockResolvedValue([
      {
        id: "00000000-0000-0000-0000-000000000805",
        content: "lexical hit",
        summary: null,
        memory_type: "fact",
        memory_scope: "group",
        tags: ["keyword"],
        auto_tags: [],
        related_memory_ids: [],
        usefulness_score: 3,
        outdated: false,
        created_at: new Date("2026-03-22T07:00:00.000Z"),
        author_agent_id: AGENT_ID,
        author_agent_display_name: "test-agent",
        search_rank: 0.2,
      },
      {
        id: "00000000-0000-0000-0000-000000000804",
        content: "vector hit",
        summary: null,
        memory_type: "fact",
        memory_scope: "group",
        tags: ["semantic"],
        auto_tags: [],
        related_memory_ids: [],
        usefulness_score: 4,
        outdated: false,
        created_at: new Date("2026-03-22T06:00:00.000Z"),
        author_agent_id: AGENT_ID,
        author_agent_display_name: "test-agent",
        search_rank: 0.87,
      },
    ]);
    const lexicalOrderByMock = vi.fn(() => ({
      limit: lexicalLimitMock,
    }));
    const lexicalWhereMock = vi.fn(() => ({
      orderBy: lexicalOrderByMock,
    }));
    const lexicalSecondLeftJoinMock = vi.fn(() => ({
      where: lexicalWhereMock,
    }));
    const lexicalFirstLeftJoinMock = vi.fn(() => ({
      leftJoin: lexicalSecondLeftJoinMock,
    }));
    const lexicalFromMock = vi.fn(() => ({
      leftJoin: lexicalFirstLeftJoinMock,
    }));
    const lexicalSelectMock = vi.fn(() => ({
      from: lexicalFromMock,
    }));

    const groupIdSelectMock = mockGroupIdSelect();
    drizzleMock.mockReturnValue({
      select: vi
        .fn()
        .mockImplementationOnce(groupIdSelectMock)
        .mockImplementationOnce(semanticSelectMock)
        .mockImplementationOnce(lexicalSelectMock),
    });

    const result = await searchMemories(
      {} as TransactionClient,
      makeAgent(),
      {
        query: "vector",
        includePrivate: true,
        limit: 2,
      },
      [0.1, 0.2, 0.3],
    ) as { items: MemoryEntryTier1[]; nextCursor: string | null };

    expect(result.items).toHaveLength(2);
    expect(result.items.map((item) => item.id)).toEqual([
      "00000000-0000-0000-0000-000000000804",
      "00000000-0000-0000-0000-000000000805",
    ]);
    expect(decodeCursor(result.nextCursor!)).toMatchObject({
      id: "00000000-0000-0000-0000-000000000805",
      offset: 2,
    });
  });

  it("caps hybrid candidate limit when cursor offset is extremely large", async () => {
    const semanticLimitMock = vi.fn().mockResolvedValue([]);
    const semanticOrderByMock = vi.fn(() => ({
      limit: semanticLimitMock,
    }));
    const semanticWhereMock = vi.fn(() => ({
      orderBy: semanticOrderByMock,
    }));
    const semanticSecondLeftJoinMock = vi.fn(() => ({
      where: semanticWhereMock,
    }));
    const semanticFirstLeftJoinMock = vi.fn(() => ({
      leftJoin: semanticSecondLeftJoinMock,
    }));
    const semanticFromMock = vi.fn(() => ({
      leftJoin: semanticFirstLeftJoinMock,
    }));
    const semanticSelectMock = vi.fn(() => ({
      from: semanticFromMock,
    }));

    const lexicalLimitMock = vi.fn().mockResolvedValue([]);
    const lexicalOrderByMock = vi.fn(() => ({
      limit: lexicalLimitMock,
    }));
    const lexicalWhereMock = vi.fn(() => ({
      orderBy: lexicalOrderByMock,
    }));
    const lexicalSecondLeftJoinMock = vi.fn(() => ({
      where: lexicalWhereMock,
    }));
    const lexicalFirstLeftJoinMock = vi.fn(() => ({
      leftJoin: lexicalSecondLeftJoinMock,
    }));
    const lexicalFromMock = vi.fn(() => ({
      leftJoin: lexicalFirstLeftJoinMock,
    }));
    const lexicalSelectMock = vi.fn(() => ({
      from: lexicalFromMock,
    }));

    const groupIdSelectMock2 = mockGroupIdSelect();
    drizzleMock.mockReturnValue({
      select: vi
        .fn()
        .mockImplementationOnce(groupIdSelectMock2)
        .mockImplementationOnce(semanticSelectMock)
        .mockImplementationOnce(lexicalSelectMock),
    });

    const largeOffsetCursor = encodeCursor(
      "2026-03-22T07:00:00.000Z",
      "00000000-0000-0000-0000-000000000805",
      undefined,
      99999999,
    );

    const result = await searchMemories(
      {} as TransactionClient,
      makeAgent(),
      {
        query: "vector",
        includePrivate: true,
        limit: 20,
        cursor: largeOffsetCursor,
      },
      [0.1, 0.2, 0.3],
    ) as { items: MemoryEntryTier1[]; nextCursor: string | null };

    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
    expect(semanticLimitMock).toHaveBeenCalledWith(3000);
    expect(lexicalLimitMock).toHaveBeenCalledWith(3000);
  });
});

describe("checkQuota", () => {
  it("skips quota check when quotaOverride is 0 (unlimited)", async () => {
    // 0 = explicitly unlimited — should return null (no error) without querying
    const result = await checkQuota({} as TransactionClient, makeAgent(), 0);
    expect(result).toBeNull();
    expect(drizzleMock).not.toHaveBeenCalled();
  });

  it("enforces default quota when quotaOverride is null", async () => {
    const selectMock = vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([{ count: 10001 }]),
      })),
    }));
    drizzleMock.mockReturnValue({ select: selectMock });

    const result = await checkQuota({} as TransactionClient, makeAgent(), null);
    expect(result).toEqual({ error: "quota_exceeded", limit: 10000, current: 10001 });
  });

  it("enforces custom quota when quotaOverride is a positive number", async () => {
    const selectMock = vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([{ count: 500 }]),
      })),
    }));
    drizzleMock.mockReturnValue({ select: selectMock });

    const result = await checkQuota({} as TransactionClient, makeAgent(), 500);
    expect(result).toEqual({ error: "quota_exceeded", limit: 500, current: 500 });
  });

  it("passes when under quota", async () => {
    const selectMock = vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([{ count: 99 }]),
      })),
    }));
    drizzleMock.mockReturnValue({ select: selectMock });

    const result = await checkQuota({} as TransactionClient, makeAgent(), 500);
    expect(result).toBeNull();
  });
});

describe("buildSummary", () => {
  it("prefers the stored summary when present", () => {
    expect(buildSummary("stored summary", "full content")).toBe("stored summary");
  });

  it("falls back to content when summary is missing", () => {
    expect(buildSummary(null, "full content")).toBe("full content");
  });

  it("truncates fallback summary at the last word boundary within 200 chars", () => {
    const content = `${"word ".repeat(45)}tail`;
    const summary = buildSummary(null, content);
    expect(summary.length).toBeLessThanOrEqual(200);
    expect(summary.endsWith(" ")).toBe(false);
  });
});

describe("cross-group isolation", () => {
  it("searchMemories WHERE clause restricts group-scoped memories to accessible groups", async () => {
    const limitMock = vi.fn().mockResolvedValue([
      {
        id: "00000000-0000-0000-0000-000000000801",
        content: "group A memory",
        summary: null,
        memory_type: "fact",
        memory_scope: "group",
        tags: ["ops"],
        auto_tags: [],
        related_memory_ids: [],
        usefulness_score: 5,
        outdated: false,
        created_at: new Date("2026-03-22T05:00:00.000Z"),
        author_agent_id: AGENT_ID,
        author_agent_display_name: "test-agent",
        search_rank: 5,
      },
      {
        id: "00000000-0000-0000-0000-000000000802",
        content: "group B memory",
        summary: null,
        memory_type: "fact",
        memory_scope: "group",
        tags: ["secret"],
        auto_tags: [],
        related_memory_ids: [],
        usefulness_score: 3,
        outdated: false,
        created_at: new Date("2026-03-22T04:00:00.000Z"),
        author_agent_id: "00000000-0000-0000-0000-000000000888",
        author_agent_display_name: "other-agent",
        search_rank: 3,
      },
    ]);
    const orderByMock = vi.fn(() => ({ limit: limitMock }));
    const whereMock = vi.fn((whereArg: unknown) => {
      void whereArg;
      return { orderBy: orderByMock };
    });
    const secondLeftJoinMock = vi.fn(() => ({ where: whereMock }));
    const firstLeftJoinMock = vi.fn(() => ({ leftJoin: secondLeftJoinMock }));
    const fromMock = vi.fn(() => ({ leftJoin: firstLeftJoinMock }));
    const groupIdSelectMock = mockGroupIdSelect([GROUP_A]);
    const selectMock = vi
      .fn()
      .mockImplementationOnce(groupIdSelectMock)
      .mockImplementationOnce(() => ({ from: fromMock }));

    drizzleMock.mockReturnValue({
      select: selectMock,
    });

    await searchMemories(
      {} as TransactionClient,
      makeAgent({ userId: USER_ID }),
      {
        query: "memory",
        includeUser: true,
        includePrivate: true,
        limit: 10,
      },
      null,
    );

    const whereSql = whereSqlToString(whereMock.mock.calls[0][0]);
    const params = whereSqlParams(whereMock.mock.calls[0][0]);
    expect(whereSql).toContain(`"memory_entries"."group_id" in (`);
    expect(params).toContain(GROUP_A);
  });

  it("fetchMemory returns forbidden for group-scoped memory in inaccessible group", async () => {
    const entryLimitMock = vi.fn().mockResolvedValue([
      {
        id: "00000000-0000-0000-0000-000000000901",
        content: "secret group B memory",
        summary: null,
        memory_type: "fact",
        memory_scope: "group",
        tags: ["secret"],
        auto_tags: [],
        related_memory_ids: [],
        usefulness_score: 0,
        outdated: false,
        ttl_seconds: null,
        expires_at: null,
        created_at: new Date("2026-03-22T01:00:00.000Z"),
        last_accessed_at: new Date("2026-03-22T01:00:00.000Z"),
        author_agent_id: AGENT_ID,
        author_agent_display_name: "test-agent",
        group_id: GROUP_B,
        user_id: null,
        version: 0,
      },
    ]);
    const entryWhereMock = vi.fn(() => ({ limit: entryLimitMock }));
    const secondLeftJoinMock = vi.fn(() => ({ where: entryWhereMock }));
    const firstLeftJoinMock = vi.fn(() => ({ leftJoin: secondLeftJoinMock }));
    const entryFromMock = vi.fn(() => ({ leftJoin: firstLeftJoinMock }));
    const groupIdSelectMock = mockGroupIdSelect([GROUP_A]);
    const selectMock = vi
      .fn()
      .mockImplementationOnce(groupIdSelectMock)
      .mockImplementationOnce(() => ({ from: entryFromMock }));

    drizzleMock.mockReturnValue({
      select: selectMock,
    });

    const result = await fetchMemory(
      {} as TransactionClient,
      makeAgent({ userId: USER_ID }),
      "00000000-0000-0000-0000-000000000901",
    );

    expect(result).toEqual({ error: "forbidden" });
  });

  it("listTags WHERE clause restricts tags to accessible groups", async () => {
    const orderByMock = vi.fn().mockResolvedValue([
      { tag: "ops" },
      { tag: "secret" },
    ]);
    const whereMock = vi.fn((whereArg: unknown) => {
      void whereArg;
      return { orderBy: orderByMock };
    });
    const fromMock = vi.fn(() => ({ where: whereMock }));
    const selectDistinctMock = vi.fn(() => ({ from: fromMock }));
    const groupIdSelectMock = mockGroupIdSelect([GROUP_A]);

    drizzleMock.mockReturnValue({
      select: groupIdSelectMock,
      selectDistinct: selectDistinctMock,
    });

    await listTags(
      {} as TransactionClient,
      makeAgent({ userId: USER_ID }),
      { includeUser: true, includePrivate: true },
    );

    const whereSql = whereSqlToString(whereMock.mock.calls[0][0]);
    const params = whereSqlParams(whereMock.mock.calls[0][0]);
    expect(whereSql).toContain(`"memory_entries"."group_id" in (`);
    expect(params).toContain(GROUP_A);
  });

  it("searchMemories WHERE clause restricts group-scoped memories via group_id membership", async () => {
    const limitMock = vi.fn().mockResolvedValue([]);
    const orderByMock = vi.fn(() => ({ limit: limitMock }));
    const whereMock = vi.fn((whereArg: unknown) => {
      void whereArg;
      return { orderBy: orderByMock };
    });
    const secondLeftJoinMock = vi.fn(() => ({ where: whereMock }));
    const firstLeftJoinMock = vi.fn(() => ({ leftJoin: secondLeftJoinMock }));
    const fromMock = vi.fn(() => ({ leftJoin: firstLeftJoinMock }));
    const groupIdSelectMock = mockGroupIdSelect([GROUP_A]);
    const selectMock = vi
      .fn()
      .mockImplementationOnce(groupIdSelectMock)
      .mockImplementationOnce(() => ({ from: fromMock }));

    drizzleMock.mockReturnValue({
      select: selectMock,
    });

    await searchMemories(
      {} as TransactionClient,
      makeAgent({ userId: USER_ID }),
      {
        query: "memory",
        includeUser: true,
        includePrivate: true,
        limit: 10,
      },
      null,
    );

    const whereSql = whereSqlToString(whereMock.mock.calls[0][0]);
    expect(whereSql).toContain(`"memory_entries"."group_id" in (`);
  });

  it("searchMemories returns forbidden when groupId param is not in agent memberships", async () => {
    const groupIdSelectMock = mockGroupIdSelect([GROUP_A]);
    drizzleMock.mockReturnValue({
      select: groupIdSelectMock,
    });

    const result = await searchMemories(
      {} as TransactionClient,
      makeAgent({ userId: USER_ID }),
      {
        query: "memory",
        groupId: GROUP_B,
        limit: 10,
      },
      null,
    );

    expect(result).toEqual({ error: "forbidden" });
  });

  it("searchMemories WHERE clause restricts to authorized groupId when param is provided", async () => {
    const limitMock = vi.fn().mockResolvedValue([]);
    const orderByMock = vi.fn(() => ({ limit: limitMock }));
    const whereMock = vi.fn((whereArg: unknown) => {
      void whereArg;
      return { orderBy: orderByMock };
    });
    const secondLeftJoinMock = vi.fn(() => ({ where: whereMock }));
    const firstLeftJoinMock = vi.fn(() => ({ leftJoin: secondLeftJoinMock }));
    const fromMock = vi.fn(() => ({ leftJoin: firstLeftJoinMock }));
    const groupIdSelectMock = mockGroupIdSelect([GROUP_A, GROUP_B]);
    const selectMock = vi
      .fn()
      .mockImplementationOnce(groupIdSelectMock)
      .mockImplementationOnce(() => ({ from: fromMock }));

    drizzleMock.mockReturnValue({
      select: selectMock,
    });

    await searchMemories(
      {} as TransactionClient,
      makeAgent({ userId: USER_ID }),
      {
        query: "memory",
        groupId: GROUP_A,
        limit: 10,
      },
      null,
    );

    const whereSql = whereSqlToString(whereMock.mock.calls[0][0]);
    const params = whereSqlParams(whereMock.mock.calls[0][0]);
    expect(whereSql).toContain(`"memory_entries"."group_id" in (`);
    expect(params).toContain(GROUP_A);
    expect(params).not.toContain(GROUP_B);
  });

  it("searchMemories WHERE clause yields FALSE when agent has zero group memberships", async () => {
    const limitMock = vi.fn().mockResolvedValue([]);
    const orderByMock = vi.fn(() => ({ limit: limitMock }));
    const whereMock = vi.fn((whereArg: unknown) => {
      void whereArg;
      return { orderBy: orderByMock };
    });
    const secondLeftJoinMock = vi.fn(() => ({ where: whereMock }));
    const firstLeftJoinMock = vi.fn(() => ({ leftJoin: secondLeftJoinMock }));
    const fromMock = vi.fn(() => ({ leftJoin: firstLeftJoinMock }));
    const groupIdSelectMock = mockGroupIdSelect([]);
    const selectMock = vi
      .fn()
      .mockImplementationOnce(groupIdSelectMock)
      .mockImplementationOnce(() => ({ from: fromMock }));

    drizzleMock.mockReturnValue({
      select: selectMock,
    });

    await searchMemories(
      {} as TransactionClient,
      makeAgent({ userId: USER_ID }),
      {
        query: "memory",
        includeUser: true,
        includePrivate: true,
        limit: 10,
      },
      null,
    );

    const whereSql = whereSqlToString(whereMock.mock.calls[0][0]);
    expect(whereSql).toContain("FALSE");
  });
});

describe("access control matrix", () => {
  const AGENT_ID_B = "00000000-0000-0000-0000-000000000002";
  const USER_ID_B = "00000000-0000-0000-0000-000000000100";
  const GROUP_C = "00000000-0000-0000-0000-000000000302";

  function makeEntryRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "00000000-0000-0000-0000-000000000950",
      content: "access-matrix-memory",
      summary: null,
      memory_type: "fact",
      memory_scope: "group",
      tags: ["matrix"],
      auto_tags: [],
      related_memory_ids: [],
      usefulness_score: 1,
      outdated: false,
      ttl_seconds: null,
      expires_at: null,
      created_at: new Date("2026-03-22T08:00:00.000Z"),
      last_accessed_at: new Date("2026-03-22T08:00:00.000Z"),
      author_agent_id: AGENT_ID,
      author_agent_display_name: "test-agent",
      group_id: GROUP_A,
      user_id: USER_ID,
      version: 0,
      ...overrides,
    };
  }

  function makeSearchRow(overrides: Record<string, unknown> = {}) {
    return {
      ...makeEntryRow(overrides),
      search_rank: 2,
    };
  }

  function setupFetchMocks(entryRow: Record<string, unknown>, groupIds: string[]) {
    const entryLimitMock = vi.fn().mockResolvedValue([entryRow]);
    const entryWhereMock = vi.fn(() => ({ limit: entryLimitMock }));
    const secondLeftJoinMock = vi.fn(() => ({ where: entryWhereMock }));
    const firstLeftJoinMock = vi.fn(() => ({ leftJoin: secondLeftJoinMock }));
    const entryFromMock = vi.fn(() => ({ leftJoin: firstLeftJoinMock }));

    const versionsOrderByMock = vi.fn().mockResolvedValue([]);
    const versionsWhereMock = vi.fn(() => ({ orderBy: versionsOrderByMock }));
    const versionsFromMock = vi.fn(() => ({ where: versionsWhereMock }));

    const selectMock = vi
      .fn()
      .mockImplementationOnce(mockGroupIdSelect(groupIds))
      .mockImplementationOnce(() => ({ from: entryFromMock }))
      .mockImplementationOnce(() => ({ from: versionsFromMock }));

    const updateWhereMock = vi.fn().mockResolvedValue([]);
    const updateSetMock = vi.fn(() => ({ where: updateWhereMock }));
    const updateMock = vi.fn(() => ({ set: updateSetMock }));

    drizzleMock.mockReturnValue({
      select: selectMock,
      update: updateMock,
    });

    return { updateMock };
  }

  function setupSearchMocks(rows: Record<string, unknown>[], groupIds: string[]) {
    const limitMock = vi.fn().mockResolvedValue(rows);
    const orderByMock = vi.fn(() => ({ limit: limitMock }));
    const whereMock = vi.fn((whereArg: unknown) => {
      void whereArg;
      return { orderBy: orderByMock };
    });
    const secondLeftJoinMock = vi.fn(() => ({ where: whereMock }));
    const firstLeftJoinMock = vi.fn(() => ({ leftJoin: secondLeftJoinMock }));
    const fromMock = vi.fn(() => ({ leftJoin: firstLeftJoinMock }));
    const selectMock = vi
      .fn()
      .mockImplementationOnce(mockGroupIdSelect(groupIds))
      .mockImplementationOnce(() => ({ from: fromMock }));

    drizzleMock.mockReturnValue({ select: selectMock });
    return { whereMock };
  }

  it("fetchMemory: author can fetch their own private memory", async () => {
    setupFetchMocks(makeEntryRow({ memory_scope: "private", author_agent_id: AGENT_ID }), [GROUP_A]);
    const result = await fetchMemory({} as TransactionClient, makeAgent(), "00000000-0000-0000-0000-000000000950");
    expect("entry" in result && result.entry.id).toBe("00000000-0000-0000-0000-000000000950");
  });

  it("fetchMemory: non-author CANNOT fetch private memory", async () => {
    const { updateMock } = setupFetchMocks(
      makeEntryRow({ memory_scope: "private", author_agent_id: AGENT_ID }),
      [GROUP_A],
    );
    const result = await fetchMemory(
      {} as TransactionClient,
      makeAgent({ id: AGENT_ID_B, externalId: "agent-b" }),
      "00000000-0000-0000-0000-000000000950",
    );
    expect(result).toEqual({ error: "forbidden" });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("searchMemories: private memory only visible to author", async () => {
    const { whereMock } = setupSearchMocks([makeSearchRow({ memory_scope: "private" })], [GROUP_A]);
    await searchMemories({} as TransactionClient, makeAgent(), { includePrivate: true, limit: 10 }, null);
    const whereSql = whereSqlToString(whereMock.mock.calls[0][0]);
    const params = whereSqlParams(whereMock.mock.calls[0][0]);
    expect(whereSql).toContain(`"memory_entries"."memory_scope" = $`);
    expect(whereSql).toContain(`"memory_entries"."author_agent_id" = $`);
    expect(params).toContain("private");
    expect(params).toContain(AGENT_ID);
  });

  it("fetchMemory: user-scoped memory accessible when same userId AND same groupId", async () => {
    setupFetchMocks(makeEntryRow({ memory_scope: "user", user_id: USER_ID, group_id: GROUP_A }), [GROUP_A]);
    const result = await fetchMemory(
      {} as TransactionClient,
      makeAgent({ userId: USER_ID }),
      "00000000-0000-0000-0000-000000000950",
    );
    expect("entry" in result && result.entry.memoryScope).toBe("user");
  });

  it("fetchMemory: user-scoped memory FORBIDDEN when same userId but different groupId", async () => {
    const { updateMock } = setupFetchMocks(
      makeEntryRow({ memory_scope: "user", user_id: USER_ID, group_id: GROUP_B }),
      [GROUP_A],
    );
    const result = await fetchMemory(
      {} as TransactionClient,
      makeAgent({ userId: USER_ID }),
      "00000000-0000-0000-0000-000000000950",
    );
    expect(result).toEqual({ error: "forbidden" });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("searchMemories: user scope WHERE clause includes groupId restriction", async () => {
    const { whereMock } = setupSearchMocks([makeSearchRow({ memory_scope: "user" })], [GROUP_A]);
    await searchMemories(
      {} as TransactionClient,
      makeAgent({ userId: USER_ID }),
      { includeUser: true, limit: 10 },
      null,
    );
    const whereSql = whereSqlToString(whereMock.mock.calls[0][0]);
    const params = whereSqlParams(whereMock.mock.calls[0][0]);
    expect(whereSql).toContain(`"memory_entries"."user_id" = $`);
    expect(whereSql).toContain(`"memory_entries"."group_id" in (`);
    expect(params).toContain(USER_ID);
    expect(params).toContain(GROUP_A);
  });

  it("searchMemories: user-scoped memory excluded when agent's groups don't include memory's groupId", async () => {
    setupSearchMocks([], [GROUP_A]);
    const result = await searchMemories(
      {} as TransactionClient,
      makeAgent({ userId: USER_ID }),
      { includeUser: true, groupId: GROUP_B, limit: 10 },
      null,
    );
    expect(result).toEqual({ error: "forbidden" });
  });

  it("fetchMemory: group-scoped memory accessible to agent in that group", async () => {
    setupFetchMocks(makeEntryRow({ memory_scope: "group", group_id: GROUP_A }), [GROUP_A]);
    const result = await fetchMemory({} as TransactionClient, makeAgent(), "00000000-0000-0000-0000-000000000950");
    expect("entry" in result && result.entry.memoryScope).toBe("group");
  });

  it("fetchMemory: group-scoped memory FORBIDDEN to agent outside that group", async () => {
    const { updateMock } = setupFetchMocks(makeEntryRow({ memory_scope: "group", group_id: GROUP_B }), [GROUP_A]);
    const result = await fetchMemory({} as TransactionClient, makeAgent(), "00000000-0000-0000-0000-000000000950");
    expect(result).toEqual({ error: "forbidden" });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("fetchMemory: multi-group agent can access memories from any of their groups", async () => {
    setupFetchMocks(makeEntryRow({ memory_scope: "group", group_id: GROUP_B }), [GROUP_A, GROUP_B]);
    const result = await fetchMemory({} as TransactionClient, makeAgent(), "00000000-0000-0000-0000-000000000950");
    expect("entry" in result && result.entry.groupId).toBe(GROUP_B);
  });

  it("fetchMemory: multi-group agent CANNOT access memory from group they don't belong to", async () => {
    const { updateMock } = setupFetchMocks(makeEntryRow({ memory_scope: "group", group_id: GROUP_C }), [GROUP_A, GROUP_B]);
    const result = await fetchMemory({} as TransactionClient, makeAgent(), "00000000-0000-0000-0000-000000000950");
    expect(result).toEqual({ error: "forbidden" });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("searchMemories: outdated memories are excluded from search results", async () => {
    const { whereMock } = setupSearchMocks([makeSearchRow()], [GROUP_A]);
    await searchMemories({} as TransactionClient, makeAgent(), { limit: 10 }, null);
    const whereSql = whereSqlToString(whereMock.mock.calls[0][0]).toLowerCase();
    expect(whereSql).toContain(`"memory_entries"."outdated" =`);
  });

  it("fetchMemory: outdated memory CAN be fetched by ID", async () => {
    setupFetchMocks(makeEntryRow({ outdated: true, memory_scope: "group", group_id: GROUP_A }), [GROUP_A]);
    const result = await fetchMemory({} as TransactionClient, makeAgent(), "00000000-0000-0000-0000-000000000950");
    expect("entry" in result && result.entry.outdated).toBe(true);
  });

  it("searchMemories: expired memories are excluded from search results", async () => {
    const { whereMock } = setupSearchMocks([makeSearchRow()], [GROUP_A]);
    await searchMemories({} as TransactionClient, makeAgent(), { limit: 10 }, null);
    const whereSql = whereSqlToString(whereMock.mock.calls[0][0]).toLowerCase();
    expect(whereSql).toContain(`"memory_entries"."expires_at" is null`);
    expect(whereSql).toContain(`"memory_entries"."expires_at" > now()`);
  });

  it("fetchMemory: expired memory CAN be fetched by ID", async () => {
    const pastExpiry = new Date("2026-01-01T00:00:00.000Z");
    setupFetchMocks(
      makeEntryRow({ memory_scope: "group", group_id: GROUP_A, expires_at: pastExpiry, user_id: USER_ID_B }),
      [GROUP_A],
    );
    const result = await fetchMemory({} as TransactionClient, makeAgent(), "00000000-0000-0000-0000-000000000950");
    expect("entry" in result && result.entry.expiresAt).toBe("2026-01-01T00:00:00.000Z");
  });
});
