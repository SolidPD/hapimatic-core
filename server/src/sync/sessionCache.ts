// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- Cohesive session-state cache; architecture-hotspot-review.md verdict is "Keep" (not a decomposition target). Crossed 1500 in #2862 (tag-keyed pending-parent map for the timeout-after-success fix); matches the grandfathering on sibling orchestrators syncEngine.ts / nodeRegistry.ts / store/index.ts. */
import { AgentStateSchema, MetadataSchema } from "@hapi/protocol/schemas";
import { scrubThenCap } from "@hapi/protocol";
import type {
  AuthBinding,
  BackgroundAgentEntry,
  BackgroundAgentsSnapshot,
  ClaudeAccountInfo,
  Metadata,
} from "@hapi/protocol/schemas";
import { getKnownSecretLiterals } from "../services/knownSecretLiterals";
import type {
  ModelMode,
  PermissionMode,
  Session,
  SessionView,
  UiCollapseState,
} from "@hapi/protocol/types";
import type { EffortLevel } from "@hapi/protocol/effort";
import type { Store } from "../store";
import type { StoredSession, StoredMessage } from "../store/types";
import { clampAliveTime } from "./aliveTime";
import { EventPublisher } from "./eventPublisher";
import { buildSessionRecord } from "./sessionRecord";
import { extractTodoWriteTodosFromMessageContent, TodosSchema } from "./todos";

/** What a keepAlive tick reports back to the engine (`handleSessionAlive`). */
export interface SessionAliveResult {
  /** Issue #3563: the `rateLimited.since` null→set rising edge. */
  rateLimitedRisingEdge: boolean;
  /** Issue #3478: the session's inactive→active rising edge (any driver). */
  activatedRisingEdge: boolean;
  /** Issue #4385: background agents that completed on this tick — the SCRUBBED
   *  cache entries, so the recorder copies `description`/`agentType` from the
   *  one scrub site, never from the raw meta file (T11). */
  completedBackgroundAgents: BackgroundAgentEntry[];
}

/**
 * Issue #4823: the five metadata fields that make up a session's credential
 * binding — captured before a payment-method switch and handed back to
 * `restoreSessionBinding` on rollback. An absent field was absent originally.
 */
export type SessionBindingSnapshot = Pick<
  Metadata,
  "accountUuid" | "claudeAccount" | "authBinding" | "apiKeyId" | "apiKeyMasked"
>;

/** A heartbeat the cache ignores (bad time, archive guard, unknown session). */
const NO_ALIVE_EDGES: SessionAliveResult = {
  rateLimitedRisingEdge: false,
  activatedRisingEdge: false,
  completedBackgroundAgents: [],
};

export class SessionCache {
  private readonly sessions: Map<string, Session> = new Map();
  private readonly lastBroadcastAtBySessionId: Map<string, number> = new Map();
  private readonly todoBackfillAttemptedSessionIds: Set<string> = new Set();
  /** Pending branch info for sessions that haven't registered yet */
  private readonly pendingBranchInfo: Map<
    string,
    { parentSessionId: string; branchLabel: string | null }
  > = new Map();
  /**
   * #2479: pending spawn-parent link for sessions that haven't registered yet.
   * Parallel to pendingBranchInfo but for the spawn path (relationship only, no
   * branch label). Keyed by the daemon's result.sessionId, applied when the
   * session first appears in refreshSession — mirroring the branch race handling.
   */
  private readonly pendingParentInfo: Map<
    string,
    { parentSessionId: string; parentRelationship: "branch" | "spawn" }
  > = new Map();
  /**
   * #2862 (Fix 2): pending spawn-parent link keyed by the pre-generated session
   * TAG (hapiSessionId), NOT the store uuid. The uuid-keyed post-success stamp
   * above is LOST when `rpcGateway.spawnSession` times out (SPAWN_RPC_TIMEOUT_MS)
   * AFTER the daemon has committed the spawn — the RPC returns an error so the
   * choke-point stamp never fires, yet the session exists (the "timeout after
   * success" bug). The tag is the ONLY id known before the daemon wait (the uuid
   * is minted at first registration), so `syncEngine.spawnSession` queues by tag
   * here and `getOrCreateSession` applies it when the child registers. Idempotent
   * with the uuid-keyed `pendingParentInfo` fallback (skips if already stamped).
   */
  private readonly pendingParentInfoByTag: Map<
    string,
    { parentSessionId: string; parentRelationship: "branch" | "spawn" }
  > = new Map();
  /**
   * Sessions recently archived via handleSessionEnd(). Heartbeats arriving
   * within the guard window are ignored to prevent the keepAlive interval
   * from re-activating a session the user just disconnected. Entries are
   * cleaned up in expireInactive().
   */
  private readonly recentlyArchivedAt: Map<string, number> = new Map();
  private static readonly ARCHIVE_GUARD_MS = 10_000;

  /**
   * Tracks when each session first became inactive (no heartbeat).
   * After FORCE_KILL_THRESHOLD_MS, escalates to process cleanup via the
   * onForceKill callback. (Issue #849)
   */
  private readonly firstInactiveAt: Map<string, number> = new Map();
  private static readonly FORCE_KILL_THRESHOLD_MS = 300_000; // 5 minutes
  private onForceKill?: (sessionId: string) => void;

  /**
   * Issue #1680: tmux/pty launcher sessions tolerate a wider heartbeat gap
   * before expireInactive flips them inactive. Their CLI wrapper process can be
   * descheduled under CPU load (busy Pi 5, up to 10 concurrent sessions + a
   * build), delaying the dedicated 2s keepAlive heartbeat past the 10s SDK
   * window and falsely flipping a genuinely-live session inactive — the
   * cosmetic "Reconnect" flap that #1661 made *safe* but did not *prevent*.
   * 30s gives ~2x margin over the ">15s under load" acceptance criterion while
   * leaving the flip, the side-effect null-outs, the firstInactiveAt tracking,
   * and the 5-min force-kill watchdog (#849) escalation otherwise unchanged.
   * SDK / unset / legacy launcherKind keep the verified-clean 10s anchor.
   */
  private static readonly TMUX_PTY_INACTIVE_TOLERANCE_MS = 30_000;

  /**
   * Sessions whose worktree CWD no longer exists on disk. These sessions are
   * unkillable via the normal killSession RPC path and would otherwise trigger
   * the watchdog every 5 minutes forever. Marking them orphaned suppresses
   * watchdog escalation while leaving the session record in cache for explicit
   * cleanup via deleteSession. (Issue #1364)
   */
  private readonly orphanedSessions: Map<
    string,
    { reason: string; at: number }
  > = new Map();

  constructor(
    private readonly store: Store,
    private readonly publisher: EventPublisher,
    options?: { onForceKill?: (sessionId: string) => void }
  ) {
    this.onForceKill = options?.onForceKill;
  }

  getSessions(): Session[] {
    return Array.from(this.sessions.values());
  }

  getSessionsByNamespace(namespace: string): Session[] {
    return this.getSessions().filter(
      session => session.namespace === namespace
    );
  }

  getSession(sessionId: string): Session | undefined {
    return (
      this.sessions.get(sessionId) ??
      this.refreshSession(sessionId) ??
      undefined
    );
  }

  getSessionByNamespace(
    sessionId: string,
    namespace: string
  ): Session | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || session.namespace !== namespace) {
      return undefined;
    }
    return session;
  }

  /**
   * Look up a session by its tag (e.g., "hapi-1234567890-abc123") within a namespace.
   * Used by CLI routes where the caller may pass a tag instead of UUID.
   */
  getSessionByTagAndNamespace(
    tag: string,
    namespace: string
  ): Session | undefined {
    for (const session of this.sessions.values()) {
      if (session.tag === tag && session.namespace === namespace) {
        return session;
      }
    }
    return undefined;
  }

  getActiveSessions(): Session[] {
    return this.getSessions().filter(session => session.active);
  }

  /**
   * Issue #2627 (Sub-Issue E, R5): scrub a deleted custom output-style name from
   * every persisted session's metadata so a respawn never carries a now-missing
   * style. Best-effort + version-checked per session — a concurrent writer just
   * means that one is skipped (a spawn naming the missing style no-ops to
   * `default` anyway, per D's #2626 Task 1 spike). Returns the count scrubbed.
   */
  clearOutputStyleFromSessions(styleName: string): number {
    let scrubbed = 0;
    for (const session of this.getSessions()) {
      if (session.metadata?.outputStyle !== styleName) continue;
      const newMetadata: Record<string, unknown> = {
        ...(session.metadata as Record<string, unknown>),
      };
      delete newMetadata.outputStyle;
      const result = this.store.sessions.updateSessionMetadata(
        session.id,
        newMetadata,
        session.metadataVersion,
        session.namespace,
        { touchUpdatedAt: false }
      );
      if (result.result !== "success") continue; // best-effort; skip on conflict
      const refreshed = this.refreshSession(session.id);
      if (refreshed) {
        this.publisher.emit({
          type: "session-updated",
          sessionId: session.id,
          data: refreshed,
        });
      }
      scrubbed++;
    }
    return scrubbed;
  }

  /**
   * Find all sessions (other than excludeId) that reference worktreePath
   * as their CWD via either metadata.path or metadata.worktree.worktreePath.
   * Used by SyncEngine to refuse worktree cleanup when siblings still own it.
   * Bug context: #1364.
   */
  findOtherSessionsByCwd(worktreePath: string, excludeId: string): Session[] {
    return this.getSessions()
      .filter(s => s.id !== excludeId)
      .filter(
        s =>
          s.metadata?.path === worktreePath ||
          s.metadata?.worktree?.worktreePath === worktreePath
      );
  }

  /**
   * Mark a session as orphaned (e.g., its worktree CWD permanently gone).
   * Orphaned sessions are skipped by the inactivity watchdog so they stop
   * producing 5-min-cadence killSession error_log spam. The session record
   * stays in cache until deleteSession is called. (Issue #1364)
   */
  markOrphaned(sessionId: string, reason: string): void {
    this.orphanedSessions.set(sessionId, { reason, at: Date.now() });
    // Belt-and-suspenders: drop any existing watchdog entry so a near-term
    // tick can't fire onForceKill before the next expireInactive() pass.
    this.firstInactiveAt.delete(sessionId);
  }

  isOrphaned(sessionId: string): boolean {
    return this.orphanedSessions.has(sessionId);
  }

  /**
   * Get the stored session's tag from the database.
   * This is needed for reconnect to reuse the same session, as getOrCreateSession
   * looks up sessions by tag, not by id.
   *
   * Falls back to metadata.hapiSessionTag for sessions created before the tag
   * column was properly populated (Issue #185 fix).
   */
  getSessionTag(sessionId: string): string | null {
    const stored = this.store.sessions.getSession(sessionId);
    if (stored?.tag) {
      return stored.tag;
    }
    // Fallback: extract hapiSessionTag from metadata for legacy sessions
    const metadata = stored?.metadata as { hapiSessionTag?: string } | null;
    return metadata?.hapiSessionTag ?? null;
  }

  getOrCreateSession(
    tag: string,
    metadata: unknown,
    agentState: unknown,
    namespace: string
  ): Session {
    const stored = this.store.sessions.getOrCreateSession(
      tag,
      metadata,
      agentState,
      namespace
    );
    const session =
      this.refreshSession(stored.id) ??
      (() => {
        throw new Error("Failed to load session");
      })();
    this.applyPendingParentByTag(tag, session);
    return session;
  }

  /**
   * #2862 (Fix 2): apply a spawn-parent stamp that was pre-queued by TAG (before
   * the daemon RPC, in `syncEngine.spawnSession`) once the child registers and
   * its store uuid is known. This is the timeout-after-success-safe half of the
   * fix: the choke-point post-success stamp keys on the awaited `result.sessionId`,
   * which is never delivered when `rpcGateway.spawnSession` times out after a
   * successful daemon spawn. Idempotent with that uuid-keyed fallback — skips when
   * a parent is already set so a late post-success stamp can't be clobbered.
   */
  private applyPendingParentByTag(tag: string, session: Session): void {
    const pending = this.pendingParentInfoByTag.get(tag);
    if (!pending) return;
    this.pendingParentInfoByTag.delete(tag);
    if (session.parentSessionId) return;
    const applied = this.store.sessions.updateSessionParentRelationship(
      session.id,
      pending.parentSessionId,
      pending.parentRelationship,
      session.namespace
    );
    if (applied) {
      session.parentSessionId = pending.parentSessionId;
      session.parentRelationship = pending.parentRelationship;
      this.publisher.emit({
        type: "session-updated",
        sessionId: session.id,
        data: session,
      });
    }
  }

  refreshSession(
    sessionId: string,
    storedSession?: StoredSession,
    preFetchedMessages?: StoredMessage[]
  ): Session | null {
    let stored = storedSession ?? this.store.sessions.getSession(sessionId);
    if (!stored) {
      const existed = this.sessions.delete(sessionId);
      if (existed) {
        this.publisher.emit({ type: "session-removed", sessionId });
      }
      return null;
    }

    const existing = this.sessions.get(sessionId);

    if (
      stored.todos === null &&
      !this.todoBackfillAttemptedSessionIds.has(sessionId)
    ) {
      this.todoBackfillAttemptedSessionIds.add(sessionId);
      const messages =
        preFetchedMessages ?? this.store.messages.getMessages(sessionId, 200);
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        const todos = extractTodoWriteTodosFromMessageContent(message.content);
        if (todos) {
          const updated = this.store.sessions.setSessionTodos(
            sessionId,
            todos,
            message.createdAt,
            stored.namespace
          );
          if (updated) {
            stored = this.store.sessions.getSession(sessionId) ?? stored;
          }
          break;
        }
      }
    }

    const metadata = (() => {
      const parsed = MetadataSchema.safeParse(stored.metadata);
      return parsed.success ? parsed.data : null;
    })();

    const agentState = (() => {
      const parsed = AgentStateSchema.safeParse(stored.agentState);
      return parsed.success ? parsed.data : null;
    })();

    const todos = (() => {
      if (stored.todos === null) return undefined;
      const parsed = TodosSchema.safeParse(stored.todos);
      return parsed.success ? parsed.data : undefined;
    })();

    // Composer-chip pin integrity: the rebuild is a pure function (see
    // sessionRecord.ts) so the ephemeral-field carry-over is unit-tested
    // directly. It seeds `effort` / `rawModel` from the metadata pins when no
    // in-memory value exists — the rebuild used to drop both on every store
    // write, which is what made the composer chip flash the "High" default
    // and show the previous turn's model after a pick.
    const session: Session = buildSessionRecord({
      stored,
      existing,
      metadata,
      agentState,
      todos,
    });

    this.sessions.set(sessionId, session);

    // Apply pending branch info if this session was spawned via branchSession()
    // before the CLI connected. The branch metadata (parent link, label) was
    // queued because the session didn't exist yet at spawn time.
    const pending = this.pendingBranchInfo.get(sessionId);
    if (pending) {
      this.pendingBranchInfo.delete(sessionId);
      const applied = this.store.sessions.updateSessionBranchInfo(
        sessionId,
        pending.parentSessionId,
        pending.branchLabel,
        session.namespace
      );
      if (applied) {
        // Re-read from DB to pick up the branch columns
        const refreshed = this.store.sessions.getSession(sessionId);
        if (refreshed) {
          session.parentSessionId = refreshed.parentSessionId ?? undefined;
          session.parentRelationship =
            refreshed.parentRelationship ?? undefined;
          session.branchLabel = refreshed.branchLabel ?? undefined;
          session.branchCreatedAt = refreshed.branchCreatedAt ?? undefined;
        }
      }
    }

    // #2479: apply pending spawn-parent link (PM-spawned managed peer) if the
    // choke-point write raced ahead of the child's registration. Distinct from
    // the branch-info queue above: relationship only, no branch label. Writing
    // with session.id (the resolved store uuid) — never a raw daemon tag.
    const pendingParent = this.pendingParentInfo.get(sessionId);
    if (pendingParent) {
      this.pendingParentInfo.delete(sessionId);
      const applied = this.store.sessions.updateSessionParentRelationship(
        session.id,
        pendingParent.parentSessionId,
        pendingParent.parentRelationship,
        session.namespace
      );
      if (applied) {
        session.parentSessionId = pendingParent.parentSessionId;
        session.parentRelationship = pendingParent.parentRelationship;
      }
    }

    this.publisher.emit({
      type: existing ? "session-updated" : "session-added",
      sessionId,
      data: session,
    });
    return session;
  }

  reloadAll(): void {
    const sessions = this.store.sessions.getSessions();

    // Identify sessions that will need todo backfill (and thus message fetching)
    const backfillNeededIds: string[] = [];
    for (const session of sessions) {
      if (
        session.todos === null &&
        !this.todoBackfillAttemptedSessionIds.has(session.id)
      ) {
        backfillNeededIds.push(session.id);
      }
    }

    // Bulk fetch messages for all sessions needing backfill in one query (+ chunks)
    const messagesBySession =
      backfillNeededIds.length > 0
        ? this.store.messages.getLatestMessagesForSessions(backfillNeededIds)
        : new Map<string, StoredMessage[]>();

    for (const session of sessions) {
      // Pass pre-fetched messages (or empty array to prevent fallback query)
      const preFetchedMessages = backfillNeededIds.includes(session.id)
        ? (messagesBySession.get(session.id) ?? [])
        : undefined;

      this.refreshSession(session.id, session, preFetchedMessages);
    }
  }

  handleSessionAlive(payload: {
    sid: string;
    time: number;
    thinking?: boolean;
    mode?: "local" | "remote";
    permissionMode?: PermissionMode;
    modelMode?: ModelMode;
    // Issue #2456: live reasoning-effort level (drives the in-session effort tag).
    effort?: string;
    // Composer-chip pin integrity: pinned raw model id riding the keepAlive tick.
    // Always-assign contract: `null` = the pin was cleared (family-mode pick), so
    // a stale id is dropped; absent (old CLI binary) = leave the record untouched.
    rawModel?: string | null;
    resolvedModel?: string;
    contextWindowTokens?: number;
    contextUsedTokens?: number;
    contextPercentage?: number;
    // Issue #1653: blocked-on-TUI-prompt state riding the keepAlive runtime.
    blockedOnTuiPrompt?: { message: string; since: number } | null;
    // Issue #1647: rate-limited (429 session-limit) state riding the runtime.
    rateLimited?: {
      resetText: string;
      resetAt: number | null;
      since: number;
    } | null;
    // Issue #4383: the background-agents snapshot riding the keepAlive runtime.
    // K11 contract: `T | null` on the wire; the server normalises null to ABSENT
    // (see the assign below). An old CLI omits it — also absent (it tracks none).
    backgroundAgents?: BackgroundAgentsSnapshot | null;
    // Issue #3563: reports the `rateLimited.since` null→set rising edge.
    // Issue #4385: reports the background agents that just completed (see
    // `completedBackgroundAgents`) so the engine can record their usage.
  }): SessionAliveResult {
    const t = clampAliveTime(payload.time);
    if (!t) return NO_ALIVE_EDGES;

    // Guard: ignore heartbeats from recently-archived sessions to prevent
    // the keepAlive interval from re-activating a session the user just
    // disconnected (race condition — issue #678).
    const archivedAt = this.recentlyArchivedAt.get(payload.sid);
    if (archivedAt !== undefined) {
      const elapsed = Date.now() - archivedAt;
      if (elapsed < SessionCache.ARCHIVE_GUARD_MS) {
        return NO_ALIVE_EDGES;
      }
      // Guard expired — allow re-activation (e.g., user reconnected)
      this.recentlyArchivedAt.delete(payload.sid);
    }

    const session =
      this.sessions.get(payload.sid) ?? this.refreshSession(payload.sid);
    if (!session) return NO_ALIVE_EDGES;

    const wasActive = session.active;
    const wasThinking = session.thinking;
    const previousBlockedOnTuiPrompt = session.blockedOnTuiPrompt;
    const previousRateLimited = session.rateLimited;
    const previousBackgroundAgents = session.backgroundAgents;
    const previousPermissionMode = session.permissionMode;
    const previousModelMode = session.modelMode;
    const previousEffort = session.effort;
    const previousRawModel = session.rawModel;
    const previousResolvedModel = session.resolvedModel;
    const previousContextWindowTokens = session.contextWindowTokens;
    const previousContextUsedTokens = session.contextUsedTokens;
    const previousContextPercentage = session.contextPercentage;

    session.active = true;
    session.activeAt = Math.max(session.activeAt, t);
    session.thinking = Boolean(payload.thinking);
    session.thinkingAt = t;
    // Issue #1653: always-assign (mirrors `thinking`) — the CLI sends this every
    // keepAlive tick, so a dropped emit self-heals and a clear (null) lands; an
    // OLD CLI omits it (undefined → null, harmless; `.optional()` Zod field).
    session.blockedOnTuiPrompt = payload.blockedOnTuiPrompt ?? null;
    // Issue #1647: always-assign (mirrors `thinking` / `blockedOnTuiPrompt`).
    // The CLI sends this on every keepAlive tick, so a clear (null) reliably
    // lands and a dropped emit self-heals next tick. An old CLI binary on a
    // mixed-version mesh omits the field → resolves to null (harmless).
    session.rateLimited = payload.rateLimited ?? null;
    // Issue #4383: K11 normalise — a null-on-the-wire becomes ABSENT on the
    // record (NOT null, unlike rateLimited). The absent key is dropped by the
    // whole-record `refreshSession` emit so a rebuild never clears the hub; the
    // delta emits below carry an EXPLICIT null when clear (NEW-4383-1). An old
    // CLI omits the field → also absent (it tracks nothing).
    // #4386 (operator ruling 4386-D1 = A): scrub every agent `description` HERE,
    // the one chokepoint every consumer (local web, SSE `session-updated`,
    // `/api/federation/sessions`, #4387's bridge) reads.
    session.backgroundAgents = scrubBackgroundAgentDescriptions(
      payload.backgroundAgents
    );

    // Server-side time accumulation: track thinking segments independently
    // of the frontend timer. This ensures accurate time even when the PWA
    // is backgrounded (iOS suspends JS execution).
    if (!wasThinking && session.thinking) {
      // Thinking started — record segment start
      session.thinkingStartedAt = Date.now();
    } else if (wasThinking && !session.thinking) {
      // Thinking stopped — accumulate elapsed segment time
      if (session.thinkingStartedAt) {
        const elapsed = Date.now() - session.thinkingStartedAt;
        session.serverAccumulatedMs =
          (session.serverAccumulatedMs ?? 0) + elapsed;
        session.thinkingStartedAt = undefined;
        // Persist to DB on thinking stop (natural checkpoint)
        this.store.sessions.updateSessionServerTime(
          payload.sid,
          session.serverAccumulatedMs,
          session.namespace
        );
      }
    }

    // When thinking transitions true→false, bump updatedAt so the
    // "needs review" indicator (orange dot) triggers in the session list.
    // (#2026) The manual read override is NO LONGER cleared here — thinking→false
    // is not a reliable "new user content" signal (fires on every SDK result,
    // including empty-bounce/autonomous cycles, and on every tmux/pty tool-use
    // boundary). The override is now cleared on genuine new assistant content in
    // syncEngine.handleRealtimeEvent — see needsReviewContent.ts.
    if (wasThinking && !session.thinking) {
      session.updatedAt = Date.now();
    }
    // Always resolve permissionMode to a concrete value — never leave undefined.
    // Prevents client-side "default" fallback flicker when JSON.stringify omits
    // undefined fields.
    session.permissionMode =
      payload.permissionMode ?? session.permissionMode ?? "default";
    if (payload.modelMode !== undefined) {
      session.modelMode = payload.modelMode;
    }
    // Issue #2456: live effort tag — in-memory only (durable effort lives in
    // metadata, stamped CLI-side), mirroring how modelMode is handled here.
    if (payload.effort !== undefined) {
      session.effort = payload.effort as Session["effort"];
    }
    // Composer-chip pin integrity: the pinned raw model self-heals from the
    // keepAlive tick (mirrors effort); `null` clears a stale pin.
    if (payload.rawModel !== undefined) {
      session.rawModel = payload.rawModel ?? undefined;
    }
    if (payload.resolvedModel !== undefined) {
      session.resolvedModel = payload.resolvedModel;
      if (payload.resolvedModel !== previousResolvedModel) {
        // #3769 R6: surface a silent tier fallback (downgrade) with the live
        // window — a 1M pick a bound account cannot serve resolves smaller here.
        console.log(
          `[sessionCache #3769] ${session.id} resolvedModel ${previousResolvedModel ?? "?"}->${payload.resolvedModel} ctxWin=${session.contextWindowTokens ?? "?"}`
        );
        this.store.sessions.updateSessionResolvedModel(
          session.id,
          payload.resolvedModel,
          session.namespace
        );
      }
    }

    // Issue #1469: first-order context window + live usage (per-turn push).
    if (payload.contextWindowTokens !== undefined) {
      session.contextWindowTokens = payload.contextWindowTokens;
    }
    if (payload.contextUsedTokens !== undefined) {
      session.contextUsedTokens = payload.contextUsedTokens;
    }
    if (payload.contextPercentage !== undefined) {
      session.contextPercentage = payload.contextPercentage;
    }
    if (
      session.contextWindowTokens !== previousContextWindowTokens ||
      session.contextUsedTokens !== previousContextUsedTokens ||
      session.contextPercentage !== previousContextPercentage
    ) {
      this.store.sessions.updateSessionContextUsage(
        session.id,
        session.contextWindowTokens ?? null,
        session.contextUsedTokens ?? null,
        session.contextPercentage ?? null,
        session.namespace
      );
    }

    const now = Date.now();
    const lastBroadcastAt =
      this.lastBroadcastAtBySessionId.get(session.id) ?? 0;
    const modeChanged =
      previousPermissionMode !== session.permissionMode ||
      previousModelMode !== session.modelMode ||
      previousEffort !== session.effort ||
      previousRawModel !== session.rawModel ||
      previousResolvedModel !== session.resolvedModel ||
      previousContextWindowTokens !== session.contextWindowTokens ||
      previousContextUsedTokens !== session.contextUsedTokens ||
      previousContextPercentage !== session.contextPercentage;
    // Issue #1653: compare by `since` (the prompt episode's identity), NOT by
    // reference — the payload is JSON-deserialized into a fresh object each
    // tick, so a reference compare would broadcast every 2s. This fires only on
    // null↔blocked transitions and on a genuinely new prompt (new `since`).
    const blockedChanged =
      (previousBlockedOnTuiPrompt?.since ?? null) !==
      (session.blockedOnTuiPrompt?.since ?? null);
    // Issue #1647: compare by `since` (the rate-limit episode's identity), NOT
    // by reference — the payload is JSON-deserialized fresh each tick. Fires
    // only on null↔rate-limited transitions and on a genuinely new 429.
    const rateLimitedChanged =
      (previousRateLimited?.since ?? null) !==
      (session.rateLimited?.since ?? null);
    const rateLimitedRose =
      rateLimitedChanged && (previousRateLimited?.since ?? null) === null;
    // Issue #4383: change-detect on a SIGNATURE (running:done:error:total + the
    // max endedAt), NOT by reference — the payload is a fresh object each tick, so
    // a reference compare would broadcast every 2s (the :628 lesson).
    const backgroundAgentsChanged =
      backgroundAgentsSignature(previousBackgroundAgents) !==
      backgroundAgentsSignature(session.backgroundAgents);
    const shouldBroadcast =
      (!wasActive && session.active) ||
      wasThinking !== session.thinking ||
      blockedChanged ||
      rateLimitedChanged ||
      backgroundAgentsChanged ||
      modeChanged ||
      now - lastBroadcastAt > 10_000;

    if (shouldBroadcast) {
      this.lastBroadcastAtBySessionId.set(session.id, now);
      this.publisher.emit({
        type: "session-updated",
        sessionId: session.id,
        data: {
          activeAt: session.activeAt,
          updatedAt: session.updatedAt,
          thinking: session.thinking,
          // Issue #1653: surface the blocked-on-TUI-prompt delta alongside the
          // cached write (web refetches the cached object via toSessionSummary).
          blockedOnTuiPrompt: session.blockedOnTuiPrompt,
          // Issue #1647: surface the rate-limited delta on the same SSE event.
          rateLimited: session.rateLimited,
          // Issue #4383: the record carries backgroundAgents as ABSENT when clear
          // (K11), and JSON.stringify drops an absent key — so emit an EXPLICIT
          // null here so #4387's `in`-guarded federation bridge clears on a T1
          // clear instead of leaving a stale hub count (NEW-4383-1). The full
          // snapshot (agents list) rides this delta; #4387 projects counts from it.
          backgroundAgents: session.backgroundAgents ?? null,
          thinkingStartedAt: session.thinkingStartedAt,
          serverAccumulatedMs: session.serverAccumulatedMs ?? 0,
          permissionMode: session.permissionMode,
          modelMode: session.modelMode,
          effort: session.effort,
          rawModel: session.rawModel,
          resolvedModel: session.resolvedModel,
          contextWindowTokens: session.contextWindowTokens,
          contextUsedTokens: session.contextUsedTokens,
          contextPercentage: session.contextPercentage,
        },
      });
    }
    return {
      rateLimitedRisingEdge: rateLimitedRose,
      // `session.active` was set true above, so the edge is exactly `!wasActive`.
      activatedRisingEdge: !wasActive,
      completedBackgroundAgents: completedBackgroundAgents(
        previousBackgroundAgents,
        session.backgroundAgents
      ),
    };
  }

  /**
   * Issue #1661: re-mark a session ACTIVE without a heartbeat payload — used by
   * reconnectSession's re-attach fast path. When the daemon authoritatively
   * reports a tmux-launcher session's wrapper + pane are still alive, the server
   * resumes the SSE subscription WITHOUT killing/respawning Claude — the session
   * was only falsely flagged inactive (the 10s `expireInactive` trip-wire lapsed
   * under load or during a long silent turn). Flip `active` back to true, refresh
   * `activeAt`, clear the inactive/force-kill tracking so the 5-min watchdog does
   * not fire on a session we just confirmed alive, and emit `session-updated` so
   * SSE clients stop offering "Reconnect" and resume the live stream. Symmetric
   * with expireInactive's `{active:false}` emit.
   *
   * Returns true if the session existed and was reactivated; false if unknown.
   */
  reactivate(sessionId: string): boolean {
    const session =
      this.sessions.get(sessionId) ?? this.refreshSession(sessionId);
    if (!session) return false;
    const now = Date.now();
    session.active = true;
    session.activeAt = Math.max(session.activeAt, now);
    // Issue #1653 (ruling D2, #1661): blockedOnTuiPrompt is DELIBERATELY NOT
    // cleared on re-attach (may still be blocking; CLI keepAlive re-sets if stale;
    // the emit below is field-whitelisted, so no possibly-stale re-broadcast).
    // Clear inactive + force-kill escalation so expireInactive's 5-min watchdog
    // does not re-fire on this confirmed-alive session.
    this.firstInactiveAt.delete(sessionId);
    this.publisher.emit({
      type: "session-updated",
      sessionId,
      data: { active: true, activeAt: session.activeAt },
    });
    return true;
  }

  handleSessionEnd(payload: {
    sid: string;
    time: number;
    archived?: boolean;
  }): void {
    const t = clampAliveTime(payload.time) ?? Date.now();

    const session =
      this.sessions.get(payload.sid) ?? this.refreshSession(payload.sid);
    if (!session) return;

    if (!session.active && !session.thinking) {
      return;
    }

    // Finalize server-side time if session was thinking when it ended
    if (session.thinking && session.thinkingStartedAt) {
      const elapsed = Date.now() - session.thinkingStartedAt;
      session.serverAccumulatedMs =
        (session.serverAccumulatedMs ?? 0) + elapsed;
      session.thinkingStartedAt = undefined;
      this.store.sessions.updateSessionServerTime(
        payload.sid,
        session.serverAccumulatedMs,
        session.namespace
      );
    }

    session.active = false;
    session.thinking = false;
    // Issue #1653 (dead-session clear): null the banner on session end so a
    // disconnected session never shows a stale "waiting on terminal prompt".
    session.blockedOnTuiPrompt = null;
    // Issue #1647 (dead-session clear): a disconnected session must not show a
    // stale rate-limited chip.
    session.rateLimited = null;
    // Issue #4383 (dead-session clear): a disconnected session must not show a
    // stale agents badge. ABSENT on the record (K11); explicit null on the emit.
    session.backgroundAgents = undefined;
    session.thinkingAt = t;

    // Record archive guard so heartbeats arriving after disconnect
    // don't re-activate the session (issue #678).
    if (payload.archived) {
      this.recentlyArchivedAt.set(payload.sid, Date.now());
    }

    this.publisher.emit({
      type: "session-updated",
      sessionId: session.id,
      data: {
        active: false,
        thinking: false,
        blockedOnTuiPrompt: null,
        rateLimited: null,
        // Issue #4383: explicit null so #4387's bridge clears the hub count.
        backgroundAgents: null,
      },
    });
  }

  expireInactive(now: number = Date.now()): void {
    // Timeout before marking a session inactive when no heartbeat is received.
    // SDK sessions use 10s for fast detection when tmux windows are manually
    // closed (reduced from 30s historically). tmux/pty launcher sessions get a
    // wider grace window per Issue #1680 — see TMUX_PTY_INACTIVE_TOLERANCE_MS.
    const SDK_SESSION_TIMEOUT_MS = 10_000;

    for (const session of this.sessions.values()) {
      if (session.active) {
        // Session is alive — clear any inactive tracking
        this.firstInactiveAt.delete(session.id);

        // Issue #1680: per-launcher inactive tolerance. A tmux/pty session's
        // wrapper can be descheduled under CPU load, delaying its dedicated 2s
        // keepAlive emit past 10s and falsely flipping a live session inactive.
        // Give those launchers a wider grace window; sdk/unset launcherKind is
        // byte-identical to the prior 10s behavior (Fallback Preservation).
        const launcherKind = session.metadata?.launcherKind;
        const sessionTimeoutMs =
          launcherKind === "tmux" || launcherKind === "pty"
            ? SessionCache.TMUX_PTY_INACTIVE_TOLERANCE_MS
            : SDK_SESSION_TIMEOUT_MS;

        if (now - session.activeAt <= sessionTimeoutMs) continue;
        // Finalize server-side time before marking inactive
        if (session.thinking && session.thinkingStartedAt) {
          const elapsed = now - session.thinkingStartedAt;
          session.serverAccumulatedMs =
            (session.serverAccumulatedMs ?? 0) + elapsed;
          session.thinkingStartedAt = undefined;
          this.store.sessions.updateSessionServerTime(
            session.id,
            session.serverAccumulatedMs,
            session.namespace
          );
        }
        session.active = false;
        session.thinking = false;
        // Issue #1653 (dead-session clear): an expired session must not show a
        // stale banner. If it was only falsely flagged inactive, reactivate()
        // preserves nothing here — the CLI's next keepAlive re-sets the banner.
        session.blockedOnTuiPrompt = null;
        // Issue #1647 (dead-session clear): same for the rate-limited chip.
        session.rateLimited = null;
        // Issue #4383 (dead-session clear): same for the agents badge.
        session.backgroundAgents = undefined;
        this.publisher.emit({
          type: "session-updated",
          sessionId: session.id,
          data: {
            active: false,
            thinking: false,
            blockedOnTuiPrompt: null,
            rateLimited: null,
            backgroundAgents: null,
          },
        });
      }

      // Track when the session first became inactive (Issue #849).
      // Orphaned sessions (#1364) are skipped — they can never recover and
      // would trigger the watchdog every 5 minutes forever.
      if (
        !session.active &&
        !this.firstInactiveAt.has(session.id) &&
        !this.orphanedSessions.has(session.id)
      ) {
        this.firstInactiveAt.set(session.id, now);
      }

      // Escalation: if inactive for >5 minutes, trigger force kill
      // to clean up orphaned MCP server processes. (Issue #849)
      // Orphaned sessions (#1364) are skipped — killSession would fail and
      // the next watchdog tick would just re-fire forever.
      const inactiveSince = this.firstInactiveAt.get(session.id);
      if (
        inactiveSince &&
        now - inactiveSince > SessionCache.FORCE_KILL_THRESHOLD_MS &&
        this.onForceKill &&
        !this.orphanedSessions.has(session.id)
      ) {
        this.firstInactiveAt.delete(session.id);
        this.onForceKill(session.id);
      }
    }

    // Clean up expired archive guards
    for (const [sid, archivedAt] of this.recentlyArchivedAt) {
      if (now - archivedAt >= SessionCache.ARCHIVE_GUARD_MS) {
        this.recentlyArchivedAt.delete(sid);
      }
    }

    // Clean up firstInactiveAt entries for sessions that no longer exist
    for (const sid of this.firstInactiveAt.keys()) {
      if (!this.sessions.has(sid)) {
        this.firstInactiveAt.delete(sid);
      }
    }

    // Clean up orphanedSessions entries for sessions that no longer exist (#1364)
    for (const sid of this.orphanedSessions.keys()) {
      if (!this.sessions.has(sid)) {
        this.orphanedSessions.delete(sid);
      }
    }
  }

  applySessionConfig(
    sessionId: string,
    config: {
      permissionMode?: PermissionMode;
      modelMode?: ModelMode;
      effort?: EffortLevel;
      rawModel?: string;
    }
  ): void {
    const session =
      this.sessions.get(sessionId) ?? this.refreshSession(sessionId);
    if (!session) {
      return;
    }

    if (config.permissionMode !== undefined) {
      session.permissionMode = config.permissionMode;
    }
    if (config.modelMode !== undefined) {
      session.modelMode = config.modelMode;
      // #3769 R3: a family pick supersedes a specific rawModel pin. The CLI drops
      // the cleared value from JSON, so clear the stale concrete pin here NOW
      // (else it flashes until the next ~2s keepalive `rawModel: null`).
      if (config.rawModel === undefined) session.rawModel = undefined;
    }
    // Issue #2456: mirror the effort + raw-model pins onto the live record.
    if (config.effort !== undefined) {
      session.effort = config.effort;
    }
    if (config.rawModel !== undefined) {
      session.rawModel = config.rawModel;
    }

    this.publisher.emit({ type: "session-updated", sessionId, data: session });
  }

  async renameSession(sessionId: string, name: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("Session not found");
    }

    const currentMetadata = session.metadata ?? { path: "", host: "" };
    const newMetadata = { ...currentMetadata, name };

    const result = this.store.sessions.updateSessionMetadata(
      sessionId,
      newMetadata,
      session.metadataVersion,
      session.namespace,
      { touchUpdatedAt: false }
    );

    if (result.result === "error") {
      throw new Error("Failed to update session metadata");
    }

    if (result.result === "version-mismatch") {
      throw new Error("Session was modified concurrently. Please try again.");
    }

    this.refreshSession(sessionId);
  }

  /**
   * Persist a mid-session account switch (issue #1517). Writes `accountUuid` +
   * `claudeAccount` + `authBinding` (#3351 — the binding is refreshed here so
   * both the live switch and #3633's staged path stay fresh) into the session
   * metadata blob, preserving every other field (`claudeSessionId`, `name`,
   * `resolvedModel`, todos, ...).
   *
   * Version-checked with a bounded re-read-on-mismatch retry that mirrors the
   * CLI's `applyVersionedAck` + `backoff` discipline
   * (`cli/src/api/versionedUpdate.ts`): if the respawned CLI concurrently stamps
   * `claudeSessionId` (its base metadata is the server's pre-switch row), the
   * loser re-reads the winner's fresh metadata and re-merges, so both writes
   * converge to `{new account, claudeSessionId}` with NO clobber (R4). This is
   * why the write MUST be version-checked + retried, not a blanket overwrite —
   * an unconditional write would be silently clobbered by the CLI's stamp.
   *
   * Returns `true` on success, `false` if the session is gone or the write
   * could not land within the retry budget. `engine.switchAccount` logs a
   * warning on `false` but does NOT roll back the process switch — the next CLI
   * metadata write self-heals via the same optimistic-concurrency machinery.
   *
   * Emits a `session-updated` event on success so SSE clients reflect the new
   * account within the refresh window (R3) without waiting for the next poll.
   */
  async updateSessionAccount(
    sessionId: string,
    accountUuid: string,
    claudeAccount: ClaudeAccountInfo
  ): Promise<boolean> {
    // Issue #3351 (epic #3345 Sub-Issue F): refresh `authBinding` alongside
    // `claudeAccount` (R6 freshness). An account switch is inherently an
    // Anthropic subscription-account rebind (both callers — the live switch and
    // #3633's stageAccount — pass a validated Anthropic `StoredAccount`), so the
    // binding is derived here from the new account rather than trusting the
    // respawned CLI to re-stamp it (the reconnect-by-tag path DISCARDS the child's
    // fresh metadata — see this method's doc; the same hazard `claudeAccount`
    // itself is written here to avoid). Folding it INTO this ONE site (per the
    // #3633 cross-reference on #3351) keeps BOTH the live switch and the staged
    // path fresh from a single write — a future third caller can't miss it.
    // displayIdentity is the NEW account email (authoritative at switch time, not
    // the child-filled empty the spawn path uses).
    const authBinding: AuthBinding = {
      kind: "subscription-account",
      displayIdentity: claudeAccount.email ?? "",
      providerId: "anthropic",
    };
    // Targeted merge: only the account fields + authBinding change; everything
    // else (re-read each attempt) is preserved verbatim. The version-checked
    // re-read-on-mismatch retry loop lives in updateSessionMetadataFields.
    // Issue #4568: binding an ACCOUNT replaces an API-key binding — drop
    // `apiKeyId` / `apiKeyMasked` in the same write. The reconnect-by-tag path
    // keeps this blob (it discards the child's fresh metadata), so a key that
    // survived here would ride the next respawn beside the new account and the
    // spawn choke point would refuse the two-credential payload.
    return this.updateSessionMetadataFields(sessionId, current => {
      const {
        apiKeyId: _droppedApiKeyId,
        apiKeyMasked: _droppedApiKeyMasked,
        ...rest
      } = current;
      return {
        ...rest,
        accountUuid,
        claudeAccount,
        authBinding,
      };
    });
  }

  /**
   * Issue #4823: bind the session to a node-vault Anthropic API key — the
   * account→key counterpart of {@link updateSessionAccount}. Writes the vault id,
   * the mask recorded for the launch-time `api_key_changed` check, and an
   * `api-key` auth binding, and DROPS `accountUuid` + `claudeAccount` in the same
   * write: every respawn path threads both `accountUuid` and `apiKeyId` from this
   * record, and `spawnSession` refuses a payload carrying both
   * (`api_key_with_account`), so a record holding both would make every later
   * respawn fail. A lingering `claudeAccount` would also let an account surface
   * name a subscription the session no longer bills.
   *
   * Never key material: `displayIdentity` is the vault label (else the masked
   * key), the same value the daemon's `computeAuthBinding` stamps at spawn.
   */
  async updateSessionApiKeyBinding(
    sessionId: string,
    binding: { apiKeyId: string; apiKeyMasked: string; displayIdentity: string }
  ): Promise<boolean> {
    const authBinding: AuthBinding = {
      kind: "api-key",
      displayIdentity: binding.displayIdentity,
      providerId: "anthropic",
    };
    return this.updateSessionMetadataFields(sessionId, current => {
      const {
        accountUuid: _droppedAccountUuid,
        claudeAccount: _droppedClaudeAccount,
        ...rest
      } = current;
      return {
        ...rest,
        apiKeyId: binding.apiKeyId,
        apiKeyMasked: binding.apiKeyMasked,
        authBinding,
      };
    });
  }

  /**
   * Issue #4823 (R5): restore a session's credential binding to an exact earlier
   * snapshot — the rollback of a failed payment-method switch. Drops all five
   * binding fields, then re-sets exactly the ones the snapshot carried, so ONE
   * writer restores an account-bound, key-bound or unbound (host-credential)
   * original without per-kind branches and can never leave two kinds mixed.
   */
  async restoreSessionBinding(
    sessionId: string,
    original: SessionBindingSnapshot
  ): Promise<boolean> {
    return this.updateSessionMetadataFields(sessionId, current => {
      const {
        accountUuid: _a,
        claudeAccount: _c,
        authBinding: _b,
        apiKeyId: _k,
        apiKeyMasked: _m,
        ...rest
      } = current;
      return {
        ...rest,
        ...(original.accountUuid !== undefined
          ? { accountUuid: original.accountUuid }
          : {}),
        ...(original.claudeAccount !== undefined
          ? { claudeAccount: original.claudeAccount }
          : {}),
        ...(original.authBinding !== undefined
          ? { authBinding: original.authBinding }
          : {}),
        ...(original.apiKeyId !== undefined
          ? { apiKeyId: original.apiKeyId }
          : {}),
        ...(original.apiKeyMasked !== undefined
          ? { apiKeyMasked: original.apiKeyMasked }
          : {}),
      };
    });
  }

  /**
   * Round 11 (epic #3285, 2026-09-07): apply a targeted patch to the session's
   * metadata blob — version-checked with the same bounded re-read-on-mismatch
   * retry as `updateSessionAccount`, so a concurrent writer never loses the
   * patch and the patch never clobbers a concurrent write. Used to STAGE a
   * disconnected session's configuration (modelMode / rawModel / effort /
   * permissionMode / stagedMcpDesired pins) and to consume the MCP stage on
   * reactivation. Returns false if the session is gone or the write could not
   * land within the retry budget. Emits `session-updated` on success.
   */
  async updateSessionMetadataFields(
    sessionId: string,
    patch: (current: Metadata) => Metadata
  ): Promise<boolean> {
    const MAX_ATTEMPTS = 5;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const session =
        this.sessions.get(sessionId) ?? this.refreshSession(sessionId);
      if (!session) {
        return false;
      }
      const currentMetadata = session.metadata ?? { path: "", host: "" };
      const newMetadata = patch(currentMetadata);
      const result = this.store.sessions.updateSessionMetadata(
        sessionId,
        newMetadata,
        session.metadataVersion,
        session.namespace,
        { touchUpdatedAt: false }
      );
      if (result.result === "success") {
        const refreshed = this.refreshSession(sessionId);
        if (refreshed) {
          this.publisher.emit({
            type: "session-updated",
            sessionId,
            data: refreshed,
          });
        }
        return true;
      }
      if (result.result === "error") {
        return false;
      }
      // version-mismatch: re-sync the in-memory version, then re-apply the
      // patch over the winner's fresh metadata.
      this.refreshSession(sessionId);
    }
    return false;
  }

  async updateSessionSource(
    sessionId: string,
    source: "scheduler" | "heartbeat",
    scheduleKind?: "at" | "cron" | "every",
    scheduleId?: string
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("Session not found");
    }

    const currentMetadata = session.metadata ?? { path: "", host: "" };
    const newMetadata = {
      ...currentMetadata,
      source,
      ...(scheduleKind ? { scheduleKind } : {}),
      ...(scheduleId ? { scheduleId } : {}),
    };

    const result = this.store.sessions.updateSessionMetadata(
      sessionId,
      newMetadata,
      session.metadataVersion,
      session.namespace,
      { touchUpdatedAt: false }
    );

    if (result.result === "error") {
      throw new Error("Failed to update session source");
    }

    if (result.result === "version-mismatch") {
      throw new Error("Session was modified concurrently. Please try again.");
    }

    this.refreshSession(sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("Session not found");
    }

    // #1443: orphaned sessions (CWD gone) are deletable even while the cache
    // still reports active:true. A live orphan CLI may re-flip active after
    // the 10s archive guard, but the session is unrecoverable and must be
    // cleanable — deleteSession kills the tmux window, so delete is terminal.
    if (session.active && !this.isOrphaned(sessionId)) {
      throw new Error("Cannot delete active session");
    }

    // Issue #1325: cascade-delete any queued messages for this session
    // before removing the session row. Same transaction is unnecessary —
    // session deletion already cascades client-side via session-removed,
    // and the queue delete is a pure DELETE that can't leave the row in
    // an inconsistent state. R9 guarantees no orphan queue rows after
    // session deletion.
    this.store.queuedMessages.deleteForSession(sessionId);

    // #2480: dissolve this parent's children BEFORE removing the parent row, so
    // they survive as independent top-level sessions instead of being
    // cascade-destroyed. The dissolve UPDATE runs synchronously immediately
    // before the parent DELETE — no interleave window (Bun is single-threaded
    // and these store calls are synchronous), so no transaction is needed. The
    // WHERE parent_session_id predicate still matches because the parent row
    // still exists here.
    const dissolvedChildIds = this.store.sessions.dissolveChildSessions(
      sessionId,
      session.namespace
    );

    const deleted = this.store.sessions.deleteSession(
      sessionId,
      session.namespace
    );
    if (!deleted) {
      throw new Error("Failed to delete session");
    }

    this.sessions.delete(sessionId);
    this.lastBroadcastAtBySessionId.delete(sessionId);
    this.todoBackfillAttemptedSessionIds.delete(sessionId);

    // #1075 (R7): cascade-delete the session's uploaded files (notes + prompt
    // attachments live in <cwd>/UserFileUploads/). Because that directory is
    // keyed by the working directory — NOT the session id — it is SHARED by any
    // sessions that run in the same cwd. Only remove it when THIS was the last
    // session owning that cwd, so deleting one session never wipes a sibling
    // session's attachments. Best-effort: a leftover dir is disk-only, never
    // user-facing data loss.
    const deletedCwd = session.metadata?.path;
    if (deletedCwd) {
      // Reuse the worktree-aware sharing check (#1364). The deleted session was
      // already removed from the map above, so excludeId is belt-and-suspenders.
      const cwdStillOwned =
        this.findOtherSessionsByCwd(deletedCwd, sessionId).length > 0;
      if (!cwdStillOwned) {
        try {
          const { rm } = await import("node:fs/promises");
          const { join } = await import("node:path");
          await rm(join(deletedCwd, "UserFileUploads"), {
            recursive: true,
            force: true,
          });
        } catch {
          // Best-effort cleanup — ignore (missing dir, permissions, etc.).
        }
      }
    }

    // Emit queue-changed before session-removed so any client still
    // showing the session sees the queue clear out first (cosmetic, but
    // matches the order the user expects).
    this.publisher.emit({
      type: "queue-changed",
      sessionId,
      namespace: session.namespace,
    });

    this.publisher.emit({
      type: "session-removed",
      sessionId,
      namespace: session.namespace,
    });

    // #2480 (R2): re-read + emit `session-updated` for each dissolved child so
    // connected clients re-render it as a top-level session (parent fields now
    // nulled). refreshSession reads the nulled row from the store, refreshes the
    // in-memory map, and emits the event. Remote federation hubs converge on the
    // next registry poll (accepted per the epic's per-node-count limitation).
    for (const childId of dissolvedChildIds) {
      this.refreshSession(childId);
    }
  }

  deleteSessions(
    sessionIds: string[],
    namespace: string
  ): { deleted: string[]; skipped: string[] } {
    const toDelete: string[] = [];
    const skipped: string[] = [];

    for (const id of sessionIds) {
      const session = this.sessions.get(id);
      // #1443: orphaned sessions bypass the active-check (covers the
      // user-reported "Delete All Disconnected" bulk path).
      if (
        !session ||
        session.namespace !== namespace ||
        (session.active && !this.isOrphaned(id))
      ) {
        skipped.push(id);
      } else {
        toDelete.push(id);
      }
    }

    if (toDelete.length > 0) {
      // Issue #1325: cascade-delete queued messages for each session.
      for (const id of toDelete) {
        this.store.queuedMessages.deleteForSession(id);
      }

      // #2480: dissolve the out-of-batch children of every parent being deleted,
      // BEFORE the bulk row removal. excludeIds = toDelete, so children that are
      // themselves in the batch ("Delete all (N)" sends parent + all descendants)
      // are left for the DELETE to remove — the whole group still goes. Only
      // children that SURVIVE the batch are dissolved (e.g. delete-disconnected
      // of a parent whose active children stay). Same shared store fn as the
      // single path (D3a) → identical dissolve semantics across single, bulk, and
      // the federation per-id bulk-delete loop.
      const dissolvedChildIds = this.store.sessions.dissolveChildSessions(
        toDelete,
        namespace,
        toDelete
      );

      this.store.sessions.deleteSessions(toDelete, namespace);

      for (const id of toDelete) {
        const session = this.sessions.get(id);
        this.sessions.delete(id);
        this.lastBroadcastAtBySessionId.delete(id);
        this.todoBackfillAttemptedSessionIds.delete(id);

        this.publisher.emit({
          type: "queue-changed",
          sessionId: id,
          namespace: session?.namespace ?? namespace,
        });

        this.publisher.emit({
          type: "session-removed",
          sessionId: id,
          namespace: session?.namespace ?? namespace,
        });
      }

      // #2480 (R2): re-read + emit session-updated for each surviving dissolved
      // child so connected clients re-render it as top-level. Runs after the
      // batch removal — the dissolved children are NOT in toDelete, so they are
      // still in the cache map and refreshSession emits session-updated.
      for (const childId of dissolvedChildIds) {
        this.refreshSession(childId);
      }
    }

    return { deleted: toDelete, skipped };
  }

  async updateSessionNotes(
    sessionId: string,
    notes: string | null
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("Session not found");
    }

    const updated = this.store.sessions.updateSessionNotes(
      sessionId,
      notes,
      session.namespace
    );
    if (!updated) {
      throw new Error("Failed to update session notes");
    }

    this.refreshSession(sessionId);
  }

  async updateSessionView(
    sessionId: string,
    view: SessionView | null
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("Session not found");
    }

    const updated = this.store.sessions.updateSessionView(
      sessionId,
      view,
      session.namespace
    );
    if (!updated) {
      throw new Error("Failed to update session view");
    }

    // #3286: refreshSession re-emits the session so the SSE/session-summary flow
    // carries persistedView cross-device (R2), exactly as notes does.
    this.refreshSession(sessionId);
  }

  async updateSessionPromptDraft(
    sessionId: string,
    promptDraft: string | null
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("Session not found");
    }

    const updated = this.store.sessions.updateSessionPromptDraft(
      sessionId,
      promptDraft,
      session.namespace
    );
    if (!updated) {
      throw new Error("Failed to update session prompt draft");
    }

    this.refreshSession(sessionId);
  }

  async updateSessionEmoji(
    sessionId: string,
    emoji: string | null
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("Session not found");
    }

    const updated = this.store.sessions.updateSessionEmoji(
      sessionId,
      emoji,
      session.namespace
    );
    if (!updated) {
      throw new Error("Failed to update session emoji");
    }

    this.refreshSession(sessionId);
  }

  async updateSessionLinkedIssue(
    sessionId: string,
    linkedIssue: {
      number: number;
      title: string;
      repo: string;
      state?: "open" | "closed";
    } | null
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("Session not found");
    }

    const updated = this.store.sessions.updateSessionLinkedIssue(
      sessionId,
      linkedIssue,
      session.namespace
    );
    if (!updated) {
      throw new Error("Failed to update session linked issue");
    }

    this.refreshSession(sessionId);
  }

  /**
   * #2026: clear a manual "needs-review" override IFF the session currently
   * carries one, keeping the in-memory session object and the persisted DB row
   * consistent at the moment of the clear (fixes the delayed-reveal aggravating
   * factor — no stale-green followed by a flip on the next refreshSession()).
   *
   * Called from `syncEngine.handleRealtimeEvent` when a genuinely new
   * user-facing assistant answer is persisted (see `needsReviewContent.ts`). It
   * is deliberately NOT keyed on `thinking:true→false` (issue #2026, R1/R2).
   */
  clearNeedsReviewOverrideOnNewContent(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    // No-op when there is nothing to clear — avoids a spurious DB write + emit
    // when the session is not currently marked "read"/"unread". The in-memory
    // value is authoritative for the live session, so we do NOT re-read the DB.
    if (session.needsReviewOverride == null) return;

    // DB clear (idempotent — the SQL is guarded by needs_review_override IS NOT NULL).
    this.store.sessions.clearSessionNeedsReviewOverride(
      sessionId,
      session.namespace
    );
    // In-memory consistency (fixes the delayed-reveal aggravating factor).
    session.needsReviewOverride = null;
    // Notify clients promptly so the dot updates within an SSE cycle instead of
    // waiting for the next refreshSession()/poll. Field-whitelisted emit
    // (mirrors reactivate()) carrying the single explicit delta.
    this.publisher.emit({
      type: "session-updated",
      sessionId,
      data: { needsReviewOverride: null },
    });
  }

  async updateSessionNeedsReviewOverride(
    sessionId: string,
    needsReviewOverride: "read" | "unread" | null
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("Session not found");
    }

    const updated = this.store.sessions.updateSessionNeedsReviewOverride(
      sessionId,
      needsReviewOverride,
      session.namespace
    );
    if (!updated) {
      throw new Error("Failed to update session needs review override");
    }

    this.refreshSession(sessionId);
  }

  async updateSessionAutoRecoverFromApiError(
    sessionId: string,
    autoRecover: boolean | null
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("Session not found");
    }

    const updated = this.store.sessions.updateSessionAutoRecoverFromApiError(
      sessionId,
      autoRecover,
      session.namespace
    );
    if (!updated) {
      throw new Error("Failed to update session auto-recover override");
    }

    this.refreshSession(sessionId);
  }

  async updateSessionUiCollapseState(
    sessionId: string,
    uiCollapseState: UiCollapseState | null
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("Session not found");
    }

    const updated = this.store.sessions.updateSessionUiCollapseState(
      sessionId,
      uiCollapseState,
      session.namespace
    );
    if (!updated) {
      throw new Error("Failed to update session UI collapse state");
    }

    this.refreshSession(sessionId);
  }

  async updateSessionBranchInfo(
    sessionId: string,
    parentSessionId: string,
    branchLabel: string | null
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      // Session hasn't registered yet (CLI still starting up).
      // Queue the branch info and apply it when the session first appears.
      this.pendingBranchInfo.set(sessionId, { parentSessionId, branchLabel });
      return;
    }

    const updated = this.store.sessions.updateSessionBranchInfo(
      sessionId,
      parentSessionId,
      branchLabel,
      session.namespace
    );
    if (!updated) {
      throw new Error("Failed to update session branch info");
    }

    this.refreshSession(sessionId);
  }

  /**
   * #2862 (Fix 2): queue a spawn-parent stamp keyed by the session TAG
   * (hapiSessionId), applied in {@link getOrCreateSession} when the child first
   * registers. Called from the `syncEngine.spawnSession` choke point BEFORE the
   * daemon RPC — which can return an error after the daemon has already committed
   * the spawn (SPAWN_RPC_TIMEOUT_MS) — so a timeout-after-success can no longer
   * drop the managed-peer link (the uuid-keyed post-success stamp never fires on
   * that path). Relationship-only, no branch label.
   */
  queuePendingParentByTag(
    tag: string,
    parentSessionId: string,
    parentRelationship: "branch" | "spawn"
  ): void {
    this.pendingParentInfoByTag.set(tag, {
      parentSessionId,
      parentRelationship,
    });
  }

  /**
   * #2479: persist a spawn-originated parent link for a managed peer.
   *
   * Called from the syncEngine.spawnSession choke point after a PM/public-route
   * spawn succeeds. `sessionId` is the daemon's result.sessionId (a uuid on the
   * webhook/create path; a tag only on reattach paths, which never set a spawn
   * relationship). We resolve it through the cache first and write the store row
   * keyed on the RESOLVED session.id (uuid) — never the raw arg. If the child
   * has not registered yet, queue it (mirrors the branch-info race handling).
   */
  updateSessionParentRelationship(
    sessionId: string,
    parentSessionId: string,
    parentRelationship: "branch" | "spawn"
  ): void {
    const session =
      this.sessions.get(sessionId) ?? this.refreshSession(sessionId);
    if (!session) {
      // Child not registered yet — apply when it first appears (refreshSession).
      this.pendingParentInfo.set(sessionId, {
        parentSessionId,
        parentRelationship,
      });
      return;
    }

    const updated = this.store.sessions.updateSessionParentRelationship(
      session.id,
      parentSessionId,
      parentRelationship,
      session.namespace
    );
    if (updated) {
      session.parentSessionId = parentSessionId;
      session.parentRelationship = parentRelationship;
      this.publisher.emit({
        type: "session-updated",
        sessionId: session.id,
        data: session,
      });
    }
  }

  getChildBranchCount(parentSessionId: string): number {
    return this.store.sessions.getChildBranchCount(parentSessionId);
  }

  getChildBranchCounts(namespace: string): Map<string, number> {
    const counts = new Map<string, number>();
    for (const session of this.sessions.values()) {
      // #2479: exclude spawn peers from the BRANCH count — a managed peer is not
      // a branch. Managed-peer counts are computed separately (client-side).
      if (
        session.namespace === namespace &&
        session.parentSessionId &&
        session.parentRelationship !== "spawn"
      ) {
        counts.set(
          session.parentSessionId,
          (counts.get(session.parentSessionId) ?? 0) + 1
        );
      }
    }
    return counts;
  }

  getMessageCountForSession(sessionId: string): number {
    return this.store.sessions.getMessageCountForSession(sessionId);
  }

  getMessageCountsByNamespace(namespace: string): Map<string, number> {
    return this.store.sessions.getMessageCountsByNamespace(namespace);
  }
}

/** Max `description` length cached after scrubbing (matches the CLI tracker's cap). */
const BACKGROUND_AGENT_DESCRIPTION_CAP = 200;

/**
 * Issue #4386 (operator ruling 4386-D1 = A): scrub every background agent's
 * `description` before it is cached. The description is the `Agent` call's
 * prompt — transcript text that can carry a secret token or an approval nonce —
 * and the cached value is what reaches the session list, SSE `session-updated`,
 * `/api/federation/sessions` and #4387's bridge, so this one chokepoint is the
 * only scrub site (#4383 and #4387 add none). `scrubThenCap` applies the same
 * transcript scrub the peek route uses (`sentryScrub.ts`, incl. the #4386 nonce
 * pattern) and keeps the 200-char cap AFTER scrubbing (a mask can lengthen the
 * string slightly). Null/undefined → undefined (the K11 normalize, #4383).
 */
function scrubBackgroundAgentDescriptions(
  snapshot: BackgroundAgentsSnapshot | null | undefined
): BackgroundAgentsSnapshot | undefined {
  if (!snapshot) return undefined;
  // #4657: defense in depth behind the `session-alive` boundary validation —
  // `handleSessionAlive` is reachable without it (tests, future callers), and
  // an unexpected shape must clear the badge, never throw.
  if (!Array.isArray(snapshot.agents)) return undefined;
  const literals = getKnownSecretLiterals({ ownToken: null });
  return {
    ...snapshot,
    agents: snapshot.agents.map(a => ({
      ...a,
      description:
        typeof a?.description === "string"
          ? scrubThenCap(
              a.description,
              BACKGROUND_AGENT_DESCRIPTION_CAP,
              literals
            )
          : "",
    })),
  };
}

/**
 * Issue #4383: a stable change-detection signature for a background-agents
 * snapshot — the four counts plus the max `endedAt` (so a new completion with the
 * same counts still broadcasts). Compared string-to-string each keepAlive tick so
 * a fresh-but-equal payload never triggers a 2s broadcast (the :628 lesson).
 */
function backgroundAgentsSignature(
  snapshot: BackgroundAgentsSnapshot | null | undefined
): string {
  if (!snapshot) return "null";
  let maxEnded = 0;
  for (const a of snapshot.agents) {
    if (typeof a.endedAt === "number" && a.endedAt > maxEnded)
      maxEnded = a.endedAt;
  }
  return `${snapshot.running}:${snapshot.done}:${snapshot.error}:${snapshot.total}:${maxEnded}`;
}

/**
 * Issue #4385 (T10): the agents of `next` that just completed — status `done` /
 * `error` where the previous snapshot had the agent `running`, had no entry for
 * it at all, or had a different `endedAt` (a re-notification after a resume:
 * #4383's tracker sets `endedAt` to each completion record's own timestamp).
 * An id first seen as finished counts too, because the snapshot is ephemeral (a
 * hub restart) and the recorder's full-file REPLACE is idempotent. Pure: reads no
 * file — the engine records the returned agents off the socket handler.
 */
function completedBackgroundAgents(
  previous: BackgroundAgentsSnapshot | null | undefined,
  next: BackgroundAgentsSnapshot | null | undefined
): BackgroundAgentEntry[] {
  const prevById = new Map<string, BackgroundAgentEntry>();
  for (const a of previous?.agents ?? []) prevById.set(a.id, a);
  const out: BackgroundAgentEntry[] = [];
  const nextIds = new Set<string>();
  for (const a of next?.agents ?? []) {
    nextIds.add(a.id);
    if (a.status !== "done" && a.status !== "error") continue;
    const prev = prevById.get(a.id);
    if (
      !prev ||
      prev.status === "running" ||
      (prev.endedAt ?? null) !== (a.endedAt ?? null)
    ) {
      out.push(a);
    }
  }
  // #4385 fix round 1: the CLI tracker clears only finished agents (T1, and the
  // snapshot keeps every running one), so a running agent missing from the next
  // snapshot finished and was cleared before any tick reported it. Recording it
  // from its file is idempotent (full-file REPLACE).
  for (const p of previous?.agents ?? []) {
    if (p.status === "running" && !nextIds.has(p.id)) {
      out.push({ ...p, status: "done" });
    }
  }
  return out;
}
