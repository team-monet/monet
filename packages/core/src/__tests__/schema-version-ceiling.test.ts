import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonetCore } from "../engine";
import { MONET_SCHEMA_VERSION } from "../schema-version";
import { BetterSqlitePort } from "../storage";

const unsupportedSchemaVersion = MONET_SCHEMA_VERSION + 1;

function refusal(version = unsupportedSchemaVersion): string {
  return `Store schema ${version} is newer than supported schema ${MONET_SCHEMA_VERSION}; ` +
    `refusing to open. Upgrade Monet first.`;
}

function withStore(run: (dbPath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "monet-schema-ceiling-"));
  try {
    run(join(dir, "monet.db"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function stampUserVersion(dbPath: string, version: number): void {
  const db = new Database(dbPath);
  try {
    db.pragma(`user_version = ${version}`);
  } finally {
    db.close();
  }
}

function readState(dbPath: string): { tables: string[]; userVersion: number } {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return {
      tables: (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as Array<{ name: string }>)
        .map((row) => row.name),
      userVersion: db.pragma("user_version", { simple: true }) as number,
    };
  } finally {
    db.close();
  }
}

function captureOpenError(db: string | BetterSqlitePort): Error {
  try {
    const core = new MonetCore(db);
    core.close();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`MonetCore threw a non-Error value: ${String(error)}`);
  }
  throw new Error("MonetCore unexpectedly opened an unsupported schema");
}

describe("MonetCore schema-version ceiling", () => {
  it("refuses an empty file store stamped above this build's schema version", () => {
    withStore((dbPath) => {
      stampUserVersion(dbPath, unsupportedSchemaVersion);

      expect(captureOpenError(dbPath).message).toBe(refusal());
    });
  });

  it("leaves a refused empty store without schema writes or a version change", () => {
    withStore((dbPath) => {
      stampUserVersion(dbPath, unsupportedSchemaVersion);
      const bytesBefore = readFileSync(dbPath);

      expect(captureOpenError(dbPath).message).toBe(refusal());
      expect(readFileSync(dbPath).equals(bytesBefore)).toBe(true);
      expect(readState(dbPath)).toEqual({
        tables: [],
        userVersion: unsupportedSchemaVersion,
      });
    });
  });

  it("refuses a migrated store that is later stamped above this build's schema version", () => {
    withStore((dbPath) => {
      const seeded = new MonetCore(dbPath);
      seeded.close();
      stampUserVersion(dbPath, unsupportedSchemaVersion);

      expect(captureOpenError(dbPath).message).toBe(refusal());
    });
  });

  it("opens a store stamped exactly at this build's schema version without changing the version", () => {
    withStore((dbPath) => {
      stampUserVersion(dbPath, MONET_SCHEMA_VERSION);

      const core = new MonetCore(dbPath);
      core.close();

      expect(readState(dbPath).userVersion).toBe(MONET_SCHEMA_VERSION);
    });
  });

  it("opens a fresh store and migrates user_version 0 to this build's schema version", () => {
    withStore((dbPath) => {
      stampUserVersion(dbPath, 0);

      const core = new MonetCore(dbPath);
      core.close();

      expect(readState(dbPath).userVersion).toBe(MONET_SCHEMA_VERSION);
    });
  });

  it("does not mask the schema ceiling as startup contention", () => {
    withStore((dbPath) => {
      stampUserVersion(dbPath, unsupportedSchemaVersion);

      const error = captureOpenError(dbPath);
      expect(error.message).toContain(refusal());
      expect(error.message).not.toMatch(/locked|SQLITE_BUSY|busy/i);
    });
  });

  it("applies the same refusal when MonetCore is constructed with a StoragePort", () => {
    withStore((dbPath) => {
      stampUserVersion(dbPath, unsupportedSchemaVersion);
      const port = new BetterSqlitePort(dbPath);
      try {
        expect(captureOpenError(port).message).toBe(refusal());
      } finally {
        port.close();
      }
    });
  });
});
