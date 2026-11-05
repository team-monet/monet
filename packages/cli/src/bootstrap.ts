import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  MonetCore,
  acquireFileLock,
  chooseStoreEmbedder,
  createSharedModelHost,
  inStartupPhase,
  instantiateEmbedderForPin,
  type EmbeddingProvider,
  type ModelHost,
} from "@team-monet/core";

export interface ServedCoreOptions {
  scopeContext: string;
  defaultCircle: string;
  /**
   * Where the governed-moment spool is appended — the append-only record every writer can reach,
   * including one that opens no store at all.
   *
   * OPTIONAL, on deliberate terms: `MonetCoreOptions.momentSpoolPath` has NO DEFAULT in engine.ts,
   * deliberately, so that no core built by a test or a one-off script appends into a real store. A
   * caller that omits it gets a no-op; the two callers of THIS function pass it UNCONDITIONALLY.
   *
   * WHY IT MUST BE DECLARED HERE, and this is not a formality (monet-client#75): `openServedCore`
   * spreads this interface into `new MonetCore(...)`, so an option ABSENT FROM THIS TYPE never
   * reaches the engine no matter what a caller writes. That is exactly how the predecessor of this
   * field went unwired in the shipped binary while looking correct at both call sites — the wiring
   * existed, the type did not, and the omission was silent and unreconstructible after the fact.
   */
  momentSpoolPath?: string;
}

type StoreEmbedderSelector = (dbPath: string) => Promise<EmbeddingProvider>;

/**
 * Every serving process on a machine uses one model through this. Constructing it touches nothing:
 * a store that never embeds through a model, such as an explicitly lexical one, starts no process.
 */
function sharedModelHost(): ModelHost {
  const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
  const entry = import.meta.url.endsWith(".ts") ? "./model-host.ts" : "./model-host.js";
  return createSharedModelHost({ version, hostEntry: fileURLToPath(new URL(entry, import.meta.url)) });
}

/** Only a schema migration holds this for long. Past it a session opens unserialized, as before the lock. */
const STORE_OPEN_WAIT_MS = 30_000;

/**
 * ONE SESSION AT A TIME THROUGH A STORE'S SCHEMA REGION.
 *
 * Construction creates and migrates the schema in many separate statements, and a process cannot see
 * that another is halfway through them: ten sessions starting on a new store failed with
 * `UNIQUE constraint failed: sync_meta.singleton` and `trigger ... already exists`, and a migration
 * on upgrade has the same shape. Waiting here means each session finds the region finished. Each
 * statement stays as it was, so a lock that cannot be taken leaves things exactly as they were.
 */
function withStoreOpenLock<T>(dbPath: string, open: () => T): T {
  let release: (() => void) | null = null;
  try {
    release = acquireFileLock(`${dbPath}.open-lock`, STORE_OPEN_WAIT_MS);
  } catch {
    // Unlockable here. Today's behaviour is still available: open without it.
  }
  try {
    return open();
  } finally {
    release?.();
  }
}

/**
 * Open a core that will be served, selecting the embedder from the store's durable pin first.
 *
 * BOTH STEPS ARE PHASE-TAGGED (#13). These are the two widest fallible regions of startup and they
 * run before the server factory is even entered, so every throw here reaches the host as
 * `Connection closed` — with, until now, nothing to say which of the two it was. The distinction is
 * not academic: the model load/download and the SQLite open fail for unrelated reasons and have
 * unrelated fixes, and the one real incident behind #12 (a `database is locked` at 2026-08-01
 * 15:21, retried twice, third attempt fine) was misread as the model download precisely because
 * the two are indistinguishable from outside. See @team-monet/core's startup-diagnosis module.
 */
export async function openServedCore(
  dbPath: string,
  options: ServedCoreOptions,
  selectEmbedder?: StoreEmbedderSelector,
): Promise<MonetCore> {
  const modelHost = selectEmbedder ? undefined : sharedModelHost();
  const select = selectEmbedder ?? ((path: string) => chooseStoreEmbedder(path, { modelHost }));
  const embedder = await inStartupPhase("embedder-selection", () => select(dbPath));
  return await inStartupPhase(
    "store-open",
    () =>
      withStoreOpenLock(
        dbPath,
        () =>
          new MonetCore(dbPath, {
            ...options,
            embedder,
            // The engine's own pin-swap path loads through the same host, or a swap would bring back
            // the private copy this exists to remove.
            ...(modelHost ? { embedderLoader: (id: string) => instantiateEmbedderForPin(id, { modelHost }) } : {}),
          }),
      ),
  );
}

/** Open the non-embedding status path without allowing construction to mint a pin. */
export function openStatusCore(dbPath: string, embedder?: EmbeddingProvider): MonetCore {
  return new MonetCore(dbPath, { ...(embedder ? { embedder } : {}), deferCreatedPin: true });
}
