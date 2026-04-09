import {
  memoryEntries,
  tenantSchemaNameFromId,
  tenants,
  withTenantDrizzleScope,
  type SqlClient,
} from "@monet/db";
import { and, asc, eq, inArray, isNotNull, ne, sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import {
  createChatEnrichmentProvider,
  createEmbeddingEnrichmentProvider,
  resolveConfiguredProviders,
} from "../providers/index";
import type {
  ChatEnrichmentProvider,
  EmbeddingEnrichmentProvider,
  EnrichmentProvider,
} from "../providers/enrichment";

const DEFAULT_MAX_CONCURRENT_ENRICHMENTS = 5;
const OLLAMA_MAX_CONCURRENT_ENRICHMENTS = 1;
const QUERY_EMBEDDING_TIMEOUT_MS = 3000;
const RELATED_MEMORY_LIMIT = 5;

interface EnrichmentJob {
  entryId: string;
  schemaName: string;
}

let providerOverride: EnrichmentProvider | null | undefined;
let cachedChatProvider: ChatEnrichmentProvider | null | undefined;
let cachedEmbeddingProvider: EmbeddingEnrichmentProvider | null | undefined;
let activeJobs = 0;
const queue: EnrichmentJob[] = [];
const drainWaiters = new Set<() => void>();
let shuttingDown = false;

export function markShuttingDown() {
  shuttingDown = true;
}

export function setEnrichmentProviderForTests(
  provider: EnrichmentProvider | null | undefined,
) {
  providerOverride = provider;
  cachedChatProvider = undefined;
  cachedEmbeddingProvider = undefined;
}

export function resetEnrichmentStateForTests() {
  providerOverride = undefined;
  cachedChatProvider = undefined;
  cachedEmbeddingProvider = undefined;
  activeJobs = 0;
  queue.length = 0;
  shuttingDown = false;
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

export function resolveMaxConcurrentEnrichments(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const explicit = parsePositiveInteger(env.ENRICHMENT_MAX_CONCURRENT_JOBS);
  if (explicit) {
    return explicit;
  }

  try {
    const { chatProvider, embeddingProvider } = resolveConfiguredProviders(env);
    if (chatProvider === "ollama" || embeddingProvider === "ollama") {
      return OLLAMA_MAX_CONCURRENT_ENRICHMENTS;
    }
  } catch {
    // Fall back to the general default when provider config is invalid.
  }

  return DEFAULT_MAX_CONCURRENT_ENRICHMENTS;
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
  sql: SqlClient,
  schemaName: string,
  entryId: string,
) {
  if (shuttingDown) return;
  queue.push({ schemaName, entryId });
  drainQueue(sql);
}

export async function recoverPendingEnrichments(sql: SqlClient) {
  const provider = getProvider({ logFailures: true });
  if (!provider) {
    return;
  }

  const db = drizzle(sql);
  const tenantRows = await db
    .select({ id: tenants.id })
    .from(tenants)
    .orderBy(asc(tenants.createdAt), asc(tenants.id));

  for (const row of tenantRows) {
    const schemaName = tenantSchemaNameFromId(row.id);
    const entries = await withTenantDrizzleScope(sql, schemaName, async (db) => {
      return db
        .select({ id: memoryEntries.id })
        .from(memoryEntries)
        .where(
          inArray(memoryEntries.enrichmentStatus, [
            "pending",
            "processing",
            "failed",
          ]),
        )
        .orderBy(asc(memoryEntries.createdAt));
    });

    for (const entry of entries) {
      queue.push({ schemaName, entryId: entry.id });
    }
  }

  if (queue.length > 0) {
    console.log(`Recovered ${queue.length} memory entries pending enrichment`);
    drainQueue(sql);
  }
}

export async function computeQueryEmbedding(query: string): Promise<number[] | null> {
  const embeddingProvider = getEmbeddingProvider({ logFailures: false });
  if (!embeddingProvider) {
    console.warn("Falling back to text search because no embedding provider is configured");
    return null;
  }

  try {
    return await withTimeout(
      embeddingProvider.computeEmbedding(query, { mode: "query" }),
      QUERY_EMBEDDING_TIMEOUT_MS,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Falling back to text search because query embedding failed: ${message}`);
    return null;
  }
}

function getProvider(opts: { logFailures: boolean }): EnrichmentProvider | null {
  const chatProvider = getChatProvider(opts);
  const embeddingProvider = getEmbeddingProvider(opts);

  if (!chatProvider || !embeddingProvider) {
    return null;
  }

  return {
    generateSummary: (content: string) => chatProvider.generateSummary(content),
    extractTags: (content: string) => chatProvider.extractTags(content),
    computeEmbedding: (content: string, options) => embeddingProvider.computeEmbedding(content, options),
  };
}

function getChatProvider(opts: { logFailures: boolean }): ChatEnrichmentProvider | null {
  if (providerOverride !== undefined) {
    return providerOverride;
  }

  if (cachedChatProvider !== undefined) {
    return cachedChatProvider;
  }

  try {
    cachedChatProvider = createChatEnrichmentProvider();
    return cachedChatProvider;
  } catch (error) {
    cachedChatProvider = null;
    if (opts.logFailures) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Chat enrichment unavailable: ${message}`);
    }
    return null;
  }
}

function getEmbeddingProvider(opts: { logFailures: boolean }): EmbeddingEnrichmentProvider | null {
  if (providerOverride !== undefined) {
    return providerOverride;
  }

  if (cachedEmbeddingProvider !== undefined) {
    return cachedEmbeddingProvider;
  }

  try {
    cachedEmbeddingProvider = createEmbeddingEnrichmentProvider();
    return cachedEmbeddingProvider;
  } catch (error) {
    cachedEmbeddingProvider = null;
    if (opts.logFailures) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Embedding provider unavailable: ${message}`);
    }
    return null;
  }
}

function drainQueue(sql: SqlClient) {
  const maxConcurrentEnrichments = resolveMaxConcurrentEnrichments();

  while (activeJobs < maxConcurrentEnrichments && queue.length > 0) {
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

async function runJob(sql: SqlClient, job: EnrichmentJob) {
  const provider = getProvider({ logFailures: true });
  if (!provider) {
    return;
  }

  try {
    const entry = await withTenantDrizzleScope(sql, job.schemaName, async (db) => {
      const [row] = await db
        .update(memoryEntries)
        .set({ enrichmentStatus: "processing" })
        .where(
          and(
            eq(memoryEntries.id, job.entryId),
            inArray(memoryEntries.enrichmentStatus, ["pending", "failed"]),
          ),
        )
        .returning({
          id: memoryEntries.id,
          content: memoryEntries.content,
          tags: memoryEntries.tags,
          version: memoryEntries.version,
        });

      if (row) {
        return row;
      }

      const [processingRow] = await db
        .select({
          id: memoryEntries.id,
          content: memoryEntries.content,
          tags: memoryEntries.tags,
          version: memoryEntries.version,
        })
        .from(memoryEntries)
        .where(
          and(
            eq(memoryEntries.id, job.entryId),
            eq(memoryEntries.enrichmentStatus, "processing"),
          ),
        )
        .limit(1);
      return processingRow;
    });

    if (!entry) {
      return;
    }

    // Running these sequentially keeps local providers such as Ollama/ONNX
    // from overcommitting memory during a single enrichment job.
    const summary = await provider.generateSummary(entry.content);
    const extractedTags = await provider.extractTags(entry.content);
    const embedding = await provider.computeEmbedding(entry.content);

    const mergedTags = [...new Set([...(entry.tags ?? []), ...extractedTags])].slice(0, 16);
    const relatedMemoryIds = await findRelatedMemoryIds(sql, job.schemaName, job.entryId, embedding);

    await withTenantDrizzleScope(sql, job.schemaName, async (db) => {
      const [updated] = await db
        .update(memoryEntries)
        .set({
          summary,
          embedding: drizzleSql`${toVectorLiteral(embedding)}::vector`,
          autoTags: mergedTags,
          relatedMemoryIds,
          enrichmentStatus: "completed",
        })
        .where(
          and(
            eq(memoryEntries.id, job.entryId),
            eq(memoryEntries.version, entry.version),
          ),
        )
        .returning({ id: memoryEntries.id });

      // If no rows were updated, content/tags changed while this job was running.
      // A newer enrichment job will write the current results.
      void updated;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markEnrichmentFailed(sql, job.schemaName, job.entryId);
    console.warn(`Memory enrichment failed for ${job.schemaName}/${job.entryId}: ${message}`);
  }
}

async function markEnrichmentFailed(
  sql: SqlClient,
  schemaName: string,
  entryId: string,
) {
  await withTenantDrizzleScope(sql, schemaName, async (db) => {
    await db
      .update(memoryEntries)
      .set({ enrichmentStatus: "failed" })
      .where(
        and(
          eq(memoryEntries.id, entryId),
          eq(memoryEntries.enrichmentStatus, "processing"),
        ),
      );
  });
}

async function findRelatedMemoryIds(
  sql: SqlClient,
  schemaName: string,
  entryId: string,
  embedding: number[],
): Promise<string[]> {
  return withTenantDrizzleScope(sql, schemaName, async (db) => {
    const rows = await db
      .select({ id: memoryEntries.id })
      .from(memoryEntries)
      .where(
        and(
          ne(memoryEntries.id, entryId),
          isNotNull(memoryEntries.embedding),
        ),
      )
      .orderBy(
        drizzleSql`${memoryEntries.embedding} <=> ${toVectorLiteral(embedding)}::vector`,
      )
      .limit(RELATED_MEMORY_LIMIT);

    return rows.map((row) => row.id);
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

function parsePositiveInteger(value: string | undefined): number | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return null;
  }

  return parsed;
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
