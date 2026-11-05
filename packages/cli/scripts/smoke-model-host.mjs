/**
 * Does the built model host start and answer? Needs no model: an unknown operation is refused by the
 * host itself, so a refusal proves the bundle loads, takes its lock, listens and speaks the protocol.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../dist/model-host.js", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "monet-host-"));
const base = join(dir, "smoke");
let stderr = "";
const host = spawn(process.execPath, [entry, base], { stdio: ["ignore", "ignore", "pipe"] });
host.stderr.on("data", (chunk) => (stderr += chunk));

function finish(error) {
  host.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
  if (error) {
    console.error(`model host smoke test failed: ${error}\n${stderr}`);
    process.exit(1);
  }
  console.log("model host started, answered, and refused an unknown operation");
  process.exit(0);
}

host.once("exit", (code) => finish(`it exited early with code ${code}`));
setTimeout(() => finish("no answer within 30 seconds"), 30_000);

const socketPath = `${base}.sock`;
while (!existsSync(socketPath)) await new Promise((resolve) => setTimeout(resolve, 50));

let pid = null;
try {
  pid = Number(readFileSync(`${base}.pid`, "utf8"));
} catch (error) {
  finish(error.message);
}
if (pid !== host.pid) finish(`it recorded pid ${pid}, not ${host.pid}`);

const socket = connect(socketPath, () => socket.write('{"id":1,"op":"smoke"}\n'));
socket.setEncoding("utf8");
socket.on("error", (error) => finish(error.message));
socket.once("data", (chunk) => {
  let answer = null;
  try {
    answer = JSON.parse(chunk.split("\n")[0]);
  } catch {
    finish(`unexpected answer ${chunk}`);
  }
  finish(answer.id === 1 && answer.ok === false ? null : `unexpected answer ${chunk}`);
});
