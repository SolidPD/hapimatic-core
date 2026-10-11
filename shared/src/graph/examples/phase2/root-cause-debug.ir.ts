// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Representative workflow #3 — ROOT-CAUSE DEBUGGING, expressed as v0.1 Graph IR
 * (issue #2890, Graph Engineering Phase 2, Sub-Issue B, requirement R3).
 *
 * Real Hapimatic flow: the diagnostic-first debugging loop (RULES.md
 * "Diagnostic-First Debugging" / issue-worker Phase 12) — observe the failure,
 * form hypotheses, branch on which hypothesis to probe, verify against real
 * runtime state, retry a bounded number of times, then apply the fix and confirm
 * (escalating to a human when the retry budget is exhausted).
 *
 * Construct coverage (coverage discipline): this one exercises `branch`
 * (which-hypothesis switch, ordered guarded arms + a required default), a bounded
 * `loop` (`max_iterations` + an `on_exhaustion` route to an AUTHORED escalate
 * node — ruling 1B-11), and a `risk_tier: "mutating"` fix effect. v0.1 has NO
 * `commit` node kind (commit nodes are compiled-artifact constructs); the fix is
 * a regular `sequence` node whose mutating effect the compiler LOWERS to a commit
 * node with a fencing `idempotency_key` + effect ledger (ruling 1B-11).
 *
 * Lint-clean by construction (V3): the branch arms carry DISTINCT `when`
 * predicates (`INV-reachable-branch-arms`); the loop is bounded and its
 * exhaustion route resolves (`INV-bounded-loops`); the fix effect declares a
 * keyed idempotency + a queryable reconciliation, so it never trips
 * `INV-ledgered-mutating-effects`; and both `confirm_fix` and `escalate` are
 * reachable `terminal: true` stopping points. Zero findings → `compileIR`
 * accepts it.
 */
import type { GraphIR } from "../../ir";

/**
 * A root-cause debugging workflow as a valid, lint-clean, compilable v0.1
 * `GraphIR`. `validateGraphIR(rootCauseDebug).ok === true` (Task 3 Verify).
 */
export const rootCauseDebug: GraphIR = {
  id: "hapimatic-root-cause-debug",
  version: "0.1",
  nodes: [
    // Observe the failure — read logs + telemetry (read-only).
    {
      id: "observe",
      kind: "sequence",
      resources: [{ name: "logs+telemetry(session)", mode: "read" }],
    },
    // Form candidate hypotheses from the observations.
    { id: "hypothesize", kind: "sequence" },
    // Branch on WHICH hypothesis to probe first (deterministic switch).
    {
      id: "select_hypothesis",
      kind: "branch",
      branches: [
        { when: "resource-contention-suspected", to: "probe_resource" },
        { when: "logic-error-suspected", to: "probe_logic" },
      ],
      default: "probe_logic",
    },
    // Probe the resource-contention hypothesis by reading runtime state.
    {
      id: "probe_resource",
      kind: "sequence",
      resources: [{ name: "runtime-state(session)", mode: "read" }],
    },
    // Probe the logic-error hypothesis by reading runtime state.
    {
      id: "probe_logic",
      kind: "sequence",
      resources: [{ name: "runtime-state(session)", mode: "read" }],
    },
    // Verify the probe result against the observed failure.
    { id: "verify_root_cause", kind: "sequence" },
    // Bounded retry of the hypothesis loop; exhaustion escalates to a human.
    {
      id: "retry_hypotheses",
      kind: "loop",
      max_iterations: 3,
      on_exhaustion: "escalate",
    },
    // Apply the fix — the mutating step. The compiler lowers this to a commit
    // node (fencing key + effect ledger). A keyed idempotency + a queryable
    // reconciliation satisfy INV-ledgered-mutating-effects.
    {
      id: "apply_fix",
      kind: "sequence",
      resources: [{ name: "source-tree(target-repo)", mode: "write" }],
      effects: [
        {
          access: "write",
          idempotency: { keyed: "root-cause-id+fix-commit" },
          reversibility: { compensatable: "git-revert-fix-commit" },
          authority: "none",
          reconciliation: { queryable: "git-log-shows-fix-commit" },
          risk_tier: "mutating",
        },
      ],
    },
    // Confirm the fix resolved the failure — a terminal stopping point.
    { id: "confirm_fix", kind: "sequence", terminal: true },
    // Retry budget exhausted → escalate to a human — the other terminal outcome.
    { id: "escalate", kind: "sequence", terminal: true },
  ],
  edges: [
    { from: "observe", to: "hypothesize" },
    { from: "hypothesize", to: "select_hypothesis" },
    // Both probe arms converge on the verification step.
    { from: "probe_resource", to: "verify_root_cause" },
    { from: "probe_logic", to: "verify_root_cause" },
    // Verification enters the bounded retry loop.
    { from: "verify_root_cause", to: "retry_hypotheses" },
    // Loop resolved (root cause found) → apply the fix.
    { from: "retry_hypotheses", to: "apply_fix" },
    // Fix applied → confirm it.
    { from: "apply_fix", to: "confirm_fix" },
  ],
};
