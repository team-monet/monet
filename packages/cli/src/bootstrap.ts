import {
  MonetCore,
  chooseStoreEmbedder,
  type EmbeddingProvider,
} from "@team-monet/core";

export interface ServedCoreOptions {
  scopeContext: string;
  defaultCircle: string;
  /**
   * Where to materialize the gate mirror (4b-D, component B). OPTIONAL, deliberately — matching
   * `MonetCoreOptions.gateSidecarPath`'s own "NO DEFAULT" stance (engine.ts: unset means
   * declarations write no file at all): a caller that omits this gets exactly today's behavior
   * (no mirror maintenance), which is the correct default for anything that ISN'T the one
   * long-running serving process this option exists for.
   *
   * ONE WRITER SURFACE. This is the FIRST call site in this client that ever passes
   * `gateSidecarPath` — before this, NOTHING materialized the mirror automatically (checked: no
   * caller anywhere in this codebase passed the option; the live `~/.monet/gate-mirror.json` file
   * that predates this change existed only because a script ran it by hand once). Callers of
   * THIS function are cli.ts's `start` action and src/index.ts's stdio entry point — both are the
   * same long-running MCP server, just two launch paths — never a short-lived command
   * (status/doctor/source/gate all construct their OWN core through a DIFFERENT open* function in
   * this same file, none of which gained this option). The core already owns WHEN to
   * rematerialize (the generation-bump contract inside declare()/refreshGateSidecar — see
   * engine.ts); this option only supplies WHERE, and only for the process actually positioned to
   * keep that file honest on every gate-relevant write.
   */
  gateSidecarPath?: string;
  /**
   * Where the governed-moment spool is appended — the append-only record every writer can reach,
   * including the standalone hook wrapper, which can open no store.
   *
   * OPTIONAL for the same reason `gateSidecarPath` above is, and on the same terms:
   * `MonetCoreOptions.momentSpoolPath` has NO DEFAULT in engine.ts, deliberately, so that no core
   * built by a test or a one-off script appends into a real store. A caller that omits it gets a
   * no-op; the two callers of THIS function pass it UNCONDITIONALLY.
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
