// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo } from "react";
import { useSessionDetailSessionId } from "@/ext/sessionDetailContext";
import { useAppContext } from "@/lib/app-context";
import { useMessages } from "@/hooks/queries/useMessages";
import { useSession } from "@/hooks/queries/useSession";
import { useSessionTokenStats } from "@/hooks/queries/useSessionTokenStats";
import { normalizeDecryptedMessage } from "@/chat/normalize";
import type { NormalizedMessage } from "@/chat/types";
import { reduceChatBlocks } from "@/chat/reducer";
import { getContextBudgetTokens } from "@/chat/modelConfig";
import { formatCompactTokens } from "./formatCompactTokens";

/**
 * Compact token-usage indicator for the session-detail info-field slot
 * (issue #1285, Sub-Issue U of epic #1264).
 *
 * Renders: 🪙 <cumulative used> [/ <context budget>]
 * Examples: "🪙 42K"          (no window reported — the COMMON idle/historical
 *                              case; the PRIMARY state)
 *           "🪙 247K / 990K"  (session reported a 1,000,000-token window;
 *                              getContextBudgetTokens subtracts 10K headroom)
 *
 * ## Data source precedence (prefer-server, fall back to client)
 *
 * Mirrors `SessionChat.tsx`'s `displayTokenStats` (:426-440) verbatim in intent:
 * the server aggregate from `GET /api/sessions/:id/token-stats` (#1671, epic
 * #1662) is AUTHORITATIVE, and the client-side `reduceChatBlocks` aggregate is
 * the documented fallback — it undercounts, because it only sees the 50-message
 * pages currently held in browser memory.
 *
 * This precedence is load-bearing for correctness, not a preference: the
 * `<TokenUsageSection>` widget renders in the SAME view a few hundred pixels
 * below this field. Reducing client-side only would put two disagreeing token
 * counts on screen at once.
 *
 * Per CLAUDE.md's Fallback Preservation Rule the fast path AUGMENTS the slow
 * path — the reducer branch is retained, not replaced, so a session whose
 * server aggregate is unavailable still shows a (marked) estimate rather than
 * nothing.
 *
 * ## No new network
 *
 * All three queries (`useMessages`, `useSession`, `useSessionTokenStats`) share
 * TanStack Query keys that `SessionChat` — this field's own mount ancestor —
 * has already issued for the same session. Query dedup means this component
 * adds zero requests; it reads a warm cache.
 *
 * ## Other implementation choices (see issue #1285 directive Key Decisions)
 *  - Self-discovers the session via the router param (slot specs render with no
 *    props), so the slot signature stays clean — no session context needed.
 *  - Renders null when the session has no usage data (R2).
 *  - Omits "/ budget" when the session has not reported contextWindowTokens
 *    (R3 — post-#1469 this is the primary state, not an edge case).
 */
export function TokenUsageField() {
  // Slot specs render with no props (per A/C), so the session arrives via the
  // session-detail slot context, which the mount site publishes.
  //
  // This deliberately does NOT read the router param directly. `<SessionChat />`
  // also mounts inside `SplitPaneContentView`, which renders session views
  // inline from pane state while the URL is `/sessions` — a strict
  // `useParams({ from: "/sessions/$sessionId" })` is not in that match tree and
  // THROWS, crashing the pane. See `@/ext/sessionDetailContext` for the full
  // mechanism and the loose-param fallback it keeps underneath.
  const sessionId = useSessionDetailSessionId();
  const { api } = useAppContext();
  const { messages } = useMessages(api, sessionId ?? null);
  const { session } = useSession(api, sessionId ?? null, false);
  const serverStats = useSessionTokenStats(api, sessionId ?? null);

  const serverTotals = serverStats.data?.totals ?? null;

  const clientStats = useMemo(() => {
    // Skip the reduce entirely when the authoritative aggregate is present —
    // its result would be discarded anyway.
    if (serverTotals) return null;
    if (!messages.length) return null;
    // normalizeDecryptedMessage returns NormalizedMessage | null — filter the
    // nulls with a type guard (same pattern as SessionChat.tsx:222-224).
    const normalized = messages
      .map(normalizeDecryptedMessage)
      .filter((m): m is NormalizedMessage => m !== null);
    // reduceChatBlocks takes TWO arguments (reducer.ts:36-38). SessionChat
    // passes the session's agentState (SessionChat.tsx:280) — mirror it.
    return reduceChatBlocks(normalized, session?.agentState ?? null).tokenStats;
  }, [serverTotals, messages, session?.agentState]);

  // Normalize BOTH sources to one shape so the server-over-client precedence
  // decision is made exactly ONCE. Branching on `serverTotals` separately for
  // each field would let the three drift apart — e.g. a future change that
  // folds cache tokens into the headline must not update the server branch and
  // forget the client one.
  // TRIPWIRE (issue #4344): `totalUsed` is the LIFETIME input+output total, NOT
  // the context fill. This field is NOT composed in the shipped build (absent from
  // extensions.config.ts since #2328), so it no longer matches the Token Usage
  // widget heading, which now shows context fill (contextUsedTokens / window). If
  // this field is ever re-enabled, compute its figure from `contextUsedTokens` —
  // never the in+out lifetime total — before adding it back to extensions.config.ts.
  const usage = serverTotals
    ? {
        isServerSourced: true,
        turnCount: serverTotals.turnCount,
        totalUsed:
          (serverTotals.totalTokIn ?? 0) + (serverTotals.totalTokOut ?? 0),
      }
    : {
        isServerSourced: false,
        turnCount: clientStats?.turnCount ?? 0,
        totalUsed:
          (clientStats?.totalInput ?? 0) + (clientStats?.totalOutput ?? 0),
      };

  // Guards run AFTER every hook so hook order stays unconditional.
  if (!sessionId) {
    // No session context and no session route — the slot is mounted somewhere
    // that cannot tell us what it is rendering for. Render nothing rather than
    // guessing a session and showing another session's numbers.
    return null;
  }
  if (usage.turnCount === 0) {
    return null; // R2: hide entirely when no usage data
  }

  // Post-#1469 (modelConfig.ts:20-27): SINGLE optional argument reading the
  // first-order window reported by Claude Code (session.contextWindowTokens).
  // Returns null when the window is unreported — the COMMON case for idle/
  // unreported sessions; there is no modelMode/tier fallback anymore.
  const contextBudget = getContextBudgetTokens(session?.contextWindowTokens);

  // Match TokenUsageSection's `isServerSourced` honesty: the compact field has
  // no room for an inline "estimate" chip, so the distinction lives in the
  // tooltip rather than being silently dropped.
  const title = usage.isServerSourced
    ? "Session token usage"
    : "Session token usage (estimate — from messages loaded in this tab)";

  const usedStr = formatCompactTokens(usage.totalUsed);
  // R3: omit the denominator when the window is unreported — the primary state.
  // Composed as one string rather than adjacent JSX children so the rendered
  // text is exact and not subject to JSX whitespace collapsing.
  const display =
    contextBudget == null
      ? `🪙 ${usedStr}`
      : `🪙 ${usedStr} / ${formatCompactTokens(contextBudget)}`;

  return (
    <span
      className="text-xs whitespace-nowrap text-[var(--app-hint)]"
      data-testid="token-usage-field"
      data-server-sourced={usage.isServerSourced ? "true" : "false"}
      title={title}
    >
      {display}
    </span>
  );
}
