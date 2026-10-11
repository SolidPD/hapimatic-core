// SPDX-License-Identifier: AGPL-3.0-only
/**
 * GitHub webhook receiver config (issue #2157, epic rp1-home#1319 — R7).
 *
 * Gates the public, JWT-less webhook receiver that pushes GitHub issue/PR events
 * into #2156's `initiative_events` queue. DEFAULT DISABLED (R7 rollback lever):
 * with the flag unset the receiver returns `404`, the peer-event observer never
 * subscribes, and the gap detector no-ops — behavior is byte-identical to
 * poll-only. Enabling it is a zero-deploy env change.
 *
 * Env-gated, read once at boot (mirrors `workflowReconcileConfig.ts` — the house
 * exemplar for an env-gated, default-disabled feature config):
 *   HAPI_GITHUB_WEBHOOK_ENABLED   "true" to enable (default: false)
 *   HAPI_GITHUB_WEBHOOK_SECRET    the webhook secret (REQUIRED when enabled)
 *   HAPI_PM_WEBHOOK_GAP_MS        gap bound before poll-fallback
 *                                 (default: 900000 = 15 min)
 *
 * 🔴 Fail-safe: if `enabled` is `true` but `secret` is empty, this logs an error
 * and FORCES `enabled: false` — an unauthenticated public receiver is never run.
 * The secret value is never logged.
 */
export interface GitHubWebhookConfig {
  enabled: boolean;
  secret: string;
  gapMs: number;
}

const DEFAULT_GAP_MS = 15 * 60 * 1000;

export function loadGitHubWebhookConfig(): GitHubWebhookConfig {
  const requested = process.env.HAPI_GITHUB_WEBHOOK_ENABLED === "true";
  const secret = process.env.HAPI_GITHUB_WEBHOOK_SECRET ?? "";
  const raw = process.env.HAPI_PM_WEBHOOK_GAP_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  const gapMs = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GAP_MS;

  // Refuse to enable an unauthenticated public receiver: a public endpoint with
  // no HMAC secret would accept forged deliveries. Force-disable + log (no secret
  // in the message).
  let enabled = requested;
  if (requested && secret.length === 0) {
    console.error(
      "[GitHubWebhook] HAPI_GITHUB_WEBHOOK_ENABLED=true but HAPI_GITHUB_WEBHOOK_SECRET " +
        "is empty — refusing to run an unauthenticated public receiver. Forcing disabled."
    );
    enabled = false;
  }

  return { enabled, secret, gapMs };
}
