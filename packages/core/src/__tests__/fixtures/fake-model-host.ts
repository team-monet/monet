import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { serveSharedModel } from "../../shared-model";
import type { ModelHost } from "../../embedding-onnx";

// A real host process around a model that answers instantly and identifies itself, so the election,
// kill and idle behaviour under test run across real process boundaries without any download.
const basePath = process.argv[2]!;

// What the host would load from, for the test that a session's relative override reaches it resolved.
writeFileSync(`${basePath}.cache`, process.env.MONET_MODEL_CACHE ?? "");

// Stands for a machine where the host cannot start at all.
if (existsSync(`${basePath}.refuse`)) process.exit(1);

const host: ModelHost = {
  async embed(_spec, text) {
    if (text === "__fail__") throw new Error("injected model failure");
    if (text === "__slow__") await new Promise((resolve) => setTimeout(resolve, 1_500));
    if (text === "__tick__") await new Promise((resolve) => setTimeout(resolve, 300));
    if (text === "__hang__") await new Promise(() => {});
    if (text === "__exact__") {
      return new Float32Array(new Uint32Array([0x7fc00001, 0x7f800000, 0x80000000, 0x00000001, 0x3f800000]).buffer);
    }
    return Float32Array.of(process.pid, ...Array.from(text, (_, index) => text.charCodeAt(index)).slice(0, 64));
  },
  async countTokens(_spec, text) {
    return text.length;
  },
  async inputWindow() {
    return process.pid;
  },
};

const server = await serveSharedModel({
  basePath,
  host,
  ...(process.env.FAKE_HOST_IDLE_EXIT_MS ? { idleExitMs: Number(process.env.FAKE_HOST_IDLE_EXIT_MS) } : {}),
});
if (server !== null) {
  appendFileSync(`${basePath}.winners`, `${process.pid}\n`);
  await server.closed;
}
process.exit(0);
