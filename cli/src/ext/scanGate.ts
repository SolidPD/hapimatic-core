// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Supply-chain scan seam (#3120 creates the PINNED contract; Sub Q / #3131 fills it).
 *
 * This is the single registration point for a supply-chain scanner. #3131 will call
 * {@link setScanBeforeInstall} with its implementation; until then the gate is a
 * documented NO-OP PASS (an absent hook never blocks an install). Because the web install
 * path shells to `hapi ext install` (the marketplace subprocess re-invocation), a
 * CLI-side scanner registered here automatically covers web-initiated installs too.
 *
 * The contract shapes (`ScanBeforeInstall` / `StagedInstall` / `ScanVerdict`) live in
 * `@hapi/protocol` (`shared/src/harnessRecipe.ts`) so #3131 does not re-declare them.
 */
import type {
  ScanBeforeInstall,
  ScanVerdict,
  StagedInstall,
} from "@hapi/protocol";

let registeredScan: ScanBeforeInstall | undefined;

/**
 * Register the supply-chain scanner (#3131). Passing `undefined` clears it (test hygiene).
 * This is the ONLY seam #3131 needs to touch — it does not change the pinned contract.
 */
export function setScanBeforeInstall(
  hook: ScanBeforeInstall | undefined
): void {
  registeredScan = hook;
}

/** The currently-registered scanner, or `undefined` (no-op pass) until #3131 lands. */
export function getScanBeforeInstall(): ScanBeforeInstall | undefined {
  return registeredScan;
}

/**
 * Thrown when a supply-chain scan returns `{ verdict: "block" }`. Carries the findings so
 * the command layer can surface them. A block aborts the install BEFORE finalize/execution.
 */
export class ScanBlockedError extends Error {
  readonly findings: ScanVerdict["findings"];
  constructor(staged: StagedInstall, verdict: ScanVerdict) {
    const summary =
      verdict.findings.map(f => `[${f.severity}] ${f.message}`).join("; ") ||
      "no findings reported";
    super(
      `Supply-chain scan BLOCKED install of ${staged.kind} '${staged.id}': ${summary}`
    );
    this.name = "ScanBlockedError";
    this.findings = verdict.findings;
  }
}

/**
 * Run a scan hook against a staged install and throw {@link ScanBlockedError} on a block.
 * An ABSENT hook is a documented no-op PASS. Callers pass the hook explicitly (the FS-ext
 * leg threads it via `installExtension` opts; the harness-recipe leg reads
 * {@link getScanBeforeInstall} at the command layer) so both legs share one block path.
 */
export async function assertScanPass(
  hook: ScanBeforeInstall | undefined,
  staged: StagedInstall
): Promise<void> {
  if (!hook) return; // no-op pass until #3131 registers a scanner
  const verdict = await hook(staged);
  if (verdict.verdict === "block") {
    throw new ScanBlockedError(staged, verdict);
  }
}
