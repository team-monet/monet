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
 * A PINNED store served by a different embedder is not degraded — it is wrong.
 *
 * The pin records the space its vectors live in. Serving that store through any other provider
 * compares query vectors from one space against stored vectors from another, so recall is not
 * "coarser", it is meaningless — and nothing in the response says so. The previous behaviour fell
 * back to createLocalEmbedder() and logged one line to a stderr an MCP host does not display, which
 * is indistinguishable from working.
 *
 * Refusing to serve is the loud version of the same fact, and it is recoverable: fix the model
 * cache, or move the store to a provider that IS available with `monet repair --target`.
 */
export class PinnedStoreEmbedderUnavailableError extends Error {
  constructor(readonly pin: string, readonly reason: string) {
    super(
      `This store is pinned to '${pin}', which could not be loaded (${reason}). Refusing to serve: ` +
        `its vectors live in that model's space, so answering through a different embedder compares ` +
        `two spaces and returns noise rather than degraded results. Fix the model download/cache, or ` +
        `move the store with \`monet repair --target <model>\` — that rewrites every vector and is ` +
        `one-way, so read \`monet doctor\` first.`,
    );
    this.name = "PinnedStoreEmbedderUnavailableError";
  }
}

/**
 * Select the startup embedder from the store's durable state before MonetCore construction.
 * Existing pins remain authoritative and are now REQUIRED to load: a pinned store served through a
 * different provider compares two embedding spaces, which is wrong rather than coarse. No path here
 * accepts an implicit lexical downgrade; `MONET_EMBEDDER=hashing` remains the explicit opt-in.
 */
export async function chooseStoreEmbedder(dbPath: string): Promise<EmbeddingProvider> {
  const pin = readStoredEmbedderPin(dbPath);
  if (pin !== null) {
    try {
      return await instantiateEmbedderForPin(pin);
    } catch (error) {
      if (!(error instanceof UnsatisfiableEmbedderError)) throw error;
      /*
       * AN EMPTY STORE CAN STILL HEAL (FIX Z, PR #51 round 8). With no vectors, an unloadable pin
       * invalidates nothing: letting construction proceed gives ensureEmbedderPin's empty-store
       * recovery a chance to re-pin. Refusing here would make a recoverable store unserveable.
       *
       * With vectors present there is nothing to recover — they live in the unloadable model's
       * space, and serving them through any other provider compares two spaces. That is wrong
       * rather than degraded, so it is refused instead of logged.
       */
      if (readStoredVectorPresence(dbPath) === false) {
        console.error(`[monet-core] pin '${pin}' could not be loaded (${error.message}); store is empty, deferring to engine recovery.`);
        return createLocalEmbedder();
      }
      throw new PinnedStoreEmbedderUnavailableError(pin, error.message);
    }
  }

  /*
   * UNPINNED WITH VECTORS IS THE LEGACY PATH, AND IT MUST REACH THE ENGINE (Codex P1, PR #173).
   *
   * A first attempt routed this through the fresh-store requirement, reasoning that an unpinned store
   * is "about to mint its pin from whatever provider answers here". That is FALSE for a store that
   * already holds vectors: backfillEmbedderPin infers the model from their DIMENSION — 384 maps to
   * LEGACY_ONNX_DEFAULT_MODEL_ID, 256 to hashing tok=1 — and that inference runs inside
   * ensureEmbedderPin, AFTER construction. Refusing here means it never runs, so a legacy store whose
   * own model is cached and perfectly loadable becomes unopenable because an unrelated current
   * default could not download.
   *
   * The fresh-store guard still applies where it was designed to: an EMPTY unpinned store has no
   * vectors to infer from, so whatever answers here really does become its permanent pin.
   *
   * THREE STATES, NOT TWO. readStoredVectorPresence returns `null` when the store could not be read
   * at all, and an earlier `!== false` test folded that into the legacy branch — so an unreadable
   * unpinned store took createLocalEmbedder(), which may silently return the lexical fallback, and
   * ensureEmbedderPin then pinned the store to it PERMANENTLY. That is the exact silent degradation
   * this function exists to prevent, reachable through the one state that proves nothing. Only a
   * confirmed `true` licenses the legacy path; unknown is treated like fresh, which does not refuse
   * a working semantic model, it refuses an implicit lexical one.
   */
  if (readStoredVectorPresence(dbPath) === true) return await createLocalEmbedder();

  return await requireSemanticOrExplicitLexical();
}

/**
 * The semantic embedder, or an EXPLICIT lexical opt-in. Never an implicit downgrade.
 *
 * `MONET_EMBEDDER=hashing` stays honoured — an operator who asks for lexical recall gets it. What
 * is refused is the SILENT path: the model fails to load, a console.error goes to a stderr no MCP
 * host displays, and the store serves lexical while its vectors are semantic.
 */
async function requireSemanticOrExplicitLexical(): Promise<EmbeddingProvider> {
  const selected = await createLocalEmbedderWithProvenance();
  if (selected.selection === "implicit-hashing-fallback") {
    throw new FreshStoreEmbedderUnavailableError();
  }
  return selected.provider;
}
