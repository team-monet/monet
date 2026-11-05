import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, realpathSync, rmSync, truncateSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { OnnxEmbeddingProvider, resolveModelCacheDir, type ModelHost, type ModelSpec } from "./embedding-onnx";

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
 */

const SOCKET_SUFFIX = ".sock";
const LOCK_SUFFIX = ".lock";
const LOG_SUFFIX = ".log";

/**
 * How long a host outlives the last request. Short, because the wait is cheap and the memory is not:
 * the next request pays one model load, measured at about a second with the files in the page cache,
 * against more than 2 GB held for nobody. An agent does not notice a second.
 */
const DEFAULT_IDLE_EXIT_MS = 5 * 60_000;
/** How long a session waits for a host to start listening, which happens before any model load. */
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

type Response =
  | { id: number; ok: true; vector: string }
  | { id: number; ok: true; value: number | null }
  | { id: number; ok: false; error: string }
  | { log: string };

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
  try {
    truncateSync(options.basePath + LOG_SUFFIX, 0);
  } catch {
    // No log file means no spawning session opened one: a test, or an operator running this by hand.
  }

  const connections = new Set<Socket>();
  const broadcast = (response: Response): void => {
    const frame = JSON.stringify(response) + "\n";
    for (const connection of connections) connection.write(frame);
  };
  const host = options.host ?? new LocalModelHost((line) => broadcast({ log: line }));
  const idleExitMs = options.idleExitMs ?? DEFAULT_IDLE_EXIT_MS;

  let settleClosed!: () => void;
  const closed = new Promise<void>((resolve) => (settleClosed = resolve));
  const server = createServer();

  let queue: Promise<void> = Promise.resolve();
  let queued = 0;
  let idleTimer: NodeJS.Timeout | null = null;

  const shutDown = (): void => {
    server.close();
    for (const connection of connections) connection.destroy();
    // In this order: the socket has to be gone before the lock lets a successor create its own.
    rmSync(socketPath, { force: true });
    releaseLock();
    settleClosed();
  };
  const armIdleExit = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = queued === 0 ? setTimeout(shutDown, idleExitMs) : null;
  };

  const answer = async (request: Request): Promise<Response> => {
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
      let request: Request;
      try {
        request = JSON.parse(line) as Request;
      } catch {
        connection.destroy();
        return;
      }
      queued += 1;
      armIdleExit();
      queue = queue.then(async () => {
        // A session that went away while queued no longer needs this, and a model run is not cheap.
        if (!connection.destroyed) {
          const response = await answer(request);
          if (!connection.destroyed) connection.write(JSON.stringify(response) + "\n");
        }
        queued -= 1;
        armIdleExit();
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
  armIdleExit();
  return { closed };
}

/** A session cannot reach the shared model right now. Only this call failed; the next one retries. */
export class SharedModelUnavailableError extends Error {
  constructor(reason: string, logPath: string) {
    super(
      `The shared embedding model could not be reached (${reason}). This call did not run and no ` +
        `other embedder was used; the next call starts the model process again. Its log is ${logPath}.`,
    );
    this.name = "SharedModelUnavailableError";
  }
}

class ConnectionLostError extends Error {}

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
  /** Once a host has answered, sharing works here, so a later failure must not load a private copy. */
  private everConnected = false;
  private basePath: string | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (response: Response) => void; reject: (error: Error) => void }>();

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
    read: (response: Extract<Response, { ok: true }>) => T,
  ): Promise<T> {
    if (this.fallback) return await onFallback(this.fallback);

    let lastError: unknown = new Error("no attempt ran");
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      let socket: Socket;
      try {
        socket = await this.connection();
      } catch (error) {
        if (!this.everConnected) return await onFallback(this.useFallback(error));
        throw new SharedModelUnavailableError(error instanceof Error ? error.message : String(error), this.logPath());
      }
      try {
        const response = await this.send(socket, request);
        if ("log" in response) throw new Error("A log line reached a request's answer.");
        if (!response.ok) throw new Error(response.error);
        return read(response);
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
  private send(socket: Socket, request: Omit<Request, "id">): Promise<Response> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      // A socket closed before this point has already rejected everything it will ever reject.
      if (socket.destroyed) {
        reject(new ConnectionLostError("the model process went away before the call"));
        return;
      }
      this.pending.set(id, {
        resolve: (response) => {
          this.pending.delete(id);
          if (this.pending.size === 0) socket.unref();
          resolve(response);
        },
        reject: (error) => {
          this.pending.delete(id);
          reject(error);
        },
      });
      socket.ref();
      socket.write(JSON.stringify({ id, ...request }) + "\n");
    });
  }

  private connection(): Promise<Socket> {
    if (this.socket) return Promise.resolve(this.socket);
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
    const basePath = this.resolveBasePath();
    const deadline = performance.now() + (this.options.connectDeadlineMs ?? DEFAULT_CONNECT_DEADLINE_MS);
    let lastSpawnAt = -Infinity;
    const host: { failure: string | null } = { failure: null };
    for (;;) {
      try {
        const socket = await this.dial(basePath + SOCKET_SUFFIX);
        this.socket = socket;
        this.everConnected = true;
        return socket;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ECONNREFUSED") throw error;
      }
      // A host that exited non-zero could not start, and starting another will not help. A host that
      // lost the election exits zero, and the winner is what this loop is waiting for.
      if (host.failure !== null) throw new Error(host.failure);
      if (performance.now() >= deadline) throw new Error("no host started listening in time");
      if (performance.now() - lastSpawnAt >= SPAWN_INTERVAL_MS) {
        lastSpawnAt = performance.now();
        this.spawnHost(basePath, (reason) => {
          host.failure = reason;
        });
      }
      await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_MS));
    }
  }

  /**
   * Detached, with its own output, because it must outlive the session that happened to start it and
   * must not hold that session's stderr open: a host waits for EOF on a server's pipes.
   */
  private spawnHost(basePath: string, onFailure: (reason: string) => void): void {
    const log = openSync(basePath + LOG_SUFFIX, "a", 0o600);
    try {
      const child = spawn(process.execPath, [...(this.options.nodeArgs ?? process.execArgv), this.options.hostEntry, basePath], {
        detached: true,
        stdio: ["ignore", log, log],
        cwd: homedir(),
      });
      child.once("error", (error) => onFailure(`could not start the model process: ${error.message}`));
      child.once("exit", (code, signal) => {
        if (code !== 0 && signal === null) onFailure(`the model process exited with code ${code}`);
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
    for (const entry of [...this.pending.values()]) {
      entry.reject(new ConnectionLostError("the model process went away during a call"));
    }
  }

  private onLine(socket: Socket, line: string): void {
    let response: Response;
    try {
      response = JSON.parse(line) as Response;
    } catch {
      // Throwing here would end the session over one bad frame. Dropping the connection costs a retry.
      socket.destroy();
      return;
    }
    if ("log" in response) {
      console.error(response.log);
      return;
    }
    this.pending.get(response.id)?.resolve(response);
  }
}

export function createSharedModelHost(options: SharedModelHostOptions): ModelHost {
  return new SharedModelClient(options);
}
