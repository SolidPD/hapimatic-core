// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Canonical `content.meta.sentFrom` taxonomy (#2205).
 *
 * SINGLE source of truth for two things that were previously declared apart and
 * could silently drift:
 *   1. The `sentFrom` union accepted by `MessageService.sendMessage` AND
 *      `SyncEngine.sendMessage` (was an inline literal union in BOTH files).
 *   2. The programmatic-sender denylist used by `AutoRecoveryService`'s R3
 *      user-input predicate (was a hardcoded `!== "auto-recovery"` check).
 *
 * Deriving the union type and the runtime denylist from ONE list guarantees they
 * can never disagree about which senders count as "not real user input".
 */

/**
 * Genuine end-user input surfaces. A message stamped with one of these ABORTS a
 * pending auto-recovery (R4 — the user took control).
 */
export const USER_SENT_FROM_VALUES = ["webapp", "telegram-bot"] as const;

/**
 * Server-side PROGRAMMATIC senders. A message stamped with one of these must NOT
 * be mistaken for real user input (R3), so it does NOT abort a pending recovery.
 * Each sender carries a DISTINCT value (rather than one lumped `programmatic`) so
 * the originating sender stays observable in `content.meta.sentFrom`.
 */
export const PROGRAMMATIC_SENT_FROM_VALUES = [
  "auto-recovery",
  "watchdog",
  "heartbeat",
  // Issue #3124: previously-mislabeled programmatic senders. These all stamped
  // (or defaulted to) "webapp" despite being server-generated, which (1) made
  // the #3124 message-hook origin filter treat them as user prompts and (2) made
  // the auto-recovery R3 predicate abort a pending recovery on them. Distinct
  // values fix both — they bypass UserPromptSubmit-class hooks by default and no
  // longer masquerade as user input.
  "scheduler", // builtin.scheduler task/heartbeat-mode sends (taskExecutor.ts)
  "handoff", // successor-handoff packet delivery (successorHandoffWiring.ts)
  "system-notice", // server-injected notices, e.g. the model-downgrade halt notice
  "self-update", // self-update impact-analysis peer seed prompt (impactOrchestrator.ts)
] as const;

/** The `sentFrom` union both `sendMessage` signatures accept. */
export type SentFrom =
  | (typeof USER_SENT_FROM_VALUES)[number]
  | (typeof PROGRAMMATIC_SENT_FROM_VALUES)[number];

/**
 * Runtime denylist for the R3 predicate: `content.meta.sentFrom` values that are
 * NOT real user input. An unknown/absent value is treated as user input
 * (fail-safe — a genuine `webapp` / `telegram-bot` send still aborts recovery);
 * the predicate only RELAXES for explicitly-programmatic values.
 */
export const PROGRAMMATIC_SENT_FROM: ReadonlySet<string> = new Set<string>(
  PROGRAMMATIC_SENT_FROM_VALUES
);

/**
 * Origin-CLASS provenance (issue #3331, epic #3329 Sub B — R2, ruling D6(a)).
 *
 * A COMPANION to `sentFrom`, deliberately NOT folded into it. `sentFrom` is the
 * recovery-abort taxonomy above and its flat union cannot carry a `uid`; and web
 * vs CLI cannot be told apart by the JWT (both mint identical `{uid, ns}` claims
 * from the same `/api/auth` accessToken branch). So origin class is carried as a
 * separate `content.meta.origin` object, discriminated on the wire by the CLI's
 * `X-Hapi-Session-Id` request header.
 *
 * `class` values match the registry's `origin` vocabulary
 * (`~/.claude/skills/_shared/token-conventions.md` §4.1); the flat grant `origin`
 * string is derived from this object by the token service.
 *
 * ⚠️ Adding `cli-api`/`federation` to `PROGRAMMATIC_SENT_FROM_VALUES` instead was
 * evaluated and REJECTED: it would make `originAdmits` skip ALL
 * UserPromptSubmit-class hooks for CLI sends — INCLUDING the token gate itself —
 * and would flip the AutoRecoveryService R3 abort predicate. The companion
 * `meta.origin` avoids both.
 */
export interface MessageOrigin {
  /** Channel origin class (registry §4.1 vocabulary). */
  class: "web-user" | "cli-api" | "federation" | "bare-terminal";
  /** Numeric owner id (web-user path) — the JWT `uid`. */
  uid?: number;
  /** The SENDER's session id (cli-api path, from `X-Hapi-Session-Id`) — the R3
   *  self-send discriminator. */
  sessionId?: string;
}
