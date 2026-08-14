import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonetCore } from "../engine";
import type { StoragePort } from "../storage";

const raw = (core: MonetCore): StoragePort =>
  (core as unknown as { db: StoragePort }).db;

function seedSchema11Pins(
  core: MonetCore,
  pins: Array<{ conceptId: string; summary: string; deletedAt?: number; id?: string }>,
): void {
  const db = raw(core);
  for (const [index, pin] of pins.entries()) {
    const concept = db.prepare(
      `SELECT circle FROM concepts WHERE id = ?`,
    ).get(pin.conceptId) as { circle: string };
    db.prepare(
      `INSERT INTO first_block
         (id, concept_id, circle, summary, summary_dirty, position, promoted_at, promoted_by,
          updated_at, sync_revision, sync_writer, deleted_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, NULL, ?, 1, 'schema-11-fixture', ?)`,
    ).run(pin.id ?? `legacy-pin-${index}`, pin.conceptId, concept.circle, pin.summary, index, 1_700_000_000_000 + index,
      1_700_000_000_000 + index, pin.deletedAt ?? null);
  }
  db.pragma("user_version = 11");
}

describe("schema 11 → 12 First Block retirement migration", () => {
  it("converts every pin row to an observation on the same concept with exact summary text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-first-block-retirement-"));
    const path = join(dir, "monet.db");
    try {
      const staged = new MonetCore(path, { tauAttach: 1.1, tauAmbiguous: 1.1 });
      const first = await staged.store("Migration target alpha.", { circle: "alpha", resolution: "forceNew" });
      const second = await staged.store("Migration target beta.", { circle: "beta", resolution: "forceNew" });
      const summaries = [
        { conceptId: first.conceptId, summary: "Keep leading and trailing spaces exactly:  alpha  " },
        { conceptId: second.conceptId, summary: "Line one\nLine two: punctuation — unchanged.", deletedAt: 1_700_000_000_100 },
      ];
      seedSchema11Pins(staged, summaries);
      staged.close();

      const migrated = new MonetCore(path);
      const db = raw(migrated);
      expect(db.pragma("user_version", { simple: true })).toBe(12);
      expect(db.prepare(`SELECT COUNT(*) AS count FROM first_block`).get()).toEqual({ count: 0 });
      for (const pin of summaries) {
        const rows = db.prepare(
          `SELECT concept_id, content FROM observations
            WHERE concept_id = ? AND author_agent_id = 'schema-12-first-block-migration'`,
        ).all(pin.conceptId) as Array<{ concept_id: string; content: string }>;
        expect(rows).toEqual([{
          concept_id: pin.conceptId,
          content: `First Block pin (surface retired 2026-08-02): ${pin.summary}`,
        }]);
        expect(db.prepare(`SELECT support_count, dirty FROM concepts WHERE id = ?`).get(pin.conceptId))
          .toEqual({ support_count: 2, dirty: 1 });
      }
      migrated.close();

      const reopened = new MonetCore(path);
      const reopenedDb = raw(reopened);
      expect(reopenedDb.pragma("user_version", { simple: true })).toBe(12);
      expect((reopenedDb.prepare(
        `SELECT COUNT(*) AS count FROM observations
          WHERE author_agent_id = 'schema-12-first-block-migration'`,
      ).get() as { count: number }).count).toBe(2);
      expect(reopenedDb.prepare(`SELECT COUNT(*) AS count FROM first_block`).get()).toEqual({ count: 0 });
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dedupes a locally migrated twin with graft conversion and preserves divergent edits as two observations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-first-block-convergence-"));
    const sourcePath = join(dir, "source.db");
    try {
      const staged = new MonetCore(sourcePath, { tauAttach: 1.1, tauAmbiguous: 1.1 });
      const stored = await staged.store("First Block convergence target.", { resolution: "forceNew" });
      const summary = "Replica summary.";
      seedSchema11Pins(staged, [{ conceptId: stored.conceptId, summary }]);
      staged.close();
      const pinId = `fb:${createHash("sha256").update(`${stored.conceptId}\0default`).digest("hex").slice(0, 32)}`;

      const locallyMigrated = new MonetCore(sourcePath);
      const localPayload = locallyMigrated.exportDelta(0);
      localPayload.schemaVersion = 13;
      localPayload.firstBlock = [{
        id: pinId,
        concept_id: stored.conceptId,
        circle: "default",
        summary,
        summary_dirty: 0,
        position: 0,
        promoted_at: 1_700_000_000_000,
        promoted_by: null,
        updated_at: 1_700_000_000_000,
        sync_revision: 1,
        sync_writer: "legacy-twin",
        deleted_at: null,
      }];

      const twinReceiver = new MonetCore(":memory:");
      expect(twinReceiver.graftRows(localPayload).converted.first_block).toBe(0);
      expect((raw(twinReceiver).prepare(
        `SELECT COUNT(*) AS count FROM observations WHERE author_agent_id = 'schema-12-first-block-migration'`,
      ).get() as { count: number }).count).toBe(1);
      twinReceiver.close();

      const divergentPayload = structuredClone(localPayload);
      divergentPayload.firstBlock![0]!.summary = "Divergent replica summary.";
      divergentPayload.firstBlock![0]!.updated_at = 1_700_000_000_001;
      divergentPayload.firstBlock![0]!.sync_revision = 2;
      divergentPayload.firstBlock![0]!.sync_writer = "legacy-divergent";
      const divergentReceiver = new MonetCore(":memory:");
      expect(divergentReceiver.graftRows(divergentPayload).converted.first_block).toBe(1);
      expect(raw(divergentReceiver).prepare(
        `SELECT content FROM observations WHERE author_agent_id = 'schema-12-first-block-migration' ORDER BY content`,
      ).all()).toEqual([
        { content: "First Block pin (surface retired 2026-08-02): Divergent replica summary." },
        { content: "First Block pin (surface retired 2026-08-02): Replica summary." },
      ]);
      divergentReceiver.close();
      locallyMigrated.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no-ops for a zero-pin schema-11 store and remains idempotent on reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-first-block-empty-retirement-"));
    const path = join(dir, "monet.db");
    try {
      const staged = new MonetCore(path);
      const stagedDb = raw(staged);
      stagedDb.pragma("user_version = 11");
      staged.close();

      for (let open = 0; open < 2; open += 1) {
        const core = new MonetCore(path);
        const db = raw(core);
        expect(db.pragma("user_version", { simple: true })).toBe(12);
        expect(db.prepare(`SELECT COUNT(*) AS count FROM first_block`).get()).toEqual({ count: 0 });
        expect(db.prepare(
          `SELECT COUNT(*) AS count FROM observations
            WHERE author_agent_id = 'schema-12-first-block-migration'`,
        ).get()).toEqual({ count: 0 });
        core.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
