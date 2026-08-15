import { defineConfig } from "vitest/config";

/**
 * The first vitest config this package has had. Before it, no `testTimeout` was set anywhere, so
 * vitest's 5000ms default governed a suite that contains tests which legitimately run far longer.
 *
 * WHY THAT WAS A PROBLEM WORTH FIXING, and it is not "tests are slow". The default made the suite's
 * verdict depend on machine load rather than on the code under test: the same commit passed alone
 * and failed under a full parallel run, and the FAILING SET SHUFFLED between runs. A verdict that
 * moves without the code moving cannot be used as evidence — and it was being used as evidence, on
 * every PR. Measured across one afternoon on this repo at 2026-08-12: 18 failures at the default,
 * 2 at 30s, and 6 on an untouched `main` under the same conditions. Every one was `Test timed out`.
 *
 * THE NUMBER COMES FROM THE OBSERVED DURATIONS, not from a round figure. The legitimately-slow
 * tests in this suite were measured at 5.1, 5.4, 6.3, 6.9, 8.2, 8.6, 10.6, 12.1 and 16.6 seconds
 * under full parallel load. 30s is a little under twice the slowest of those, which is enough
 * headroom that ordinary contention cannot reach it while still failing a genuinely hung test in
 * well under a minute. If a future test needs more than this, that test should carry its own
 * timeout argument and say why — raising this constant to accommodate one test would hide the next
 * hang behind it.
 *
 * `hookTimeout` moves with it, and for the same reason: several suites clone git repositories in
 * `beforeEach`, which is the same kind of work under the same contention, and a hook that times out
 * fails its tests with a message that points at the wrong place.
 *
 * NOT ADDRESSED HERE: the tests that take double-digit seconds are doing real work (corpus replay,
 * git materialization) and are slow by nature rather than by defect. This makes their verdict
 * honest; it does not make them fast.
 */

/**
 * `maxThreads` on CI is a SEPARATE mechanism from the timeouts above, and neither one affects the
 * other. It exists because the first CI run on GitHub failed with every test passing:
 *
 *     Tests 2257 passed | 10 skipped     Errors 1 error
 *     Unhandled Error: [vitest-worker]: Timeout calling "onTaskUpdate"
 *
 * That error is not a test timeout and `testTimeout` cannot reach it. It comes from the bundled
 * birpc transport, whose `DEFAULT_TIMEOUT` is a hardcoded 60000ms that neither pool passes an
 * override for, so no vitest config option changes it in 3.2.7 — the upstream PR that would have
 * made it configurable (vitest-dev/vitest#8227) was closed unmerged. `onTaskUpdate` awaits a reply,
 * unlike console forwarding, which is fire-and-forget and therefore cannot time out. The failure
 * condition is a worker thread blocked synchronously long enough that it cannot service the reply.
 *
 * WHY FEWER WORKERS. `gates.test.ts` is the only file in the suite whose own duration — 64.5s of a
 * 125s run — exceeds that 60s ceiling on its own, and it makes 273 synchronous better-sqlite3 calls,
 * which block a worker exactly as a synchronous subprocess does. Standard runners give 4 vCPU and
 * vitest sizes the pool at `numCpus - 1`, so three workers were contending for four cores. Fewer
 * workers means each one's own wall-clock shrinks, which is what has to drop below the ceiling.
 *
 * IT IS `forks`, NOT `threads` — CHECK BEFORE YOU CHANGE THIS. The bundle contains exactly one pool
 * default, `resolved.pool ??= "threads"`, and reading it is how the first attempt at this cap
 * configured `poolOptions.threads` and silently did nothing at all. The governing pool is `forks`,
 * established by a probe test that printed `worker_threads.isMainThread === true` — tests execute in
 * a child process's main thread, which the threads pool cannot produce. Source reading lost to a
 * five-line runtime probe here; if you touch this, run the probe rather than re-reading the bundle.
 *
 * THIS IS A MITIGATION, NOT A PROOF. It reduces the wall-clock a blocked worker accumulates; it does
 * not remove the blocking. If the error returns, the next move is to make the synchronous work
 * async rather than to cut workers further — `source-git.test.ts` performs 84 `execFileSync` calls
 * through one helper, which is the shape upstream reporters fixed. Do not reach for
 * `dangerouslyIgnoreUnhandledErrors`: it does not touch this cause and would silence every future
 * unhandled rejection in the suite along with it.
 *
 * Local runs are left alone. The failure has never reproduced off CI.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    ...(process.env.CI ? { poolOptions: { forks: { maxForks: 2 } } } : {}),
  },
});
