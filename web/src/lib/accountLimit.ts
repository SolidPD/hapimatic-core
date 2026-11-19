// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError } from "@/api/client";
import {
  AccountExhaustionSchema,
  type AccountExhaustion,
  type HardLockWindow,
} from "@hapi/protocol";

/**
 * Format `resetsAt` as an exact Eastern-Time wall-clock stamp with the weekday,
 * date, time, and zone abbreviation ("Mon, Jun 23, 11:34 PM EDT"). Pinning
 * `timeZone: "America/New_York"` makes the stamp DST-aware and identical
 * regardless of the viewing device's timezone. Returns "" when missing/unparseable.
 * (Moved here from `AccountUsageCard.tsx` by #6742, which re-exports it, so the
 * account hook can word a refusal without importing the usage-card tree.)
 */
export function formatResetAbsolute(
  resetsAt: string | null | undefined
): string {
  if (!resetsAt) return "";
  const t = Date.parse(resetsAt);
  if (!Number.isFinite(t)) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(t));
}

/**
 * "5-hour" / "weekly" / "<Model> weekly" for a usage lock or a refusal's
 * `exhaustion` — the wording of the at-limit caption and confirm (#5879, #6742).
 */
export function limitWindowName(lock: {
  window: HardLockWindow;
  model: string | null;
}): string {
  if (lock.window === "five_hour") return "5-hour";
  if (lock.window === "weekly_scoped") return `${lock.model ?? "model"} weekly`;
  return "weekly";
}

/**
 * Issue #6742: the limit a refused session switch hit — the account, the limit,
 * its reset and the node that read it — in the words every web surface for that
 * refusal shares (the Session Configuration confirm, its error line, and the
 * toast once the modal has closed). Without a valid `exhaustion`, a plain line
 * that names no limit. Never the server's own text, which tells an API client
 * to send forceAccount.
 */
export function exhaustedLimitText(
  exhaustion: AccountExhaustion | null
): string {
  if (!exhaustion) {
    return "This account is at a usage limit, as the session's node reads its usage.";
  }
  return `${exhaustion.email ?? "This account"} is at its ${limitWindowName(exhaustion)} limit until ${formatResetAbsolute(exhaustion.resetsAt)}, as ${exhaustion.nodeLabel} reads its usage.`;
}

/**
 * Issue #6742: a session switch refused with 409 `account_exhausted`, with the
 * refusal's detail when its body carries a valid one (`exhaustion: null`
 * otherwise); `null` for any other error.
 */
export function readAccountExhausted(
  err: unknown
): { exhaustion: AccountExhaustion | null } | null {
  if (!(err instanceof ApiError) || err.code !== "account_exhausted") {
    return null;
  }
  let detail: unknown;
  try {
    detail = (JSON.parse(err.body ?? "") as { exhaustion?: unknown })
      .exhaustion;
  } catch {
    return { exhaustion: null };
  }
  const parsed = AccountExhaustionSchema.safeParse(detail);
  return { exhaustion: parsed.success ? parsed.data : null };
}
