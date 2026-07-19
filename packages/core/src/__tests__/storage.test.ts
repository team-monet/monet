/**
 * storage.ts — readStoredEmbedderPin unit tests (Codex review, PR #51 round 7, FIX U).
 *
 * A lightweight, read-only peek at a store's persisted pin WITHOUT constructing a MonetCore — no
 * schema creation, no migration, no sync-identity write. Tolerant by design: every "nothing to
 * read yet" shape (missing file, missing table, missing row, missing columns) collapses to null,
 * never a thrown error.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { readStoredEmbedderPin } from "../storage";
import { MonetCore } from "../engine";
import { HashingEmbeddingProvider } from "../embedding";

describe("readStoredEmbedderPin (Codex review, PR #51 round 7, FIX U)", () => {
  let dir: string;
  let dbPath: string;

  function freshDir(prefix: string): string {
    return mkdtempSync(join(tmpdir(), prefix));
  }

  it("pin present: returns the exact persisted modelId string", () => {
    dir = freshDir("monet-read-pin-present-");
    dbPath = join(dir, "monet.db");
    try {
      const core = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider(256, 1) }); // pins itself 'created'
      core.close();
      expect(readStoredEmbedderPin(dbPath)).toBe("hashing:dim=256:tok=1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pin absent (NULL row): returns null, not the string 'null' or an empty string", () => {
    dir = freshDir("monet-read-pin-absent-");
    dbPath = join(dir, "monet.db");
    try {
      const core = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider() });
      (core as any).db.prepare(`UPDATE sync_meta SET embedder_model_id = NULL, embedder_pin_source = NULL, embedder_pinned_at = NULL WHERE singleton = 1`).run();
      core.close();
      expect(readStoredEmbedderPin(dbPath)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("missing sync_meta table entirely (a raw sqlite file that predates the ADR, or isn't a monet-core store at all): returns null, not a thrown error", () => {
    dir = freshDir("monet-read-pin-no-table-");
    dbPath = join(dir, "monet.db");
    try {
      const raw = new Database(dbPath);
      raw.exec(`CREATE TABLE some_other_table (id INTEGER PRIMARY KEY)`); // a real sqlite file, just not a monet-core one
      raw.close();
      expect(readStoredEmbedderPin(dbPath)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sync_meta table exists but the singleton row does not (fabricated old-shape store, same FIX T shape): returns null, not a thrown error", () => {
    dir = freshDir("monet-read-pin-no-row-");
    dbPath = join(dir, "monet.db");
    try {
      const raw = new Database(dbPath);
      raw.exec(`
        CREATE TABLE sync_meta (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          device_id TEXT NOT NULL,
          last_mutation_at INTEGER NOT NULL,
          embedder_model_id TEXT,
          embedder_pin_source TEXT,
          embedder_pinned_at INTEGER
        );
      `);
      raw.close();
      expect(readStoredEmbedderPin(dbPath)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sync_meta table exists with a row, but the pin columns themselves don't exist (pre-embedder-pin-ADR schema): returns null, not a thrown error", () => {
    dir = freshDir("monet-read-pin-no-columns-");
    dbPath = join(dir, "monet.db");
    try {
      const raw = new Database(dbPath);
      raw.exec(`
        CREATE TABLE sync_meta (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          device_id TEXT NOT NULL,
          last_mutation_at INTEGER NOT NULL
        );
      `);
      raw.prepare(`INSERT INTO sync_meta (singleton, device_id, last_mutation_at) VALUES (1, 'dev', 0)`).run();
      raw.close();
      expect(readStoredEmbedderPin(dbPath)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("nonexistent file path (no store has ever been created here — the genuinely first-ever run): returns null, not a thrown error", () => {
    dir = freshDir("monet-read-pin-nonexistent-");
    try {
      const neverCreated = join(dir, "does-not-exist.db");
      expect(readStoredEmbedderPin(neverCreated)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
