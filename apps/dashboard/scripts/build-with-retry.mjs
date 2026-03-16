#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";

const NEXT_BIN = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
const RETRYABLE_PATTERNS = [
  /ENOENT: no such file or directory.*routes-manifest\.json/s,
  /ENOENT: no such file or directory.*pages-manifest\.json/s,
];

function runNextBuild() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [NEXT_BIN, "build"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["inherit", "pipe", "pipe"],
    });

    let combinedOutput = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      combinedOutput += text;
      process.stdout.write(chunk);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      combinedOutput += text;
      process.stderr.write(chunk);
    });

    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({
        code: code ?? 1,
        signal,
        combinedOutput,
      });
    });
  });
}

function isRetryableStandaloneManifestFailure(output) {
  return RETRYABLE_PATTERNS.some((pattern) => pattern.test(output));
}

const firstAttempt = await runNextBuild();

if (firstAttempt.code === 0) {
  process.exit(0);
}

if (!isRetryableStandaloneManifestFailure(firstAttempt.combinedOutput)) {
  process.exit(firstAttempt.code);
}

console.warn(
  "Retrying dashboard build after a flaky Next standalone manifest ENOENT during cold build...",
);

const secondAttempt = await runNextBuild();

if (secondAttempt.code === 0) {
  process.exit(0);
}

if (secondAttempt.signal) {
  process.kill(process.pid, secondAttempt.signal);
}

process.exit(secondAttempt.code);
