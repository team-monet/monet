import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  freezeSameDeviceTree,
  mountIdentitiesFromLinuxMountInfo,
  removeFrozenSameDeviceTree,
} from "../source-safe-remove";
import type { MountIdentityLookup, SafeTreeOps } from "../source-safe-remove";

function fixture() {
  const parent = mkdtempSync(join(tmpdir(), "monet-safe-remove-"));
  const root = join(parent, "managed");
  const nested = join(root, "nested");
  const victim = join(nested, "keep.txt");
  mkdirSync(nested, { recursive: true, mode: 0o700 });
  writeFileSync(victim, "safe");
  return { parent, root, nested, victim, cleanup: () => rmSync(parent, { recursive: true, force: true }) };
}

function countingOps(mountIdentities: MountIdentityLookup, counters: { chmod: number; rm: number }): SafeTreeOps {
  return {
    mountIdentities,
    chmod: ((path: Parameters<typeof chmodSync>[0], mode: Parameters<typeof chmodSync>[1]) => {
      counters.chmod += 1;
      chmodSync(path, mode);
    }) as typeof chmodSync,
    rm: ((path: Parameters<typeof rmSync>[0], options?: Parameters<typeof rmSync>[1]) => {
      counters.rm += 1;
      rmSync(path, options);
    }) as typeof rmSync,
  };
}

const ubuntuRunnerMountInfo = [
  "22 1 0:21 / / rw,relatime - overlay overlay rw,lowerdir=/runner/lower,upperdir=/runner/upper",
  "23 22 0:22 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw",
  "24 23 0:23 / /proc/sys/fs/binfmt_misc rw,relatime - autofs systemd-1 rw,fd=31",
  "25 24 0:24 / /proc/sys/fs/binfmt_misc rw,nosuid,nodev,noexec,relatime - binfmt_misc binfmt_misc rw",
  "26 22 0:25 / /sys ro,nosuid,nodev,noexec,relatime - sysfs sysfs ro",
  "27 26 0:26 / /sys/devices/system/cpu/cpu0/thermal_throttle ro,relatime - tmpfs tmpfs ro",
].join("\n");

function linuxFixtureLookup(contents = ubuntuRunnerMountInfo): MountIdentityLookup {
  return (paths) => mountIdentitiesFromLinuxMountInfo(contents, paths);
}

describe("mount-safe managed tree removal", () => {
  it("resolves ordinary temporary trees through an Ubuntu overlay root despite a valid stacked mount elsewhere", () => {
    const identities = mountIdentitiesFromLinuxMountInfo(ubuntuRunnerMountInfo, [
      "/tmp/monet/managed",
      "/tmp/monet/managed/nested/file.md",
      "/proc/sys/fs/binfmt_misc/register",
    ]);
    expect(identities).toEqual(["linux:22", "linux:22", "linux:25"]);
  });

  it("fails the complete snapshot for forked, cyclic, or disconnected duplicate mountpoint groups", () => {
    const malformedGroups = [
      [
        "30 22 0:21 /runner/fork /mnt/fork rw,relatime - overlay overlay rw",
        "31 30 0:21 /runner/fork-1 /mnt/fork rw,relatime - overlay overlay rw",
        "32 30 0:21 /runner/fork-2 /mnt/fork rw,relatime - overlay overlay rw",
      ],
      [
        "30 31 0:21 /runner/cycle-1 /mnt/cycle rw,relatime - overlay overlay rw",
        "31 30 0:21 /runner/cycle-2 /mnt/cycle rw,relatime - overlay overlay rw",
      ],
      [
        "30 30 0:21 /runner/self-cycle /mnt/self-cycle rw,relatime - overlay overlay rw",
        "31 30 0:21 /runner/self-cycle-top /mnt/self-cycle rw,relatime - overlay overlay rw",
      ],
      [
        "30 22 0:21 /runner/disconnected-1 /mnt/disconnected rw,relatime - overlay overlay rw",
        "31 23 0:21 /runner/disconnected-2 /mnt/disconnected rw,relatime - overlay overlay rw",
      ],
    ];
    for (const group of malformedGroups) {
      expect(() => mountIdentitiesFromLinuxMountInfo(
        `${ubuntuRunnerMountInfo}\n${group.join("\n")}`,
        ["/tmp/unrelated-managed-tree"],
      )).toThrow(/ambiguous mount table/);
    }
  });

  it("ignores a nested mount hidden by a later ancestor overmount and exposes it again after unmount", () => {
    const lower = [
      "28 22 0:21 /runner/lower /a rw,relatime - overlay overlay rw",
      "29 28 0:21 /runner/lower-b /a/b rw,relatime - overlay overlay rw",
    ].join("\n");
    const overmount = "30 28 0:21 /runner/upper /a rw,relatime - overlay overlay rw";
    expect(mountIdentitiesFromLinuxMountInfo(
      `${ubuntuRunnerMountInfo}\n${lower}\n${overmount}`,
      ["/a", "/a/b/file.md"],
    )).toEqual(["linux:30", "linux:30"]);
    expect(mountIdentitiesFromLinuxMountInfo(
      `${ubuntuRunnerMountInfo}\n${lower}`,
      ["/a/b/file.md"],
    )).toEqual(["linux:29"]);
  });

  it("accepts a self-parented namespace-root stack and catches its top unmount", () => {
    const f = fixture();
    try {
      const selfParentRoot = ubuntuRunnerMountInfo.replace(
        "22 1 0:21 / /",
        "22 22 0:21 / /",
      );
      const rootOvermount = "28 22 0:21 /runner/root-overmount / rw,relatime - overlay overlay rw";
      expect(mountIdentitiesFromLinuxMountInfo(
        `${selfParentRoot}\n${rootOvermount}`,
        ["/tmp/managed", "/tmp/managed/nested"],
      )).toEqual(["linux:28", "linux:28"]);
      expect(() => mountIdentitiesFromLinuxMountInfo(
        `${ubuntuRunnerMountInfo}\n28 28 0:21 /runner/not-bottom / rw,relatime - overlay overlay rw\n`
          + "29 28 0:21 /runner/not-bottom-top / rw,relatime - overlay overlay rw",
        ["/tmp/managed"],
      )).toThrow(/ambiguous mount table/);

      let unmounted = false;
      const counters = { chmod: 0, rm: 0 };
      const ops = countingOps(
        (paths) => mountIdentitiesFromLinuxMountInfo(
          `${selfParentRoot}${unmounted ? "" : `\n${rootOvermount}`}`,
          paths,
        ),
        counters,
      );
      const frozen = freezeSameDeviceTree(f.root, "managed tree", ops);
      expect(frozen.rootMountId).toBe("linux:28");
      expect(() => removeFrozenSameDeviceTree(frozen, "managed tree", () => { unmounted = true; }, { ops }))
        .toThrow(/mount identity/);
      expect(counters).toEqual({ chmod: 0, rm: 0 });
      expect(readFileSync(f.victim, "utf8")).toBe("safe");
    } finally { f.cleanup(); }
  });

  it("catches an ancestor overmount disappearing between freeze and deletion", () => {
    const f = fixture();
    try {
      const lower = [
        `28 22 0:21 /runner/lower ${f.root} rw,relatime - overlay overlay rw`,
        `29 28 0:21 /runner/lower-nested ${f.nested} rw,relatime - overlay overlay rw`,
      ].join("\n");
      const overmount = `30 28 0:21 /runner/upper ${f.root} rw,relatime - overlay overlay rw`;
      let unmounted = false;
      const counters = { chmod: 0, rm: 0 };
      const ops = countingOps(
        (paths) => mountIdentitiesFromLinuxMountInfo(
          `${ubuntuRunnerMountInfo}\n${lower}${unmounted ? "" : `\n${overmount}`}`,
          paths,
        ),
        counters,
      );
      const frozen = freezeSameDeviceTree(f.root, "managed tree", ops);
      expect(frozen.rootMountId).toBe("linux:30");
      expect(() => removeFrozenSameDeviceTree(frozen, "managed tree", () => { unmounted = true; }, { ops }))
        .toThrow(/mount identity/);
      expect(counters).toEqual({ chmod: 0, rm: 0 });
      expect(readFileSync(f.victim, "utf8")).toBe("safe");
    } finally { f.cleanup(); }
  });

  it("rejects a same-filesystem nested bind mount from a Linux mountinfo snapshot", () => {
    const f = fixture();
    try {
      const bind = `28 22 0:21 /runner/bind ${f.nested} rw,relatime - overlay overlay rw`;
      const counters = { chmod: 0, rm: 0 };
      const ops = countingOps(linuxFixtureLookup(`${ubuntuRunnerMountInfo}\n${bind}`), counters);
      expect(() => freezeSameDeviceTree(f.root, "managed tree", ops)).toThrow(/mount boundary/);
      expect(counters).toEqual({ chmod: 0, rm: 0 });
      expect(readFileSync(f.victim, "utf8")).toBe("safe");
    } finally { f.cleanup(); }
  });

  it("rejects a same-st_dev descendant with a different mount ID before chmod or removal", () => {
    const f = fixture();
    try {
      expect(lstatSync(f.root).dev).toBe(lstatSync(f.nested).dev);
      const counters = { chmod: 0, rm: 0 };
      const ops = countingOps((paths) => paths.map((path) => path === f.nested ? "bind:2" : "root:1"), counters);
      expect(() => freezeSameDeviceTree(f.root, "managed tree", ops)).toThrow(/mount boundary/);
      expect(counters).toEqual({ chmod: 0, rm: 0 });
      expect(readFileSync(f.victim, "utf8")).toBe("safe");
    } finally { f.cleanup(); }
  });

  it("fails closed when a Linux bind mount appears after freeze and immediately before recursive deletion", () => {
    const f = fixture();
    try {
      let mounted = false;
      const counters = { chmod: 0, rm: 0 };
      const bind = `28 22 0:21 /runner/bind ${f.nested} rw,relatime - overlay overlay rw`;
      const ops = countingOps(
        (paths) => mountIdentitiesFromLinuxMountInfo(
          mounted ? `${ubuntuRunnerMountInfo}\n${bind}` : ubuntuRunnerMountInfo,
          paths,
        ),
        counters,
      );
      const frozen = freezeSameDeviceTree(f.root, "managed tree", ops);
      expect(() => removeFrozenSameDeviceTree(frozen, "managed tree", () => { mounted = true; }, { ops }))
        .toThrow(/mount identity/);
      expect(counters).toEqual({ chmod: 0, rm: 0 });
      expect(readFileSync(f.victim, "utf8")).toBe("safe");
    } finally { f.cleanup(); }
  });

  it("fails closed when mount identity lookup is unavailable or malformed", () => {
    for (const mountIdentities of [
      (() => { throw new Error("mount table unavailable"); }) as MountIdentityLookup,
      linuxFixtureLookup("22 invalid mountinfo"),
      (() => []) as MountIdentityLookup,
      ((paths: readonly string[]) => paths.map(() => "")) as MountIdentityLookup,
    ]) {
      const f = fixture();
      try {
        const counters = { chmod: 0, rm: 0 };
        const ops = countingOps(mountIdentities, counters);
        expect(() => freezeSameDeviceTree(f.root, "managed tree", ops)).toThrow(/mount identity could not be proven/);
        expect(counters).toEqual({ chmod: 0, rm: 0 });
        expect(readFileSync(f.victim, "utf8")).toBe("safe");
      } finally { f.cleanup(); }
    }
  });

  it("removes a complete same-mount tree through the shared helper", () => {
    const f = fixture();
    try {
      const counters = { chmod: 0, rm: 0 };
      const ops = countingOps(linuxFixtureLookup(), counters);
      const frozen = freezeSameDeviceTree(f.root, "managed tree", ops);
      removeFrozenSameDeviceTree(frozen, "managed tree", () => undefined, { writable: true, ops });
      expect(counters.chmod).toBe(2);
      expect(counters.rm).toBe(1);
      expect(existsSync(f.root)).toBe(false);
    } finally { f.cleanup(); }
  });
});
