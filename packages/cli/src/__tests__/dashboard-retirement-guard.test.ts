/**
 * The dashboard's own retirement guard (#16).
 *
 * Every other surface refuses an unretired store through `new MonetCore(...)`. The dashboard never
 * constructs a core — it snapshots the SQLite file and queries it directly — so the refusal had to
 * be installed here separately, and this test goes through the real HTTP surface rather than the
 * helper, because the defect Codex found was precisely that the handlers did not call it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonetCore, RETIRED_SOURCE_TABLES } from "@team-monet/core";
import type { BetterSqlitePort } from "@team-monet/core";
import { startDashboard } from "../dashboard/server";

const PORT = 39_517;
let storageDir: string | undefined;
const priorStorageDir = process.env.MONET_STORAGE_DIR;

afterEach(() => {
  if (priorStorageDir === undefined) delete process.env.MONET_STORAGE_DIR;
  else process.env.MONET_STORAGE_DIR = priorStorageDir;
  if (storageDir) rmSync(storageDir, { recursive: true, force: true });
  storageDir = undefined;
});

function seedStore(unretired: boolean): void {
  storageDir = mkdtempSync(join(tmpdir(), "monet-dashboard-guard-"));
  process.env.MONET_STORAGE_DIR = storageDir;
  const core = new MonetCore(join(storageDir, "monet.db"), { tauAttach: 1.1, tauAmbiguous: 1.1 });
  const db = (core as unknown as { db: BetterSqlitePort }).db;
  if (unretired) {
    for (const table of RETIRED_SOURCE_TABLES) {
      db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, circle TEXT)`);
    }
    db.prepare(`INSERT INTO knowledge_sources (id, circle) VALUES ('src-a', 'default')`).run();
    db.pragma("user_version = 12");
  }
  core.close();
}

async function get(path: string): Promise<{ status: number; body: string }> {
  const response = await fetch(`http://127.0.0.1:${PORT}${path}`);
  return { status: response.status, body: await response.text() };
}

describe("dashboard — retirement guard", () => {
  it("refuses /api/graph and /api/entities on an unretired store, naming the remediation", async () => {
    seedStore(true);
    startDashboard(PORT);
    try {
      for (const path of ["/api/graph", "/api/entities"]) {
        const response = await get(path);
        expect(response.status, path).toBe(409);
        const payload = JSON.parse(response.body) as { code: string; error: string };
        expect(payload.code, path).toBe("source-retirement-required");
        expect(payload.error, path).toMatch(/monet retire-source .*--apply --yes/);
        // The population must not leak through the error path either.
        expect(response.body, path).not.toContain("knowledge_sources\": [");
      }
    } finally {
      await fetch(`http://127.0.0.1:${PORT}/api/graph`).catch(() => undefined);
    }
  });

  it("serves a retired store normally", async () => {
    seedStore(false);
    startDashboard(PORT + 1);
    const response = await fetch(`http://127.0.0.1:${PORT + 1}/api/graph`);
    expect(response.status).toBe(200);
    const payload = await response.json() as { counts: { concepts: number } };
    expect(payload.counts.concepts).toBe(0);
  });
});
