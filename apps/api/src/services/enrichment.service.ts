import { withTenantScope } from "@monet/db";
import type postgres from "postgres";
import { createEnrichmentProvider } from "../providers/index";
import type { EnrichmentProvider } from "../providers/enrichment";

const MAX_CONCURRENT_ENRICHMENTS = 5;
const QUERY_EMBEDDING_TIMEOUT_MS = 3000;
const RELATED_MEMORY_LIMIT = 5;

interface EnrichmentJob {
  entryId: string;
  schemaName: string;
}

let providerOverride: EnrichmentProvider | null | undefined;
let cachedProvider: EnrichmentProvider | null | undefined;
let activeJobs = 0;
const queue: EnrichmentJob[] = [];
const drainWaiters = new Set<() => void>();

export function setEnrichmentProviderForTests(
  provider: EnrichmentProvider | null | undefined,
) {
  providerOverride = provider;
  cachedProvider = undefined;
}

export function resetEnrichmentStateForTests() {
  providerOverride = undefined;
  cachedProvider = undefined;
  activeJobs = 0;
  queue.length = 0;
  for (const resolve of drainWaiters) {
    resolve();
  }
  drainWaiters.clear();
}

export function getActiveEnrichmentCount(): number {
  return activeJobs;
}

export function getQueuedEnrichmentCount(): number {
  return queue.length;
}

export async function waitForEnrichmentDrain(timeoutMs: number): Promise<void> {
  if (isQueueDrained()) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;

    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      drainWaiters.delete(onDrain);
      resolve();
    };

    const onDrain = () => {
      done();
    };

    const timer = setTimeout(() => {
      done();
    }, timeoutMs);

    drainWaiters.add(onDrain);

    if (isQueueDrained()) {
      done();
    }
  });
}

export function enqueueEnrichment(
  sql: postgres.Sql,
  schemaName: string,
  entryId: string,
) {
  queue.push({ schemaName, entryId });
  drainQueue(sql);
}

export async function recoverPendingEnrichments(sql: postgres.Sql) {
  const provider = getProvider({ logFailures: true });
  if (!provider) {
    return;
  }

  const schemas = await sql`
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name LIKE 'tenant\_%' ESCAPE '\'
    ORDER BY schema_name ASC
  `;

  for (const row of schemas) {
    const schemaName = row.schema_name as string;
    const entries = await withTenantScope(sql, schemaName, async (txSql) => {
      const tx = txSql as unknown as postgres.Sql;
      return tx`
        SELECT id
        FROM memory_entries
        WHERE enrichment_status IN ('pending', 'processing', 'failed')
        ORDER BY created_at ASC
      `;
    });

    for (const entry of entries) {
      queue.push({ schemaName, entryId: entry.id as string });
    }
  }

  if (queue.length > 0) {
    console.log(`Recovered ${queue.length} memory entries pending enrichment`);
    drainQueue(sql);
  }
}

export async function computeQueryEmbedding(query: string): Promise<number[] | null> {
  const provider = getProvider({ logFailures: false });
  if (!provider) {
    console.warn("Falling back to text search because no enrichment provider is configured");
    return null;
  }

  try {
    return await withTimeout(provider.computeEmbedding(query), QUERY_EMBEDDING_TIMEOUT_MS);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Falling back to text search because query embedding failed: ${message}`);
    return null;
  }
}

function getProvider(opts: { logFailures: boolean }): EnrichmentProvider | null {
  if (providerOverride !== undefined) {
    return providerOverride;
  }

  if (cachedProvider !== undefined) {
    return cachedProvider;
  }

  try {
    cachedProvider = createEnrichmentProvider();
    return cachedProvider;
  } catch (error) {
    cachedProvider = null;
    if (opts.logFailures) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Enrichment provider unavailable: ${message}`);
    }
    return null;
  }
}

function drainQueue(sql: postgres.Sql) {
  while (activeJobs < MAX_CONCURRENT_ENRICHMENTS && queue.length > 0) {
    const job = queue.shift();
    if (!job) {
      return;
    }

    activeJobs += 1;
    void runJob(sql, job).finally(() => {
      activeJobs -= 1;
      drainQueue(sql);
    });
  }

  notifyDrainWaiters();
}

async function runJob(sql: postgres.Sql, job: EnrichmentJob) {
  const provider = getProvider({ logFailures: true });
  if (!provider) {
    return;
  }

  try {
    const entry = await withTenantScope(sql, job.schemaName, async (txSql) => {
      const tx = txSql as unknown as postgres.Sql;
      const [row] = await tx`
        UPDATE memory_entries
        SET enrichment_status = 'processing'
        WHERE id = ${job.entryId}
          AND enrichment_status IN ('pending', 'failed')
        RETURNING id, content, tags
      `;

      if (row) {
        return row as { id: string; content: string; tags: string[] } | undefined;
      }

      const [processingRow] = await tx`
        SELECT id, content, tags
        FROM memory_entries
        WHERE id = ${job.entryId}
          AND enrichment_status = 'processing'
      `;
      return processingRow as { id: string; content: string; tags: string[] } | undefined;
    });

    if (!entry) {
      return;
    }

    const [summary, embedding, extractedTags] = await Promise.all([
      provider.generateSummary(entry.content),
      provider.computeEmbedding(entry.content),
      provider.extractTags(entry.content),
    ]);

    const mergedTags = [...new Set([...(entry.tags ?? []), ...extractedTags])].slice(0, 16);
    const relatedMemoryIds = await findRelatedMemoryIds(sql, job.schemaName, job.entryId, embedding);

    await withTenantScope(sql, job.schemaName, async (txSql) => {
      const tx = txSql as unknown as postgres.Sql;
      await tx`
        UPDATE memory_entries
        SET summary = ${summary},
            embedding = ${toVectorLiteral(embedding)}::vector,
            auto_tags = ${mergedTags},
            related_memory_ids = ${relatedMemoryIds},
            enrichment_status = 'completed'
        WHERE id = ${job.entryId}
      `;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markEnrichmentFailed(sql, job.schemaName, job.entryId);
    console.warn(`Memory enrichment failed for ${job.schemaName}/${job.entryId}: ${message}`);
  }
}

async function markEnrichmentFailed(
  sql: postgres.Sql,
  schemaName: string,
  entryId: string,
) {
  await withTenantScope(sql, schemaName, async (txSql) => {
    const tx = txSql as unknown as postgres.Sql;
    await tx`
      UPDATE memory_entries
      SET enrichment_status = 'failed'
      WHERE id = ${entryId}
        AND enrichment_status = 'processing'
    `;
  });
}

async function findRelatedMemoryIds(
  sql: postgres.Sql,
  schemaName: string,
  entryId: string,
  embedding: number[],
): Promise<string[]> {
  return withTenantScope(sql, schemaName, async (txSql) => {
    const tx = txSql as unknown as postgres.Sql;
    const rows = await tx.unsafe(`
      SELECT id
      FROM memory_entries
      WHERE id <> $1::uuid
        AND embedding IS NOT NULL
      ORDER BY embedding <=> $2::vector
      LIMIT $3
    `, [entryId, toVectorLiteral(embedding), RELATED_MEMORY_LIMIT]);

    return (rows as Array<Record<string, unknown>>).map((row) => row.id as string);
  });
}

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.map((value) => {
    if (!Number.isFinite(value)) {
      throw new Error("Embedding contains non-finite values");
    }
    return Number(value).toString();
  }).join(",")}]`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isQueueDrained(): boolean {
  return activeJobs === 0 && queue.length === 0;
}

function notifyDrainWaiters(): void {
  if (!isQueueDrained()) return;

  for (const resolve of drainWaiters) {
    resolve();
  }
  drainWaiters.clear();
}
