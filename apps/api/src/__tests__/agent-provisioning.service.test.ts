import { beforeEach, describe, expect, it, vi } from "vitest";
import { agents, type SqlClient } from "@monet/db";
import { provisionAgentWithApiKey } from "../services/agent-provisioning.service";

const FIXED_AGENT_ID = "00000000-0000-0000-0000-000000000123";

const {
  drizzleMock,
  insertMock,
  valuesMock,
  returningMock,
  generateApiKeyMock,
  hashApiKeyMock,
  randomUUIDMock,
} = vi.hoisted(() => ({
  drizzleMock: vi.fn(),
  insertMock: vi.fn(),
  valuesMock: vi.fn(),
  returningMock: vi.fn(),
  generateApiKeyMock: vi.fn(),
  hashApiKeyMock: vi.fn(),
  randomUUIDMock: vi.fn(),
}));

vi.mock("node:crypto", () => ({
  randomUUID: randomUUIDMock,
}));

vi.mock("drizzle-orm/postgres-js", () => ({
  drizzle: drizzleMock,
}));

vi.mock("../services/api-key.service", () => ({
  generateApiKey: generateApiKeyMock,
  hashApiKey: hashApiKeyMock,
}));

describe("agent provisioning service", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    randomUUIDMock.mockReturnValue(FIXED_AGENT_ID);
    generateApiKeyMock.mockReturnValue("mnt_test.key");
    hashApiKeyMock.mockReturnValue({
      hash: "hashed-api-key",
      salt: "salt-value",
    });

    returningMock.mockResolvedValue([
      {
        createdAt: new Date("2026-03-22T00:00:00.000Z"),
      },
    ]);
    valuesMock.mockReturnValue({
      returning: returningMock,
    });
    insertMock.mockReturnValue({
      values: valuesMock,
    });
    drizzleMock.mockReturnValue({
      insert: insertMock,
    });
  });

  it("creates an agent via Drizzle and returns the raw API key once", async () => {
    const sql = {} as SqlClient;

    const result = await provisionAgentWithApiKey(sql, {
      externalId: "agent-1",
      tenantId: "00000000-0000-0000-0000-000000000010",
      userId: "00000000-0000-0000-0000-000000000099",
      role: "group_admin",
      isAutonomous: true,
    });

    const drizzleClient = drizzleMock.mock.calls[0]?.[0] as {
      options?: { parsers: Record<string, unknown>; serializers: Record<string, unknown> };
    };
    expect(drizzleClient).not.toBe(sql);
    expect(drizzleClient.options).toEqual({
      parsers: {},
      serializers: {},
    });
    expect("options" in sql).toBe(false);
    expect(insertMock).toHaveBeenCalledWith(agents);
    expect(valuesMock).toHaveBeenCalledWith({
      id: FIXED_AGENT_ID,
      externalId: "agent-1",
      tenantId: "00000000-0000-0000-0000-000000000010",
      userId: "00000000-0000-0000-0000-000000000099",
      role: "group_admin",
      apiKeyHash: "hashed-api-key",
      apiKeySalt: "salt-value",
      isAutonomous: true,
    });
    expect(result).toEqual({
      agent: {
        id: FIXED_AGENT_ID,
        externalId: "agent-1",
        userId: "00000000-0000-0000-0000-000000000099",
        role: "group_admin",
        isAutonomous: true,
        createdAt: new Date("2026-03-22T00:00:00.000Z"),
      },
      rawApiKey: "mnt_test.key",
    });
  });
});
