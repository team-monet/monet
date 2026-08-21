import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

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

/** Beside `monet.db`, `gate-mirror.json` and `moments.jsonl` — see this module's header. */
export const STARTUP_FAILURE_FILENAME = "startup-failure.json";

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

export function startupFailurePath(dir: string): string {
  return join(dir, STARTUP_FAILURE_FILENAME);
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
  /** Where to write — the store's own directory, resolved by the caller that opened it. */
  dir: string;
  /** The store this startup was serving, for a reader holding the file but not the invocation. */
  store: string;
  error: unknown;
  /**
   * Used only when the error carries no phase tag. Entry points pass "post-connect" once the
   * server factory has returned, because from that point the transport IS live and a death there
   * is a materially different fact from one before it. Defaults to "unknown" — never guessed.
   */
  fallbackPhase?: StartupPhase;
}

/**
 * Write the most recent startup failure beside the store. Returns the path written, or null if
 * nothing could be written.
 *
 * TEMP + RENAME, matching gates.ts's sidecar and install-cli.ts's atomic write: a reader that
 * arrives mid-write must see the previous record or the new one, never half of either. `wx` on the
 * temp file so two servers failing at the same instant cannot land in one buffer.
 *
 * TOTAL, NEVER THROWING — see this module's header. The caller is already reporting a failure; this
 * must not become a second one.
 */
export function recordStartupFailure(options: RecordStartupFailureOptions): string | null {
  const path = startupFailurePath(options.dir);
  const { stack, ...error } = describe(options.error);
  const record: StartupFailureRecord = {
    v: STARTUP_FAILURE_FORMAT,
    at: new Date().toISOString(),
    pid: process.pid,
    phase: startupPhaseOf(options.error) ?? options.fallbackPhase ?? "unknown",
    store: options.store,
    error,
    stack,
  };
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(options.dir, { recursive: true });
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(record, null, 2)}\n`);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    return path;
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      // Nothing to clean up, or nothing we may clean up. Either way this path reports by returning
      // null; it never speaks for itself.
    }
    return null;
  }
}

/** Read the record beside a store. Total: a diagnostic that throws while diagnosing is useless. */
export function readStartupFailure(dir: string): StartupFailureRead {
  let raw: string;
  try {
    raw = readFileSync(startupFailurePath(dir), "utf8");
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
  if (typeof candidate.at !== "string" || typeof candidate.error !== "object" || candidate.error === null) {
    return { status: "unreadable", reason: "record is missing required fields" };
  }
  return { status: "found", record: candidate as StartupFailureRecord };
}
