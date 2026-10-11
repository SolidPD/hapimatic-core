// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Phase-2 representative-workflow corpus barrel — issue #2890 (Graph Engineering
 * Phase 2, Sub-Issue B, requirement R5 / Task 5).
 *
 * The four representative production workflows expressed as v0.1 Graph IR, plus
 * the LOCKED `PHASE2_WORKFLOWS` export that the downstream benchmark (#2891) and
 * evidence report (#2892) index into. They collectively span the representative
 * surface: investigation · implementation · debugging · human-gated long-horizon
 * (V4).
 *
 * 🔒 EXPORT SHAPE LOCKED (expert-review reconciliation ruling D3(a)):
 * `PHASE2_WORKFLOWS` is `ReadonlyArray<{ id; ir; metrics }>` with STABLE ids and
 * `metrics` = the frozen #2889 absolute metric IDs (`A1..A8`) each workflow
 * exercises in #2891. Consumed by #2891 (benchmark + fault injection) and #2892
 * (evidence report) — do NOT reshape (id union, field names, or their meaning)
 * without flagging both. The per-workflow `metrics` sets are cross-referenced in
 * `claudedocs/graph-engineering/phase-2-workflow-catalog.md` (with the expected
 * evidence class per metric, ruling D2(a)).
 *
 * Importable out-of-workspace as `@hapi/protocol/graph/examples/phase2` (the
 * `shared/package.json` subpath export added by this issue, mirroring #2887's
 * `@hapi/protocol/graph/examples/issue-workflow` precedent, ruling D3(a)).
 */
import type { GraphIR } from "../../ir";
import { deepResearch } from "./deep-research.ir";
import { issueImplementation } from "./issue-implementation.ir";
import { rootCauseDebug } from "./root-cause-debug.ir";
import { humanGatedLong } from "./human-gated-long.ir";

export { deepResearch } from "./deep-research.ir";
export { issueImplementation } from "./issue-implementation.ir";
export { rootCauseDebug } from "./root-cause-debug.ir";
export { humanGatedLong } from "./human-gated-long.ir";

/**
 * The stable id set for the Phase-2 corpus (a NAMED alias for the locked id
 * union — structurally identical to ruling D3(a)'s inline annotation). #2891 /
 * #2892 select workflows by these ids.
 */
export type Phase2WorkflowId =
  | "deep-research"
  | "issue-implementation"
  | "root-cause-debug"
  | "human-gated-long";

/**
 * The LOCKED Phase-2 export (ruling D3(a)). Each entry carries a stable `id`, its
 * `ir` (a valid, lint-clean, compilable v0.1 `GraphIR`), and `metrics` — the
 * frozen #2889 absolute metric IDs the workflow exercises when driven through the
 * #2891 benchmark. The `metrics` sets are DISTINCT per workflow (each declares
 * only the metrics it genuinely subjects); `A6` (resource-conflict) has no
 * clean-workflow subject by design — it is exercised only by #2891's injected
 * conflicting-parallel variants, and the protocol assigns it no
 * critical-correctness gate.
 */
export const PHASE2_WORKFLOWS: ReadonlyArray<{
  id: Phase2WorkflowId;
  ir: GraphIR;
  metrics: ReadonlyArray<string>;
}> = [
  {
    // Investigation surface: map/join, read-only multi-hop research.
    // A1 node identity · A2 join explainability · A3 defined stop (report).
    id: "deep-research",
    ir: deepResearch,
    metrics: ["A1", "A2", "A3"],
  },
  {
    // Implementation surface: full pipeline reusing #2887 (human_gate + mutating
    // close). A1 identity · A3 stop (closed) · A4 unsafe-graph rejection (the
    // #2887 broken variant is the fault-injection subject) · A7 effect
    // classification (the mutating close) · A8 operator sees the approval gate.
    id: "issue-implementation",
    ir: issueImplementation,
    metrics: ["A1", "A3", "A4", "A7", "A8"],
  },
  {
    // Debugging surface: branch/bounded-loop + mutating fix. A1 identity · A2
    // branch explainability (which hypothesis) · A3 stop (confirm/escalate) ·
    // A4 unsafe-graph rejection (unbounded-loop fault injection) · A7 effect
    // classification (the mutating fix).
    id: "root-cause-debug",
    ir: rootCauseDebug,
    metrics: ["A1", "A2", "A3", "A4", "A7"],
  },
  {
    // Human-gated long-horizon surface: human_gate + witnessed mutating deploy.
    // A1 identity · A3 stop (verify) · A5 charter recovery (long-running, resumable
    // deploy) · A7 effect classification (the mutating deploy) · A8 operator sees
    // the pending deploy-approval gate.
    id: "human-gated-long",
    ir: humanGatedLong,
    metrics: ["A1", "A3", "A5", "A7", "A8"],
  },
];
