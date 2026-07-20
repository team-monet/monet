import {
  MonetCore,
  chooseStoreEmbedder,
  type EmbeddingProvider,
} from "@team-monet/core";

export interface ServedCoreOptions {
  scopeContext: string;
  defaultCircle: string;
}

type StoreEmbedderSelector = (dbPath: string) => Promise<EmbeddingProvider>;

/** Open a core that will be served, selecting the embedder from the store's durable pin first. */
export async function openServedCore(
  dbPath: string,
  options: ServedCoreOptions,
  selectEmbedder: StoreEmbedderSelector = chooseStoreEmbedder,
): Promise<MonetCore> {
  const embedder = await selectEmbedder(dbPath);
  return new MonetCore(dbPath, { ...options, embedder });
}

/** Open the non-embedding status path without allowing construction to mint a pin. */
export function openStatusCore(dbPath: string, embedder?: EmbeddingProvider): MonetCore {
  return new MonetCore(dbPath, { ...(embedder ? { embedder } : {}), deferCreatedPin: true });
}

/** Open the synchronous source-registry path without allowing construction to mint a pin. */
export function openSourceCore(
  dbPath: string,
  sourceStorageDir: string,
  embedder?: EmbeddingProvider,
): MonetCore {
  return new MonetCore(dbPath, {
    ...(embedder ? { embedder } : {}),
    sourceStorageDir,
    deferCreatedPin: true,
  });
}
