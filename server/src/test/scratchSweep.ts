// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Test preload (server/bunfig.toml), issue #6158 D3. Before the tests: remove
 * the scratch run dirs a killed or interrupted earlier run left under
 * `~/.hapi-test-scratch`. After them (a global `afterAll`, which bun runs after
 * every file under `--isolate` and even when `-t` matched nothing): remove this
 * process's own run dir. A preload that throws aborts the whole run, so a
 * failure here only warns.
 */
import { afterAll } from "bun:test";
import { removeOwnRunDir, sweepStaleTestScratch } from "./scratchRoot";

try {
  sweepStaleTestScratch();
} catch (err) {
  console.warn(`[test-scratch] stale-run sweep failed: ${String(err)}`);
}

afterAll(() => {
  try {
    removeOwnRunDir();
  } catch (err) {
    console.warn(`[test-scratch] run-dir cleanup failed: ${String(err)}`);
  }
});
