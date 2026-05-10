import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  getTestApp,
  getTestSql,
  provisionTestTenant,
  cleanupTestData,
  closeTestDb,
} from "./helpers/setup";
import { withTenantScope } from "@monet/db";
import {
  resetEnrichmentStateForTests,
  setEnrichmentProviderForTests,
} from "../../src/services/enrichment.service";
import {
  EMBEDDING_DIMENSIONS,
  type EnrichmentProvider,
} from "../../src/providers/enrichment";

function vector(axis: number, magnitude = 1): number[] {
  const values = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0);
  values[axis] = magnitude;
  return values;
}

describe("search integration", () => {
  const app = getTestApp();
  const sql = getTestSql();

  let apiKey = "";
  let agentId = "";
  let tenantId = "";
  let schemaName = "";

  function authHeaders(key = apiKey) {
    return {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    };
  }

  async function search(params: Record<string, string | number | boolean | undefined> = {}) {
    const qp = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) {
        qp.append(k, String(v));
      }
    });
    const url = qp.size > 0 ? `/api/memories?${qp.toString()}` : "/api/memories";
    const res = await app.request(url, { headers: authHeaders() });
    return { res, body: await res.json() as { items: Array<Record<string, unknown>>; nextCursor: string | null } };
  }

  async function createMemory(input: Record<string, unknown>) {
    const res = await app.request("/api/memories", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(input),
    });
    return { res, body: await res.json() as { id: string } };
  }

  async function patchMemory(
    id: string,
    fields: {
      embedding?: number[] | null;
      auto_tags?: string[];
      usefulness_score?: number;
      created_at?: string;
      last_accessed_at?: string;
      expires_at?: string | null;
    },
  ) {
    await withTenantScope(sql, schemaName, async (txSql) => {
      if (fields.embedding !== undefined) {
        if (fields.embedding === null) {
          await txSql`UPDATE memory_entries SET embedding = NULL WHERE id = ${id}`;
        } else {
          await txSql.unsafe(
            `UPDATE memory_entries SET embedding = '[${fields.embedding.join(",")}]'::vector WHERE id = $1`,
            [id],
          );
        }
      }

      if (fields.auto_tags !== undefined) {
        const autoTagLiteral = fields.auto_tags
          .map((t) => `'${t.replace(/'/g, "''")}'`)
          .join(",");
        await txSql.unsafe(
          `UPDATE memory_entries SET auto_tags = ARRAY[${autoTagLiteral}]::text[] WHERE id = $1`,
          [id],
        );
      }

      if (fields.usefulness_score !== undefined) {
        await txSql`UPDATE memory_entries SET usefulness_score = ${fields.usefulness_score} WHERE id = ${id}`;
      }

      if (fields.created_at !== undefined) {
        await txSql`UPDATE memory_entries SET created_at = ${fields.created_at}::timestamptz WHERE id = ${id}`;
      }

      if (fields.last_accessed_at !== undefined) {
        await txSql`UPDATE memory_entries SET last_accessed_at = ${fields.last_accessed_at}::timestamptz WHERE id = ${id}`;
      }

      if (fields.expires_at !== undefined) {
        if (fields.expires_at === null) {
          await txSql`UPDATE memory_entries SET expires_at = NULL WHERE id = ${id}`;
        } else {
          await txSql`UPDATE memory_entries SET expires_at = ${fields.expires_at}::timestamptz WHERE id = ${id}`;
        }
      }
    });
  }

  async function seedBaseline() {
    const T1 = "2025-01-02T00:00:00.000Z";
    const T2 = "2025-01-03T00:00:00.000Z";
    const T3 = "2025-01-04T00:00:00.000Z";
    const T4 = "2025-01-05T00:00:00.000Z";
    const T5 = "2025-01-06T00:00:00.000Z";

    const items = [
      { key: "lex_content", content: "alpha needle content", tags: ["base", "tagA"], memoryType: "fact", scope: "group" },
      { key: "lex_summary", content: "summary host", summary: "contains needle summary", tags: ["base"], memoryType: "fact", scope: "group" },
      { key: "lex_tags", content: "tag host", tags: ["needle-tag", "base"], memoryType: "fact", scope: "group" },
      { key: "lex_auto", content: "auto tag host", tags: ["base"], memoryType: "fact", scope: "group" },
      { key: "multi_col", content: "needle in content", summary: "needle in summary", tags: ["needle-tag", "base"], memoryType: "fact", scope: "group" },
      { key: "percent_literal", content: "literal 100% safe", tags: ["base"], memoryType: "fact", scope: "group" },
      { key: "percent_decoy", content: "100x match token", tags: ["base"], memoryType: "fact", scope: "group" },
      { key: "underscore_literal", content: "literal token_a value", tags: ["base"], memoryType: "fact", scope: "group" },
      { key: "underscore_decoy", content: "tokenXa", tags: ["base"], memoryType: "fact", scope: "group" },
      { key: "or_tag_a", content: "overlap tag A", tags: ["team-a", "base"], memoryType: "fact", scope: "group" },
      { key: "or_tag_b", content: "overlap tag B", tags: ["team-b", "base"], memoryType: "fact", scope: "group" },
      { key: "type_decision", content: "decision memory", tags: ["typed"], memoryType: "decision", scope: "group" },
      { key: "type_fact", content: "fact memory", tags: ["typed"], memoryType: "fact", scope: "group" },
      { key: "sem_axis0_high_useful", content: "semantic strong", tags: ["semantic"], memoryType: "fact", scope: "group" },
      { key: "sem_axis0_low_useful", content: "semantic weaker", tags: ["semantic"], memoryType: "fact", scope: "group" },
      { key: "sem_axis2_overlap", content: "hybrid-anchor lexical marker", tags: ["hybrid"], memoryType: "fact", scope: "group" },
      { key: "sem_only_axis2", content: "semantic only anchor", tags: ["hybrid"], memoryType: "fact", scope: "group" },
      { key: "hybrid_lex_only", content: "hybrid-anchor lexical only fixture", summary: "hybrid-anchor summary fixture", tags: ["hybrid"], memoryType: "fact", scope: "group" },
      { key: "sem_axis1_higher_useful", content: "semantic farther axis one", tags: ["semantic"], memoryType: "fact", scope: "group" },
      { key: "expired_item", content: "expired memory", tags: ["expiry"], memoryType: "fact", scope: "group" },
    ] as const;

    const ids: Record<string, string> = {};

    for (const item of items) {
      const { res, body } = await createMemory({
        content: item.content,
        summary: (item as { summary?: string }).summary,
        memoryType: item.memoryType,
        memoryScope: item.scope,
        tags: item.tags,
      });
      expect(res.status).toBe(201);
      ids[item.key] = body.id;
    }

    await patchMemory(ids.lex_content, { embedding: vector(5), created_at: T1, last_accessed_at: T1, usefulness_score: 0, auto_tags: ["meta"] });
    await patchMemory(ids.lex_summary, { embedding: vector(6), created_at: T2, last_accessed_at: T2, usefulness_score: 0, auto_tags: ["meta"] });
    await patchMemory(ids.lex_tags, { embedding: vector(7), created_at: T3, last_accessed_at: T3, usefulness_score: 0, auto_tags: ["meta"] });
    await patchMemory(ids.lex_auto, { embedding: vector(8), created_at: T4, last_accessed_at: T4, usefulness_score: 0, auto_tags: ["needle-auto"] });
    await patchMemory(ids.multi_col, { embedding: vector(2), created_at: T5, last_accessed_at: T5, usefulness_score: 1, auto_tags: ["needle-auto"] });
    await patchMemory(ids.percent_literal, { embedding: vector(4), created_at: T2, last_accessed_at: T3, usefulness_score: 0, auto_tags: ["meta"] });
    await patchMemory(ids.percent_decoy, { embedding: null, created_at: T2, last_accessed_at: T3, usefulness_score: 0, auto_tags: ["meta"] });
    await patchMemory(ids.underscore_literal, { embedding: vector(4), created_at: T2, last_accessed_at: T3, usefulness_score: 0, auto_tags: ["meta"] });
    await patchMemory(ids.underscore_decoy, { embedding: null, created_at: T2, last_accessed_at: T3, usefulness_score: 0, auto_tags: ["meta"] });
    await patchMemory(ids.or_tag_a, { embedding: vector(4), created_at: T1, last_accessed_at: T2, usefulness_score: 0, auto_tags: ["meta"] });
    await patchMemory(ids.or_tag_b, { embedding: vector(4), created_at: T1, last_accessed_at: T2, usefulness_score: 0, auto_tags: ["meta"] });
    await patchMemory(ids.type_decision, { embedding: vector(4), created_at: T4, last_accessed_at: T4, usefulness_score: 0, auto_tags: ["meta"] });
    await patchMemory(ids.type_fact, { embedding: vector(4), created_at: T3, last_accessed_at: T3, usefulness_score: 0, auto_tags: ["meta"] });
    await patchMemory(ids.sem_axis0_high_useful, { embedding: vector(0, 1), created_at: T5, last_accessed_at: T5, usefulness_score: 20, auto_tags: ["meta"] });
    await patchMemory(ids.sem_axis0_low_useful, { embedding: vector(0, 1), created_at: T4, last_accessed_at: T4, usefulness_score: 0, auto_tags: ["meta"] });
    await patchMemory(ids.sem_axis2_overlap, { embedding: vector(2, 1), created_at: T4, last_accessed_at: T4, usefulness_score: 2, auto_tags: ["meta"] });
    await patchMemory(ids.sem_only_axis2, { embedding: vector(2, 1), created_at: T3, last_accessed_at: T3, usefulness_score: 1, auto_tags: ["meta"] });
    await patchMemory(ids.hybrid_lex_only, { embedding: vector(8, 1), created_at: T3, last_accessed_at: T3, usefulness_score: 0, auto_tags: ["meta"] });
    await patchMemory(ids.sem_axis1_higher_useful, { embedding: vector(1, 1), created_at: T5, last_accessed_at: T5, usefulness_score: 1, auto_tags: ["meta"] });
    await patchMemory(ids.expired_item, {
      embedding: vector(3),
      created_at: T2,
      last_accessed_at: T2,
      usefulness_score: 0,
      auto_tags: ["meta"],
      expires_at: "2000-01-01T00:00:00.000Z",
    });

    return ids;
  }

  async function bindCurrentAgentToUser() {
    await withTenantScope(sql, schemaName, async (txSql) => {
      const [user] = await txSql<{ id: string }[]>`
        INSERT INTO users (tenant_id, external_id)
        VALUES (${tenantId}, ${`ext-${agentId}`})
        RETURNING id
      `;
      await txSql`UPDATE agents SET user_id = ${user.id} WHERE id = ${agentId}`;
    });
  }

  beforeAll(() => {
    const provider: EnrichmentProvider = {
      generateSummary: async (content) => `summary:${content.slice(0, 16)}`,
      extractTags: async () => [],
      computeEmbedding: async (content) => {
        if (content.includes("semantic-axis-0")) return vector(0);
        if (content.includes("hybrid-anchor")) return vector(2);
        return vector(9);
      },
    };
    setEnrichmentProviderForTests(provider);
  });

  beforeEach(async () => {
    resetEnrichmentStateForTests();
    const provider: EnrichmentProvider = {
      generateSummary: async (content) => `summary:${content.slice(0, 16)}`,
      extractTags: async () => [],
      computeEmbedding: async (content) => {
        if (content.includes("semantic-axis-0")) return vector(0);
        if (content.includes("hybrid-anchor")) return vector(2);
        return vector(9);
      },
    };
    setEnrichmentProviderForTests(provider);

    await cleanupTestData();
    const { body } = await provisionTestTenant({ name: "search-test" });
    apiKey = body.apiKey as string;
    agentId = (body.agent as { id: string }).id;
    tenantId = (body.tenant as { id: string }).id;
    schemaName = `tenant_${tenantId.replace(/-/g, "_")}`;

    const groupRes = await app.request("/api/groups", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "search-group" }),
    });
    const group = await groupRes.json() as { id: string };
    await app.request(`/api/groups/${group.id}/members`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ agentId }),
    });
  });

  afterAll(async () => {
    resetEnrichmentStateForTests();
    await cleanupTestData();
    await closeTestDb();
  });

  describe("lexical retrieval", () => {
    it("matches content, summary, tags, auto_tags via ILIKE", async () => {
      const ids = await seedBaseline();
      const { body } = await search({ query: "needle" });
      const got = new Set(body.items.map((i) => i.id as string));
      expect(got.has(ids.lex_content)).toBe(true);
      expect(got.has(ids.lex_summary)).toBe(true);
      expect(got.has(ids.lex_tags)).toBe(true);
      expect(got.has(ids.lex_auto)).toBe(true);
    });

    it("ranks multi-column matches higher", async () => {
      const ids = await seedBaseline();
      const { body } = await search({ query: "needle", limit: 10 });
      expect(body.items[0].id).toBe(ids.multi_col);
    });

    it("escapes % and _ characters", async () => {
      const ids = await seedBaseline();
      const pct = await search({ query: "100%" });
      expect(pct.body.items.some((i) => i.id === ids.percent_literal)).toBe(true);
      expect(pct.body.items.some((i) => i.id === ids.percent_decoy)).toBe(false);
      const under = await search({ query: "token_a" });
      expect(under.body.items.some((i) => i.id === ids.underscore_literal)).toBe(true);
      expect(under.body.items.some((i) => i.id === ids.underscore_decoy)).toBe(false);
    });

    it("matches query case-insensitively with ILIKE", async () => {
      const ids = await seedBaseline();
      const { body } = await search({ query: "ALPHA" });
      expect(body.items.some((i) => i.id === ids.lex_content)).toBe(true);
    });
  });

  describe("filters", () => {
    it("tag overlap semantics (OR not AND)", async () => {
      const ids = await seedBaseline();
      const { body } = await search({ tags: "team-a", tags2: "team-b" });
      // URLSearchParams above does not support duplicate key directly via object, use manual call:
      const res = await app.request("/api/memories?tags=team-a,team-b", { headers: authHeaders() });
      const data = await res.json() as { items: Array<{ id: string }> };
      const got = new Set(data.items.map((i) => i.id));
      expect(got.has(ids.or_tag_a)).toBe(true);
      expect(got.has(ids.or_tag_b)).toBe(true);
      expect(body).toBeDefined();
    });

    it("tag filter + lexical query combined", async () => {
      const ids = await seedBaseline();
      const res = await app.request("/api/memories?tags=hybrid&query=anchor", { headers: authHeaders() });
      const body = await res.json() as { items: Array<{ id: string }> };
      expect(body.items.some((i) => i.id === ids.sem_axis2_overlap)).toBe(true);
      expect(body.items.some((i) => i.id === ids.sem_only_axis2)).toBe(true);
    });

    it("exact memory type filter", async () => {
      const ids = await seedBaseline();
      const { body } = await search({ tags: "typed", memoryType: "decision" });
      expect(body.items).toHaveLength(1);
      expect(body.items[0].id).toBe(ids.type_decision);
    });
  });

  describe("semantic retrieval", () => {
    it("pure semantic matches with empty lexical set", async () => {
      const ids = await seedBaseline();
      const { body } = await search({ query: "semantic-axis-0" });
      const got = new Set(body.items.map((i) => i.id as string));
      expect(got.has(ids.sem_axis0_high_useful)).toBe(true);
      expect(got.has(ids.sem_axis0_low_useful)).toBe(true);
    });

    it("usefulness score ranking boost", async () => {
      const ids = await seedBaseline();
      const { body } = await search({ query: "semantic-axis-0", limit: 5 });
      expect(body.items[0].id).toBe(ids.sem_axis0_high_useful);
    });

    it("cosine distance influences ranking even with usefulness differences", async () => {
      const ids = await seedBaseline();
      const { body } = await search({ query: "semantic-axis-0", limit: 10 });
      const rank = new Map(body.items.map((item, index) => [item.id as string, index]));
      expect(rank.has(ids.sem_axis0_low_useful)).toBe(true);
      expect(rank.has(ids.sem_axis1_higher_useful)).toBe(true);
      expect((rank.get(ids.sem_axis0_low_useful) ?? Number.POSITIVE_INFINITY))
        .toBeLessThan(rank.get(ids.sem_axis1_higher_useful) ?? Number.NEGATIVE_INFINITY);
    });

    it("NULL embedding handling (excluded from semantic, works in lexical)", async () => {
      const ids = await seedBaseline();
      await patchMemory(ids.lex_content, { embedding: null });
      const semantic = await search({ query: "semantic-axis-0" });
      expect(semantic.body.items.some((i) => i.id === ids.lex_content)).toBe(false);

      const lexical = await search({ query: "alpha needle" });
      expect(lexical.body.items.some((i) => i.id === ids.lex_content)).toBe(true);
    });
  });

  describe("hybrid retrieval", () => {
    it("returns lexical-only, semantic-only, and overlap items", async () => {
      const ids = await seedBaseline();
      const { body } = await search({ query: "hybrid-anchor" });
      const got = new Set(body.items.map((i) => i.id as string));
      expect(got.has(ids.sem_axis2_overlap)).toBe(true);
      expect(got.has(ids.sem_only_axis2)).toBe(true);
      expect(got.has(ids.hybrid_lex_only)).toBe(true);
      expect(got.size).toBe(body.items.length);
      expect(body.items.length).toBeGreaterThan(0);
    });

    it("overlap items rank highest (RRF boost)", async () => {
      const ids = await seedBaseline();
      const { body } = await search({ query: "hybrid-anchor" });
      expect(body.items[0].id).toBe(ids.sem_axis2_overlap);
    });
  });

  describe("pagination", () => {
    async function seedPaginationFixtures() {
      const ids: string[] = [];
      for (let idx = 0; idx < 6; idx += 1) {
        const created = await createMemory({
          content: `page-anchor item ${idx}`,
          summary: `page-anchor summary ${idx}`,
          memoryType: "fact",
          memoryScope: "group",
          tags: ["page-anchor"],
        });
        expect(created.res.status).toBe(201);
        ids.push(created.body.id);
        await patchMemory(created.body.id, {
          embedding: vector(8),
          usefulness_score: idx,
          created_at: `2025-01-0${idx + 1}T00:00:00.000Z`,
          last_accessed_at: `2025-01-0${idx + 1}T00:00:00.000Z`,
          auto_tags: ["page-anchor"],
        });
      }
      return ids;
    }

    it("hybrid cursor pagination across pages", async () => {
      await seedBaseline();
      await seedPaginationFixtures();
      const p1 = await search({ query: "page-anchor", limit: 2 });
      expect(p1.body.items).toHaveLength(2);
      expect(p1.body.nextCursor).toBeTruthy();
      const p2 = await search({ query: "page-anchor", limit: 2, cursor: p1.body.nextCursor ?? undefined });

      const combined = [...p1.body.items, ...p2.body.items].map((i) => i.id as string);
      let cursor = p2.body.nextCursor;
      while (cursor) {
        const page = await search({ query: "page-anchor", limit: 2, cursor });
        combined.push(...page.body.items.map((i) => i.id as string));
        cursor = page.body.nextCursor;
      }
      const full = await search({ query: "page-anchor", limit: 50 });
      const fullIds = full.body.items.map((i) => i.id as string);
      expect(new Set(combined)).toEqual(new Set(fullIds));
    });

    it("lexical cursor pagination", async () => {
      await seedBaseline();
      await seedPaginationFixtures();
      const p1 = await search({ query: "page-anchor", limit: 2 });
      expect(p1.body.items).toHaveLength(2);
      expect(p1.body.nextCursor).toBeTruthy();
      const p2 = await search({ query: "page-anchor", limit: 2, cursor: p1.body.nextCursor ?? undefined });

      const combined = [...p1.body.items, ...p2.body.items].map((i) => i.id as string);
      let cursor = p2.body.nextCursor;
      while (cursor) {
        const page = await search({ query: "page-anchor", limit: 2, cursor });
        combined.push(...page.body.items.map((i) => i.id as string));
        cursor = page.body.nextCursor;
      }
      const full = await search({ query: "page-anchor", limit: 50 });
      const fullIds = full.body.items.map((i) => i.id as string);
      expect(new Set(combined)).toEqual(new Set(fullIds));
    });
  });

  describe("expiration and timestamps", () => {
    it("excludes expired, includes NULL expires_at", async () => {
      const ids = await seedBaseline();
      const { body } = await search({ query: "memory" });
      expect(body.items.some((i) => i.id === ids.expired_item)).toBe(false);
      expect(body.items.some((i) => i.id === ids.type_fact)).toBe(true);
    });

    it("createdAfter/createdBefore filters", async () => {
      const ids = await seedBaseline();
      const { body } = await search({ createdAfter: "2025-01-04T00:00:00.000Z", createdBefore: "2025-01-05T00:00:00.000Z" });
      expect(body.items.every((i) => {
        const created = new Date(i.createdAt as string).toISOString();
        return created >= "2025-01-04T00:00:00.000Z" && created <= "2025-01-05T00:00:00.000Z";
      })).toBe(true);
      expect(body.items.length).toBeGreaterThan(0);
      expect(body.items.length).toBe(8);
    });

    it("accessedAfter/accessedBefore filters", async () => {
      const ids = await seedBaseline();
      const { body } = await search({ accessedAfter: "2025-01-04T00:00:00.000Z", accessedBefore: "2025-01-05T00:00:00.000Z" });
      const got = new Set(body.items.map((i) => i.id as string));
      const expected = new Set([
        ids.lex_tags,
        ids.lex_auto,
        ids.percent_decoy,
        ids.percent_literal,
        ids.underscore_decoy,
        ids.underscore_literal,
        ids.type_decision,
        ids.type_fact,
        ids.sem_axis0_low_useful,
        ids.sem_axis2_overlap,
        ids.sem_only_axis2,
        ids.hybrid_lex_only,
      ]);
      expect(got).toEqual(expected);
    });
  });

  describe("scope visibility", () => {
    it("default: only group memories", async () => {
      await seedBaseline();
      await bindCurrentAgentToUser();
      await createMemory({ content: "u-scope", memoryType: "fact", memoryScope: "user", tags: ["scope-flag"] });
      await createMemory({ content: "p-scope", memoryType: "fact", memoryScope: "private", tags: ["scope-flag"] });
      const { body } = await search({ tags: "scope-flag" });
      expect(body.items).toHaveLength(0);
    });

    it("includeUser: true adds user memories", async () => {
      await seedBaseline();
      await bindCurrentAgentToUser();
      const created = await createMemory({ content: "u-scope", memoryType: "fact", memoryScope: "user", tags: ["scope-flag"] });
      const { body } = await search({ tags: "scope-flag", includeUser: true });
      expect(body.items.length).toBe(1);
      expect(body.items[0].id).toBe(created.body.id);
    });

    it("includePrivate: true adds private memories", async () => {
      await seedBaseline();
      const created = await createMemory({ content: "p-scope", memoryType: "fact", memoryScope: "private", tags: ["scope-flag"] });
      const { body } = await search({ tags: "scope-flag", includePrivate: true });
      expect(body.items.length).toBe(1);
      expect(body.items[0].id).toBe(created.body.id);
    });

    it("both flags: all scopes visible", async () => {
      await seedBaseline();
      await bindCurrentAgentToUser();
      await createMemory({ content: "u-scope", memoryType: "fact", memoryScope: "user", tags: ["scope-flag"] });
      await createMemory({ content: "p-scope", memoryType: "fact", memoryScope: "private", tags: ["scope-flag"] });
      await createMemory({ content: "g-scope", memoryType: "fact", memoryScope: "group", tags: ["scope-flag"] });
      const { body } = await search({ tags: "scope-flag", includeUser: true, includePrivate: true });
      expect(body.items).toHaveLength(3);
    });
  });
});
