// SPDX-License-Identifier: AGPL-3.0-only
import type { Session } from "@hapi/protocol/types";
import type { CacheKeepaliveConfig } from "./config";

/**
 * Whether one session gets a prompt-cache keep-alive now (issue #6169, R1/R3).
 * Pure: the service builds the input from the live session record and its own
 * per-session state, and this decides. Every guard errs toward NOT sending,
 * because a read of an expired cache writes the whole prefix.
 */

export const KEEPALIVE_SKIP_REASONS = [
  "disabled",
  "inactive",
  "archived",
  "not_claude",
  "not_sdk",
  "local_control",
  "no_method",
  "no_cache_state",
  "thinking",
  "permission_pending",
  "queued",
  "rate_limited",
  "tui_blocked",
  "handoff",
  "below_threshold",
  "ttl_not_1h",
  "stopped",
  "not_due",
  "missed_window",
  "capped",
  "typing",
] as const;
export type KeepaliveSkipReason = (typeof KEEPALIVE_SKIP_REASONS)[number];

export type KeepaliveDecision =
  | { action: "send"; deadlineAt: number }
  | { action: "skip"; reason: KeepaliveSkipReason };

export interface KeepalivePolicyInput {
  session: Pick<
    Session,
    | "active"
    | "thinking"
    | "metadata"
    | "agentState"
    | "blockedOnTuiPrompt"
    | "rateLimited"
    | "contextUsedTokens"
    | "promptCache"
  >;
  /** Messages waiting in the session's queue. */
  queuedCount: number;
  /** A context-watermark handoff holds the session. */
  handoffHeld: boolean;
  /** The session's CLI registered `cache-keepalive` (SDK remote launcher). */
  hasMethod: boolean;
  /** Last time the session's prompt draft changed (someone typing), or null. */
  lastDraftChangeAt: number | null;
  /** An earlier refusal or failure stopped keep-alives for this idle period. */
  stopped: boolean;
  /**
   * When this server last sent this session a keep-alive, or null. The next one
   * is due an interval after the later of this and the reported cache touch, so
   * a `promptCache` report that has not caught up cannot cause a second send.
   */
  lastSentAt: number | null;
}

function skip(reason: KeepaliveSkipReason): KeepaliveDecision {
  return { action: "skip", reason };
}

export function decideKeepalive(
  input: KeepalivePolicyInput,
  config: CacheKeepaliveConfig,
  now: number
): KeepaliveDecision {
  const { session } = input;
  if (!config.enabled) return skip("disabled");
  if (!session.active) return skip("inactive");
  if (session.metadata?.lifecycleState === "archived") return skip("archived");
  if ((session.metadata?.flavor ?? "claude") !== "claude") {
    return skip("not_claude");
  }
  // Absent on legacy sessions: `hasMethod` decides for them.
  const launcherKind = session.metadata?.launcherKind;
  if (launcherKind !== undefined && launcherKind !== "sdk") {
    return skip("not_sdk");
  }
  if (session.agentState?.controlledByUser === true) {
    return skip("local_control");
  }
  if (!input.hasMethod) return skip("no_method");
  const cache = session.promptCache;
  if (!cache) return skip("no_cache_state");
  // `idleSince === null`: the CLI has a turn pending.
  if (session.thinking || cache.idleSince === null) return skip("thinking");
  if (Object.keys(session.agentState?.requests ?? {}).length > 0) {
    return skip("permission_pending");
  }
  if (input.queuedCount > 0) return skip("queued");
  if (session.rateLimited) return skip("rate_limited");
  if (session.blockedOnTuiPrompt) return skip("tui_blocked");
  if (input.handoffHeld) return skip("handoff");
  if ((session.contextUsedTokens ?? 0) < config.contextThresholdTokens) {
    return skip("below_threshold");
  }
  if (cache.ttl !== "1h") return skip("ttl_not_1h");
  if (input.stopped) return skip("stopped");
  const lastTouch = Math.max(cache.touchedAt, input.lastSentAt ?? 0);
  if (now < lastTouch + config.intervalMs) return skip("not_due");
  if (now > cache.touchedAt + config.deadlineMs) return skip("missed_window");
  if (now - cache.idleSince > config.capMs) return skip("capped");
  // Typing only defers: a draft change past the deadline is `missed_window` above.
  if (
    input.lastDraftChangeAt !== null &&
    now - input.lastDraftChangeAt < config.typingQuietMs
  ) {
    return skip("typing");
  }
  return { action: "send", deadlineAt: cache.touchedAt + config.deadlineMs };
}
