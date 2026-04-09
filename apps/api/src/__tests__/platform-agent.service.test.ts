import { describe, expect, it, vi } from "vitest";
import type { SqlClient } from "@monet/db";
import { listPlatformAgents } from "../services/platform-agent.service";

describe("platform agent service", () => {
  it("throws when a non-admin caller omits requesterUserId at runtime", async () => {
    const sql = {
      select: vi.fn(),
    } as unknown as SqlClient;

    await expect(
      listPlatformAgents(sql, "tenant_schema", {
        isAdmin: false,
        requesterUserId: null,
      } as never),
    ).rejects.toThrow(
      "requesterUserId is required when listing platform agents as a non-admin",
    );

    expect(vi.isMockFunction((sql as unknown as { select: unknown }).select)).toBe(true);
  });
});
