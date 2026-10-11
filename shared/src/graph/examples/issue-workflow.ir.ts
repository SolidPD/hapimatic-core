// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A REAL Hapimatic workflow expressed as v0.1 Graph IR — issue #2887 (Graph
 * Engineering Phase 1, sub-issue E), requirements R2 + R5.
 *
 * This encodes Hapimatic's own issue-workflow state machine — the very pipeline
 * this sweep runs — sourced from `shared/src/workflowPhases.ts` `WORKFLOW_PHASES`
 * (the 9-phase table: created · formatted · researched · expert-reviewed ·
 * worked · tested · refactor-reflected · pr-reviewing[lock-only] · closed). It is
 * a genuine in-repo, well-specified workflow with a real human gate (the
 * approval-gated close, MUST_HOLD invariant #1) and a real mutating effect (the
 * label transition on close), so it is a meaningful — not toy — subject for the
 * Epic-1 exit criterion "every IR field has a named consumer".
 *
 * Modeling decisions (locked by the expert-review reconciliation, 2026-08-15):
 *  - Each `WORKFLOW_PHASES` stage is a `sequence`-kind LEAF node (ruling D1-B: the
 *    v0.1 IR has no `agent` construct — a stage IS a leaf work unit). All 9
 *    phases are present, including the order-8 `pr-reviewing` lock-only stage.
 *  - The `closed` stage is `terminal: true` (ruling D2-a — the IR's decided
 *    terminal representation; there is deliberately no `end` node kind).
 *  - A `human_gate` models the approval-gated close; its outgoing edge to
 *    `pr_reviewing` is the continuation the linter requires
 *    (`INV-human-gate-has-continuation`).
 *  - The label-transition effect on `closed` is `risk_tier: "mutating"` with a
 *    keyed idempotency + `keyed-dedup` reconciliation + the approval as its
 *    authority witness — arbiter-backed fencing (issue-label transitions are
 *    arbiter-backed, #1318). This is exactly the declaration the linter's
 *    `INV-ledgered-mutating-effects` rule demands and the compiler lowers to a
 *    dedicated `commit` node.
 *
 * 🔒 CF-8 LOCKED EXPORT. `issueWorkflow` is a cross-epic contract consumed by
 * Phase-2 #2890/#2891 via the `@hapi/protocol/graph/examples/issue-workflow`
 * subpath export (`shared/package.json`). Its shape is pinned by the type-snapshot
 * test in `issue-workflow.test.ts`; do NOT let a downstream sweep fork this file.
 */
import type { GraphIR } from "../ir";

/**
 * Hapimatic's issue-workflow pipeline as a valid, lint-clean, compilable v0.1
 * `GraphIR`. Passes `validateGraphIR` (V2), lints clean under BOTH provenance
 * classes (V3-correct), and compiles to a `CompiledWorkflow` (V4).
 */
export const issueWorkflow: GraphIR = {
  id: "hapimatic-issue-workflow",
  version: "0.1",
  nodes: [
    // ── order 1: created ──────────────────────────────────────────────────
    { id: "created", kind: "sequence" },
    // ── order 2: formatted ────────────────────────────────────────────────
    { id: "formatted", kind: "sequence" },
    // ── order 3: researched — reads the codebase (read-only, no conflict) ──
    {
      id: "researched",
      kind: "sequence",
      resources: [{ name: "codebase(hapimatic-private)", mode: "read" }],
    },
    // ── order 4: expert-reviewed ──────────────────────────────────────────
    { id: "expert_reviewed", kind: "sequence" },
    // ── order 5: worked — writes the isolated worktree; retries up to 3 ────
    //    patch iterations (Phase 12 patch mode). A lone sequential writer, so
    //    the git-object-db concurrency rule cannot fire.
    {
      id: "worked",
      kind: "sequence",
      resources: [{ name: "git-worktree(issue-branch)", mode: "write" }],
      retry: { max: 3 },
    },
    // ── order 6: tested ───────────────────────────────────────────────────
    { id: "tested", kind: "sequence" },
    // ── order 7: refactor-reflected ───────────────────────────────────────
    { id: "refactor_reflected", kind: "sequence" },
    // ── the approval-gated close (MUST_HOLD invariant #1) ─────────────────
    {
      id: "approval_gate",
      kind: "human_gate",
      gate_id: "issue-approval",
      approver: "human-maintainer",
    },
    // ── order 8: pr-reviewing (lock-only stage; checkpoint null) ──────────
    { id: "pr_reviewing", kind: "sequence" },
    // ── order 9: closed — terminal; the mutating label-transition effect ──
    {
      id: "closed",
      kind: "sequence",
      terminal: true,
      resources: [
        { name: "github-issue-labels(hapimatic-private)", mode: "write" },
      ],
      effects: [
        {
          access: "write",
          // keyed on (issue, target checkpoint) → the effect-ledger can dedup a
          // re-applied label across a crash window.
          idempotency: { keyed: "issue-number+target-checkpoint" },
          // a mis-applied close is reversible by reopening + restoring labels.
          reversibility: {
            compensatable: "reopen-issue-restores-prior-labels",
          },
          // the human approval gate is the authority witness for the transition.
          authority: { witness: ["human-maintainer-approval"] },
          // arbiter-backed fencing: label transitions reconcile by key (#1318).
          reconciliation: "keyed-dedup",
          risk_tier: "mutating",
        },
      ],
    },
  ],
  edges: [
    { from: "created", to: "formatted" },
    { from: "formatted", to: "researched" },
    { from: "researched", to: "expert_reviewed" },
    { from: "expert_reviewed", to: "worked" },
    { from: "worked", to: "tested" },
    { from: "tested", to: "refactor_reflected" },
    { from: "refactor_reflected", to: "approval_gate" },
    // the human_gate's continuation — an approved gate leads into the close.
    { from: "approval_gate", to: "pr_reviewing" },
    { from: "pr_reviewing", to: "closed" },
  ],
};
