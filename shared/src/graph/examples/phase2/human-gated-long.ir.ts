// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Representative workflow #4 — LONG-RUNNING HUMAN-GATED, expressed as v0.1 Graph
 * IR (issue #2890, Graph Engineering Phase 2, Sub-Issue B, requirement R4).
 *
 * Real Hapimatic flow: the merge-dev-to-prod / production-deployment approval
 * flow — build the release, stage a canary, run smoke tests, PAUSE at a human
 * approval gate, then deploy to production behind that gate, then verify the live
 * version. The long-horizon, human-gated archetype (ruling: the expert-review
 * reconciliation chose the deployment-approval flow over an epic flow because it
 * exercises the effect-ledger path more broadly — a witnessed mutating deploy
 * with a queryable reconciliation).
 *
 * Construct coverage (coverage discipline): this one exercises `human_gate` (the
 * approval before the mutating step) and the EFFECT-LEDGER path — the production
 * deploy is `risk_tier: "mutating"` with the approval as its `authority.witness`
 * and `reconciliation: { queryable: ... }` (synthesis II.4: the run can query the
 * live version endpoint to reconcile an IN_DOUBT deploy). The compiler lowers the
 * gate to a `gate` node and the deploy to a `commit` node.
 *
 * Lint-clean by construction (V3): the `human_gate` has an outgoing edge to the
 * deploy (`INV-human-gate-has-continuation` — the ONE lint rule that most
 * naturally trips a human-gate workflow); the mutating deploy declares a keyed
 * idempotency + a queryable reconciliation (never both `"none"`, so
 * `INV-ledgered-mutating-effects` stays quiet) and lives on a `sequence` node,
 * not a `subgraph` (so the `INV-mutating-is-commit-node` advisory stays quiet);
 * and `verify_deploy` is a reachable `terminal: true` stop. Zero findings →
 * `compileIR` accepts it.
 */
import type { GraphIR } from "../../ir";

/**
 * A long-running human-gated deployment workflow as a valid, lint-clean,
 * compilable v0.1 `GraphIR`. `validateGraphIR(humanGatedLong).ok === true`
 * (Task 4 Verify).
 */
export const humanGatedLong: GraphIR = {
  id: "hapimatic-human-gated-long",
  version: "0.1",
  nodes: [
    // Build the release artifact (writes CI build output, not prod — no gate yet).
    {
      id: "build_release",
      kind: "sequence",
      resources: [{ name: "ci-build-artifacts", mode: "write" }],
    },
    // Stage the build onto a canary instance.
    { id: "stage_canary", kind: "sequence" },
    // Run smoke tests against the canary (read-only observation).
    {
      id: "run_smoke_tests",
      kind: "sequence",
      resources: [{ name: "canary-instance", mode: "read" }],
    },
    // Human approval gate — the long-horizon pause before the mutating deploy.
    {
      id: "deploy_approval",
      kind: "human_gate",
      gate_id: "production-deploy-approval",
      approver: "release-manager",
    },
    // Deploy to production — the witnessed mutating step. The compiler lowers
    // this to a commit node; the approval is the authority witness and the live
    // version endpoint is the queryable reconciliation for an IN_DOUBT deploy.
    {
      id: "deploy_production",
      kind: "sequence",
      resources: [{ name: "prod-instance(3008)", mode: "write" }],
      effects: [
        {
          access: "write",
          // keyed on the release version → a re-applied deploy dedups across a
          // crash window.
          idempotency: { keyed: "release-version" },
          // a bad deploy is reversible by rolling back to the previous binary.
          reversibility: { compensatable: "rollback-previous-binary" },
          // the human approval gate is the authority witness for the deploy.
          authority: { witness: ["release-manager-approval"] },
          // reconcile an uncertain deploy by querying the live version endpoint
          // (synthesis II.4 — the queryable reconciliation path).
          reconciliation: {
            queryable: "api-version-endpoint-reports-release-version",
          },
          risk_tier: "mutating",
        },
      ],
    },
    // Verify the live version reports the new release — the terminal stop.
    {
      id: "verify_deploy",
      kind: "sequence",
      terminal: true,
      resources: [{ name: "prod-instance(3008)", mode: "read" }],
    },
  ],
  edges: [
    { from: "build_release", to: "stage_canary" },
    { from: "stage_canary", to: "run_smoke_tests" },
    { from: "run_smoke_tests", to: "deploy_approval" },
    // The human_gate's continuation — an approved gate leads into the deploy.
    { from: "deploy_approval", to: "deploy_production" },
    { from: "deploy_production", to: "verify_deploy" },
  ],
};
