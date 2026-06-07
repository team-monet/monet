import path from "node:path";
import fs from "node:fs";

/**
 * Storage path resolution for the local runtime. The store itself is provided by
 * `@team-monet/core` (the state-centric substrate engine); this module only resolves where
 * the SQLite file lives.
 */
const MONET_DIR = ".monet";
const DB_FILE = "monet.db";

export function getMonetDir(): string {
  if (process.env.MONET_STORAGE_DIR) {
    return process.env.MONET_STORAGE_DIR;
  }
  const projectMonetDir = path.join(process.cwd(), MONET_DIR);
  if (fs.existsSync(projectMonetDir)) {
    return projectMonetDir;
  }
  const homeDir = process.env.HOME || process.env.USERPROFILE || process.cwd();
  return path.join(homeDir, MONET_DIR);
}

export function getDbPath(): string {
  return path.join(getMonetDir(), DB_FILE);
}

export function ensureMonetDir(): string {
  const dir = getMonetDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
