// SPDX-License-Identifier: AGPL-3.0-only
import type { Session } from "../sync/syncEngine";
import { getAgentName, getSessionName } from "./sessionInfo";

/**
 * Issue #1883 — the set of session-fatal conditions the escalation surface (G3)
 * can carry. Only `"model-downgrade"` is WIRED today; the type is the documented
 * extension point for a future `"autocompact-thrash" | "repeated-api-error"`
 * detector. Neither of those signals exists server-side yet (verified — see the
 * issue-1883 directive Key Decisions §3), so building either means building a NEW
 * detector, which is explicitly out of scope. The surface is signal-agnostic
 * (R6) so a future detector wires in with a single `escalate(sessionId, reason)`
 * call — no change to this module or the SyncEngine plumbing.
 */
export type SessionFatalReason = "model-downgrade";

/**
 * error_logs category shared by every session-fatal escalation row — the R4
 * total-tier-failure log AND the R12 restart-survivable cooldown anchor. Single
 * source of truth (imported by the notifier and by SyncEngine).
 */
export const SESSION_FATAL_ESCALATION_CATEGORY = "session-fatal-escalation";

/**
 * Build the out-of-band escalation payload (R2). Pure — no `execFile`, no
 * SyncEngine import beyond the `Session` type — so it is unit-testable in
 * isolation. Plain text only: notify-pm delivers Telegram with no `parse_mode`.
 */
export function buildEscalationPayload(
  session: Session,
  reason: SessionFatalReason
): { subject: string; body: string } {
  const name = getSessionName(session);
  const agent = getAgentName(session);
  const planLabel =
    session.metadata?.claudeAccount?.planLabel ?? "unknown plan";

  const subject = `⚠️ Hapimatic session-fatal: ${reason} — ${name}`;

  const lines: string[] = [
    "A session-fatal condition was detected and the impaired session cannot",
    "reliably relay it in-band — escalating out-of-band.",
    "",
    `Condition: ${reason}`,
    `Session:   ${name} (${session.id})`,
    `Agent:     ${agent}`,
    `Account:   ${planLabel}`,
  ];

  if (reason === "model-downgrade") {
    lines.push(
      `Resolved model: ${session.resolvedModel ?? "unknown"}`,
      `Context window: ${
        session.contextWindowTokens != null
          ? `${session.contextWindowTokens} tokens`
          : "unknown"
      }`
    );
  }

  lines.push(
    "",
    "The session was already notified in-band (G2) and the anomaly logged (G1);",
    "this out-of-band notice (G3) guarantees you see it even if the session is",
    "impaired. Consider pausing or respawning the session."
  );

  return { subject, body: lines.join("\n") };
}
