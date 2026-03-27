import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addRuleToSet,
  associateRuleSetWithAgent,
  createRuleSet,
  createRule,
  deleteRuleSet,
  deleteRule,
  getAgentIdsForRule,
  getAgentIdsForRuleSet,
  dissociateRuleSetFromAgent,
  getActiveRulesForAgent,
  getRule,
  listRuleSetsForAgent,
  listRuleSetsForGroup,
  listPersonalRuleSetsForUser,
  listPersonalRulesForUser,
  listRuleSets,
  listRules,
  removeRuleFromSet,
  updateRule,
} from "../services/rule.service";

const withTenantDrizzleScopeMock = vi.fn();
const logAuditEventMock = vi.fn();

vi.mock("@monet/db", async () => {
  const actual = await vi.importActual<typeof import("@monet/db")>("@monet/db");
  return {
    ...actual,
    withTenantDrizzleScope: (...args: unknown[]) => withTenantDrizzleScopeMock(...args),
  };
});

vi.mock("../services/audit.service.js", () => ({
  logAuditEvent: (...args: unknown[]) => logAuditEventMock(...args),
}));

function makeSelectLimitDb(sequence: unknown[][]) {
  const limitMock = vi.fn();
  for (const item of sequence) {
    limitMock.mockResolvedValueOnce(item);
  }
  const whereMock = vi.fn(() => ({
    limit: limitMock,
  }));
  const fromMock = vi.fn(() => ({
    where: whereMock,
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
    whereMock,
    limitMock,
  };
}

function makeActiveRulesDb({
  directRuleSets,
  groupRuleSets,
  rules,
}: {
  directRuleSets: { ruleSetId: string }[];
  groupRuleSets: { ruleSetId: string }[];
  rules: unknown[];
}) {
  const directWhereMock = vi.fn().mockResolvedValue(directRuleSets);
  const groupWhereMock = vi.fn().mockResolvedValue(groupRuleSets);
  const orderByMock = vi.fn().mockResolvedValue(rules);

  const selectMock = vi.fn()
    .mockReturnValueOnce({
      from: vi.fn(() => ({
        where: directWhereMock,
      })),
    })
    .mockReturnValueOnce({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: groupWhereMock,
        })),
      })),
    });

  const selectDistinctMock = vi.fn(() => ({
    from: vi.fn(() => ({
      innerJoin: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: orderByMock,
        })),
      })),
    })),
  }));

  return {
    db: {
      select: selectMock,
      selectDistinct: selectDistinctMock,
    },
    selectDistinctMock,
    orderByMock,
  };
}

function makeAgentIdsForRuleSetDb({
  directAgents,
  groupAgents,
}: {
  directAgents: { agentId: string }[];
  groupAgents: { agentId: string }[];
}) {
  const directWhereMock = vi.fn().mockResolvedValue(directAgents);
  const groupWhereMock = vi.fn().mockResolvedValue(groupAgents);

  const selectMock = vi.fn()
    .mockReturnValueOnce({
      from: vi.fn(() => ({
        where: directWhereMock,
      })),
    })
    .mockReturnValueOnce({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: groupWhereMock,
        })),
      })),
    });

  return {
    db: {
      select: selectMock,
    },
  };
}

function makeAgentIdsForRuleDb({
  directAgents,
  groupAgents,
}: {
  directAgents: { agentId: string }[];
  groupAgents: { agentId: string }[];
}) {
  const directWhereMock = vi.fn().mockResolvedValue(directAgents);
  const groupWhereMock = vi.fn().mockResolvedValue(groupAgents);

  const selectMock = vi.fn()
    .mockReturnValueOnce({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: directWhereMock,
        })),
      })),
    })
    .mockReturnValueOnce({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            where: groupWhereMock,
          })),
        })),
      })),
    });

  return {
    db: {
      select: selectMock,
    },
  };
}

function makeLinkedRuleSetListDb(rows: unknown[]) {
  const orderByMock = vi.fn().mockResolvedValue(rows);
  const groupByMock = vi.fn(() => ({
    orderBy: orderByMock,
  }));
  const whereMock = vi.fn(() => ({
    groupBy: groupByMock,
  }));
  const leftJoinMock = vi.fn(() => ({
    where: whereMock,
  }));
  const innerJoinMock = vi.fn(() => ({
    leftJoin: leftJoinMock,
  }));
  const fromMock = vi.fn(() => ({
    innerJoin: innerJoinMock,
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
    innerJoinMock,
    leftJoinMock,
    whereMock,
    groupByMock,
    orderByMock,
  };
}

const actor = { actorId: "agent-1", actorType: "agent" as const };

describe("rule service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    logAuditEventMock.mockResolvedValue({ success: true });
  });

  it("createRule returns rule with generated id", async () => {
    const db = {
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([{
            id: "00000000-0000-0000-0000-000000000001",
            name: "Rule A",
            description: "Desc A",
            ownerUserId: null,
            updatedAt: new Date("2026-03-06T00:00:00.000Z"),
            createdAt: new Date("2026-03-06T00:00:00.000Z"),
          }]),
        })),
      })),
    };
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) => fn(db));

    const result = await createRule({} as never, "tenant-1", "tenant_schema", actor, {
      name: "Rule A",
      description: "Desc A",
    });

    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.id).toBe("00000000-0000-0000-0000-000000000001");
    }
    expect(logAuditEventMock).toHaveBeenCalledTimes(1);
  });

  it("createRuleSet returns rule set with generated id", async () => {
    const sql = {} as never;
    const db = {
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([{
            id: "rule-set-1",
            name: "Rule Set A",
            ownerUserId: null,
            createdAt: new Date("2026-03-06T00:00:00.000Z"),
          }]),
        })),
      })),
    };
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) => fn(db));

    const result = await createRuleSet(
      sql,
      "tenant-1",
      "tenant_schema",
      actor,
      { name: "Rule Set A" },
    );

    expect(result).toEqual({
      id: "rule-set-1",
      name: "Rule Set A",
      ownerUserId: null,
      createdAt: "2026-03-06T00:00:00.000Z",
    });
    expect(logAuditEventMock).toHaveBeenCalledWith(
      sql,
      "tenant_schema",
      expect.objectContaining({
        tenantId: "tenant-1",
        action: "rule_set.create",
        targetId: "rule-set-1",
        outcome: "success",
      }),
    );
  });

  it("createRuleSet persists and returns the personal owner scope", async () => {
    const valuesMock = vi.fn(() => ({
      returning: vi.fn().mockResolvedValue([{
        id: "rule-set-2",
        name: "Personal Set",
        ownerUserId: "user-1",
        createdAt: new Date("2026-03-07T00:00:00.000Z"),
      }]),
    }));
    const db = {
      insert: vi.fn(() => ({
        values: valuesMock,
      })),
    };
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) => fn(db));

    const result = await createRuleSet(
      {} as never,
      "tenant-1",
      "tenant_schema",
      actor,
      { name: "Personal Set" },
      { ownerUserId: "user-1" },
    );

    expect(valuesMock).toHaveBeenCalledWith({
      name: "Personal Set",
      ownerUserId: "user-1",
    });
    expect(result).toEqual({
      id: "rule-set-2",
      name: "Personal Set",
      ownerUserId: "user-1",
      createdAt: "2026-03-07T00:00:00.000Z",
    });
  });

  it("updateRule returns not_found for unknown rule id", async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([]),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue([]),
          })),
        })),
      })),
    };
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) => fn(db));

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

  it("updateRule returns the updated personal rule on success", async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([{
              name: "Rule B",
              description: "Original",
            }]),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue([{
              id: "rule-2",
              name: "Rule B",
              description: "Updated",
              ownerUserId: "user-1",
              updatedAt: new Date("2026-03-07T00:00:00.000Z"),
              createdAt: new Date("2026-03-06T00:00:00.000Z"),
            }]),
          })),
        })),
      })),
    };
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) => fn(db));

    const result = await updateRule(
      {} as never,
      "tenant-1",
      "tenant_schema",
      actor,
      "rule-2",
      { description: "Updated" },
      { ownerUserId: "user-1" },
    );

    expect(result).toEqual({
      id: "rule-2",
      name: "Rule B",
      description: "Updated",
      ownerUserId: "user-1",
      updatedAt: "2026-03-07T00:00:00.000Z",
      createdAt: "2026-03-06T00:00:00.000Z",
    });
  });

  it("deleteRule attempts deletion; cascade is handled by database FK", async () => {
    const db = {
      delete: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([{ id: "rule-1", name: "Test Rule" }]),
        })),
      })),
    };
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) => fn(db));

    const result = await deleteRule({} as never, "tenant-1", "tenant_schema", actor, "rule-1");

    expect(result).toEqual({ success: true });
  });

  it("deleteRule returns not_found when no rule matches the requested scope", async () => {
    const db = {
      delete: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([]),
        })),
      })),
    };
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) => fn(db));

    const result = await deleteRule(
      {} as never,
      "tenant-1",
      "tenant_schema",
      actor,
      "rule-1",
      { ownerUserId: "user-1" },
    );

    expect(result).toEqual({ error: "not_found" });
  });

  it("listRules normalizes timestamp output from Drizzle rows", async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn().mockResolvedValue([{
              id: "rule-1",
              name: "Rule A",
              description: "Desc A",
              ownerUserId: null,
              updatedAt: new Date("2026-03-06T00:00:00.000Z"),
              createdAt: new Date("2026-03-06T00:00:00.000Z"),
            }]),
          })),
        })),
      })),
    };
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) => fn(db));

    const result = await listRules({} as never, "tenant_schema");

    expect(result).toEqual([{
      id: "rule-1",
      name: "Rule A",
      description: "Desc A",
      ownerUserId: null,
      updatedAt: "2026-03-06T00:00:00.000Z",
      createdAt: "2026-03-06T00:00:00.000Z",
    }]);
  });

  it("getRule returns null when the shared rule does not exist", async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([]),
          })),
        })),
      })),
    };
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) => fn(db));

    const result = await getRule({} as never, "tenant_schema", "missing-rule");

    expect(result).toBeNull();
  });

  it("getRule returns the shared rule with normalized timestamps", async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([{
              id: "rule-3",
              name: "Rule C",
              description: "Desc C",
              ownerUserId: null,
              updatedAt: "2026-03-08 00:00:00+00",
              createdAt: "2026-03-07 00:00:00+00",
            }]),
          })),
        })),
      })),
    };
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) => fn(db));

    const result = await getRule({} as never, "tenant_schema", "rule-3");

    expect(result).toEqual({
      id: "rule-3",
      name: "Rule C",
      description: "Desc C",
      ownerUserId: null,
      updatedAt: "2026-03-08T00:00:00.000Z",
      createdAt: "2026-03-07T00:00:00.000Z",
    });
  });

  it("listPersonalRulesForUser returns only personal rules for the owner", async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn().mockResolvedValue([{
              id: "rule-2",
              name: "Personal Rule",
              description: "Desc B",
              ownerUserId: "user-1",
              updatedAt: new Date("2026-03-07T00:00:00.000Z"),
              createdAt: new Date("2026-03-07T00:00:00.000Z"),
            }]),
          })),
        })),
      })),
    };
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) => fn(db));

    const result = await listPersonalRulesForUser({} as never, "tenant_schema", "user-1");

    expect(result).toEqual([{
      id: "rule-2",
      name: "Personal Rule",
      description: "Desc B",
      ownerUserId: "user-1",
      updatedAt: "2026-03-07T00:00:00.000Z",
      createdAt: "2026-03-07T00:00:00.000Z",
    }]);
  });

  it("listRuleSets returns shared rule sets with aggregated rule ids", async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          leftJoin: vi.fn(() => ({
            where: vi.fn(() => ({
              groupBy: vi.fn(() => ({
                orderBy: vi.fn().mockResolvedValue([{
                  id: "rule-set-1",
                  name: "Shared Set",
                  ownerUserId: null,
                  createdAt: new Date("2026-03-08T00:00:00.000Z"),
                  ruleIds: ["rule-1", "rule-2"],
                }]),
              })),
            })),
          })),
        })),
      })),
    };
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) => fn(db));

    const result = await listRuleSets({} as never, "tenant_schema");

    expect(result).toEqual([{
      id: "rule-set-1",
      name: "Shared Set",
      ownerUserId: null,
      createdAt: "2026-03-08T00:00:00.000Z",
      ruleIds: ["rule-1", "rule-2"],
    }]);
  });

  it("listPersonalRuleSetsForUser returns only personal rule sets for the owner", async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          leftJoin: vi.fn(() => ({
            where: vi.fn(() => ({
              groupBy: vi.fn(() => ({
                orderBy: vi.fn().mockResolvedValue([{
                  id: "rule-set-2",
                  name: "Personal Set",
                  ownerUserId: "user-1",
                  createdAt: "2026-03-09 00:00:00+00",
                  ruleIds: null,
                }]),
              })),
            })),
          })),
        })),
      })),
    };
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) => fn(db));

    const result = await listPersonalRuleSetsForUser({} as never, "tenant_schema", "user-1");

    expect(result).toEqual([{
      id: "rule-set-2",
      name: "Personal Set",
      ownerUserId: "user-1",
      createdAt: "2026-03-09T00:00:00.000Z",
      ruleIds: [],
    }]);
  });

  it("deleteRuleSet returns success when the rule set exists", async () => {
    const sql = {} as never;
    const db = {
      delete: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([{ id: "rule-set-1", name: "Shared Set" }]),
        })),
      })),
    };
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) => fn(db));

    const result = await deleteRuleSet(
      sql,
      "tenant-1",
      "tenant_schema",
      actor,
      "rule-set-1",
    );

    expect(result).toEqual({ success: true });
    expect(logAuditEventMock).toHaveBeenCalledWith(
      sql,
      "tenant_schema",
      expect.objectContaining({
        tenantId: "tenant-1",
        action: "rule_set.delete",
        targetId: "rule-set-1",
        outcome: "success",
      }),
    );
  });

  it("deleteRuleSet returns not_found when no rule set matches the requested scope", async () => {
    const sql = {} as never;
    const db = {
      delete: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([]),
        })),
      })),
    };
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) => fn(db));

    const result = await deleteRuleSet(
      sql,
      "tenant-1",
      "tenant_schema",
      actor,
      "rule-set-2",
      { ownerUserId: "user-1" },
    );

    expect(result).toEqual({ error: "not_found" });
    expect(logAuditEventMock).toHaveBeenCalledWith(
      sql,
      "tenant_schema",
      expect.objectContaining({
        tenantId: "tenant-1",
        action: "rule_set.delete",
        targetId: "rule-set-2",
        outcome: "failure",
        reason: "not_found",
      }),
    );
  });

  it("listRuleSetsForAgent returns linked rule sets with normalized timestamps", async () => {
    const { db } = makeLinkedRuleSetListDb([
      {
        id: "rule-set-3",
        name: "Agent Set",
        ownerUserId: "user-2",
        createdAt: new Date("2026-03-10T00:00:00.000Z"),
        ruleIds: ["rule-3"],
      },
    ]);
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) => fn(db));

    const result = await listRuleSetsForAgent({} as never, "tenant_schema", "agent-2");

    expect(result).toEqual([{
      id: "rule-set-3",
      name: "Agent Set",
      ownerUserId: "user-2",
      createdAt: "2026-03-10T00:00:00.000Z",
      ruleIds: ["rule-3"],
    }]);
  });

  it("listRuleSetsForGroup returns linked shared rule sets", async () => {
    const { db } = makeLinkedRuleSetListDb([
      {
        id: "rule-set-4",
        name: "Group Set",
        ownerUserId: null,
        createdAt: "2026-03-11 00:00:00+00",
        ruleIds: ["rule-4", "rule-5"],
      },
    ]);
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) => fn(db));

    const result = await listRuleSetsForGroup({} as never, "tenant_schema", "group-1");

    expect(result).toEqual([{
      id: "rule-set-4",
      name: "Group Set",
      ownerUserId: null,
      createdAt: "2026-03-11T00:00:00.000Z",
      ruleIds: ["rule-4", "rule-5"],
    }]);
  });

  it("addRuleToSet links a personal rule into a personal rule set", async () => {
    const sql = {} as never;
    const { db } = makeSelectLimitDb([
      [{ id: "rule-set-5" }],
      [{ id: "rule-6" }],
    ]);
    const insertMock = vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([{ ruleSetId: "rule-set-5" }]),
        })),
      })),
    }));
    (db as { insert?: typeof insertMock }).insert = insertMock;
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) => fn(db));

    const result = await addRuleToSet(
      sql,
      "tenant-1",
      "tenant_schema",
      actor,
      "rule-set-5",
      "rule-6",
      { ownerUserId: "user-1" },
    );

    expect(result).toEqual({ success: true });
    expect(logAuditEventMock).toHaveBeenCalledWith(
      sql,
      "tenant_schema",
      expect.objectContaining({
        tenantId: "tenant-1",
        action: "rule_set_rule.add",
        targetId: "rule-set-5:rule-6",
        outcome: "success",
      }),
    );
  });

  it("addRuleToSet returns not_found when the scoped rule is missing", async () => {
    const sql = {} as never;
    const { db } = makeSelectLimitDb([
      [{ id: "rule-set-5" }],
      [],
    ]);
    const insertMock = vi.fn();
    (db as { insert?: typeof insertMock }).insert = insertMock;
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) => fn(db));

    const result = await addRuleToSet(
      sql,
      "tenant-1",
      "tenant_schema",
      actor,
      "rule-set-5",
      "missing-rule",
      { ownerUserId: "user-1" },
    );

    expect(result).toEqual({ error: "not_found" });
    expect(insertMock).not.toHaveBeenCalled();
    expect(logAuditEventMock).toHaveBeenCalledWith(
      sql,
      "tenant_schema",
      expect.objectContaining({
        action: "rule_set_rule.add",
        targetId: "rule-set-5:missing-rule",
        outcome: "failure",
        reason: "not_found",
      }),
    );
  });

  it("addRuleToSet returns not_found when the scoped rule set is missing", async () => {
    const sql = {} as never;
    const { db } = makeSelectLimitDb([[]]);
    const insertMock = vi.fn();
    (db as { insert?: typeof insertMock }).insert = insertMock;
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) => fn(db));

    const result = await addRuleToSet(
      sql,
      "tenant-1",
      "tenant_schema",
      actor,
      "missing-rule-set",
      "rule-6",
      { ownerUserId: "user-1" },
    );

    expect(result).toEqual({ error: "not_found" });
    expect(insertMock).not.toHaveBeenCalled();
    expect(logAuditEventMock).toHaveBeenCalledWith(
      sql,
      "tenant_schema",
      expect.objectContaining({
        action: "rule_set_rule.add",
        targetId: "missing-rule-set:rule-6",
        outcome: "failure",
        reason: "not_found",
      }),
    );
  });

  it("addRuleToSet returns conflict when the link already exists", async () => {
    const { db } = makeSelectLimitDb([
      [{ id: "rule-set-5" }],
      [{ id: "rule-6" }],
    ]);
    const insertMock = vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([]),
        })),
      })),
    }));
    (db as { insert?: typeof insertMock }).insert = insertMock;
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) => fn(db));

    const result = await addRuleToSet(
      {} as never,
      "tenant-1",
      "tenant_schema",
      actor,
      "rule-set-5",
      "rule-6",
    );

    expect(result).toEqual({ error: "conflict" });
  });

  it("removeRuleFromSet unlinks a personal rule from its rule set", async () => {
    const sql = {} as never;
    const { db } = makeSelectLimitDb([[{ id: "rule-set-5" }]]);
    const deleteMock = vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([{ ruleSetId: "rule-set-5" }]),
      })),
    }));
    (db as { delete?: typeof deleteMock }).delete = deleteMock;
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) => fn(db));

    const result = await removeRuleFromSet(
      sql,
      "tenant-1",
      "tenant_schema",
      actor,
      "rule-set-5",
      "rule-6",
      { ownerUserId: "user-1" },
    );

    expect(result).toEqual({ success: true });
    expect(logAuditEventMock).toHaveBeenCalledWith(
      sql,
      "tenant_schema",
      expect.objectContaining({
        tenantId: "tenant-1",
        action: "rule_set_rule.remove",
        targetId: "rule-set-5:rule-6",
        outcome: "success",
      }),
    );
  });

  it("removeRuleFromSet returns not_found when the link is absent", async () => {
    const sql = {} as never;
    const { db } = makeSelectLimitDb([[{ id: "rule-set-5" }]]);
    const deleteMock = vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([]),
      })),
    }));
    (db as { delete?: typeof deleteMock }).delete = deleteMock;
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) => fn(db));

    const result = await removeRuleFromSet(
      sql,
      "tenant-1",
      "tenant_schema",
      actor,
      "rule-set-5",
      "missing-rule",
      { ownerUserId: "user-1" },
    );

    expect(result).toEqual({ error: "not_found" });
    expect(logAuditEventMock).toHaveBeenCalledWith(
      sql,
      "tenant_schema",
      expect.objectContaining({
        action: "rule_set_rule.remove",
        targetId: "rule-set-5:missing-rule",
        outcome: "failure",
        reason: "not_found",
      }),
    );
  });

  it("removeRuleFromSet returns not_found when the scoped rule set is missing", async () => {
    const sql = {} as never;
    const { db } = makeSelectLimitDb([[]]);
    const deleteMock = vi.fn();
    (db as { delete?: typeof deleteMock }).delete = deleteMock;
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) => fn(db));

    const result = await removeRuleFromSet(
      sql,
      "tenant-1",
      "tenant_schema",
      actor,
      "missing-rule-set",
      "rule-6",
      { ownerUserId: "user-1" },
    );

    expect(result).toEqual({ error: "not_found" });
    expect(deleteMock).not.toHaveBeenCalled();
    expect(logAuditEventMock).toHaveBeenCalledWith(
      sql,
      "tenant_schema",
      expect.objectContaining({
        action: "rule_set_rule.remove",
        targetId: "missing-rule-set:rule-6",
        outcome: "failure",
        reason: "not_found",
      }),
    );
  });

  it("associateRuleSetWithAgent links a matching personal rule set to its owner agent", async () => {
    const sql = {} as never;
    const { db } = makeSelectLimitDb([
      [{ userId: "user-1" }],
      [{ ownerUserId: "user-1" }],
    ]);
    const insertMock = vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([{ agentId: "agent-2" }]),
        })),
      })),
    }));
    (db as { insert?: typeof insertMock }).insert = insertMock;
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) => fn(db));

    const result = await associateRuleSetWithAgent(
      sql,
      "tenant-1",
      "tenant_schema",
      actor,
      "agent-2",
      "rule-set-7",
    );

    expect(result).toEqual({ success: true });
    expect(logAuditEventMock).toHaveBeenCalledWith(
      sql,
      "tenant_schema",
      expect.objectContaining({
        tenantId: "tenant-1",
        action: "agent_rule_set.associate",
        targetId: "agent-2:rule-set-7",
        outcome: "success",
      }),
    );
  });

  it("associateRuleSetWithAgent links a shared rule set to an autonomous agent", async () => {
    const sql = {} as never;
    const { db } = makeSelectLimitDb([
      [{ userId: null }],
      [{ ownerUserId: null }],
    ]);
    const insertMock = vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([{ agentId: "agent-3" }]),
        })),
      })),
    }));
    (db as { insert?: typeof insertMock }).insert = insertMock;
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) => fn(db));

    const result = await associateRuleSetWithAgent(
      sql,
      "tenant-1",
      "tenant_schema",
      actor,
      "agent-3",
      "shared-rule-set",
    );

    expect(result).toEqual({ success: true });
    expect(logAuditEventMock).toHaveBeenCalledWith(
      sql,
      "tenant_schema",
      expect.objectContaining({
        action: "agent_rule_set.associate",
        targetId: "agent-3:shared-rule-set",
        outcome: "success",
      }),
    );
  });

  it("associateRuleSetWithAgent returns not_found when the target agent is missing", async () => {
    const sql = {} as never;
    const { db } = makeSelectLimitDb([[]]);
    const insertMock = vi.fn();
    (db as { insert?: typeof insertMock }).insert = insertMock;
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) => fn(db));

    const result = await associateRuleSetWithAgent(
      sql,
      "tenant-1",
      "tenant_schema",
      actor,
      "missing-agent",
      "rule-set-7",
    );

    expect(result).toEqual({ error: "not_found" });
    expect(insertMock).not.toHaveBeenCalled();
    expect(logAuditEventMock).toHaveBeenCalledWith(
      sql,
      "tenant_schema",
      expect.objectContaining({
        action: "agent_rule_set.associate",
        targetId: "missing-agent:rule-set-7",
        outcome: "failure",
        reason: "not_found",
      }),
    );
  });

  it("associateRuleSetWithAgent returns forbidden when the personal rule set belongs to another user", async () => {
    const sql = {} as never;
    const { db } = makeSelectLimitDb([
      [{ userId: "user-1" }],
      [{ ownerUserId: "user-2" }],
    ]);
    const insertMock = vi.fn();
    (db as { insert?: typeof insertMock }).insert = insertMock;
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) => fn(db));

    const result = await associateRuleSetWithAgent(
      sql,
      "tenant-1",
      "tenant_schema",
      actor,
      "agent-2",
      "rule-set-7",
    );

    expect(result).toEqual({ error: "forbidden" });
    expect(insertMock).not.toHaveBeenCalled();
    expect(logAuditEventMock).toHaveBeenCalledWith(
      sql,
      "tenant_schema",
      expect.objectContaining({
        action: "agent_rule_set.associate",
        targetId: "agent-2:rule-set-7",
        outcome: "failure",
        reason: "forbidden",
      }),
    );
  });

  it("associateRuleSetWithAgent returns not_found when the rule set does not exist", async () => {
    const sql = {} as never;
    const { db } = makeSelectLimitDb([
      [{ userId: "user-1" }],
      [],
    ]);
    const insertMock = vi.fn();
    (db as { insert?: typeof insertMock }).insert = insertMock;
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) => fn(db));

    const result = await associateRuleSetWithAgent(
      sql,
      "tenant-1",
      "tenant_schema",
      actor,
      "agent-2",
      "missing-rule-set",
    );

    expect(result).toEqual({ error: "not_found" });
    expect(insertMock).not.toHaveBeenCalled();
    expect(logAuditEventMock).toHaveBeenCalledWith(
      sql,
      "tenant_schema",
      expect.objectContaining({
        action: "agent_rule_set.associate",
        targetId: "agent-2:missing-rule-set",
        outcome: "failure",
        reason: "not_found",
      }),
    );
  });

  it("associateRuleSetWithAgent returns conflict when the association already exists", async () => {
    const { db } = makeSelectLimitDb([
      [{ userId: "user-1" }],
      [{ ownerUserId: null }],
    ]);
    const insertMock = vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([]),
        })),
      })),
    }));
    (db as { insert?: typeof insertMock }).insert = insertMock;
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) => fn(db));

    const result = await associateRuleSetWithAgent(
      {} as never,
      "tenant-1",
      "tenant_schema",
      actor,
      "agent-2",
      "rule-set-7",
    );

    expect(result).toEqual({ error: "conflict" });
  });

  it("dissociateRuleSetFromAgent removes an existing agent association", async () => {
    const sql = {} as never;
    const db = {
      delete: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([{ agentId: "agent-2" }]),
        })),
      })),
    };
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) => fn(db));

    const result = await dissociateRuleSetFromAgent(
      sql,
      "tenant-1",
      "tenant_schema",
      actor,
      "agent-2",
      "rule-set-7",
    );

    expect(result).toEqual({ success: true });
    expect(logAuditEventMock).toHaveBeenCalledWith(
      sql,
      "tenant_schema",
      expect.objectContaining({
        tenantId: "tenant-1",
        action: "agent_rule_set.dissociate",
        targetId: "agent-2:rule-set-7",
        outcome: "success",
      }),
    );
  });

  it("dissociateRuleSetFromAgent returns not_found when the association is missing", async () => {
    const sql = {} as never;
    const db = {
      delete: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([]),
        })),
      })),
    };
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) => fn(db));

    const result = await dissociateRuleSetFromAgent(
      sql,
      "tenant-1",
      "tenant_schema",
      actor,
      "agent-2",
      "missing-rule-set",
    );

    expect(result).toEqual({ error: "not_found" });
    expect(logAuditEventMock).toHaveBeenCalledWith(
      sql,
      "tenant_schema",
      expect.objectContaining({
        action: "agent_rule_set.dissociate",
        targetId: "agent-2:missing-rule-set",
        outcome: "failure",
        reason: "not_found",
      }),
    );
  });

  it("getActiveRulesForAgent returns deduplicated rules from linked direct and group rule sets", async () => {
    const { db } = makeActiveRulesDb({
      directRuleSets: [{ ruleSetId: "rule-set-1" }],
      groupRuleSets: [{ ruleSetId: "rule-set-1" }, { ruleSetId: "rule-set-2" }],
      rules: [{
        id: "rule-1",
        name: "Dedup",
        description: "Desc",
        ownerUserId: null,
        updatedAt: new Date("2026-03-06T00:00:00.000Z"),
        createdAt: new Date("2026-03-06T00:00:00.000Z"),
      }],
    });
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) => fn(db));

    const result = await getActiveRulesForAgent({} as never, "tenant_schema", "agent-1");

    expect(result).toEqual([{
      id: "rule-1",
      name: "Dedup",
      description: "Desc",
      ownerUserId: null,
      updatedAt: "2026-03-06T00:00:00.000Z",
      createdAt: "2026-03-06T00:00:00.000Z",
    }]);
  });

  it("getActiveRulesForAgent returns empty array when no rule sets are linked", async () => {
    const { db, selectDistinctMock } = makeActiveRulesDb({
      directRuleSets: [],
      groupRuleSets: [],
      rules: [],
    });
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) => fn(db));

    const result = await getActiveRulesForAgent({} as never, "tenant_schema", "agent-1");

    expect(result).toEqual([]);
    expect(selectDistinctMock).not.toHaveBeenCalled();
  });

  it("getAgentIdsForRuleSet returns deduplicated direct and group agent ids", async () => {
    const { db } = makeAgentIdsForRuleSetDb({
      directAgents: [{ agentId: "agent-1" }, { agentId: "agent-2" }],
      groupAgents: [{ agentId: "agent-2" }, { agentId: "agent-3" }],
    });
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) => fn(db));

    const result = await getAgentIdsForRuleSet({} as never, "tenant_schema", "rule-set-1");

    expect(result).toEqual(["agent-1", "agent-2", "agent-3"]);
  });

  it("getAgentIdsForRuleSet returns empty array when no agents are affected", async () => {
    const { db } = makeAgentIdsForRuleSetDb({
      directAgents: [],
      groupAgents: [],
    });
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) => fn(db));

    const result = await getAgentIdsForRuleSet({} as never, "tenant_schema", "rule-set-1");

    expect(result).toEqual([]);
  });

  it("getAgentIdsForRule returns deduplicated direct and group agent ids", async () => {
    const { db } = makeAgentIdsForRuleDb({
      directAgents: [{ agentId: "agent-1" }, { agentId: "agent-2" }],
      groupAgents: [{ agentId: "agent-2" }, { agentId: "agent-4" }],
    });
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) => fn(db));

    const result = await getAgentIdsForRule({} as never, "tenant_schema", "rule-1");

    expect(result).toEqual(["agent-1", "agent-2", "agent-4"]);
  });

  it("getAgentIdsForRule returns empty array when no agents are affected", async () => {
    const { db } = makeAgentIdsForRuleDb({
      directAgents: [],
      groupAgents: [],
    });
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) => fn(db));

    const result = await getAgentIdsForRule({} as never, "tenant_schema", "rule-1");

    expect(result).toEqual([]);
  });
});
