// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import type { SessionView, UiCollapseState } from "@hapi/protocol";

import type { StoredSession, VersionedUpdateResult } from "./types";
import {
  deleteSession,
  deleteSessions,
  getMessageCountForSession,
  getMessageCountsByNamespace,
  getOrCreateSession,
  getSession,
  getSessionByNamespace,
  getSessions,
  getSessionsByNamespace,
  setSessionTodos,
  updateSessionAgentState,
  updateSessionMetadata,
  updateSessionNotes,
  updateSessionView,
  updateSessionPromptDraft,
  updateSessionEmoji,
  updateSessionServerTime,
  updateSessionLinkedIssue,
  updateSessionResolvedModel,
  updateSessionContextUsage,
  updateSessionNeedsReviewOverride,
  updateSessionAutoRecoverFromApiError,
  clearSessionNeedsReviewOverride,
  updateSessionUiCollapseState,
  updateSessionBranchInfo,
  updateSessionParentRelationship,
  getChildBranchCount,
  getChildBranchCounts,
  dissolveChildSessions,
} from "./sessions";

export class SessionStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  getOrCreateSession(
    tag: string,
    metadata: unknown,
    agentState: unknown,
    namespace: string
  ): StoredSession {
    return getOrCreateSession(this.db, tag, metadata, agentState, namespace);
  }

  updateSessionMetadata(
    id: string,
    metadata: unknown,
    expectedVersion: number,
    namespace: string,
    options?: { touchUpdatedAt?: boolean }
  ): VersionedUpdateResult<unknown | null> {
    return updateSessionMetadata(
      this.db,
      id,
      metadata,
      expectedVersion,
      namespace,
      options
    );
  }

  updateSessionAgentState(
    id: string,
    agentState: unknown,
    expectedVersion: number,
    namespace: string
  ): VersionedUpdateResult<unknown | null> {
    return updateSessionAgentState(
      this.db,
      id,
      agentState,
      expectedVersion,
      namespace
    );
  }

  setSessionTodos(
    id: string,
    todos: unknown,
    todosUpdatedAt: number,
    namespace: string
  ): boolean {
    return setSessionTodos(this.db, id, todos, todosUpdatedAt, namespace);
  }

  getSession(id: string): StoredSession | null {
    return getSession(this.db, id);
  }

  getSessionByNamespace(id: string, namespace: string): StoredSession | null {
    return getSessionByNamespace(this.db, id, namespace);
  }

  getSessions(): StoredSession[] {
    return getSessions(this.db);
  }

  getSessionsByNamespace(namespace: string): StoredSession[] {
    return getSessionsByNamespace(this.db, namespace);
  }

  deleteSession(id: string, namespace: string): boolean {
    return deleteSession(this.db, id, namespace);
  }

  deleteSessions(ids: string[], namespace: string): number {
    return deleteSessions(this.db, ids, namespace);
  }

  updateSessionNotes(
    id: string,
    notes: string | null,
    namespace: string
  ): boolean {
    return updateSessionNotes(this.db, id, notes, namespace);
  }

  updateSessionView(
    id: string,
    view: SessionView | null,
    namespace: string
  ): boolean {
    return updateSessionView(this.db, id, view, namespace);
  }

  updateSessionPromptDraft(
    id: string,
    promptDraft: string | null,
    namespace: string
  ): boolean {
    return updateSessionPromptDraft(this.db, id, promptDraft, namespace);
  }

  updateSessionEmoji(
    id: string,
    emoji: string | null,
    namespace: string
  ): boolean {
    return updateSessionEmoji(this.db, id, emoji, namespace);
  }

  updateSessionServerTime(
    id: string,
    serverAccumulatedMs: number,
    namespace: string
  ): boolean {
    return updateSessionServerTime(this.db, id, serverAccumulatedMs, namespace);
  }

  updateSessionLinkedIssue(
    id: string,
    linkedIssue: {
      number: number;
      title: string;
      repo: string;
      state?: "open" | "closed";
    } | null,
    namespace: string
  ): boolean {
    return updateSessionLinkedIssue(this.db, id, linkedIssue, namespace);
  }

  updateSessionResolvedModel(
    id: string,
    resolvedModel: string | null,
    namespace: string
  ): boolean {
    return updateSessionResolvedModel(this.db, id, resolvedModel, namespace);
  }

  // Issue #1469: persist first-order context window + live usage.
  updateSessionContextUsage(
    id: string,
    contextWindowTokens: number | null,
    contextUsedTokens: number | null,
    contextPercentage: number | null,
    namespace: string
  ): boolean {
    return updateSessionContextUsage(
      this.db,
      id,
      contextWindowTokens,
      contextUsedTokens,
      contextPercentage,
      namespace
    );
  }

  updateSessionNeedsReviewOverride(
    id: string,
    needsReviewOverride: "read" | "unread" | null,
    namespace: string
  ): boolean {
    return updateSessionNeedsReviewOverride(
      this.db,
      id,
      needsReviewOverride,
      namespace
    );
  }

  updateSessionAutoRecoverFromApiError(
    id: string,
    autoRecover: boolean | null,
    namespace: string
  ): boolean {
    return updateSessionAutoRecoverFromApiError(
      this.db,
      id,
      autoRecover,
      namespace
    );
  }

  clearSessionNeedsReviewOverride(id: string, namespace: string): boolean {
    return clearSessionNeedsReviewOverride(this.db, id, namespace);
  }

  updateSessionUiCollapseState(
    id: string,
    uiCollapseState: UiCollapseState | null,
    namespace: string
  ): boolean {
    return updateSessionUiCollapseState(
      this.db,
      id,
      uiCollapseState,
      namespace
    );
  }

  getMessageCountForSession(sessionId: string): number {
    return getMessageCountForSession(this.db, sessionId);
  }

  getMessageCountsByNamespace(namespace: string): Map<string, number> {
    return getMessageCountsByNamespace(this.db, namespace);
  }

  updateSessionBranchInfo(
    id: string,
    parentSessionId: string,
    branchLabel: string | null,
    namespace: string
  ): boolean {
    return updateSessionBranchInfo(
      this.db,
      id,
      parentSessionId,
      branchLabel,
      namespace
    );
  }

  /** Persist a spawn-originated parent link (issue #2479). See store fn docs. */
  updateSessionParentRelationship(
    id: string,
    parentSessionId: string,
    parentRelationship: "branch" | "spawn",
    namespace: string
  ): boolean {
    return updateSessionParentRelationship(
      this.db,
      id,
      parentSessionId,
      parentRelationship,
      namespace
    );
  }

  getChildBranchCount(parentSessionId: string): number {
    return getChildBranchCount(this.db, parentSessionId);
  }

  getChildBranchCounts(namespace: string): Map<string, number> {
    return getChildBranchCounts(this.db, namespace);
  }

  /**
   * #2480: dissolve the children of one or more deleted parents (null the
   * parent link + bump seq) so a parent delete leaves them as independent
   * top-level sessions. Returns the dissolved child ids for the caller's emit.
   * See {@link dissolveChildSessions} for the single/bulk + excludeIds contract.
   */
  dissolveChildSessions(
    parentIds: string | string[],
    namespace: string,
    excludeIds: string[] = []
  ): string[] {
    return dissolveChildSessions(this.db, parentIds, namespace, excludeIds);
  }
}
