import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionStore, SessionLimitError } from "../mcp/session-store";

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

  it("closes all sessions for an agent", async () => {
    const transportCloseA = vi.fn().mockResolvedValue(undefined);
    const transportCloseB = vi.fn().mockResolvedValue(undefined);
    const serverCloseA = vi.fn().mockResolvedValue(undefined);
    const serverCloseB = vi.fn().mockResolvedValue(undefined);
    const base = {
      tenantSchemaName: "tenant_test",
      connectedAt: new Date("2026-03-04T00:00:00.000Z"),
      lastActivityAt: new Date("2026-03-04T00:00:00.000Z"),
    };

    store.add("session-1", {
      ...base,
      transport: { close: transportCloseA } as never,
      server: { close: serverCloseA } as never,
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
      transport: { close: transportCloseB } as never,
      server: { close: serverCloseB } as never,
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
      transport: { close: vi.fn().mockResolvedValue(undefined) } as never,
      server: { close: vi.fn().mockResolvedValue(undefined) } as never,
      agentContext: {
        id: "agent-2",
        externalId: "agent-2",
        tenantId: "tenant-1",
        isAutonomous: false,
        userId: null,
        role: null,
      },
    });

    await expect(store.closeSessionsForAgent("agent-1")).resolves.toBe(2);

    expect(store.count()).toBe(1);
    expect(store.get("session-1")).toBeUndefined();
    expect(store.get("session-2")).toBeUndefined();
    expect(store.get("session-3")).toBeDefined();
    expect(transportCloseA).toHaveBeenCalledTimes(1);
    expect(transportCloseB).toHaveBeenCalledTimes(1);
    expect(serverCloseA).toHaveBeenCalledTimes(1);
    expect(serverCloseB).toHaveBeenCalledTimes(1);
  });

  it("throws SessionLimitError when per-agent limit is reached", () => {
    const base = {
      transport: {} as never,
      server: {} as never,
      tenantSchemaName: "tenant_test",
      connectedAt: new Date("2026-03-04T00:00:00.000Z"),
      lastActivityAt: new Date("2026-03-04T00:00:00.000Z"),
    };
    const agentContext = {
      id: "agent-1",
      externalId: "agent-1",
      tenantId: "tenant-1",
      isAutonomous: false,
      userId: null,
      role: null,
    };

    for (let i = 0; i < 5; i++) {
      store.add(`session-${i}`, { ...base, agentContext });
    }

    expect(() => store.add("session-6", { ...base, agentContext }))
      .toThrow(SessionLimitError);
  });

  it("throws SessionLimitError when total session limit is reached", () => {
    const base = {
      transport: {} as never,
      server: {} as never,
      tenantSchemaName: "tenant_test",
      connectedAt: new Date("2026-03-04T00:00:00.000Z"),
      lastActivityAt: new Date("2026-03-04T00:00:00.000Z"),
    };

    for (let i = 0; i < 1000; i++) {
      store.add(`session-${i}`, {
        ...base,
        agentContext: {
          id: `agent-${i}`,
          externalId: `agent-${i}`,
          tenantId: "tenant-1",
          isAutonomous: false,
          userId: null,
          role: null,
        },
      });
    }

    expect(() => store.add("session-overflow", {
      ...base,
      agentContext: {
        id: "agent-new",
        externalId: "agent-new",
        tenantId: "tenant-1",
        isAutonomous: false,
        userId: null,
        role: null,
      },
    })).toThrow(SessionLimitError);
  });

  it("allows new sessions after removing one that hit the per-agent limit", () => {
    const base = {
      transport: {} as never,
      server: {} as never,
      tenantSchemaName: "tenant_test",
      connectedAt: new Date("2026-03-04T00:00:00.000Z"),
      lastActivityAt: new Date("2026-03-04T00:00:00.000Z"),
    };
    const agentContext = {
      id: "agent-1",
      externalId: "agent-1",
      tenantId: "tenant-1",
      isAutonomous: false,
      userId: null,
      role: null,
    };

    for (let i = 0; i < 5; i++) {
      store.add(`session-${i}`, { ...base, agentContext });
    }

    store.remove("session-0");
    expect(() => store.add("session-new", { ...base, agentContext })).not.toThrow();
    expect(store.count()).toBe(5);
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
