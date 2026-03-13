import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRule,
  updateRule,
  deleteRule,
  getActiveRulesForAgent,
} from "../services/rule.service";

const withTenantScopeMock = vi.fn();
const logAuditEventMock = vi.fn();

vi.mock("@monet/db", () => ({
  withTenantScope: (...args: unknown[]) => withTenantScopeMock(...args),
}));

vi.mock("../services/audit.service.js", () => ({
  logAuditEvent: (...args: unknown[]) => logAuditEventMock(...args),
}));

function makeSqlMock(sequence: unknown[]) {
  const sql = vi.fn();
  for (const item of sequence) {
    sql.mockResolvedValueOnce(item);
  }
  return sql;
}

const actor = { actorId: "agent-1", actorType: "agent" as const };

describe("rule service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    logAuditEventMock.mockResolvedValue(undefined);
  });

  it("createRule returns rule with generated id", async () => {
    const tx = makeSqlMock([[
      {
        id: "00000000-0000-0000-0000-000000000001",
        name: "Rule A",
        description: "Desc A",
        updated_at: "2026-03-06T00:00:00.000Z",
        created_at: "2026-03-06T00:00:00.000Z",
      },
    ]]);
    withTenantScopeMock.mockImplementation(async (_sql, _schemaName, fn) => fn(tx));

    const result = await createRule({} as never, "tenant-1", "tenant_schema", actor, {
      name: "Rule A",
      description: "Desc A",
    });

    expect(result.id).toBe("00000000-0000-0000-0000-000000000001");
    expect(logAuditEventMock).toHaveBeenCalledTimes(1);
  });

  it("updateRule returns not_found for unknown rule id", async () => {
    const tx = makeSqlMock([[]]);
    withTenantScopeMock.mockImplementation(async (_sql, _schemaName, fn) => fn(tx));

    const result = await updateRule(
      {} as never,
      "tenant-1",
      "tenant_schema",
      actor,
      "00000000-0000-0000-0000-000000000099",
      { description: "Updated" },
    );

    expect(result).toEqual({ error: "not_found" });
  });

  it("deleteRule attempts deletion; cascade is handled by database FK", async () => {
    const tx = makeSqlMock([[{ id: "rule-1" }]]);
    withTenantScopeMock.mockImplementation(async (_sql, _schemaName, fn) => fn(tx));

    const result = await deleteRule({} as never, "tenant-1", "tenant_schema", actor, "rule-1");

    expect(result).toEqual({ success: true });
  });

  it("getActiveRulesForAgent returns deduplicated rules from SQL result", async () => {
    const tx = makeSqlMock([[
      {
        id: "rule-1",
        name: "Dedup",
        description: "Desc",
        updated_at: "2026-03-06T00:00:00.000Z",
        created_at: "2026-03-06T00:00:00.000Z",
      },
    ]]);
    withTenantScopeMock.mockImplementation(async (_sql, _schemaName, fn) => fn(tx));

    const result = await getActiveRulesForAgent({} as never, "tenant_schema", "agent-1");

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("rule-1");
  });

  it("getActiveRulesForAgent returns empty array when no rule sets are linked", async () => {
    const tx = makeSqlMock([[]]);
    withTenantScopeMock.mockImplementation(async (_sql, _schemaName, fn) => fn(tx));

    const result = await getActiveRulesForAgent({} as never, "tenant_schema", "agent-1");
    expect(result).toEqual([]);
  });
});
