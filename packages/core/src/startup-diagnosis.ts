import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

/**
 * The startup failure record — so a server that died before it had a protocol channel can still
 * say why.
 *
 * WHY THIS EXISTS (#13). Everything that can fail during startup runs BEFORE the transport
 * connects: the embedder is selected and the model loaded, the store is opened and migrated, the
 * pin is enforced — and only then does `server.connect()` create the first moment anything can be
 * said in MCP terms. A throw anywhere above that leaves the host looking at a pipe that closed, so
 * a busy store, a poisoned model cache, an unreadable database path and a broken native binary all
 * arrive at the user as one string: `-32000: Connection closed`.
 *
 * The cause is not missing — every entry point writes it to stderr with a non-zero exit. What is
 * missing is a place the user can READ it. stdout is the protocol channel and must stay clean, and
 * stderr is at the host's discretion: Claude Code, for instance, keeps it in a per-project cache
 * under `~/Library/Caches/claude-cli-nodejs/.../mcp-logs-<server>/` that nothing in its own error
 * message names, and another host may discard it outright. A diagnosis whose location depends on
 * which host spawned you is not findable.
 *
 * SO THE RECORD GOES BESIDE THE STORE, at `<store dir>/startup-failure.json` — the same directory
 * as `monet.db`, `gate-mirror.json` and the moment spool, resolved by the same rung the failing
 * process was already using. It is the one location every reader (a human, `monet doctor`, the
 * agent the user asks) can find from the store path alone.
 *
 * ONE RECORD, THE MOST RECENT, NEVER APPENDED. A startup failure is not an event stream: the
 * question it answers is "why did the last attempt die", and one timestamped record answers it
 * without a rotation policy, an unbounded file, or a reader wondering whether line 40 is stale.
 *
 * AND IT IS NEVER CLEARED ON A LATER SUCCESS. A host that retries automatically (Claude Code
 * retries a failed stdio connection) routinely goes fail → fail → succeed, so deleting the record
 * once something finally starts would destroy exactly the evidence the user came back for. The
 * record is timestamped and carries its pid; the reader decides whether it is still relevant. This
 * also keeps two servers racing on one store from erasing each other's diagnosis.
 *
 * RECORDING MUST NEVER MASK THE FAILURE IT RECORDS. Every write is best-effort inside a try/catch
 * and returns null on failure — the original error is what propagates, and an instrument that can
 * replace the fault it observes is worse than no instrument (the same stance statement-trace.ts
 * takes for its markers and moment-spool.ts for its appends).
 */

/**
 * The record is a SIDECAR OF ONE DATABASE, named after it — `monet.db.startup-failure.json` beside
 * `monet.db` — not one shared file per directory (Codex round 1, PR #79).
 *
 * WHY, and this was a live defect rather than a hypothetical: one `.monet` directory routinely holds
 * TWO databases. The shipped CLI serves `monet.db`; `packages/core/scripts/mcp-cli.ts` serves
 * `monet-core.db` out of the SAME directory, resolved by the same `MONET_STORAGE_DIR` rung. A
 * per-directory filename gave them one record between them, so the dev server's failure overwrote
 * the shipped server's — and `monet doctor`, which reads by directory, then reported a perfectly
 * healthy `monet.db` as having failed to start with the OTHER file's error. A diagnostic that
 * confidently attributes one store's fault to another is worse than one that says nothing.
 *
 * KEYING THE PATH ON THE STORE, rather than checking a `store` field on read, is what fixes BOTH
 * halves. A mismatch check would keep the readers honest but leave the two writers still sharing one
 * file — the older record simply destroyed instead of misread — and it would need a fourth read
 * state ("a record, but for something else") that no writer can produce once the paths differ.
 * Distinct paths make the collision unrepresentable, and leave the read a plain lookup.
 *
 * The `.db`-suffixed shape follows SQLite's own sidecar convention beside the store (`-wal`, `-shm`)
 * so the file sorts next to the database it describes.
 */
export const STARTUP_FAILURE_SUFFIX = ".startup-failure.json";

/** Bumped only when a reader would misread an older record; readers reject what they don't know. */
export const STARTUP_FAILURE_FORMAT = 1;

/**
 * Which startup step died.
 *
 * The message alone does not locate the fault: `database is locked` reads identically whether it
 * came from the pre-construction pin peek, the store open, or a tool call, and each has a different
 * answer. The phase is what makes the cause specific.
 *
 * `unknown` IS A VALUE, not a gap to be filled with the likeliest guess. Only the boundaries that
 * actually tag their throws produce a named phase; anything else is recorded as unknown, because a
 * record that guesses is a record that can be wrong without saying so.
 */
export type StartupPhase =
  /** Choosing/loading the embedder for the store's pin — model load, first-run download. */
  | "embedder-selection"
  /** `new MonetCore(...)`: the SQLite open, `journal_mode = WAL`, init and migrations. */
  | "store-open"
  /** `core.ensureEmbedderPin()` inside the server factory — the store is already open here. */
  | "embedder-pin"
  /** `server.connect(transport)` — the protocol channel was never established. */
  | "transport-connect"
  /** After the transport connected: the host HAD a live channel and the process died anyway. */
  | "post-connect"
  /** No boundary claimed this throw. Never inferred — see this type's doc comment. */
  | "unknown";

const STARTUP_PHASES: readonly StartupPhase[] = [
  "embedder-selection",
  "store-open",
  "embedder-pin",
  "transport-connect",
  "post-connect",
  "unknown",
];

/**
 * Symbol-keyed and non-enumerable, deliberately: the phase rides on the ORIGINAL error object so
 * every `instanceof` check downstream (FreshStoreEmbedderUnavailableError, StoreBusyError, ...)
 * keeps working, and it stays out of `JSON.stringify`, `Object.keys` and any existing error
 * serialization that never asked for it.
 */
const STARTUP_PHASE_KEY = Symbol.for("monet.startupPhase");

/**
 * Tag `error` with the startup step it escaped from, and return it unchanged otherwise.
 *
 * INNERMOST WINS. An outer boundary re-marking an inner one's throw would replace the specific
 * answer with the general one — `store-open` is more useful than the whole-startup phase that
 * contains it — so an already-tagged error is left alone.
 *
 * A non-object throw (a string, a number) cannot carry a property; it is returned untouched and
 * lands as `unknown`, which is the honest phase for it.
 */
export function markStartupPhase<E>(error: E, phase: StartupPhase): E {
  if (typeof error !== "object" || error === null) return error;
  if (STARTUP_PHASE_KEY in error) return error;
  try {
    Object.defineProperty(error, STARTUP_PHASE_KEY, { value: phase, enumerable: false, configurable: true });
  } catch {
    // A frozen or sealed error cannot be tagged. That costs a phase — it lands as `unknown`, which
    // is the honest answer — and it must not cost the error itself: this runs inside the catch that
    // is on its way to rethrowing, so a throw here would REPLACE the startup fault with a
    // TypeError about a property nobody asked for.
  }
  return error;
}

/** The phase `error` was tagged with, or null when no boundary claimed it. */
export function startupPhaseOf(error: unknown): StartupPhase | null {
  if (typeof error !== "object" || error === null) return null;
  const phase = (error as Record<symbol, unknown>)[STARTUP_PHASE_KEY];
  return typeof phase === "string" && (STARTUP_PHASES as readonly string[]).includes(phase)
    ? (phase as StartupPhase)
    : null;
}

/**
 * Run one startup step with its phase attached to anything it throws.
 *
 * Accepts a sync or async `run` so the two shapes a startup step actually has — `await
 * selectEmbedder(dbPath)` and the synchronous `new MonetCore(...)` — go through one boundary
 * rather than each call site writing its own try/catch.
 */
export async function inStartupPhase<T>(phase: StartupPhase, run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw markStartupPhase(error, phase);
  }
}

export interface StartupFailureRecord {
  /** STARTUP_FAILURE_FORMAT at write time. */
  v: number;
  /** ISO 8601, so a reader can tell a diagnosis of this attempt from one left three weeks ago. */
  at: string;
  /** Which process wrote it — the store is shared, and two servers can fail against it at once. */
  pid: number;
  phase: StartupPhase;
  /** The store this process was trying to serve, resolved. */
  store: string;
  error: {
    name: string;
    message: string;
    /** SQLite and Node errno codes (SQLITE_BUSY, ENOENT, ...); absent when the error carries none. */
    code?: string;
  };
  /** Truncated at STACK_MAX_CHARS; null when the throw carried no stack. */
  stack: string | null;
}

/**
 * What a reader found. Three states, not two: "no record" and "a record I could not read" are
 * different facts, and reporting the second as the first is how a diagnostic starts lying about
 * itself.
 */
export type StartupFailureRead =
  | { status: "none" }
  | { status: "unreadable"; reason: string }
  | { status: "found"; record: StartupFailureRecord };

/** Enough to identify the fault; not so much that the file becomes the log it deliberately isn't. */
const STACK_MAX_CHARS = 4000;
const MESSAGE_MAX_CHARS = 4000;

/**
 * Where the record for THIS store lives. Takes the store path, never a directory: one directory can
 * hold several databases, and the writer and the reader must not be able to disagree about which
 * one a record describes (see STARTUP_FAILURE_SUFFIX).
 */
export function startupFailurePath(storePath: string): string {
  const resolved = resolve(storePath);
  return join(dirname(resolved), `${basename(resolved)}${STARTUP_FAILURE_SUFFIX}`);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}… [truncated]`;
}

function describe(error: unknown): StartupFailureRecord["error"] & { stack: string | null } {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      name: error.name,
      message: truncate(error.message, MESSAGE_MAX_CHARS),
      ...(typeof code === "string" ? { code } : {}),
      stack: typeof error.stack === "string" ? truncate(error.stack, STACK_MAX_CHARS) : null,
    };
  }
  return { name: typeof error, message: truncate(String(error), MESSAGE_MAX_CHARS), stack: null };
}

export interface RecordStartupFailureOptions {
  /**
   * The store this startup was serving. It decides BOTH where the record goes and what the record
   * says it is about — one input, so the two can never disagree (see STARTUP_FAILURE_SUFFIX).
   */
  store: string;
  error: unknown;
  /**
   * Used only when the error carries no phase tag. Entry points pass "post-connect" once the
   * server factory has returned, because from that point the transport IS live and a death there
   * is a materially different fact from one before it. Defaults to "unknown" — never guessed.
   */
  fallbackPhase?: StartupPhase;
  /** Injectable clock, for tests that need two records with a known ordering between them. */
  now?: () => Date;
}

/**
 * Write one full record's worth of bytes, or throw.
 *
 * `fs.writeSync` DOES NOT LOOP (Codex round 1, PR #79 — measured: asked for 1 MiB against a bounded
 * pipe, it returned 8192). It issues one `write(2)` and hands back whatever the kernel took, so a
 * caller that ignores the count publishes whatever fraction happened to land. On a regular file the
 * realistic short write is a filling disk — which is also a perfectly good reason for the startup
 * that is being recorded to have failed, so this is not a case the record can afford to fumble.
 *
 * Throwing on a stalled write (0 bytes taken with bytes still owing) rather than spinning: the outer
 * catch turns that into `null`, which leaves the PREVIOUS record intact and tells the caller
 * plainly that nothing was written. A truncated record renamed into place would destroy a good one
 * and report success.
 */
function writeFully(fd: number, payload: Buffer): void {
  let written = 0;
  while (written < payload.length) {
    const n = writeSync(fd, payload, written, payload.length - written);
    if (n <= 0) throw new Error(`startup record write stalled after ${written}/${payload.length} bytes`);
    written += n;
  }
}

/**
 * Write the most recent startup failure beside the store. Returns the path holding the diagnosis,
 * or null if nothing could be written.
 *
 * TEMP + RENAME, matching gates.ts's sidecar and install-cli.ts's atomic write: a reader that
 * arrives mid-write must see the previous record or the new one, never half of either. `wx` on the
 * temp file so two servers failing at the same instant cannot land in one buffer.
 *
 * TOTAL, NEVER THROWING — see this module's header. EVERYTHING is inside the try, including reading
 * the error's own fields: `describe` touches `.name`, `.message`, `.code` and `.stack`, any of which
 * can be an accessor, and `String(x)` throws outright for a null-prototype object. Those reads sat
 * outside the try until Codex round 1 on PR #79 showed both escaping — which meant this function
 * could replace the startup fault it was called to record with a TypeError about a property nobody
 * asked for, in the one code path whose whole purpose is to not lose the original error.
 */
export function recordStartupFailure(options: RecordStartupFailureOptions): string | null {
  let tmp: string | null = null;
  try {
    const path = startupFailurePath(options.store);
    const { stack, ...error } = describe(options.error);
    const record: StartupFailureRecord = {
      v: STARTUP_FAILURE_FORMAT,
      at: (options.now?.() ?? new Date()).toISOString(),
      pid: process.pid,
      phase: startupPhaseOf(options.error) ?? options.fallbackPhase ?? "unknown",
      store: resolve(options.store),
      error,
      stack,
    };
    tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeFully(fd, Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8"));
    } finally {
      closeSync(fd);
    }
    // DO NOT PUBLISH OVER SOMETHING NEWER (Codex round 1, PR #79). `renameSync` replaces whatever is
    // at the destination, so two servers failing against one shared store — the ordinary shape when
    // the store is contended, since contention means a second process — can publish out of order:
    // the slower writer's OLDER record lands last and buries the newer one, in exactly the
    // host-retry scenario the record exists to explain.
    //
    // ONLY A RECORD THAT IS BOTH READABLE AND STRICTLY NEWER BLOCKS. An absent or unparseable
    // destination is not evidence of a newer diagnosis, and treating it as one would let a single
    // corrupt file wedge the mechanism permanently.
    //
    // WHAT THIS DOES NOT CLOSE, stated rather than implied: check-then-rename is not atomic, so a
    // record published in the microseconds between the two still loses. That window is bounded by
    // two syscalls instead of by the whole open/write/close, and closing it properly needs either a
    // lock or per-writer files with a reader that merges them — machinery out of proportion to a
    // race between two diagnoses of the same moment.
    //
    // NO RECORD CONTENT MAY PERMANENTLY BLOCK A FUTURE RECORD, and validation alone does not buy
    // that (Codex round 2, PR #79). A canonical, perfectly well-formed `9999-12-31T23:59:59.999Z`
    // passes every field check and then wins every comparison for the next eight thousand years —
    // one bad file and the store can never record another startup failure, while the pointer line
    // keeps directing readers to it. So the deferral is bounded at BOTH ends: the existing record
    // must be newer than ours AND not dated in the future. Those two together make the window
    // exactly "someone else published while I was writing", which is the only case this guard was
    // ever for — anything outside it gets replaced.
    //
    // The bound reads the REAL clock deliberately, not `options.now`: the seam exists to make two
    // records' ORDER deterministic in a test, and letting it also move "now" would let a test (or a
    // caller) re-open the unbounded-future hole this closes. Both clocks agree for any honest
    // writer, which on a local-first store is the only writer there is.
    const existing = readStartupFailure(options.store);
    if (existing.status === "found") {
      // Both are canonical ISO by validation, so both parse. Compared as INSTANTS rather than as
      // text: `toISOString` also emits expanded years (`+275760-09-13T…`), which sort before every
      // ordinary year as strings while being later in time.
      const existingAt = Date.parse(existing.record.at);
      if (existingAt > Date.parse(record.at) && existingAt <= Date.now()) {
        unlinkSync(tmp);
        return path; // the destination already holds a more recent diagnosis — which is the contract
      }
    }
    renameSync(tmp, path);
    return path;
  } catch {
    try {
      // `tmp` is null when the failure happened before a temp path existed at all — describing the
      // error, or resolving where the record would go.
      if (tmp !== null) unlinkSync(tmp);
    } catch {
      // Nothing to clean up, or nothing we may clean up. Either way this path reports by returning
      // null; it never speaks for itself.
    }
    return null;
  }
}

/**
 * Names the first field that is missing or of the wrong type, or null when the record is whole.
 *
 * EVERY FIELD THE TYPE PROMISES IS CHECKED, not a representative sample (Codex round 1, PR #79). The
 * reader used to accept anything carrying `v` and `at`, so `{"v":1,"at":"…","error":{}}` came back
 * `found` and `doctor` printed `pid undefined, phase 'undefined': undefined: undefined` — a partial
 * record presented with the full confidence of a verdict, which is the exact conflation the
 * three-state result exists to prevent. A record this function cannot vouch for entirely is
 * `unreadable`, and says which field made it so.
 */
/**
 * A timestamp this module can both compare and trust: parseable, finite, and in exactly the form
 * `Date.prototype.toISOString` produces — which is what the writer emits, so a record it wrote
 * always satisfies this.
 *
 * ROUND-TRIP, NOT "PARSES" (Codex round 2, PR #79). `at` is not decoration: it decides which of two
 * records is the more recent, so a value that merely looks stringy is a value the ordering rule
 * reads as an instant. `"zzzz"` passed a `typeof` check, and every subsequent comparison against it
 * was a string comparison it always won. Canonical form is also what makes comparing two records
 * meaningful at all: `2026-08-21T00:00:00Z` and `2026-08-21T00:00:00.000Z` are the same instant and
 * sort differently as text.
 */
function isCanonicalIsoTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function missingRecordField(candidate: Partial<StartupFailureRecord>): string | null {
  if (typeof candidate.at !== "string" || !isCanonicalIsoTimestamp(candidate.at)) return "at";
  if (typeof candidate.pid !== "number") return "pid";
  if (typeof candidate.phase !== "string" || !(STARTUP_PHASES as readonly string[]).includes(candidate.phase)) {
    return "phase";
  }
  if (typeof candidate.store !== "string") return "store";
  if (candidate.stack !== null && typeof candidate.stack !== "string") return "stack";
  const error = candidate.error;
  if (typeof error !== "object" || error === null) return "error";
  if (typeof error.name !== "string") return "error.name";
  if (typeof error.message !== "string") return "error.message";
  // `code` is genuinely optional — plenty of errors carry none — but a present one must be a string
  // rather than whatever else ended up there.
  if (error.code !== undefined && typeof error.code !== "string") return "error.code";
  return null;
}

/**
 * Read the record for a store. Takes the STORE path, not a directory — see startupFailurePath.
 *
 * Total: a diagnostic that throws while diagnosing is useless.
 */
export function readStartupFailure(storePath: string): StartupFailureRead {
  let raw: string;
  try {
    raw = readFileSync(startupFailurePath(storePath), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "none" };
    return { status: "unreadable", reason: error instanceof Error ? error.message : String(error) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "unreadable", reason: "not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null) return { status: "unreadable", reason: "not an object" };
  const candidate = parsed as Partial<StartupFailureRecord>;
  if (candidate.v !== STARTUP_FAILURE_FORMAT) {
    return { status: "unreadable", reason: `unsupported record format ${String(candidate.v)}` };
  }
  const missing = missingRecordField(candidate);
  if (missing !== null) return { status: "unreadable", reason: `record is missing or malformed: ${missing}` };
  return { status: "found", record: candidate as StartupFailureRecord };
}
