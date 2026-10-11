// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Approval hygiene-TTL config (issue #3332, epic #3329 Sub D — R6).
 *
 * The state-binding engine (`server/src/services/stateBinding.ts`) replaces the
 * 60-minute approval-validity TTL with a content-fingerprint check for CRISP
 * gates — those with a Layer-1/Layer-2 state fingerprint. A crisp gate carries
 * NO clock: elapsed time never invalidates it (R6). Gates that have NO crisp
 * fingerprint — the "bypass class" — cannot be state-bound, so they fall back to
 * a coarse, days-scale HYGIENE TTL purely so a bypass grant cannot live forever.
 *
 * Env-gated, read once at boot — mirrors the sibling per-feature config modules
 * (`workflowReconcileConfig.ts`, `githubWebhookConfig.ts`); `server/src/services/`
 * contains ZERO `process.env` reads by convention, so the resolved number is
 * injected into the engine (keeping the engine pure per R8):
 *   HAPI_APPROVAL_HYGIENE_TTL_DAYS   days a fingerprint-less gate stays valid
 *                                    (default: 7)
 */
export interface ApprovalHygieneConfig {
  hygieneTtlDays: number;
}

const DEFAULT_HYGIENE_TTL_DAYS = 7;

export function loadApprovalHygieneConfig(): ApprovalHygieneConfig {
  const raw = process.env.HAPI_APPROVAL_HYGIENE_TTL_DAYS;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  const hygieneTtlDays =
    Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HYGIENE_TTL_DAYS;
  return { hygieneTtlDays };
}
