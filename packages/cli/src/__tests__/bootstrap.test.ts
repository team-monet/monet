import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  FreshStoreEmbedderUnavailableError,
  type EmbeddingProvider,
} from "@team-monet/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openServedCore, openSourceCore, openStatusCore } from "../bootstrap";

interface EmbedderPinRow {
  embedder_model_id: string | null;
}

function readEmbedderPin(dbPath: string): string | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare("SELECT embedder_model_id FROM sync_meta WHERE singleton = 1")
      .get() as EmbedderPinRow;
    return row.embedder_model_id;
  } finally {
    db.close();
  }
}

describe("client core bootstrap", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "monet-client-bootstrap-"));
    dbPath = join(dir, "monet.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function throwingEmbedder(): EmbeddingProvider & { embed: ReturnType<typeof vi.fn> } {
    return {
      dim: 8,
      modelId: "test/inspection-embedder",
      embed: vi.fn(() => {
        throw new Error("inspection path invoked the embedder");
      }),
    };
  }

  it("status-style inspection leaves a fresh store unpinned and does not embed", () => {
    const embedder = throwingEmbedder();
    const core = openStatusCore(dbPath, embedder);

    expect(core.stats()).toMatchObject({ concepts: 0, observations: 0 });
    expect(embedder.embed).not.toHaveBeenCalled();
    core.close();

    expect(readEmbedderPin(dbPath)).toBeNull();
  });

  it("source openCore-style inspection leaves a fresh store unpinned and does not embed", () => {
    const embedder = throwingEmbedder();
    const core = openSourceCore(dbPath, join(dir, "sources"), embedder);

    expect(core.listSources()).toEqual([]);
    expect(embedder.embed).not.toHaveBeenCalled();
    core.close();

    expect(readEmbedderPin(dbPath)).toBeNull();
  });

  it("served bootstrap surfaces the typed fresh-store fallback error", async () => {
    const error = new FreshStoreEmbedderUnavailableError();
    const selectEmbedder = vi.fn(async () => {
      throw error;
    });

    await expect(
      openServedCore(
        dbPath,
        { scopeContext: dir, defaultCircle: "test-circle" },
        selectEmbedder,
      ),
    ).rejects.toBe(error);
    expect(selectEmbedder).toHaveBeenCalledWith(dbPath);
  });
});
