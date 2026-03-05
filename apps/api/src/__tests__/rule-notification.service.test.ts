import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionStore } from "../mcp/session-store.js";
import { pushRulesToAgent } from "../services/rule-notification.service.js";

const getActiveRulesForAgentMock = vi.fn();

vi.mock("../services/rule.service.js", () => ({
  getActiveRulesForAgent: (...args: unknown[]) => getActiveRulesForAgentMock(...args),
}));

function makeSessionStore(sessions: unknown[]): SessionStore {
  return {
    getByAgentId: vi.fn().mockReturnValue(sessions),
  } as unknown as SessionStore;
}

describe("rule notification service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends notifications to all active sessions for the agent", async () => {
    getActiveRulesForAgentMock.mockResolvedValue([
      { id: "rule-1", name: "R1", description: "d1", updatedAt: "", createdAt: "" },
    ]);

    const notifyA = vi.fn().mockResolvedValue(undefined);
    const notifyB = vi.fn().mockResolvedValue(undefined);
    const sessionStore = makeSessionStore([
      { server: { server: { notification: notifyA } } },
      { server: { server: { notification: notifyB } } },
    ]);

    await pushRulesToAgent("agent-1", sessionStore, {} as never, "tenant_test");

    expect(notifyA).toHaveBeenCalledTimes(1);
    expect(notifyB).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when no active sessions exist", async () => {
    const sessionStore = makeSessionStore([]);

    await pushRulesToAgent("agent-1", sessionStore, {} as never, "tenant_test");

    expect(getActiveRulesForAgentMock).not.toHaveBeenCalled();
  });

  it("sends the full rule list in notification payload", async () => {
    const rules = [
      { id: "rule-1", name: "R1", description: "d1", updatedAt: "", createdAt: "" },
      { id: "rule-2", name: "R2", description: "d2", updatedAt: "", createdAt: "" },
    ];
    getActiveRulesForAgentMock.mockResolvedValue(rules);

    const notify = vi.fn().mockResolvedValue(undefined);
    const sessionStore = makeSessionStore([
      { server: { server: { notification: notify } } },
    ]);

    await pushRulesToAgent("agent-1", sessionStore, {} as never, "tenant_test");

    expect(notify).toHaveBeenCalledWith({
      method: "notifications/rules/updated",
      params: { rules },
    });
  });
});
