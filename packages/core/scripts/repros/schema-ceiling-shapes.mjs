/**
 * Shape table for the store-level schema ceiling (#158).
 *
 * For every on-disk shape a Monet store can be found in, this records what the pre-write decision
 * can see (`readStoredSchemaVersion`), what a bare readonly peek can see at both timeouts, and what
 * `new MonetCore(dbPath)` does — then whether the main file and its sidecars changed.
 *
 * It runs entirely in a fresh temp directory and never touches the real `~/.monet` store.
 *
 * Usage (node@22, from packages/core, after a build):
 *   node scripts/repros/schema-ceiling-shapes.mjs
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import * as core from "../../dist/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), "monet-shapes-"));
const ABOVE = Number(core.MONET_SCHEMA_VERSION) + 1;
const PEEK_TIMEOUT_MS = 5000;
const rows = [];

let seq = 0;
const freshDir = (label) => {
  const dir = join(ROOT, `${String(++seq).padStart(2, "0")}-${label}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const filesOf = (dir) => readdirSync(dir).sort().join(" ");
const hashOf = (p) => (existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 12) : "-");
const since = (t) => `${Date.now() - t}ms`;

/** A readonly open of the store, exactly as the ladder models it. */
function peek(dbPath, timeoutMs) {
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: timeoutMs });
    return `ok:${db.pragma("user_version", { simple: true })}`;
  } catch (e) {
    return `null(${String(e.message).slice(0, 24).replace(/\s+/g, " ")})`;
  } finally {
    try { db?.close(); } catch { /* the peek is best-effort by design */ }
  }
}

/** What the ladder decides before anything opens the store for writing. */
function ladder(dbPath) {
  if (typeof core.readStoredSchemaVersion !== "function") return "(not exported)";
  try {
    const v = core.readStoredSchemaVersion(dbPath);
    return v === null ? "null" : String(v);
  } catch (e) {
    return `threw:${String(e.message).slice(0, 24)}`;
  }
}

function engine(dbPath) {
  const t = Date.now();
  try {
    core.MonetCore ? new core.MonetCore(dbPath).close() : null;
    return { out: "OPENED", ms: since(t) };
  } catch (e) {
    const m = String(e.message);
    const kind = /newer than supported schema/.test(m) ? "REFUSED(ceiling)" : /busy|locked|contention/i.test(m) ? "REFUSED(contention)" : "THREW(other)";
    return { out: `${kind} in ${since(t)}`, ms: since(t) };
  }
}

function record(label, dbPath, dir, { note = "", cleanup } = {}) {
  const before = filesOf(dir);
  const hashBefore = hashOf(dbPath);
  const dec = ladder(dbPath);
  const p0 = peek(dbPath, 0);
  const pB = peek(dbPath, PEEK_TIMEOUT_MS);
  const opened = engine(dbPath);
  const after = filesOf(dir);
  const hashAfter = hashOf(dbPath);
  rows.push({
    shape: label,
    sidecars: before.replace(/monet\.db ?/g, "").trim() || "(none)",
    decision: dec,
    "peek t=0": p0,
    [`peek t=${PEEK_TIMEOUT_MS}`]: pB,
    engine: opened.out,
    "main file": hashBefore === hashAfter ? "unchanged" : `CHANGED ${hashBefore}->${hashAfter}`,
    "file list after": after.replace(/monet\.db ?/g, "").trim() || "(none)",
    note,
  });
  cleanup?.();
}

const buildStore = (dbPath, { journalMode = "DELETE", version = ABOVE, commit = true } = {}) => {
  const db = new Database(dbPath);
  db.pragma(`journal_mode = ${journalMode}`);
  db.exec("CREATE TABLE t (x)");
  db.pragma(`user_version = ${version}`);
  db.exec("INSERT INTO t VALUES (1)");
  if (commit) db.close();
  return db;
};

// 0. no file at all
{
  const dir = freshDir("missing");
  record("missing file", join(dir, "monet.db"), dir);
}

// 0b. an EXISTING store file that is zero bytes: the shape an interrupted create leaves behind
//     (`new Database()` creates the file and `journal_mode = WAL` follows it), and the shape the
//     engine itself OPENS and creates a schema in. The pre-engine decision has to agree with that
//     verdict — `0` (a fresh store), not `null` (unreadable). `null` here made the CLI refuse to
//     write the store's own circle map and pin the project's circle to a path slug (#158 review
//     round 2, P1).
{
  const dir = freshDir("empty-file");
  const p = join(dir, "monet.db");
  writeFileSync(p, "");
  record("zero-length main file (interrupted create)", p, dir, {
    note: "a fresh store, not an unreadable one: the decision must match the engine's OPENED verdict",
  });
}

// 1. cleanly closed store, no sidecars
{
  const dir = freshDir("file-only");
  const p = join(dir, "monet.db");
  buildStore(p);
  record("no sidecars (clean close)", p, dir);
}

// 2. live WAL writer: -wal + -shm present
{
  const src = freshDir("wal-src");
  const { p: srcPath, db } = (() => {
    const p = join(src, "monet.db");
    return { p, db: buildStore(p, { journalMode: "WAL", commit: false }) };
  })();
  const dir = freshDir("wal-live");
  const p = join(dir, "monet.db");
  for (const s of ["", "-wal", "-shm"]) readFileSync(srcPath + s) && writeFileSync(p + s, readFileSync(srcPath + s));
  db.close();
  record("clean -wal/-shm pair (live writer)", p, dir);
}

// 3. asymmetric: -wal without -shm
{
  const src = freshDir("walonly-src");
  const p0src = join(src, "monet.db");
  const db = buildStore(p0src, { journalMode: "WAL", commit: false });
  const dir = freshDir("wal-only");
  const p = join(dir, "monet.db");
  for (const s of ["", "-wal"]) writeFileSync(p + s, readFileSync(p0src + s));
  db.close();
  record("asymmetric: -wal without -shm", p, dir);
}

// 4. asymmetric: -shm without -wal
{
  const src = freshDir("shmonly-src");
  const p0src = join(src, "monet.db");
  const db = buildStore(p0src, { journalMode: "WAL", commit: false });
  const dir = freshDir("shm-only");
  const p = join(dir, "monet.db");
  for (const s of ["", "-shm"]) writeFileSync(p + s, readFileSync(p0src + s));
  db.close();
  record("asymmetric: -shm without -wal", p, dir);
}

// 5. leftover zero-length -journal (a `-journal` that is present but not hot)
{
  const dir = freshDir("journal-stale");
  const p = join(dir, "monet.db");
  buildStore(p);
  writeFileSync(`${p}-journal`, "");
  record("leftover -journal (not hot)", p, dir);
}

// 6. hot -journal: an interrupted transaction, copied out mid-flight
{
  const src = freshDir("journal-hot-src");
  const srcPath = join(src, "monet.db");
  const db = new Database(srcPath);
  db.pragma("journal_mode = DELETE");
  db.exec("CREATE TABLE t (x)");
  db.pragma(`user_version = ${ABOVE}`);
  db.exec("BEGIN IMMEDIATE");
  db.exec("INSERT INTO t VALUES (1)"); // uncommitted → a hot journal exists
  const dir = freshDir("journal-hot");
  const p = join(dir, "monet.db");
  for (const s of ["", "-journal"]) writeFileSync(p + s, readFileSync(srcPath + s));
  db.exec("ROLLBACK");
  db.close();
  record("hot -journal (interrupted txn, copied mid-flight)", p, dir, {
    note: "a journal-shaped sidecar is not a version source: the header is read, so the store is refused before the journal is recovered",
  });
}

// 7. -journal present AND the write lock held by a peer in this process
{
  const dir = freshDir("journal-locked");
  const p = join(dir, "monet.db");
  const holder = new Database(p);
  holder.pragma("journal_mode = DELETE");
  holder.exec("CREATE TABLE t (x)");
  holder.pragma(`user_version = ${ABOVE}`);
  holder.exec("BEGIN IMMEDIATE");
  holder.exec("INSERT INTO t VALUES (1)"); // the peer keeps the write lock + a hot journal
  record("-journal + write lock held by a peer", p, dir, {
    cleanup: () => { try { holder.exec("ROLLBACK"); } catch { /* already gone */ } holder.close(); },
  });
}

// 8. malformed main file (control: nothing here can be trusted)
{
  const dir = freshDir("malformed");
  const p = join(dir, "monet.db");
  writeFileSync(p, Buffer.alloc(4096, 0x7a));
  record("malformed main file (control)", p, dir);
}

// 9-11. candidate shapes that force an inconclusive preflight (peek cannot read the version)
//       while the store itself is still openable — the live re-check's own territory.
{
  const dir = freshDir("wal-empty");
  const p = join(dir, "monet.db");
  buildStore(p);
  writeFileSync(`${p}-wal`, "");
  record("zero-length -wal, no -shm", p, dir, { note: "can the preflight read this?" });
}
{
  const dir = freshDir("wal-empty-pair");
  const p = join(dir, "monet.db");
  buildStore(p);
  writeFileSync(`${p}-wal`, "");
  writeFileSync(`${p}-shm`, Buffer.alloc(32768, 0));
  record("zero-length -wal + -shm", p, dir, { note: "can the preflight read this?" });
}
{
  const dir = freshDir("wal-garbage");
  const p = join(dir, "monet.db");
  buildStore(p);
  writeFileSync(`${p}-wal`, Buffer.alloc(4096, 0x7a));
  writeFileSync(`${p}-shm`, Buffer.alloc(32768, 0));
  record("garbage -wal + -shm", p, dir, { note: "can the preflight read this?" });
}

const cols = ["shape", "sidecars", "decision", "peek t=0", `peek t=${PEEK_TIMEOUT_MS}`, "engine", "main file", "file list after", "note"];
const width = (c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length));
const widths = cols.map(width);
const line = (cells) => `| ${cells.map((c, i) => String(c).padEnd(widths[i])).join(" | ")} |`;

console.log(`core=packages/core  node=${process.version}  better-sqlite3=${JSON.parse(readFileSync(join(HERE, "..", "..", "node_modules", "better-sqlite3", "package.json"), "utf8")).version}`);
console.log(`MONET_SCHEMA_VERSION=${core.MONET_SCHEMA_VERSION}  fixture user_version=${ABOVE}  temp=${ROOT}`);
console.log("");
console.log(line(cols));
console.log(`| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`);
for (const r of rows) console.log(line(cols.map((c) => r[c])));

const strayFiles = readdirSync(ROOT).length;
console.log("");
console.log(`fixture dirs: ${strayFiles} (all under ${ROOT})`);

if (process.argv.includes("--clean")) {
  rmSync(ROOT, { recursive: true, force: true });
  console.log("cleaned fixture dirs");
} else {
  void execFileSync; // keep the import list honest for the crash-recovery variant below
}
