// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Test-only poll-until-condition helpers.
 *
 * Consolidates the ad-hoc `waitUntil` / `waitFor` / deadline-loop helpers that
 * were hand-rolled independently across the `cli/src` test suites (issue #2439,
 * the follow-up to #2365). A test that waits on tmux / pane / file / mock state
 * should poll the condition it actually cares about rather than sleeping a
 * guessed interval: a fixed sleep must cover the worst case yet is dead time in
 * the common one, and it still races under load (the pane marker measured in
 * #2365 arrived in 29-116ms, so a former 800ms sleep was 7-27x more than needed
 * AND could still elapse early on a loaded machine, failing as a misleading
 * assertion error instead of an honest timeout).
 *
 * Two contracts are exported so every migrated call site keeps its semantics:
 *   - `waitUntil` returns whether the predicate held and NEVER throws — the
 *     caller keeps its own assertion as the thing that decides pass/fail, so a
 *     genuine regression still fails loudly instead of being absorbed here.
 *   - `waitFor` is the throwing wrapper for sites that assert-by-throw.
 *
 * 🔴 REAL timers only. Both helpers sleep via `setTimeout`, so they MUST NOT be
 * called under `vi.useFakeTimers()` — the interval sleep never resolves without
 * a real clock and the poll hangs until the test timeout. A fake-timer test
 * should drive its condition with `vi.advanceTimersByTimeAsync()` instead.
 *
 * Runtime-neutral: plain `setTimeout` / `Promise`, no Bun-only APIs (`cli` tests
 * run under the Vitest/Node runtime, not Bun).
 */

export interface WaitOptions {
  /** Give up after this many milliseconds (default 5000). */
  timeoutMs?: number;
  /** Delay between predicate evaluations (default 25). */
  intervalMs?: number;
}

export interface WaitForOptions extends WaitOptions {
  /** Error message thrown on timeout (default "waitFor: condition not met within timeout"). */
  message?: string;
}

/**
 * Poll `pred` until it is truthy or the deadline passes. Returns whether the
 * predicate held. Never throws.
 *
 * The deadline is checked first, the predicate is evaluated before the first
 * sleep, and there is no post-deadline final evaluation — matching the existing
 * `waitUntil` shape in `claudeTmuxRemoteLauncher.test.ts` (#2365).
 */
export async function waitUntil(
  pred: () => boolean | Promise<boolean>,
  { timeoutMs = 5000, intervalMs = 25 }: WaitOptions = {}
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return false;
}

/**
 * Poll `pred` until it is truthy or the deadline passes, throwing on timeout.
 * The throwing wrapper for sites that assert-by-throw.
 */
export async function waitFor(
  pred: () => boolean | Promise<boolean>,
  { message, ...poll }: WaitForOptions = {}
): Promise<void> {
  if (!(await waitUntil(pred, poll))) {
    throw new Error(message ?? "waitFor: condition not met within timeout");
  }
}
