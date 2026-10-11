// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Workflow reconcile service config (issue #1672, epic #1662 Sub J — R6).
 *
 * Gates the periodic GitHub-timeline poller that absorbs out-of-band label edits
 * into `workflow_reconcile` (which `v_workflow_state` UNIONs). DEFAULT DISABLED
 * (KD3): the read path (badge + chips, derived from turn events) ships
 * independently; the poller is opt-in until its gh-quota + federation behavior
 * are validated in the field.
 *
 * Env-gated, read once at boot (mirrors the rate-limit configs):
 *   HAPI_WORKFLOW_RECONCILE_ENABLED      "true" to enable (default: false)
 *   HAPI_WORKFLOW_RECONCILE_INTERVAL_MS  poll cadence ms (default: 300000 = 5 min,
 *                                        matching github.ts ISSUE_CACHE_TTL_MS)
 */
export interface WorkflowReconcileConfig {
  enabled: boolean;
  intervalMs: number;
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

export function loadWorkflowReconcileConfig(): WorkflowReconcileConfig {
  const enabled = process.env.HAPI_WORKFLOW_RECONCILE_ENABLED === "true";
  const raw = process.env.HAPI_WORKFLOW_RECONCILE_INTERVAL_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  const intervalMs =
    Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;
  return { enabled, intervalMs };
}
