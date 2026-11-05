import { defineConfig } from "vitest/config";

/**
 * Many tests in this package run the real CLI as a child process, so under vitest's 5000ms default
 * the verdict depends on machine load rather than on the code. It became visible with the test that
 * starts ten sessions at once: on a 4 vCPU runner one uninstall test went from 1.1 s to 5.9 s and
 * failed with nothing wrong. `packages/core/vitest.config.ts` has the same reasoning at more length.
 *
 * 5.9 s is the slowest measured so far among tests without their own timeout, and 20 s leaves room
 * for ordinary contention while still failing a hung test quickly. A test that needs longer should
 * carry its own timeout and say why.
 */
export default defineConfig({
  test: {
    testTimeout: 20_000,
  },
});
