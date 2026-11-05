import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  OnnxEmbeddingProvider,
  resolveModelCacheDir,
  SharedModelUnavailableError,
  type ModelHost,
  type ModelSpec,
} from "./embedding-onnx";

/**
 * ONE MODEL PER MACHINE, NOT ONE PER SESSION.
 *
 * A host spawns one `monet start` per agent session, and the embedding model costs each of them more
 * than a gigabyte, so memory grew with the session count. Each session keeps its own process and its
 * own store connection; only the model moves, into one process they all talk to over a local socket.
 *
 * What holds this together:
 *  - THE SPACE DOES NOT MOVE. The provider in the session still owns identity, width and thresholds,
 *    and the host runs the same OnnxEmbeddingProvider a session would have. Vectors cross as raw
 *    bytes, because a JSON number array would turn a NaN into null and hide it from validation.
 *  - NOTHING TO CLEAN UP AFTER A KILL. Who hosts is decided by an OS file lock, which the kernel
 *    releases however the holder died, so a stale socket can only be removed by the one process
 *    entitled to replace it. Abstract sockets would give the same cleanup but no permissions.
 *  - TEXT STAYS WITH THE USER. The socket lives in a 0700 directory, so no other account can reach
 *    it, and it is not a network address. Nothing in here logs text.
 *  - A DEAD HOST COSTS ONE CALL AT WORST. The session respawns it and retries. If that fails, the
 *    call fails loudly and the next one tries again; no session moves to another embedder.
 *  - A STUCK HOST IS TREATED AS A DEAD ONE. Every session depends on this one process, and the lock
 *    sends each new session back to it, so a host that is alive and answers nothing would hang them
 *    all with restarts no help. A waiting session ends it, and the retry brings up a working one.
 */

const SOCKET_SUFFIX = ".sock";
const LOCK_SUFFIX = ".lock";
const LOG_SUFFIX = ".log";
const PID_SUFFIX = ".pid";

/**
 * How long a host outlives the last request. Short, because the wait is cheap and the memory is not:
 * the next request pays one model load, measured at about a second with the files in the page cache,
 * against more than 2 GB held for nobody. An agent does not notice a second.
 */
const DEFAULT_IDLE_EXIT_MS = 5 * 60_000;
/**
 * How long a session waits with work in flight and no sign of life before ending the host. "No sign"
 * means nothing finished for ANY session and no download progress, so queue depth does not count
 * against it. What it has to outlast is the longest silence with nothing wrong, a model load: measured
 * at 1.5 s after dropping the page cache on Linux, and 13 s with ten loads at once driving a 16 GB
 * machine 12 GB into swap. A slower disk than either is not measured, hence the margin. Too long costs
 * a stuck machine two minutes, and too short kills healthy hosts mid-load, which is the worse error.
 */
const DEFAULT_STALL_LIMIT_MS = 2 * 60_000;
/**
 * How long a session waits for a host to start listening, which happens before any model load and
 * measures about 60 ms. A wait this long means a machine in no state to load a private copy either,
 * so running out fails the call rather than falling back.
 */
const DEFAULT_CONNECT_DEADLINE_MS = 20_000;
const CONNECT_RETRY_MS = 50;
const SPAWN_INTERVAL_MS = 1_000;
/** A killed host costs one retry; three in a row means it cannot stay up, and more would not help. */
const MAX_ATTEMPTS = 3;
/** sun_path is 108 bytes on Linux and 104 on macOS. */
const MAX_SOCKET_PATH_BYTES = 100;

type Op = "embed" | "countTokens" | "inputWindow";

interface Request {
  id: number;
  op: Op;
  spec: ModelSpec;
  text?: string;
}

type Answer =
  | { id: number; ok: true; vector: string }
  | { id: number; ok: true; value: number | null }
  | { id: number; ok: false; error: string };

/** `progress` is what a session queued behind others sees instead of mistaking the wait for a stall. */
type Frame = Answer | { log: string } | { progress: true };

function encodeVector(vector: Float32Array): string {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString("base64");
}

function decodeVector(encoded: string): Float32Array {
  // Copied out of the Buffer: a pooled Buffer's offset need not be 4-byte aligned.
  return new Float32Array(new Uint8Array(Buffer.from(encoded, "base64")).buffer);
}

/**
 * Take an OS file lock, or return null if another process holds it past `waitMs`.
 *
 * SQLite's because it is the file lock already in the dependency tree and Node has none of its own.
 * The kernel releases it however the holder dies, so there is no stale state for anyone to break.
 * Nothing is ever written, so no journal on disk either. MEMORY rather than OFF, which
 * better-sqlite3's defensive mode ignores without an error. Throws when the path cannot be locked at
 * all, which is a different fact from someone else holding it.
 */
export function acquireFileLock(path: string, waitMs = 0): (() => void) | null {
  let lock: Database.Database | null = null;
  try {
    lock = new Database(path, { timeout: waitMs });
    lock.pragma("journal_mode = MEMORY");
    lock.exec("BEGIN EXCLUSIVE");
    const held = lock;
    return () => held.close();
  } catch (error) {
    lock?.close();
    if (String((error as { code?: unknown }).code).startsWith("SQLITE_BUSY")) return null;
    throw error;
  }
}

/** Calls `onLine` for each complete line. JSON escapes newlines, so a frame never holds a raw one. */
function readLines(socket: Socket, onLine: (line: string) => void): void {
  let buffered = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffered += chunk;
    let end: number;
    while ((end = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      onLine(line);
    }
  });
}

/** Runs the model in this process. It is what a host serves with, and a session's last resort. */
export class LocalModelHost implements ModelHost {
  private readonly providers = new Map<string, OnnxEmbeddingProvider>();

  constructor(private readonly reportLoad?: (line: string) => void) {}

  /**
   * A FAILED PROVIDER IS DROPPED. It caches its load promise, including a rejected one, which is fine
   * for a process that exits on failure and wrong for one that outlives it: a host that hit one
   * network error during a download would otherwise refuse every session until it idled out.
   */
  private async run<T>(spec: ModelSpec, operation: (provider: OnnxEmbeddingProvider) => Promise<T>): Promise<T> {
    const key = JSON.stringify([spec.model, spec.pooling, spec.dtype ?? null]);
    let provider = this.providers.get(key);
    if (!provider) {
      provider = new OnnxEmbeddingProvider({ ...spec, reportLoad: this.reportLoad });
      this.providers.set(key, provider);
    }
    try {
      return await operation(provider);
    } catch (error) {
      this.providers.delete(key);
      throw error;
    }
  }

  embed(spec: ModelSpec, text: string): Promise<Float32Array> {
    return this.run(spec, (provider) => provider.embed(text));
  }

  countTokens(spec: ModelSpec, text: string): Promise<number> {
    return this.run(spec, (provider) => provider.countTokens(text));
  }

  inputWindow(spec: ModelSpec): Promise<number | null> {
    return this.run(spec, (provider) => provider.inputWindow());
  }
}

export interface SharedModelServer {
  /** Settles once the host has idled out and released everything. */
  readonly closed: Promise<void>;
}

/**
 * Become the machine's model host, or return null because another process already is.
 *
 * Requests run one at a time, in arrival order. A model already uses every core for one embed, so
 * running several at once would not finish any sooner, and it bounds what ten busy sessions can ask
 * of the machine. A session embeds one text at a time, so the queue also takes turns between them.
 */
export async function serveSharedModel(options: {
  basePath: string;
  host?: ModelHost;
  idleExitMs?: number;
}): Promise<SharedModelServer | null> {
  const socketPath = options.basePath + SOCKET_SUFFIX;
  const releaseLock = acquireFileLock(options.basePath + LOCK_SUFFIX);
  if (releaseLock === null) return null;

  // This process is the host now, so what sits at the socket path is a dead host's, and this log is
  // the only one anyone still needs.
  rmSync(socketPath, { force: true });
  writeFileSync(options.basePath + PID_SUFFIX, String(process.pid), { mode: 0o600 });
  try {
    truncateSync(options.basePath + LOG_SUFFIX, 0);
  } catch {
    // No log file means no spawning session opened one: a test, or an operator running this by hand.
  }

  const connections = new Set<Socket>();
  const broadcast = (frame: Frame): void => {
    const encoded = JSON.stringify(frame) + "\n";
    for (const connection of connections) connection.write(encoded);
  };
  const idleExitMs = options.idleExitMs ?? DEFAULT_IDLE_EXIT_MS;

  let settleClosed!: () => void;
  const closed = new Promise<void>((resolve) => (settleClosed = resolve));
  const server = createServer();

  let queue: Promise<void> = Promise.resolve();
  let idleTimer: NodeJS.Timeout | null = null;
  let closing = false;

  const shutDown = (): void => {
    closing = true;
    server.close();
    for (const connection of connections) connection.destroy();
    // In this order: the socket has to be gone before the lock lets a successor create its own.
    rmSync(socketPath, { force: true });
    releaseLock();
    settleClosed();
  };
  /**
   * Requests and finished work push the exit back; a request still running does not hold it off. So
   * the same clock also ends a host stuck on a call that nobody is left waiting for, which would
   * otherwise keep its memory until the next session came along and timed out on it.
   */
  const noteActivity = (): void => {
    if (closing) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(shutDown, idleExitMs);
  };
  const host =
    options.host ??
    new LocalModelHost((line) => {
      noteActivity();
      broadcast({ log: line });
    });

  const answer = async (request: Request): Promise<Answer> => {
    try {
      switch (request.op) {
        case "embed":
          return { id: request.id, ok: true, vector: encodeVector(await host.embed(request.spec, request.text ?? "")) };
        case "countTokens":
          return { id: request.id, ok: true, value: await host.countTokens(request.spec, request.text ?? "") };
        case "inputWindow":
          return { id: request.id, ok: true, value: await host.inputWindow(request.spec) };
        default:
          return { id: request.id, ok: false, error: `unknown operation ${String(request.op)}` };
      }
    } catch (error) {
      return { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  server.on("connection", (connection) => {
    connections.add(connection);
    connection.on("close", () => connections.delete(connection));
    connection.on("error", () => connection.destroy());
    readLines(connection, (line) => {
      let request: Request | null;
      try {
        request = JSON.parse(line) as Request | null;
      } catch {
        request = null;
      }
      if (typeof request !== "object" || request === null) {
        connection.destroy();
        return;
      }
      const accepted = request;
      noteActivity();
      queue = queue.then(async () => {
        // A session that went away while queued no longer needs this, and a model run is not cheap.
        if (connection.destroyed) return;
        const response = await answer(accepted);
        if (!connection.destroyed) connection.write(JSON.stringify(response) + "\n");
        noteActivity();
        broadcast({ progress: true });
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  noteActivity();
  return { closed };
}

class ConnectionLostError extends Error {}

/** Sharing cannot work on this machine at all. Unlike a host that is down, no retry changes this. */
class CannotShareHereError extends Error {}

export interface SharedModelHostOptions {
  /** The release, so a session never talks to a host running another version's model code. */
  version: string;
  /** The script that runs serveSharedModel with its first argument as the base path. */
  hostEntry: string;
  /** Node flags for the host. Defaults to this process's own. */
  nodeArgs?: string[];
  /** Where the socket lives. Defaults to a directory under the home directory, not the store. */
  runtimeDir?: string;
  connectDeadlineMs?: number;
  stallLimitMs?: number;
  /** What a session uses when it cannot share here at all. */
  createFallback?: () => ModelHost;
}

/**
 * The owner-only directory the socket lives in, or a throw when that cannot be guaranteed.
 *
 * The socket is only as private as this directory, and a Unix socket gets no other access check that
 * Node can apply, so "looks fine" is not enough: a symlink, another owner or an open mode refuses.
 */
function prepareRuntimeDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let stat = lstatSync(dir);
  if (stat.isDirectory() && stat.uid === process.getuid?.() && (stat.mode & 0o077) !== 0) {
    chmodSync(dir, 0o700);
    stat = lstatSync(dir);
  }
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error(`${dir} is not a directory only this user can reach`);
  }
}

class SharedModelClient implements ModelHost {
  private socket: Socket | null = null;
  private connecting: Promise<Socket> | null = null;
  private fallback: ModelHost | null = null;
  /** Once a host has been reached, sharing works here, so a later failure must not load a private copy. */
  private everConnected = false;
  private basePath: string | null = null;
  private nextId = 1;
  private stallTimer: NodeJS.Timeout | null = null;
  private readonly pending = new Map<number, { resolve: (answer: Answer) => void; reject: (error: Error) => void }>();

  constructor(private readonly options: SharedModelHostOptions) {}

  embed(spec: ModelSpec, text: string): Promise<Float32Array> {
    return this.call(
      (fallback) => fallback.embed(spec, text),
      { op: "embed", spec, text },
      (response) => {
        if (!("vector" in response)) throw new Error("The shared model host answered an embed without a vector.");
        return decodeVector(response.vector);
      },
    );
  }

  countTokens(spec: ModelSpec, text: string): Promise<number> {
    return this.call(
      (fallback) => fallback.countTokens(spec, text),
      { op: "countTokens", spec, text },
      (response) => {
        if (!("value" in response) || typeof response.value !== "number") {
          throw new Error("The shared model host answered a token count without a number.");
        }
        return response.value;
      },
    );
  }

  inputWindow(spec: ModelSpec): Promise<number | null> {
    return this.call(
      (fallback) => fallback.inputWindow(spec),
      { op: "inputWindow", spec },
      (response) => {
        if (!("value" in response)) throw new Error("The shared model host answered a window without a value.");
        return response.value;
      },
    );
  }

  private useFallback(reason: unknown): ModelHost {
    if (!this.fallback) {
      const why = reason instanceof Error ? reason.message : String(reason);
      console.error(`[monet-core] sharing the embedding model is unavailable here (${why}); this session loads its own copy of the same model.`);
      this.fallback = this.options.createFallback?.() ?? new LocalModelHost();
    }
    return this.fallback;
  }

  private async call<T>(
    onFallback: (fallback: ModelHost) => Promise<T>,
    request: Omit<Request, "id">,
    read: (answer: Extract<Answer, { ok: true }>) => T,
  ): Promise<T> {
    if (this.fallback) return await onFallback(this.fallback);

    let lastError: unknown = new Error("no attempt ran");
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      let socket: Socket;
      try {
        socket = await this.connection();
      } catch (error) {
        if (error instanceof CannotShareHereError && !this.everConnected) {
          return await onFallback(this.useFallback(error));
        }
        throw new SharedModelUnavailableError(error instanceof Error ? error.message : String(error), this.logPath());
      }
      try {
        const answer = await this.send(socket, request);
        if (!answer.ok) throw new Error(answer.error);
        return read(answer);
      } catch (error) {
        if (!(error instanceof ConnectionLostError)) throw error;
        lastError = error;
      }
    }
    throw new SharedModelUnavailableError(
      lastError instanceof Error ? lastError.message : String(lastError),
      this.logPath(),
    );
  }

  private logPath(): string {
    return (this.basePath ?? "(not started)") + LOG_SUFFIX;
  }

  /**
   * The socket is unreferenced while nothing is in flight, so an idle connection never holds a
   * session open at shutdown, and referenced during a request, because at startup a pending embed
   * can be the only thing left to keep the process alive before the transport exists.
   */
  private send(socket: Socket, request: Omit<Request, "id">): Promise<Answer> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      // A socket closed before this point has already rejected everything it will ever reject.
      if (socket.destroyed) {
        reject(new ConnectionLostError("the model process went away before the call"));
        return;
      }
      this.pending.set(id, {
        resolve: (answer) => {
          this.pending.delete(id);
          if (this.pending.size === 0) socket.unref();
          resolve(answer);
        },
        reject: (error) => {
          this.pending.delete(id);
          reject(error);
        },
      });
      socket.ref();
      socket.write(JSON.stringify({ id, ...request }) + "\n");
      this.watchForStall(socket);
    });
  }

  /** Restarted by everything the host sends, and stopped once nothing is in flight. */
  private watchForStall(socket: Socket): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer =
      this.pending.size === 0
        ? null
        : setTimeout(() => this.endStuckHost(socket), this.options.stallLimitMs ?? DEFAULT_STALL_LIMIT_MS);
  }

  /**
   * The connection is still open, so the process that wrote this pid is alive and is the one holding
   * the lock: no successor can have written it, and the pid cannot have been reused. Every waiting
   * session may do this, and the second kill finds nothing. Destroying the socket is what ends the
   * wait, whether or not the kill landed, so a host that cannot be killed still only costs retries.
   */
  private endStuckHost(socket: Socket): void {
    try {
      const pid = Number(readFileSync((this.basePath ?? "") + PID_SUFFIX, "utf8"));
      if (Number.isInteger(pid) && pid > 0) process.kill(pid, "SIGKILL");
    } catch {
      // Already gone, or not ours to signal.
    }
    socket.destroy();
  }

  private connection(): Promise<Socket> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
    this.connecting ??= this.establish().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private resolveBasePath(): string {
    if (this.basePath) return this.basePath;
    if (process.platform === "win32") {
      throw new Error("a private local socket is only implemented on Unix");
    }
    const dir = this.options.runtimeDir ?? join(homedir(), ".monet", "shared-model");
    // The install path is part of the key because two installs of one release can resolve different
    // versions of the model runtime, and a store must get the vectors of the Monet that opened it.
    const key = createHash("sha256")
      .update(JSON.stringify([this.options.version, realpathSync(this.options.hostEntry), resolveModelCacheDir()]))
      .digest("hex")
      .slice(0, 16);
    const basePath = join(dir, key);
    if (Buffer.byteLength(basePath + SOCKET_SUFFIX) > MAX_SOCKET_PATH_BYTES) {
      throw new Error(`the socket path under ${dir} is too long`);
    }
    prepareRuntimeDir(dir);
    this.basePath = basePath;
    return basePath;
  }

  private async establish(): Promise<Socket> {
    let basePath: string;
    try {
      basePath = this.resolveBasePath();
    } catch (error) {
      throw new CannotShareHereError(error instanceof Error ? error.message : String(error));
    }
    const deadline = performance.now() + (this.options.connectDeadlineMs ?? DEFAULT_CONNECT_DEADLINE_MS);
    let lastSpawnAt = -Infinity;
    const host: { running: boolean; failure: string | null } = { running: false, failure: null };
    for (;;) {
      try {
        const socket = await this.dial(basePath + SOCKET_SUFFIX);
        this.socket = socket;
        this.everConnected = true;
        return socket;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ECONNREFUSED") {
          throw new CannotShareHereError(error instanceof Error ? error.message : String(error));
        }
      }
      // A host that exited non-zero could not start, and starting another will not help. A host that
      // lost the election exits zero, and the winner is what this loop is waiting for.
      if (host.failure !== null) throw new CannotShareHereError(host.failure);
      if (performance.now() >= deadline) throw new Error("no host started listening in time");
      // One at a time: on a machine too slow to start one, more of them only make it slower.
      if (!host.running && performance.now() - lastSpawnAt >= SPAWN_INTERVAL_MS) {
        lastSpawnAt = performance.now();
        host.running = true;
        try {
          this.spawnHost(basePath, (failure) => {
            host.running = false;
            host.failure = failure;
          });
        } catch (error) {
          throw new CannotShareHereError(error instanceof Error ? error.message : String(error));
        }
      }
      await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_MS));
    }
  }

  /**
   * Detached, with its own output, because it must outlive the session that happened to start it and
   * must not hold that session's stderr open: a host waits for EOF on a server's pipes.
   */
  private spawnHost(basePath: string, onExit: (failure: string | null) => void): void {
    const log = openSync(basePath + LOG_SUFFIX, "a", 0o600);
    try {
      const child = spawn(process.execPath, [...(this.options.nodeArgs ?? process.execArgv), this.options.hostEntry, basePath], {
        detached: true,
        stdio: ["ignore", log, log],
        cwd: homedir(),
        // Resolved here because the host runs from another directory: a relative override would
        // otherwise name one cache for this session's key and a different one for the host's load.
        env: { ...process.env, MONET_MODEL_CACHE: resolveModelCacheDir() },
      });
      child.once("error", (error) => onExit(`could not start the model process: ${error.message}`));
      child.once("exit", (code, signal) => {
        onExit(code !== 0 && signal === null ? `the model process exited with code ${code}` : null);
      });
      child.unref();
    } finally {
      closeSync(log);
    }
  }

  private dial(socketPath: string): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = connect(socketPath);
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.off("error", reject);
        socket.on("error", () => socket.destroy());
        socket.on("close", () => this.onClose(socket));
        readLines(socket, (line) => this.onLine(socket, line));
        socket.unref();
        resolve(socket);
      });
    });
  }

  private onClose(socket: Socket): void {
    if (this.socket === socket) this.socket = null;
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = null;
    for (const entry of [...this.pending.values()]) {
      entry.reject(new ConnectionLostError("the model process went away during a call"));
    }
  }

  private onLine(socket: Socket, line: string): void {
    // Throwing here would end the session over one bad frame. Dropping the connection costs a retry.
    let frame: Frame | null;
    try {
      frame = JSON.parse(line) as Frame | null;
    } catch {
      frame = null;
    }
    if (typeof frame !== "object" || frame === null) {
      socket.destroy();
      return;
    }
    if ("log" in frame) console.error(frame.log);
    else if ("id" in frame) this.pending.get(frame.id)?.resolve(frame);
    this.watchForStall(socket);
  }
}

export function createSharedModelHost(options: SharedModelHostOptions): ModelHost {
  return new SharedModelClient(options);
}
