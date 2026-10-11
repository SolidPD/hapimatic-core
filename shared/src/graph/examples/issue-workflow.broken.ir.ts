// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A deliberately-broken variant of the issue-workflow IR — issue #2887 (Graph
 * Engineering Phase 1, sub-issue E), requirement R3. This graph is STRUCTURALLY
 * VALID (`validateGraphIR(...).ok === true` — unique ids, no dangling refs) yet
 * trips the linter, proving the seeded rules fire on a real (broken) graph and
 * that the linter catches SEMANTIC defects the structural validator passes.
 *
 * It seeds ONE finding from EACH provenance class:
 *  - INCIDENT_DERIVED (#2884 `git-object-db-write-conflict`): a `parallel`
 *    fan-out whose two sibling nodes BOTH declare `write` access to the same
 *    exclusive resource `git-object-db(hapimatic-private)` — the exact shape of
 *    the 2026-05-17 shared-`.git/` subagent shallow-fetch corruption incident.
 *  - SEMANTIC_INVARIANT (#2885 `unledgered-mutating-effect`): the `closed`
 *    stage's `mutating` label-transition effect declares `idempotency:"none"`
 *    AND `reconciliation:"none"` — the effect-ledger then has no key to dedup on
 *    and no query to reconcile (a `mutating` effect that cannot be made safe on
 *    resume).
 *
 * Both defects are statically decidable, so `runLinter(issueWorkflowBroken, …)`
 * returns `ok: false` with ≥ 2 findings, and `compileIR(issueWorkflowBroken)`
 * throws `CompileError` (the lint → compile gate rejects it).
 */
import type { GraphIR } from "../ir";

/**
 * The broken variant. Do NOT export this from the `@hapi/protocol/graph/examples/
 * issue-workflow` subpath — only the clean `issueWorkflow` is the CF-8 Phase-2
 * contract. This lives beside it purely as the linter's proof-of-life fixture.
 */
export const issueWorkflowBroken: GraphIR = {
  id: "hapimatic-issue-workflow-broken",
  version: "0.1",
  nodes: [
    { id: "created", kind: "sequence" },
    { id: "formatted", kind: "sequence" },
    {
      id: "researched",
      kind: "sequence",
      resources: [{ name: "codebase(hapimatic-private)", mode: "read" }],
    },
    { id: "expert_reviewed", kind: "sequence" },
    {
      id: "worked",
      kind: "sequence",
      resources: [{ name: "git-worktree(issue-branch)", mode: "write" }],
      retry: { max: 3 },
    },
    // ── BREAKAGE (b): concurrent conflicting writes to the shared git-object-db.
    //    Two parallel siblings both `write` the SAME exclusive resource — the
    //    2026-05-17 shared-`.git/` corruption shape. Trips
    //    `git-object-db-write-conflict` (INV-no-concurrent-exclusive-writes).
    {
      id: "fanout",
      kind: "parallel",
      targets: ["worker_git_a", "worker_git_b"],
    },
    {
      id: "worker_git_a",
      kind: "sequence",
      resources: [{ name: "git-object-db(hapimatic-private)", mode: "write" }],
    },
    {
      id: "worker_git_b",
      kind: "sequence",
      resources: [{ name: "git-object-db(hapimatic-private)", mode: "write" }],
    },
    {
      id: "join_workers",
      kind: "join",
      upstreams: ["worker_git_a", "worker_git_b"],
    },
    { id: "tested", kind: "sequence" },
    { id: "refactor_reflected", kind: "sequence" },
    {
      id: "approval_gate",
      kind: "human_gate",
      gate_id: "issue-approval",
      approver: "human-maintainer",
    },
    { id: "pr_reviewing", kind: "sequence" },
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
          // ── BREAKAGE (a): unledgered mutating effect — nothing to key or
          //    reconcile on. Trips `unledgered-mutating-effect`
          //    (INV-ledgered-mutating-effects).
          idempotency: "none",
          reversibility: {
            compensatable: "reopen-issue-restores-prior-labels",
          },
          authority: { witness: ["human-maintainer-approval"] },
          reconciliation: "none",
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
    { from: "worked", to: "fanout" },
    // fan-out targets are structural (parallel.targets); the branches rejoin:
    { from: "worker_git_a", to: "join_workers" },
    { from: "worker_git_b", to: "join_workers" },
    { from: "join_workers", to: "tested" },
    { from: "tested", to: "refactor_reflected" },
    { from: "refactor_reflected", to: "approval_gate" },
    { from: "approval_gate", to: "pr_reviewing" },
    { from: "pr_reviewing", to: "closed" },
  ],
};
