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
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
