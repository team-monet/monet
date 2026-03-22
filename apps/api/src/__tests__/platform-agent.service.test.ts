import { describe, expect, it, vi } from "vitest";
import type { Database } from "@monet/db";
import { listPlatformAgents } from "../services/platform-agent.service";

describe("platform agent service", () => {
  it("throws when a non-admin caller omits requesterUserId at runtime", async () => {
    const db = {
      select: vi.fn(),
    } as unknown as Database;

    await expect(
      listPlatformAgents(db, "tenant-1", {
        isAdmin: false,
        requesterUserId: null,
      } as never),
    ).rejects.toThrow(
      "requesterUserId is required when listing platform agents as a non-admin",
    );

    expect(db.select).not.toHaveBeenCalled();
  });
});
