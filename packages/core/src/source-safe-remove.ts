import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, readFileSync, readdirSync, rmSync } from "node:fs";
import type { Stats } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export type MountIdentityLookup = (paths: readonly string[]) => readonly string[];

export interface SafeTreeOps {
  /** Test seams used to model a mount/device substitution during preflight. */
  lstat?: typeof lstatSync;
  readdir?: typeof readdirSync;
  chmod?: typeof chmodSync;
  rm?: typeof rmSync;
  /** Return one stable mount-instance identity for each path in the same snapshot. */
  mountIdentities?: MountIdentityLookup;
  /** Directory durability barrier used by callers after unlink/rename. */
  fsyncPath?: (path: string) => void;
}

/**
 * Reject managed directory roots that another local account can replace or
 * modify. Node exposes a normalized permission mask on every supported
 * platform; POSIX ownership is additionally enforced when getuid is present.
 */
export function assertManagedDirectoryTrust(
  path: string,
  label: string,
  ops: SafeTreeOps = {},
  privateRoot = false,
): Stats {
  const entry = (ops.lstat ?? lstatSync)(path) as Stats;
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`${label} is not a real directory`);
  if (typeof process.getuid === "function" && entry.uid !== process.getuid()) {
    throw new Error(`${label} has unsafe ownership`);
  }
  const permissions = entry.mode & 0o777;
  if (privateRoot ? permissions !== 0o700 : (permissions & 0o022) !== 0) {
    throw new Error(`${label} has unsafe permissions`);
  }
  return entry;
}

export interface FrozenTreeNode {
  path: string;
  dev: number;
  ino: number;
  mountId: string;
  directory: boolean;
  symbolicLink: boolean;
  regularFile: boolean;
  nlink: number;
  children: string[];
}

export interface FrozenSameDeviceTree {
  root: string;
  rootDev: number;
  rootMountId: string;
  nodes: FrozenTreeNode[];
}

function statFor(ops: SafeTreeOps, path: string) {
  return (ops.lstat ?? lstatSync)(path);
}

function childrenFor(ops: SafeTreeOps, path: string): string[] {
  return [...(ops.readdir ?? readdirSync)(path) as string[]].sort();
}

interface MountRecord {
  id: string;
  parentId?: string;
  point: string;
}

function decodeMountField(field: string): string {
  let decoded = "";
  for (let index = 0; index < field.length; index += 1) {
    if (field[index] !== "\\") {
      decoded += field[index];
      continue;
    }
    const escape = field.slice(index + 1, index + 4);
    if (!/^[0-7]{3}$/.test(escape)) throw new Error("malformed mount table escape");
    decoded += String.fromCharCode(Number.parseInt(escape, 8));
    index += 3;
  }
  return decoded;
}

function validateMountRecords(records: MountRecord[], allowStackedPoints = false): MountRecord[] {
  if (records.length === 0) throw new Error("empty mount table");
  const identities = new Set<string>();
  const points = new Set<string>();
  for (const record of records) {
    if (!record.id || !isAbsolute(record.point) || identities.has(record.id)
        || (!allowStackedPoints && points.has(record.point))) {
      throw new Error("ambiguous mount table");
    }
    identities.add(record.id);
    points.add(record.point);
  }
  return records;
}

function linuxMountStack(records: readonly MountRecord[]): { bottom: MountRecord; top: MountRecord } {
  if (records.length === 0) throw new Error("empty mount stack");
  if (records.length === 1) return { bottom: records[0]!, top: records[0]! };
  const byId = new Map(records.map((record) => [record.id, record]));
  const parents = new Set(records.map((record) => record.parentId).filter((id): id is string => byId.has(id ?? "")));
  const tops = records.filter((record) => !parents.has(record.id));
  if (tops.length !== 1) throw new Error("ambiguous mount table");
  let current = tops[0]!;
  let bottom = current;
  const visited = new Set<string>();
  while (true) {
    if (visited.has(current.id)) throw new Error("ambiguous mount table");
    visited.add(current.id);
    bottom = current;
    const parent = current.parentId ? byId.get(current.parentId) : undefined;
    if (!parent) break;
    // The namespace root may validly name itself as its parent. It is a
    // terminator only at `/`; the full-visit check below still requires it to
    // be the one bottom of this stack.
    if (parent.id === current.id && current.point === "/") break;
    current = parent;
  }
  if (visited.size !== records.length) throw new Error("ambiguous mount table");
  return { bottom, top: tops[0]! };
}

function validateLinuxMountRecords(records: MountRecord[]): MountRecord[] {
  validateMountRecords(records, true);
  const byPoint = new Map<string, MountRecord[]>();
  for (const record of records) {
    const group = byPoint.get(record.point) ?? [];
    group.push(record);
    byPoint.set(record.point, group);
  }
  // A malformed stack anywhere means this was not a trustworthy namespace
  // snapshot, even when the queried path lies elsewhere.
  for (const group of byPoint.values()) {
    if (group.length > 1) linuxMountStack(group);
  }
  return records;
}

function linuxMountRecords(contents: string): MountRecord[] {
  const records: MountRecord[] = [];
  for (const line of contents.split("\n")) {
    if (!line) continue;
    const separator = line.indexOf(" - ");
    if (separator < 0 || separator !== line.lastIndexOf(" - ")) throw new Error("malformed Linux mountinfo");
    const left = line.slice(0, separator).split(" ");
    const right = line.slice(separator + 3).split(" ");
    if (left.length < 6 || right.length < 3 || !/^[1-9][0-9]*$/.test(left[0]!)
        || !/^[1-9][0-9]*$/.test(left[1]!) || !/^[0-9]+:[0-9]+$/.test(left[2]!)) {
      throw new Error("malformed Linux mountinfo");
    }
    const point = decodeMountField(left[4]!);
    records.push({ id: `linux:${left[0]}`, parentId: `linux:${left[1]}`, point });
  }
  // Linux explicitly permits mounts to be stacked at one pathname. systemd's
  // binfmt_misc automount is a common example on Ubuntu runners, so duplicate
  // points cannot make the entire otherwise usable snapshot ambiguous.
  return validateLinuxMountRecords(records);
}

function darwinMountRecords(): MountRecord[] {
  const contents = execFileSync("/sbin/mount", [], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const records: MountRecord[] = [];
  for (const line of contents.split("\n")) {
    if (!line) continue;
    const options = line.lastIndexOf(" (");
    if (options < 0 || !line.endsWith(")")) throw new Error("malformed Darwin mount table");
    const prefix = line.slice(0, options);
    const separators: number[] = [];
    for (let offset = prefix.indexOf(" on "); offset >= 0; offset = prefix.indexOf(" on ", offset + 1)) {
      if (isAbsolute(prefix.slice(offset + 4))) separators.push(offset);
    }
    if (separators.length !== 1) throw new Error("ambiguous Darwin mount table");
    const separator = separators[0]!;
    const source = prefix.slice(0, separator);
    const point = prefix.slice(separator + 4);
    const fsType = line.slice(options + 2, -1).split(",", 1)[0]?.trim();
    if (!source || !fsType) throw new Error("malformed Darwin mount table");
    records.push({ id: `darwin:${source}\0${point}\0${fsType}`, point });
  }
  return validateMountRecords(records);
}

function mountRecordFor(path: string, records: readonly MountRecord[]): MountRecord {
  const absolute = resolve(path);
  let deepest: MountRecord | undefined;
  for (const record of records) {
    const contained = absolute === record.point || absolute.startsWith(record.point === "/" ? "/" : `${record.point}/`);
    if (contained && (!deepest || record.point.length > deepest.point.length)) deepest = record;
  }
  if (!deepest) throw new Error("path is absent from mount table");
  return deepest;
}

function linuxMountRecordFor(path: string, records: readonly MountRecord[]): MountRecord {
  const absolute = resolve(path);
  const byPoint = new Map<string, MountRecord[]>();
  for (const record of records) {
    const contained = absolute === record.point || absolute.startsWith(record.point === "/" ? "/" : `${record.point}/`);
    if (!contained) continue;
    const group = byPoint.get(record.point) ?? [];
    group.push(record);
    byPoint.set(record.point, group);
  }
  const root = byPoint.get("/");
  if (!root) throw new Error("path is absent from mount table");
  let visible = linuxMountStack(root).top;
  const points = [...byPoint.keys()].filter((point) => point !== "/").sort((left, right) => left.length - right.length);
  for (const point of points) {
    const stack = linuxMountStack(byPoint.get(point)!);
    // Mounts below an overmounted ancestor remain in mountinfo but are hidden
    // from pathname traversal. Only a stack whose bottom is parented by the
    // currently visible containing mount can replace it.
    if (stack.bottom.parentId === visible.id) visible = stack.top;
  }
  return visible;
}

/** Testable parser/lookup for the Linux mount namespace snapshot. */
export function mountIdentitiesFromLinuxMountInfo(
  contents: string, paths: readonly string[],
): readonly string[] {
  const records = linuxMountRecords(contents);
  return paths.map((path) => linuxMountRecordFor(path, records).id);
}

function platformMountIdentities(paths: readonly string[]): readonly string[] {
  if (process.platform === "linux") {
    return mountIdentitiesFromLinuxMountInfo(readFileSync("/proc/self/mountinfo", "utf8"), paths);
  }
  const records = process.platform === "darwin" ? darwinMountRecords()
    : (() => { throw new Error(`mount identity is unavailable on ${process.platform}`); })();
  return paths.map((path) => mountRecordFor(path, records).id);
}

function mountIdentitiesFor(ops: SafeTreeOps, paths: readonly string[], label: string): string[] {
  let identities: readonly string[];
  try {
    identities = (ops.mountIdentities ?? platformMountIdentities)(paths);
  } catch {
    throw new Error(`${label} mount identity could not be proven`);
  }
  if (identities.length !== paths.length || identities.some((identity) => typeof identity !== "string" || !identity)) {
    throw new Error(`${label} mount identity could not be proven`);
  }
  return [...identities];
}

function assertFrozenMounts(
  frozen: FrozenSameDeviceTree, label: string, ops: SafeTreeOps, paths = frozen.nodes.map((node) => node.path),
): void {
  const identities = mountIdentitiesFor(ops, paths, label);
  for (let index = 0; index < paths.length; index += 1) {
    const node = frozen.nodes.find((candidate) => candidate.path === paths[index]);
    if (!node || identities[index] !== node.mountId || identities[index] !== frozen.rootMountId) {
      throw new Error(`${label} changed mount identity after preflight`);
    }
  }
}

/**
 * Freeze a complete no-follow tree before any recursive mutation. Descendant
 * nodes must remain on the root mount instance, so a same-device bind mount or
 * another volume mounted inside managed storage is rejected before chmod or
 * removal. Revalidation narrows replacement races to the documented same-UID
 * filesystem TOCTOU boundary.
 */
export function freezeSameDeviceTree(
  root: string, label: string, ops: SafeTreeOps = {}, check: () => void = () => undefined,
): FrozenSameDeviceTree {
  check();
  const rootEntry = statFor(ops, root);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) throw new Error(`${label} is not a real directory`);
  const rootDev = rootEntry.dev;
  const nodes: FrozenTreeNode[] = [];
  const walk = (path: string): void => {
    check();
    const entry = statFor(ops, path);
    const symbolicLink = entry.isSymbolicLink();
    const directory = entry.isDirectory() && !symbolicLink;
    if (directory && entry.dev !== rootDev) throw new Error(`${label} crosses a filesystem boundary`);
    const children = directory ? childrenFor(ops, path) : [];
    check();
    nodes.push({
      path, dev: entry.dev, ino: entry.ino, mountId: "", directory, symbolicLink,
      regularFile: entry.isFile() && !symbolicLink, nlink: entry.nlink, children,
    });
    for (const child of children) walk(join(path, child));
  };
  walk(root);
  check();
  const identities = mountIdentitiesFor(ops, nodes.map((node) => node.path), label);
  const rootMountId = identities[0]!;
  if (identities.some((identity) => identity !== rootMountId)) {
    throw new Error(`${label} crosses a mount boundary`);
  }
  for (let index = 0; index < nodes.length; index += 1) nodes[index]!.mountId = identities[index]!;
  return { root, rootDev, rootMountId, nodes };
}

export function revalidateSameDeviceTree(
  frozen: FrozenSameDeviceTree, label: string, ops: SafeTreeOps = {}, check: () => void = () => undefined,
): void {
  assertFrozenMounts(frozen, label, ops);
  for (const node of frozen.nodes) {
    check();
    const entry = statFor(ops, node.path);
    const directory = entry.isDirectory() && !entry.isSymbolicLink();
    if (entry.dev !== node.dev || entry.ino !== node.ino || directory !== node.directory
        || entry.isSymbolicLink() !== node.symbolicLink
        || (entry.isFile() && !entry.isSymbolicLink()) !== node.regularFile || entry.nlink !== node.nlink
        || (directory && entry.dev !== frozen.rootDev)) throw new Error(`${label} changed after preflight`);
    if (directory) {
      const children = childrenFor(ops, node.path);
      check();
      if (children.length !== node.children.length || children.some((name, index) => name !== node.children[index])) {
        throw new Error(`${label} changed after preflight`);
      }
    }
  }
}

export function removeFrozenSameDeviceTree(
  frozen: FrozenSameDeviceTree,
  label: string,
  beforeMutation: () => void = () => undefined,
  options: { writable?: boolean; ops?: SafeTreeOps; check?: () => void } = {},
): void {
  const ops = options.ops ?? {};
  const check = options.check ?? (() => undefined);
  // Complete validation precedes the first chmod. Every directory is then
  // revalidated immediately before its own chmod.
  revalidateSameDeviceTree(frozen, label, ops, check);
  if (options.writable) {
    for (const node of frozen.nodes) {
      if (!node.directory) continue;
      check();
      beforeMutation();
      assertFrozenMounts(frozen, label, ops, node.path === frozen.root ? [frozen.root] : [frozen.root, node.path]);
      const entry = statFor(ops, node.path);
      if (entry.dev !== node.dev || entry.ino !== node.ino || entry.dev !== frozen.rootDev
          || !entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`${label} changed before chmod`);
      (ops.chmod ?? chmodSync)(node.path, 0o700);
    }
  }
  // Chmod changes metadata but not identity. Validate the entire frozen tree
  // again, then revalidate the root immediately before the recursive unlink.
  revalidateSameDeviceTree(frozen, label, ops, check);
  check();
  beforeMutation();
  revalidateSameDeviceTree(frozen, label, ops, check);
  const root = statFor(ops, frozen.root);
  assertFrozenMounts(frozen, label, ops, [frozen.root]);
  if (root.dev !== frozen.rootDev || root.ino !== frozen.nodes[0]!.ino || !root.isDirectory() || root.isSymbolicLink()) {
    throw new Error(`${label} changed before removal`);
  }
  (ops.rm ?? rmSync)(frozen.root, { recursive: true, force: true });
}
