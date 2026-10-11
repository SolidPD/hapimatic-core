// SPDX-License-Identifier: AGPL-3.0-only
import type { Session } from "@hapi/protocol/types";
import type { StoredSession } from "../store/types";

/**
 * Build the in-memory `Session` record from its persisted row, carrying the
 * EPHEMERAL runtime fields over from the previous in-memory record.
 *
 * Extracted from `SessionCache.refreshSession` (composer-chip pin integrity)
 * so the rebuild is a pure, directly-testable function. The cache calls this
 * on EVERY store write (rename, notes, prompt-draft clear on send, linked
 * issue, the CLI's own metadata stamp, …), so any ephemeral field omitted here
 * silently vanishes from the record until its next keepAlive tick — or, for a
 * field no tick carries, until the next explicit write.
 *
 * #2479: load-bearing enumeration — EVERY web session summary flows through
 * this build (routes/sessions → syncEngine → toSessionSummary), so a missed
 * field here silently dies before the web ever sees it. tsc does NOT catch a
 * dropped optional field — verify by grep, not compile.
 */
export function buildSessionRecord(input: {
  stored: StoredSession;
  existing: Session | undefined;
  metadata: Session["metadata"];
  agentState: Session["agentState"];
  todos: Session["todos"];
}): Session {
  const { stored, existing, metadata, agentState, todos } = input;
  return {
    id: stored.id,
    tag: stored.tag ?? null,
    namespace: stored.namespace,
    seq: stored.seq,
    createdAt: stored.createdAt,
    updatedAt: Math.max(stored.updatedAt, existing?.updatedAt ?? 0),
    active: existing?.active ?? stored.active,
    activeAt: existing?.activeAt ?? stored.activeAt ?? stored.createdAt,
    metadata,
    metadataVersion: stored.metadataVersion,
    agentState,
    agentStateVersion: stored.agentStateVersion,
    thinking: existing?.thinking ?? false,
    // Issue #1653: ephemeral blocked-on-TUI-prompt state (preserved across a
    // cache refresh; never sourced from the DB — same lifetime as `thinking`).
    blockedOnTuiPrompt: existing?.blockedOnTuiPrompt ?? null,
    // Issue #1647: ephemeral rate-limited state (same lifetime as `thinking`).
    rateLimited: existing?.rateLimited ?? null,
    // Issue #4383: ephemeral background-agents snapshot. K11 contract — carried as
    // ABSENT (undefined), NOT null: a rebuild (refreshSession emits the whole
    // record) must not CLEAR the hub's cached count, and the whole-record emit
    // drops an absent key. A live alive-tick carries the current snapshot forward;
    // a clear is an explicit null on the delta emits only (NEW-4383-1).
    backgroundAgents: existing?.backgroundAgents ?? undefined,
    thinkingAt: existing?.thinkingAt ?? 0,
    thinkingStartedAt: existing?.thinkingStartedAt,
    serverAccumulatedMs:
      existing?.serverAccumulatedMs ??
      ((stored as Record<string, unknown>).serverAccumulatedMs as
        | number
        | undefined) ??
      0,
    todos,
    permissionMode: existing?.permissionMode,
    modelMode: existing?.modelMode,
    // Composer-chip pin integrity: carry the EPHEMERAL effort / rawModel across
    // a rebuild, seeded from the durable metadata pins when there is no
    // in-memory value (mirrors resolvedModel's existing→stored fallback).
    // Before this, every rebuild dropped them: `effort` read as undefined for
    // up to one keepAlive tick (the chip's "High" flash on an xhigh session),
    // and `rawModel` — which no keepAlive tick carried — was gone until the
    // next Apply, so the chip fell back to the PREVIOUS turn's resolvedModel
    // until the first token of the next response.
    effort: existing?.effort ?? metadata?.effort,
    rawModel: existing?.rawModel ?? metadata?.rawModel,
    notes: stored.notes ?? undefined,
    // #3286: hydrate the persisted view (undefined when no row value → the
    // client falls back to DEFAULT_SESSION_VIEW).
    persistedView: stored.persistedView ?? undefined,
    // #1261: emit promptDraft as null (NOT undefined) when there is no draft,
    // so the web usePromptDraft hydration gate (serverDraft === undefined =
    // "not loaded") opens for empty sessions and enables autosave.
    promptDraft: stored.promptDraft ?? null,
    emoji: stored.emoji ?? undefined,
    timerData: stored.timerData ?? undefined,
    linkedIssue: stored.linkedIssue ?? undefined,
    resolvedModel: existing?.resolvedModel ?? stored.resolvedModel ?? undefined,
    // Issue #1469: prefer in-memory live value, fall back to persisted last-known.
    contextWindowTokens:
      existing?.contextWindowTokens ?? stored.contextWindowTokens ?? undefined,
    contextUsedTokens:
      existing?.contextUsedTokens ?? stored.contextUsedTokens ?? undefined,
    contextPercentage:
      existing?.contextPercentage ?? stored.contextPercentage ?? undefined,
    needsReviewOverride: stored.needsReviewOverride ?? undefined,
    autoRecoverFromApiError: stored.autoRecoverFromApiError ?? null,
    uiCollapseState: stored.uiCollapseState ?? undefined,
    parentSessionId: stored.parentSessionId ?? undefined,
    parentRelationship: stored.parentRelationship ?? undefined,
    branchLabel: stored.branchLabel ?? undefined,
    branchCreatedAt: stored.branchCreatedAt ?? undefined,
  };
}
