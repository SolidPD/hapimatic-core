// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Representative workflow #2 — ISSUE IMPLEMENTATION, expressed as v0.1 Graph IR
 * (issue #2890, Graph Engineering Phase 2, Sub-Issue B, requirement R2).
 *
 * 🔴 REUSE, NEVER FORK (cross-epic reuse contract). Phase-1 Sub-Issue E (#2887)
 * already expressed Hapimatic's own issue-workflow pipeline as a valid,
 * lint-clean, compilable v0.1 `GraphIR` (`issueWorkflow`). The expert-review
 * reconciliation for #2890 (ruling 1B-7) established that #2887's workflow IS a
 * superset (all 9 `WORKFLOW_PHASES` stages + the approval gate + the mutating
 * close), so R2 takes the import/re-export branch: this file re-exports the
 * Phase-1 constant under a Phase-2 name rather than authoring a divergent copy.
 * Copying node definitions here would create two divergent issue-implementation
 * graphs — exactly what the reuse contract forbids.
 *
 * Real Hapimatic flow: the issue-worker → tester → refactor-reflector →
 * approval-gated closer pipeline (created … closed). It is the IMPLEMENTATION
 * workflow and it already carries a real `human_gate` (the approval-gated close,
 * MUST_HOLD invariant #1) and a real `risk_tier: "mutating"` effect (the
 * label-transition on close, which the compiler lowers to a `commit` node) — so
 * it exercises the human-gate + effect-ledger surface without duplicating them.
 */
import type { GraphIR } from "../../ir";
import { issueWorkflow } from "../issue-workflow.ir";

/**
 * R2: the issue-implementation workflow IS #2887's `issueWorkflow`, re-exported
 * under a Phase-2 name. `validateGraphIR(issueImplementation).ok === true`
 * follows from #2887's own V2 proof — this is the same object, not a copy.
 */
export const issueImplementation: GraphIR = issueWorkflow;
