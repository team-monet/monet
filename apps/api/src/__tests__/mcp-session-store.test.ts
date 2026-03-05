import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionStore } from "../mcp/session-store.js";

describe("MCP session store", () => {
  let store: SessionStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new SessionStore();
  });

  it("adds, gets, and removes sessions", () => {
    const session = {
      transport: {} as never,
      server: {} as never,
      agentContext: {
        id: "agent-1",
        externalId: "agent-1",
        tenantId: "tenant-1",
        isAutonomous: false,
        userId: null,
        role: null,
      },
      tenantSchemaName: "tenant_test",
      connectedAt: new Date("2026-03-04T00:00:00.000Z"),
      lastActivityAt: new Date("2026-03-04T00:00:00.000Z"),
    };

    store.add("session-1", session);
    expect(store.get("session-1")).toBe(session);
    expect(store.count()).toBe(1);

    store.remove("session-1");
    expect(store.get("session-1")).toBeUndefined();
    expect(store.count()).toBe(0);
  });

  it("touch updates lastActivityAt", () => {
    const session = {
      transport: {} as never,
      server: {} as never,
      agentContext: {
        id: "agent-1",
        externalId: "agent-1",
        tenantId: "tenant-1",
        isAutonomous: false,
        userId: null,
        role: null,
      },
      tenantSchemaName: "tenant_test",
      connectedAt: new Date("2026-03-04T00:00:00.000Z"),
      lastActivityAt: new Date("2026-03-04T00:00:00.000Z"),
    };

    store.add("session-1", session);
    vi.setSystemTime(new Date("2026-03-04T00:10:00.000Z"));
    store.touch("session-1");

    expect(store.get("session-1")?.lastActivityAt.toISOString())
      .toBe("2026-03-04T00:10:00.000Z");
  });

  it("getByAgentId returns all sessions for an agent", () => {
    const base = {
      transport: {} as never,
      server: {} as never,
      tenantSchemaName: "tenant_test",
      connectedAt: new Date("2026-03-04T00:00:00.000Z"),
      lastActivityAt: new Date("2026-03-04T00:00:00.000Z"),
    };

    store.add("session-1", {
      ...base,
      agentContext: {
        id: "agent-1",
        externalId: "agent-1",
        tenantId: "tenant-1",
        isAutonomous: false,
        userId: null,
        role: null,
      },
    });
    store.add("session-2", {
      ...base,
      agentContext: {
        id: "agent-1",
        externalId: "agent-1",
        tenantId: "tenant-1",
        isAutonomous: false,
        userId: null,
        role: null,
      },
    });
    store.add("session-3", {
      ...base,
      agentContext: {
        id: "agent-2",
        externalId: "agent-2",
        tenantId: "tenant-1",
        isAutonomous: false,
        userId: null,
        role: null,
      },
    });

    expect(store.getByAgentId("agent-1")).toHaveLength(2);
    expect(store.getByAgentId("unknown")).toEqual([]);
  });

  it("idle sweep expires stale sessions and preserves active ones", () => {
    const onExpired = vi.fn();
    const base = {
      transport: {} as never,
      server: {} as never,
      tenantSchemaName: "tenant_test",
      connectedAt: new Date("2026-03-04T00:00:00.000Z"),
    };

    store.add("stale", {
      ...base,
      agentContext: {
        id: "agent-1",
        externalId: "agent-1",
        tenantId: "tenant-1",
        isAutonomous: false,
        userId: null,
        role: null,
      },
      lastActivityAt: new Date("2026-03-04T00:00:00.000Z"),
    });
    store.add("fresh", {
      ...base,
      agentContext: {
        id: "agent-2",
        externalId: "agent-2",
        tenantId: "tenant-1",
        isAutonomous: false,
        userId: null,
        role: null,
      },
      lastActivityAt: new Date("2026-03-04T00:20:00.000Z"),
    });

    vi.setSystemTime(new Date("2026-03-04T00:31:00.000Z"));
    store.startIdleSweep(onExpired);
    vi.advanceTimersByTime(5 * 60 * 1000);

    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(onExpired).toHaveBeenCalledWith("stale", expect.objectContaining({
      agentContext: expect.objectContaining({ id: "agent-1" }),
    }));

    store.stopIdleSweep();
  });
});
