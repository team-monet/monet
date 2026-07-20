import type { EmbeddingProvider } from "./embedding";
import {
  createLocalEmbedder,
  createLocalEmbedderWithProvenance,
  instantiateEmbedderForPin,
  UnsatisfiableEmbedderError,
} from "./embedding-onnx";
import { readStoredEmbedderPin, readStoredVectorPresence } from "./storage";

/** A new store would otherwise permanently pin itself to an unrequested lexical fallback. */
export class FreshStoreEmbedderUnavailableError extends Error {
  constructor() {
    super(
      "The semantic embedder is unavailable. This is a NEW store, and pinning it to the lexical " +
        "fallback would permanently degrade recall. Fix the model download/cache (or set " +
        "MONET_EMBEDDER=onnx to see the underlying error), or explicitly opt into lexical recall " +
        "with MONET_EMBEDDER=hashing.",
    );
    this.name = "FreshStoreEmbedderUnavailableError";
  }
}

/**
 * Select the startup embedder from the store's durable state before MonetCore construction.
 * Existing pins remain authoritative; unpinned legacy vectors retain the historical auto-fallback
 * behavior; only a genuinely fresh store rejects an implicit ONNX-to-hashing downgrade.
 */
export async function chooseStoreEmbedder(dbPath: string): Promise<EmbeddingProvider> {
  const pin = readStoredEmbedderPin(dbPath);
  if (pin !== null) {
    try {
      return await instantiateEmbedderForPin(pin);
    } catch (error) {
      if (!(error instanceof UnsatisfiableEmbedderError)) throw error;
      console.error(`[monet-core] pin '${pin}' could not be loaded (${error.message}); deferring to engine recovery.`);
      return createLocalEmbedder();
    }
  }

  const vectorPresence = readStoredVectorPresence(dbPath);
  if (vectorPresence !== false) return createLocalEmbedder();

  const selected = await createLocalEmbedderWithProvenance();
  if (selected.selection === "implicit-hashing-fallback") {
    throw new FreshStoreEmbedderUnavailableError();
  }
  return selected.provider;
}
