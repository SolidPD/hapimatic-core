// SPDX-License-Identifier: AGPL-3.0-only
import {
  CHAT_SECTIONS_DEFAULT,
  type ChatSectionsPreference,
} from "@hapi/protocol/schemas";
import type { AgentEvent, AgentTextBlock } from "@/chat/types";

export function formatTurnDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes} min ${seconds} sec`;
  }
  if (minutes > 0) {
    return `${minutes} min ${seconds} sec`;
  }
  return `${seconds} sec`;
}

export function formatUnixTimestamp(value: number): string {
  const ms = value < 1_000_000_000_000 ? value * 1000 : value;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

export type EventPresentation = {
  icon: string | null;
  text: string;
};

export function getEventPresentation(event: AgentEvent): EventPresentation {
  if (event.type === "api-error") {
    const {
      retryAttempt,
      maxRetries,
      retryInSeconds,
      isThundering,
      thunderingDurationSeconds,
    } = event as {
      retryAttempt: number;
      maxRetries: number;
      retryInSeconds?: number;
      isThundering?: boolean;
      thunderingDurationSeconds?: number;
    };

    if (isThundering && thunderingDurationSeconds != null) {
      return {
        icon: "⚡",
        text: `API overloaded — thundering (${thunderingDurationSeconds}s)`,
      };
    }

    if (maxRetries > 0 && retryAttempt >= maxRetries) {
      return { icon: "⚠️", text: "API error: Max retries reached" };
    }

    if (maxRetries > 0 && retryInSeconds != null && retryInSeconds > 0) {
      return {
        icon: "⏳",
        text: `API error: Retrying in ${retryInSeconds}s (${retryAttempt}/${maxRetries})`,
      };
    }

    if (maxRetries > 0) {
      return {
        icon: "⏳",
        text: `API error: Retrying (${retryAttempt}/${maxRetries})`,
      };
    }
    if (retryAttempt > 0) {
      return { icon: "⏳", text: "API error: Retrying..." };
    }
    return { icon: "⚠️", text: "API error" };
  }
  if (event.type === "switch") {
    const mode = event.mode === "local" ? "local" : "remote";
    return { icon: "🔄", text: `Switched to ${mode}` };
  }
  if (event.type === "title-changed") {
    const title = typeof event.title === "string" ? event.title : "";
    return {
      icon: null,
      text: title ? `Title changed to "${title}"` : "Title changed",
    };
  }
  if (event.type === "permission-mode-changed") {
    const modeValue = (event as Record<string, unknown>).mode;
    const mode = typeof modeValue === "string" ? modeValue : "default";
    return { icon: "🔐", text: `Permission mode: ${mode}` };
  }
  if (event.type === "limit-reached") {
    const endsAt = typeof event.endsAt === "number" ? event.endsAt : null;
    return {
      icon: "⏳",
      text: endsAt
        ? `Usage limit reached until ${formatUnixTimestamp(endsAt)}`
        : "Usage limit reached",
    };
  }
  if (event.type === "context-compaction") {
    return { icon: "📦", text: "Context compacted" };
  }
  if (event.type === "conversation-branched") {
    return { icon: "🌿", text: "Conversation Branched" };
  }
  if (event.type === "turn-result") {
    const e = event as {
      duration_ms: number;
      duration_api_ms: number;
      num_turns: number;
      total_cost_usd: number;
      is_error: boolean;
    };
    return { icon: "⏱", text: formatTurnDuration(e.duration_ms) };
  }
  if (event.type === "turn-duration") {
    // #4095: pty/tmux turn clock; drawn like an SDK turn-result (never raw JSON).
    const e = event as { duration_ms: number };
    return { icon: "⏱", text: formatTurnDuration(e.duration_ms) };
  }
  if (event.type === "branch-point") {
    return { icon: "🌿", text: "Branch created here" };
  }
  if (event.type === "message") {
    return {
      icon: null,
      text: typeof event.message === "string" ? event.message : "Message",
    };
  }
  if (event.type === "gate-denied") {
    // #3579: without this branch the unknown-type default would render the raw
    // JSON on screen. SystemMessage's GateDenialNotice branch renders the rich
    // card; this text is the label fallback (renderEventLabel).
    const outcome = (event as { outcome?: { title?: string } }).outcome;
    const title =
      outcome && typeof outcome.title === "string"
        ? outcome.title
        : "Message not sent";
    return { icon: "🚫", text: title };
  }
  if (event.type === "spend-limit-reached") {
    // #4936: label fallback for the SpendLimitNotice card (never raw JSON).
    const copy = getSpendLimitNoticeCopy(event as SpendLimitNoticeEvent);
    return { icon: "🛑", text: `${copy.title} — ${copy.resumes}` };
  }
  try {
    return { icon: null, text: JSON.stringify(event) };
  } catch {
    return { icon: null, text: String(event.type) };
  }
}

export function renderEventLabel(event: AgentEvent): string {
  return getEventPresentation(event).text;
}

/** The `spend-limit-reached` member of {@link AgentEvent} (#4936). */
export type SpendLimitNoticeEvent = Extract<
  AgentEvent,
  { type: "spend-limit-reached" }
>;

/** The copy of the #4936 spend-limit STOP notice. */
export type SpendLimitNoticeCopy = {
  /** "API spend cap reached for <key label>". */
  title: string;
  /** "resumes <date> UTC", or that the API gave no date. */
  resumes: string;
  /** The sentence form of `resumes`, for the card body. */
  detail: string;
  /** What the operator can do. */
  nextStep: string;
};

/**
 * Format the API-reported resume instant in UTC — the API states it in UTC
 * ("regain access on 2026-11-01 at 00:00 UTC"), so the notice does too.
 */
export function formatSpendLimitResume(resumesAt: number): string {
  const d = new Date(resumesAt);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    timeZone: "UTC",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/**
 * The single source of the #4936 stop-notice wording, shared by the
 * SpendLimitNotice card and the event-label fallback. Pure.
 */
export function getSpendLimitNoticeCopy(
  event: Pick<SpendLimitNoticeEvent, "variant" | "keyLabel" | "resumesAt">
): SpendLimitNoticeCopy {
  const key =
    typeof event.keyLabel === "string" && event.keyLabel.trim() !== ""
      ? event.keyLabel
      : "this API key";
  const title =
    event.variant === "org-limit"
      ? `API spend limit reached for ${key}`
      : event.variant === "workspace-limit"
        ? `Workspace spend limit reached for ${key}`
        : `API spend cap reached for ${key}`;
  const when =
    typeof event.resumesAt === "number"
      ? formatSpendLimitResume(event.resumesAt)
      : "";
  const resumes = when ? `resumes ${when} UTC` : "resume date not reported";
  const detail = when
    ? `Resumes ${when} UTC.`
    : "The API did not say when access resumes.";
  const nextStep =
    event.variant === "tier-cap"
      ? "Auto-recovery is off for this session. To restore access sooner, request a higher usage tier on the Claude Console Rate limits page, or switch this session to another key or account."
      : "Auto-recovery is off for this session. Raise or remove the spend limit in the Claude Console (Settings → Billing → Spend limits), or switch this session to another key or account.";
  return { title, resumes, detail, nextStep };
}

/**
 * Per-surface presentation hints the deep message renderers consume instead of
 * branching on preferences inline, so the contract is centralized here and
 * exhaustively unit-testable. Produced by `getChatSectionRenderHints` (below)
 * from the per-category chat-sections matrix (#2988, epic #2987 Sub-Issue S1).
 *
 * - `reasoning` — how the reasoning group renders: fully `shown` (auto-expand
 *   while streaming), `collapsed` (visible toggle, no auto-expand), or `hidden`
 *   (the message-layer wrapper folds it behind the reveal affordance).
 * - `narration` — how a narration-classified (interstitial) text block renders:
 *   `shown` (expanded), `collapsed` (visible toggle with an N-line preview), or
 *   `hidden` (soft-collapse — a closed collapsible mirroring reasoning, NEVER a
 *   true removal; #3154 KD6).
 * - `toolCards` — `full` cards, `compact` single-line rows, or `hidden`.
 * - `terminal` — CLI/terminal output rendered `full`, `collapsed`, or `hidden`.
 * - `autoExpandStreamingReasoning` — whether `ReasoningGroup` force-opens while
 *   reasoning streams.
 *
 * The safety floor (user/assistant text, errors, permission prompts) is NEVER
 * expressed here — it is enforced structurally in the renderers regardless of
 * preference. These hints only govern the gate-able surfaces.
 */
export type ChatDetailRenderHints = {
  reasoning: "shown" | "collapsed" | "hidden";
  narration: "shown" | "collapsed" | "hidden";
  toolCards: "full" | "compact" | "hidden";
  terminal: "full" | "collapsed" | "hidden";
  autoExpandStreamingReasoning: boolean;
};

/**
 * Presentation hints for the per-category chat-sections matrix (#2988, epic
 * #2987 Sub-Issue S1). Successor to the retired enum hint function — it maps
 * the matrix to the SAME `ChatDetailRenderHints` shape so the migrated defaults
 * render byte-identically to the corresponding enum level (the "rendering
 * equivalent at migrated defaults" AC). S1 keeps behavior equivalent; S2 expands
 * the rendering over these matrix-derived hints.
 *
 * The matrix carries `toolRuns` + `reasoning` (S1) plus `narration` (#3154), but
 * still no dedicated `terminal`, so `terminal` is derived from the `toolRuns`
 * category — in the
 * retired enum model tool cards and terminal always moved together
 * (full→full/full, compact→compact/collapsed, output-only→hidden/hidden), so
 * this preserves equivalence at every migrated default while giving S2 a clean
 * base to split the terminal category later.
 */
export function getChatSectionRenderHints(
  prefs: ChatSectionsPreference
): ChatDetailRenderHints {
  const toolRunsVisible = prefs.toolRuns.visible;
  const toolRunsExpanded = prefs.toolRuns.defaultState === "expanded";
  const reasoningVisible = prefs.reasoning.visible;
  const reasoningExpanded = prefs.reasoning.defaultState === "expanded";
  // #3154: narration mirrors reasoning — visible+expanded ⇒ shown, visible+
  // collapsed ⇒ collapsed, hidden ⇒ soft-collapse (closed collapsible, KD6).
  const narrationVisible = prefs.narration.visible;
  const narrationExpanded = prefs.narration.defaultState === "expanded";
  return {
    reasoning: !reasoningVisible
      ? "hidden"
      : reasoningExpanded
        ? "shown"
        : "collapsed",
    narration: !narrationVisible
      ? "hidden"
      : narrationExpanded
        ? "shown"
        : "collapsed",
    toolCards: !toolRunsVisible
      ? "hidden"
      : toolRunsExpanded
        ? "full"
        : "compact",
    terminal: !toolRunsVisible
      ? "hidden"
      : toolRunsExpanded
        ? "full"
        : "collapsed",
    autoExpandStreamingReasoning: reasoningVisible && reasoningExpanded,
  };
}

/**
 * #3879: the shared line-count unit for narration. NON-EMPTY trimmed `\n`-split
 * lines — the SAME unit the collapsed preview counts (`AssistantMessage.tsx`) — so
 * the promote guard and the preview never disagree. Deliberately NOT a raw `\n`
 * count: `preserveBlankLines` keeps `\n` and inserts placeholder paragraphs for
 * ≥3 newlines, so a raw count double-counts paragraph breaks.
 */
export function narrationLines(text: string): string[] {
  return text
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0);
}

export function countNarrationLines(text: string): number {
  return narrationLines(text).length;
}

/**
 * #3879: THE single source of truth for whether a narration-classified block
 * COLLAPSES. `block.category === "narration"` alone means only "structurally
 * interstitial" (a text block the reducer's turn-position pass stamped because a
 * tool call follows it in-segment) — it does NOT by itself mean "will collapse".
 * Whether it collapses is a PRESENTATION decision made here, exactly like
 * `previewLines`: a SUBSTANTIAL interstitial (strictly more non-empty lines than
 * the user's `promoteThresholdLines`) is PROMOTED to a visible response instead of
 * collapsing. `promoteThresholdLines === 0` disables promotion (today's behaviour:
 * every narration block collapses). Any consumer that needs "does this narration
 * block collapse?" MUST call this selector rather than reading `block.category`
 * directly. Pure function of `(block.category, block.text, prefs)` → idempotent by
 * construction (R4), and a preference change re-renders an open thread live through
 * `HappyChatContext` with no reconcile dependency.
 */
export function isCollapsedNarration(
  block: AgentTextBlock,
  prefs: ChatSectionsPreference
): boolean {
  if (block.category !== "narration") return false;
  const threshold = prefs.narration.promoteThresholdLines;
  const promoted = threshold > 0 && countNarrationLines(block.text) > threshold;
  return !promoted;
}

/**
 * Section-scoped detail override (#2989, epic #2987 Sub-Issue S2). The SINGLE
 * reveal channel `MessageDetailOverrideContext` (ruling D1) carries this mode
 * instead of the pre-S2 `{ revealed: boolean }`:
 *
 * - `inherit` — no override; render at the ambient chat-sections preference.
 * - `compact`  — force compact single-row tools (stage-1 group expansion). This
 *   is the mechanism the boolean lacked: at the shipping `full` default the
 *   prefs alone yield `toolCards: "full"`, so a group's stage-1 expansion needs
 *   an explicit force to render compact member rows independent of prefs.
 * - `full`     — force full cards (message-level reveal / expand-all).
 *
 * Only `toolCards` is forced by `compact` — `reasoning`/`terminal` follow prefs,
 * since the tool-run override wraps only the tool-call member subtree.
 */
export type MessageDetailMode = "inherit" | "compact" | "full";

export function resolveSectionHints(
  mode: MessageDetailMode,
  prefs: ChatSectionsPreference
): ChatDetailRenderHints {
  if (mode === "full") {
    return getChatSectionRenderHints(CHAT_SECTIONS_DEFAULT);
  }
  const base = getChatSectionRenderHints(prefs);
  if (mode === "compact") {
    return { ...base, toolCards: "compact" };
  }
  return base;
}
