import { describe, it, expect } from "vitest";
import { CreateMemoryEntryInput } from "@monet/types";
import {
  encodeCursor,
  decodeCursor,
  buildScopeFilter,
  createMemory,
  buildSummary,
} from "../services/memory.service.js";
import type { AgentContext } from "../middleware/context.js";

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

describe("encodeCursor / decodeCursor", () => {
  it("round-trips correctly", () => {
    const createdAt = "2025-01-01T00:00:00.000Z";
    const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const cursor = encodeCursor(createdAt, id);
    const decoded = decodeCursor(cursor);
    expect(decoded.createdAt).toBe(createdAt);
    expect(decoded.id).toBe(id);
  });

  it("produces a URL-safe base64 string", () => {
    const cursor = encodeCursor("2025-01-01T00:00:00.000Z", "some-id");
    expect(cursor).not.toMatch(/[+/=]/);
  });
});

describe("buildScopeFilter", () => {
  it("always includes group scope", () => {
    const conditions = buildScopeFilter(makeAgent(), {
      includeUser: false,
      includePrivate: false,
    });
    expect(conditions).toContain("me.memory_scope = 'group'");
    expect(conditions).toHaveLength(1);
  });

  it("includes user scope when includeUser=true and agent has userId", () => {
    const conditions = buildScopeFilter(makeAgent({ userId: USER_ID }), {
      includeUser: true,
      includePrivate: false,
    });
    expect(conditions).toHaveLength(2);
    expect(conditions[1]).toContain("me.memory_scope = 'user'");
    expect(conditions[1]).toContain(USER_ID);
  });

  it("does NOT include user scope when agent has no userId", () => {
    const conditions = buildScopeFilter(makeAgent({ userId: null }), {
      includeUser: true,
      includePrivate: false,
    });
    expect(conditions).toHaveLength(1);
  });

  it("includes private scope when includePrivate=true", () => {
    const conditions = buildScopeFilter(makeAgent(), {
      includeUser: false,
      includePrivate: true,
    });
    expect(conditions).toHaveLength(2);
    expect(conditions[1]).toContain("me.memory_scope = 'private'");
    expect(conditions[1]).toContain(AGENT_ID);
  });

  it("includes all scopes when both flags set and agent has userId", () => {
    const conditions = buildScopeFilter(makeAgent({ userId: USER_ID }), {
      includeUser: true,
      includePrivate: true,
    });
    expect(conditions).toHaveLength(3);
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
  it("rejects autonomous agents storing user-scoped memories", async () => {
    const sql = (() => {
      throw new Error("should not query");
    }) as unknown as import("postgres").Sql;

    const result = await createMemory(
      sql as unknown as import("postgres").TransactionSql,
      makeAgent({ isAutonomous: true }),
      {
        content: "test",
        memoryType: "fact",
        memoryScope: "user",
        tags: ["test"],
      },
      null,
    );

    expect(result).toEqual({
      error: "validation",
      message: "Autonomous agents cannot store user-scoped memories",
    });
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
