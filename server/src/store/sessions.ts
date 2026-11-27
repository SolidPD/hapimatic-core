// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { SessionView, UiCollapseState } from "@hapi/protocol";
import { MAX_RUNNER_KEYS_PER_LIST } from "@hapi/protocol";

import type { StoredSession, VersionedUpdateResult } from "./types";
import { safeJsonParse } from "./json";
import { attachedMetadata, erasedArchiveLine } from "./sessionLifecycle";
import {
  parseManagerStampReason,
  type ManagerStampReason,
} from "@hapi/protocol/schemas";
import { updateVersionedField } from "./versionedUpdates";
import type { TrackingOrigin, TrackingRecordDraft } from "@hapi/protocol";
import { isBillableSwitchStorageReady } from "./billableSwitchStore";
import {
  writeTrackingState,
  type TrackingEventFields,
} from "./billableTrackingStore";

type DbSessionRow = {
  id: string;
  tag: string | null;
  namespace: string;
  machine_id: string | null;
  created_at: number;
  updated_at: number;
  metadata: string | null;
  metadata_version: number;
  agent_state: string | null;
  agent_state_version: number;
  todos: string | null;
  todos_updated_at: number | null;
  active: number;
  active_at: number | null;
  seq: number;
  notes: string | null;
  persisted_view: string | null;
  prompt_draft: string | null;
  emoji: string | null;
  timer_data: string | null;
  server_accumulated_ms: number | null;
  linked_issue: string | null;
  resolved_model: string | null;
  context_window_tokens: number | null;
  context_used_tokens: number | null;
  context_percentage: number | null;
  needs_review_override: string | null;
  auto_recover_from_api_error: number | null;
  ui_collapse_state: string | null;
  message_count?: number;
  parent_session_id: string | null;
  parent_relationship: string | null;
  branch_label: string | null;
  branch_created_at: number | null;
  // Issue #6918: absent on a database whose manager-stamp migration failed.
  manager_session_id?: string | null;
  manager_stamp_reason?: string | null;
  // Issue #6646: absent on a database whose billable migration failed.
  billable?: number | null;
  billable_confirm?: string | null;
};

/**
 * Issue #6646: the switch is read only when the node's switch storage is ready;
 * otherwise both fields stay undefined, so the record and the summary leave
 * them out and the session reads "unknown" (A5), never "non-billable".
 */
function billableFields(
  row: DbSessionRow,
  switchReady: boolean
): Pick<StoredSession, "billable" | "billableConfirm"> {
  if (!switchReady || row.billable === undefined || row.billable === null) {
    return {};
  }
  return {
    billable: row.billable === 1,
    billableConfirm: row.billable_confirm === "pending" ? "pending" : null,
  };
}

function toStoredSession(
  row: DbSessionRow,
  switchReady: boolean
): StoredSession {
  return {
    ...billableFields(row, switchReady),
    id: row.id,
    tag: row.tag,
    namespace: row.namespace,
    machineId: row.machine_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: safeJsonParse(row.metadata),
    metadataVersion: row.metadata_version,
    agentState: safeJsonParse(row.agent_state),
    agentStateVersion: row.agent_state_version,
    todos: safeJsonParse(row.todos),
    todosUpdatedAt: row.todos_updated_at,
    active: row.active === 1,
    activeAt: row.active_at,
    seq: row.seq,
    notes: row.notes,
    // Issue #3286: TEXT column → typed view. DB TEXT is untyped, so cast at this
    // boundary; the mutation schema (SessionViewSchema) validates on write.
    persistedView: row.persisted_view as SessionView | null,
    promptDraft: row.prompt_draft,
    emoji: row.emoji,
    timerData: row.timer_data,
    serverAccumulatedMs: row.server_accumulated_ms ?? 0,
    linkedIssue: safeJsonParse(row.linked_issue) as {
      number: number;
      title: string;
      repo: string;
      state?: "open" | "closed";
    } | null,
    resolvedModel: row.resolved_model,
    contextWindowTokens: row.context_window_tokens,
    contextUsedTokens: row.context_used_tokens,
    contextPercentage: row.context_percentage,
    needsReviewOverride: row.needs_review_override as "read" | "unread" | null,
    autoRecoverFromApiError:
      row.auto_recover_from_api_error == null
        ? null
        : row.auto_recover_from_api_error === 1,
    uiCollapseState: safeJsonParse(
      row.ui_collapse_state
    ) as UiCollapseState | null,
    messageCount: row.message_count,
    parentSessionId: row.parent_session_id,
    parentRelationship:
      (row.parent_relationship as "branch" | "spawn" | null) ?? null,
    branchLabel: row.branch_label,
    branchCreatedAt: row.branch_created_at,
    // Issue #6918: read defensively (a failed migration leaves the keys absent),
    // and an unknown reason string reads as undecided, never as a decision.
    managerSessionId: row.manager_session_id ?? null,
    managerStampReason: parseManagerStampReason(row.manager_stamp_reason),
  };
}

/**
 * Issue #6646: the start value of a new session row, applied on the INSERT
 * branch only, in the same transaction as the row. Since #6778 PR-B it is the
 * tracking record (null: untracked) and its `start` row, written through the one
 * writer (`writeTrackingState`), which sets the projection columns from it. The
 * caller computes it only when the gate is `on`.
 */
export type BillableSwitchInitial = {
  record: TrackingRecordDraft | null;
  reason: string;
  origin: TrackingOrigin;
  event: TrackingEventFields;
};

/**
 * The one place a session row is created (every registration reaches it through
 * `sessionCache.getOrCreateSession` from `POST /cli/sessions`). The existence
 * SELECT, the base INSERT (unchanged, so registration never names a column a
 * failed migration could lack), the switch UPDATE and the `start` event all
 * run in ONE `.immediate()` transaction: the check and the
 * insert are atomic across processes (the CLI and operator scripts can hold the
 * same file), and a busy writer waits for `busy_timeout` instead of failing on
 * a lock upgrade (#3631). `initial` is called only when a row is inserted;
 * anything it or the event write throws rolls the whole insert back.
 *
 * Issue #6324: an existing row is returned as stored, except that a
 * daemon-started attach sets a row that does not read `running` back to it
 * (`attachedMetadata`), in the same transaction. The reset fails open: an error
 * of its write, or one that takes the transaction or the commit with it (a full
 * disk), leaves the row and the attach as they would be without it.
 */
export function getOrCreateSessionWithFlag(
  db: Database,
  tag: string,
  metadata: unknown,
  agentState: unknown,
  namespace: string,
  initial?: () => BillableSwitchInitial | null
): { session: StoredSession; created: boolean } {
  let resetOf: string | null = null;
  let resetDone = false;
  let erasedArchive: string | null = null;
  const run = db.transaction(
    (withReset: boolean): { session: StoredSession; created: boolean } => {
      const existing = db
        .prepare(
          "SELECT * FROM sessions WHERE tag = ? AND namespace = ? ORDER BY created_at DESC LIMIT 1"
        )
        .get(tag, namespace) as DbSessionRow | undefined | null;

      if (existing != null) {
        const stored = safeJsonParse(existing.metadata);
        const attached = withReset
          ? attachedMetadata(stored, metadata, Date.now())
          : null;
        let reset: StoredSession | null = null;
        if (attached !== null) {
          resetOf = existing.id;
          const written = updateSessionMetadata(
            db,
            existing.id,
            attached,
            existing.metadata_version,
            namespace,
            { touchUpdatedAt: false }
          );
          if (written.result === "success") {
            reset = getSession(db, existing.id);
            resetDone = true;
            erasedArchive = erasedArchiveLine(existing.id, stored);
          }
        }
        return {
          session:
            reset ??
            toStoredSession(existing, isBillableSwitchStorageReady(db)),
          created: false,
        };
      }

      const now = Date.now();
      const id = randomUUID();

      const metadataJson = JSON.stringify(metadata);
      const agentStateJson =
        agentState === null || agentState === undefined
          ? null
          : JSON.stringify(agentState);

      db.prepare(
        `
        INSERT INTO sessions (
            id, tag, namespace, machine_id, created_at, updated_at,
            metadata, metadata_version,
            agent_state, agent_state_version,
            todos, todos_updated_at,
            active, active_at, seq
        ) VALUES (
            @id, @tag, @namespace, NULL, @created_at, @updated_at,
            @metadata, 1,
            @agent_state, 1,
            NULL, NULL,
            0, NULL, 0
        )
    `
      ).run({
        id,
        tag,
        namespace,
        created_at: now,
        updated_at: now,
        metadata: metadataJson,
        agent_state: agentStateJson,
      });

      const start = initial?.() ?? null;
      if (start) {
        writeTrackingState(db, {
          namespace,
          sessionId: id,
          start: true,
          next: () => start.record,
          reasonFor: () => start.reason,
          origin: start.origin,
          event: start.event,
          now,
        });
      }

      const row = getSession(db, id);
      if (!row) {
        throw new Error("Failed to create session");
      }
      return { session: row, created: true };
    }
  );
  let result: { session: StoredSession; created: boolean };
  try {
    result = run.immediate(true);
  } catch (error) {
    // Only the reset's own failure is retried, without it. An insert's error
    // goes on as before: the session cache records it as a lost start.
    if (resetOf === null) throw error;
    resetDone = false;
    erasedArchive = null;
    result = run.immediate(false);
  }
  if (resetOf !== null && !resetDone) {
    console.warn(`[Store] session attach could not reset: session=${resetOf}`);
  }
  if (erasedArchive !== null) console.log(erasedArchive);
  return result;
}

export function getOrCreateSession(
  db: Database,
  tag: string,
  metadata: unknown,
  agentState: unknown,
  namespace: string
): StoredSession {
  return getOrCreateSessionWithFlag(db, tag, metadata, agentState, namespace)
    .session;
}

export function updateSessionMetadata(
  db: Database,
  id: string,
  metadata: unknown,
  expectedVersion: number,
  namespace: string,
  options?: { touchUpdatedAt?: boolean }
): VersionedUpdateResult<unknown | null> {
  const now = Date.now();
  const touchUpdatedAt = options?.touchUpdatedAt !== false;

  return updateVersionedField({
    db,
    table: "sessions",
    id,
    namespace,
    field: "metadata",
    versionField: "metadata_version",
    expectedVersion,
    value: metadata,
    encode: value => {
      const json = JSON.stringify(value);
      return json === undefined ? null : json;
    },
    decode: safeJsonParse,
    setClauses: [
      "updated_at = CASE WHEN @touch_updated_at = 1 THEN @updated_at ELSE updated_at END",
      "seq = seq + 1",
    ],
    params: {
      updated_at: now,
      touch_updated_at: touchUpdatedAt ? 1 : 0,
    },
  });
}

export function updateSessionAgentState(
  db: Database,
  id: string,
  agentState: unknown,
  expectedVersion: number,
  namespace: string
): VersionedUpdateResult<unknown | null> {
  const now = Date.now();
  const normalized = agentState ?? null;

  return updateVersionedField({
    db,
    table: "sessions",
    id,
    namespace,
    field: "agent_state",
    versionField: "agent_state_version",
    expectedVersion,
    value: normalized,
    encode: value => (value === null ? null : JSON.stringify(value)),
    decode: safeJsonParse,
    setClauses: ["updated_at = @updated_at", "seq = seq + 1"],
    params: { updated_at: now },
  });
}

export function setSessionTodos(
  db: Database,
  id: string,
  todos: unknown,
  todosUpdatedAt: number,
  namespace: string
): boolean {
  try {
    const json =
      todos === null || todos === undefined ? null : JSON.stringify(todos);
    const result = db
      .prepare(
        `
            UPDATE sessions
            SET todos = @todos,
                todos_updated_at = @todos_updated_at,
                updated_at = CASE WHEN updated_at > @updated_at THEN updated_at ELSE @updated_at END,
                seq = seq + 1
            WHERE id = @id
              AND namespace = @namespace
              AND (todos_updated_at IS NULL OR todos_updated_at < @todos_updated_at)
        `
      )
      .run({
        id,
        todos: json,
        todos_updated_at: todosUpdatedAt,
        updated_at: todosUpdatedAt,
        namespace,
      });

    return result.changes === 1;
  } catch {
    return false;
  }
}

export function getSession(db: Database, id: string): StoredSession | null {
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
    | DbSessionRow
    | undefined;
  return row ? toStoredSession(row, isBillableSwitchStorageReady(db)) : null;
}

export function getSessionByNamespace(
  db: Database,
  id: string,
  namespace: string
): StoredSession | null {
  const row = db
    .prepare("SELECT * FROM sessions WHERE id = ? AND namespace = ?")
    .get(id, namespace) as DbSessionRow | undefined;
  return row ? toStoredSession(row, isBillableSwitchStorageReady(db)) : null;
}

export function getSessions(db: Database): StoredSession[] {
  const rows = db
    .prepare(
      `
        SELECT s.*, COUNT(m.id) as message_count
        FROM sessions s
        LEFT JOIN messages m ON m.session_id = s.id
        GROUP BY s.id
        ORDER BY s.updated_at DESC
    `
    )
    .all() as DbSessionRow[];
  const ready = isBillableSwitchStorageReady(db);
  return rows.map(row => toStoredSession(row, ready));
}

export function getSessionsByNamespace(
  db: Database,
  namespace: string
): StoredSession[] {
  const rows = db
    .prepare(
      `
        SELECT s.*, COUNT(m.id) as message_count
        FROM sessions s
        LEFT JOIN messages m ON m.session_id = s.id
        WHERE s.namespace = ?
        GROUP BY s.id
        ORDER BY s.updated_at DESC
    `
    )
    .all(namespace) as DbSessionRow[];
  const ready = isBillableSwitchStorageReady(db);
  return rows.map(row => toStoredSession(row, ready));
}

export function deleteSession(
  db: Database,
  id: string,
  namespace: string
): boolean {
  const result = db
    .prepare("DELETE FROM sessions WHERE id = ? AND namespace = ?")
    .run(id, namespace);
  return result.changes > 0;
}

export function deleteSessions(
  db: Database,
  ids: string[],
  namespace: string
): number {
  if (ids.length === 0) return 0;

  const placeholders = ids.map(() => "?").join(", ");
  const result = db
    .prepare(
      `DELETE FROM sessions WHERE id IN (${placeholders}) AND namespace = ?`
    )
    .run(...ids, namespace);
  return result.changes;
}

/**
 * Persist a session's notes. `notes` is OPAQUE to the store — it may be a legacy
 * plain string or a JSON-serialized `NotesContent` envelope (`{ text, attachments }`,
 * issue #1075). The `notes TEXT` column accepts either with NO schema migration;
 * clients decode via `parseNotes()` from `@hapi/protocol` on read.
 */
export function updateSessionNotes(
  db: Database,
  id: string,
  notes: string | null,
  namespace: string
): boolean {
  const result = db
    .prepare(
      `
        UPDATE sessions
        SET notes = @notes,
            seq = seq + 1
        WHERE id = @id AND namespace = @namespace
    `
    )
    .run({
      id,
      notes,
      namespace,
    });
  return result.changes === 1;
}

/**
 * Issue #3286 (View Picker): persist a session's selected view. Additive/nullable
 * column (`persisted_view TEXT`); the value is validated as a `SessionView` enum
 * upstream by the mutation schema, so the store treats it as an opaque string.
 */
export function updateSessionView(
  db: Database,
  id: string,
  view: SessionView | null,
  namespace: string
): boolean {
  const result = db
    .prepare(
      `
        UPDATE sessions
        SET persisted_view = @view,
            seq = seq + 1
        WHERE id = @id AND namespace = @namespace
    `
    )
    .run({
      id,
      view,
      namespace,
    });
  return result.changes === 1;
}

export function updateSessionPromptDraft(
  db: Database,
  id: string,
  promptDraft: string | null,
  namespace: string
): boolean {
  const result = db
    .prepare(
      `
        UPDATE sessions
        SET prompt_draft = @promptDraft,
            seq = seq + 1
        WHERE id = @id AND namespace = @namespace
    `
    )
    .run({
      id,
      promptDraft,
      namespace,
    });
  return result.changes === 1;
}

export function updateSessionEmoji(
  db: Database,
  id: string,
  emoji: string | null,
  namespace: string
): boolean {
  const result = db
    .prepare(
      `
        UPDATE sessions
        SET emoji = @emoji,
            seq = seq + 1
        WHERE id = @id AND namespace = @namespace
    `
    )
    .run({
      id,
      emoji,
      namespace,
    });
  return result.changes === 1;
}

export function updateSessionServerTime(
  db: Database,
  id: string,
  serverAccumulatedMs: number,
  namespace: string
): boolean {
  const result = db
    .prepare(
      `
        UPDATE sessions
        SET server_accumulated_ms = @server_accumulated_ms
        WHERE id = @id AND namespace = @namespace
    `
    )
    .run({
      id,
      server_accumulated_ms: serverAccumulatedMs,
      namespace,
    });
  return result.changes === 1;
}

export function updateSessionLinkedIssue(
  db: Database,
  id: string,
  linkedIssue: {
    number: number;
    title: string;
    repo: string;
    state?: "open" | "closed";
  } | null,
  namespace: string
): boolean {
  const result = db
    .prepare(
      `
        UPDATE sessions
        SET linked_issue = @linked_issue,
            seq = seq + 1
        WHERE id = @id AND namespace = @namespace
    `
    )
    .run({
      id,
      linked_issue: linkedIssue ? JSON.stringify(linkedIssue) : null,
      namespace,
    });
  return result.changes === 1;
}

export function updateSessionResolvedModel(
  db: Database,
  id: string,
  resolvedModel: string | null,
  namespace: string
): boolean {
  const result = db
    .prepare(
      `
        UPDATE sessions
        SET resolved_model = @resolved_model,
            seq = seq + 1
        WHERE id = @id AND namespace = @namespace
    `
    )
    .run({
      id,
      resolved_model: resolvedModel,
      namespace,
    });
  return result.changes === 1;
}

// Issue #1469: persist first-order context window + live usage.
export function updateSessionContextUsage(
  db: Database,
  id: string,
  contextWindowTokens: number | null,
  contextUsedTokens: number | null,
  contextPercentage: number | null,
  namespace: string
): boolean {
  const result = db
    .prepare(
      `
        UPDATE sessions
        SET context_window_tokens = @context_window_tokens,
            context_used_tokens = @context_used_tokens,
            context_percentage = @context_percentage,
            seq = seq + 1
        WHERE id = @id AND namespace = @namespace
    `
    )
    .run({
      id,
      context_window_tokens: contextWindowTokens,
      context_used_tokens: contextUsedTokens,
      context_percentage: contextPercentage,
      namespace,
    });
  return result.changes === 1;
}

export function updateSessionNeedsReviewOverride(
  db: Database,
  id: string,
  needsReviewOverride: "read" | "unread" | null,
  namespace: string
): boolean {
  const result = db
    .prepare(
      `
        UPDATE sessions
        SET needs_review_override = @needs_review_override,
            seq = seq + 1
        WHERE id = @id AND namespace = @namespace
    `
    )
    .run({
      id,
      needs_review_override: needsReviewOverride,
      namespace,
    });
  return result.changes === 1;
}

export function updateSessionAutoRecoverFromApiError(
  db: Database,
  id: string,
  autoRecover: boolean | null,
  namespace: string
): boolean {
  const result = db
    .prepare(
      `
        UPDATE sessions
        SET auto_recover_from_api_error = @auto_recover,
            seq = seq + 1
        WHERE id = @id AND namespace = @namespace
    `
    )
    .run({
      id,
      auto_recover: autoRecover == null ? null : autoRecover ? 1 : 0,
      namespace,
    });
  return result.changes === 1;
}

export function clearSessionNeedsReviewOverride(
  db: Database,
  id: string,
  namespace: string
): boolean {
  const result = db
    .prepare(
      `
        UPDATE sessions
        SET needs_review_override = NULL
        WHERE id = @id AND namespace = @namespace AND needs_review_override IS NOT NULL
    `
    )
    .run({ id, namespace });
  return result.changes === 1;
}

export function updateSessionUiCollapseState(
  db: Database,
  id: string,
  uiCollapseState: UiCollapseState | null,
  namespace: string
): boolean {
  const result = db
    .prepare(
      `
        UPDATE sessions
        SET ui_collapse_state = @ui_collapse_state,
            seq = seq + 1
        WHERE id = @id AND namespace = @namespace
    `
    )
    .run({
      id,
      ui_collapse_state: uiCollapseState
        ? JSON.stringify(uiCollapseState)
        : null,
      namespace,
    });
  return result.changes === 1;
}

export function updateSessionBranchInfo(
  db: Database,
  id: string,
  parentSessionId: string,
  branchLabel: string | null,
  namespace: string
): boolean {
  const now = Date.now();
  const result = db
    .prepare(
      `
        UPDATE sessions
        SET parent_session_id = @parent_session_id,
            parent_relationship = 'branch',
            branch_label = @branch_label,
            branch_created_at = @branch_created_at,
            seq = seq + 1
        WHERE id = @id AND namespace = @namespace
    `
    )
    .run({
      id,
      parent_session_id: parentSessionId,
      branch_label: branchLabel,
      branch_created_at: now,
      namespace,
    });
  return result.changes === 1;
}

/**
 * Persist a spawn-originated parent link (issue #2479).
 *
 * Distinct from updateSessionBranchInfo: it writes ONLY parent_session_id +
 * parent_relationship (no branch_label / branch_created_at), so a PM-spawned
 * managed peer is never mistaken for a branch by branch-created-at readers.
 * The caller (syncEngine.spawnSession choke point → sessionCache) MUST pass the
 * child's resolved store uuid as `id`, NEVER a raw daemon result.sessionId
 * (which is a tag on reattach/no-webhook paths — expert-review 2026-08-02, R-1).
 */
export function updateSessionParentRelationship(
  db: Database,
  id: string,
  parentSessionId: string,
  parentRelationship: "branch" | "spawn",
  namespace: string
): boolean {
  const result = db
    .prepare(
      `
        UPDATE sessions
        SET parent_session_id = @parent_session_id,
            parent_relationship = @parent_relationship,
            seq = seq + 1
        WHERE id = @id AND namespace = @namespace
    `
    )
    .run({
      id,
      parent_session_id: parentSessionId,
      parent_relationship: parentRelationship,
      namespace,
    });
  return result.changes === 1;
}

export function getChildBranchCount(
  db: Database,
  parentSessionId: string
): number {
  const row = db
    .prepare(
      // #2479: BRANCH count excludes spawn peers (managed peers, not branches).
      // `IS NOT 'spawn'` is null-safe in SQLite: legacy-null and 'branch' count,
      // 'spawn' does not.
      "SELECT COUNT(*) as count FROM sessions WHERE parent_session_id = ? AND parent_relationship IS NOT 'spawn'"
    )
    .get(parentSessionId) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function getChildBranchCounts(
  db: Database,
  namespace: string
): Map<string, number> {
  const rows = db
    .prepare(
      // #2479: BRANCH counts exclude spawn peers (managed peers, not branches).
      `SELECT parent_session_id, COUNT(*) as count
       FROM sessions
       WHERE parent_session_id IS NOT NULL AND parent_relationship IS NOT 'spawn' AND namespace = ?
       GROUP BY parent_session_id`
    )
    .all(namespace) as Array<{ parent_session_id: string; count: number }>;
  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(row.parent_session_id, row.count);
  }
  return map;
}

/**
 * #2480 (R5): check whether a column exists on the sessions table. Cheap PRAGMA
 * read — used by dissolveChildSessions to feature-detect `parent_relationship`
 * so the dissolve works whether or not Sub-Issue A (#2479) has landed. The
 * delete path is not hot, so a per-call PRAGMA is acceptable (and avoids a stale
 * cache across the distinct DB instances tests create).
 */
function sessionsColumnExists(db: Database, column: string): boolean {
  const cols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{
    name: string;
  }>;
  return cols.some(c => c.name === column);
}

/** Issue #6918: a manager-stamp decision as the spawn path writes it. */
export type ManagerStampWrite = {
  managerSessionId: string | null;
  reason: ManagerStampReason;
};

/**
 * Issue #6918: write a session's manager stamp, set once. Its own statement,
 * never part of the parent-link UPDATE: an UPDATE naming a missing column
 * throws before it writes, so on a node whose migration failed the parent link
 * and the registration must not depend on it (R11). Returns true only when
 * this call wrote the decision; a decided row is never changed (R3).
 */
export function setManagerStamp(
  db: Database,
  id: string,
  stamp: ManagerStampWrite,
  namespace: string
): boolean {
  try {
    if (
      !sessionsColumnExists(db, "manager_stamp_reason") ||
      !sessionsColumnExists(db, "manager_session_id")
    ) {
      return false;
    }
    const result = db
      .prepare(
        `
          UPDATE sessions
          SET manager_session_id = CASE WHEN manager_stamp_reason IS NULL
                THEN @manager_session_id ELSE manager_session_id END,
              manager_stamp_reason = COALESCE(manager_stamp_reason, @reason),
              seq = seq + 1
          WHERE id = @id AND namespace = @namespace
            AND manager_stamp_reason IS NULL
      `
      )
      .run({
        id,
        namespace,
        manager_session_id: stamp.managerSessionId,
        reason: stamp.reason,
      });
    return result.changes === 1;
  } catch (error) {
    console.warn(
      `[manager-stamp] could not write the stamp of session ${id}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return false;
  }
}

/**
 * #2480: dissolve the children of one or more deleted parent sessions.
 *
 * Nulls each surviving child's parent link (`parent_session_id` +
 * `parent_relationship`) and bumps `seq`, so deleting a parent leaves its
 * children as independent top-level sessions instead of cascade-destroying the
 * whole group. Applies to BOTH peer (`"spawn"`) and branch (`"branch"`)
 * children — the predicate is relationship-agnostic.
 *
 * The SELECT captures the child ids BEFORE the UPDATE nulls
 * `parent_session_id`, so the caller can emit a `session-updated` per surviving
 * child (a post-update SELECT on the same predicate would match nothing).
 *
 * - **Single form** — pass one parent id (the `deleteSession` path).
 * - **Bulk form** — pass the batch of deleted parent ids AND `excludeIds` = the
 *   same batch, so children that are themselves being deleted ("Delete all (N)")
 *   are left for the cascade to remove, while out-of-batch children (e.g. a
 *   delete-disconnected of a parent whose children survive) are dissolved. This
 *   keeps local and federation bulk-delete semantics aligned.
 *
 * R5 (defensive): `parent_relationship` may not exist if Sub-Issue A (#2479) has
 * not landed — feature-detect and drop that clause when the column is absent, so
 * the dissolve still nulls `parent_session_id`.
 *
 * Ordering is load-bearing: the caller MUST run this BEFORE removing the parent
 * row, so `WHERE parent_session_id IN (...)` still matches.
 *
 * @returns the ids of the children that were dissolved.
 */
export function dissolveChildSessions(
  db: Database,
  parentIds: string | string[],
  namespace: string,
  excludeIds: string[] = []
): string[] {
  const parents = Array.isArray(parentIds) ? parentIds : [parentIds];
  if (parents.length === 0) return [];

  const parentPlaceholders = parents.map(() => "?").join(", ");
  const excludeClause =
    excludeIds.length > 0
      ? ` AND id NOT IN (${excludeIds.map(() => "?").join(", ")})`
      : "";
  const whereArgs = [...parents, namespace, ...excludeIds];

  // Capture the child ids BEFORE the UPDATE nulls parent_session_id.
  const childIds = (
    db
      .prepare(
        `SELECT id FROM sessions
         WHERE parent_session_id IN (${parentPlaceholders})
           AND namespace = ?${excludeClause}`
      )
      .all(...whereArgs) as Array<{ id: string }>
  ).map(row => row.id);
  if (childIds.length === 0) return [];

  // R5: null parent_relationship only when the column exists (Sub A #2479).
  const setClause = sessionsColumnExists(db, "parent_relationship")
    ? "parent_session_id = NULL, parent_relationship = NULL, seq = seq + 1"
    : "parent_session_id = NULL, seq = seq + 1";

  db.prepare(
    `UPDATE sessions
     SET ${setClause}
     WHERE parent_session_id IN (${parentPlaceholders})
       AND namespace = ?${excludeClause}`
  ).run(...whereArgs);

  return childIds;
}

// #1032: read from the denormalized sessions.user_message_count column
// instead of scanning the messages table with a json_extract filter. Bun's
// sqlite driver is synchronous, so the old O(messages) query blocked the
// entire event loop under memory pressure. MessageStore.addMessage keeps
// the counter in sync on every user-role insert; Store.backfillUserMessageCount
// reconciles the counter at startup.
export function getMessageCountForSession(
  db: Database,
  sessionId: string
): number {
  const row = db
    .prepare(
      "SELECT COALESCE(user_message_count, 0) AS message_count FROM sessions WHERE id = ?"
    )
    .get(sessionId) as { message_count: number } | null;
  return row?.message_count ?? 0;
}

// #5254: the ceiling guard's inactivity gate. A primary-key read of the
// denormalized column MessageStore.addMessage maintains, so the turn-finalize
// hot path never scans `messages`. NULL = no operator message ever arrived.
export function getLastOperatorMessageAt(
  db: Database,
  sessionId: string
): number | null {
  const row = db
    .prepare("SELECT last_operator_message_at AS at FROM sessions WHERE id = ?")
    .get(sessionId) as { at: number | null } | null;
  return typeof row?.at === "number" ? row.at : null;
}

export function getMessageCountsByNamespace(
  db: Database,
  namespace: string
): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT id, COALESCE(user_message_count, 0) AS message_count
       FROM sessions
       WHERE namespace = ?`
    )
    .all(namespace) as Array<{ id: string; message_count: number }>;

  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.id, row.message_count);
  }
  return counts;
}

/**
 * Issue #6647 (R2, R15): a session's runner record, kept in seven nullable
 * `sessions` columns and never mapped into the Session record (plan §7). A
 * NULL `attachedAt` is "no record"; the two key lists and `cutAt` are read in
 * every state. Keys only, never a runner id.
 */
export type RunnerRecord = {
  runnerKey: string | null;
  startedBy: string | null;
  pid: number | null;
  attachedAt: number | null;
  supersededKeys: string[];
  refusedKeys: string[];
  cutAt: number | null;
};

type DbRunnerRow = {
  runner_key: string | null;
  runner_started_by: string | null;
  runner_pid: number | null;
  runner_attached_at: number | null;
  runner_superseded_keys: string | null;
  runner_refused_keys: string | null;
  runner_cut_at: number | null;
};

/** A malformed or missing list column reads as `[]`. */
function readRunnerKeys(raw: string | null): string[] {
  const parsed = safeJsonParse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((k): k is string => typeof k === "string");
}

/** Keep the newest keys: the list is oldest first, so the oldest go first. */
function capRunnerKeys(keys: readonly string[]): string[] {
  return keys.slice(-MAX_RUNNER_KEYS_PER_LIST);
}

export function getRunnerRecord(
  db: Database,
  sessionId: string,
  namespace: string
): RunnerRecord | null {
  const row = db
    .prepare(
      `SELECT runner_key, runner_started_by, runner_pid, runner_attached_at,
              runner_superseded_keys, runner_refused_keys, runner_cut_at
       FROM sessions WHERE id = ? AND namespace = ?`
    )
    .get(sessionId, namespace) as DbRunnerRow | undefined | null;
  if (row == null) return null;
  return {
    runnerKey: row.runner_key,
    startedBy: row.runner_started_by,
    pid: row.runner_pid,
    attachedAt: row.runner_attached_at,
    supersededKeys: readRunnerKeys(row.runner_superseded_keys),
    refusedKeys: readRunnerKeys(row.runner_refused_keys),
    cutAt: row.runner_cut_at,
  };
}

/**
 * Writes the `runner_*` columns only, never `seq` or `updated_at`: the session
 * lists are ordered by `updated_at`, so a record write must not reorder them.
 */
export function setRunnerRecord(
  db: Database,
  sessionId: string,
  namespace: string,
  record: RunnerRecord
): boolean {
  const result = db
    .prepare(
      `UPDATE sessions
       SET runner_key = @runner_key,
           runner_started_by = @runner_started_by,
           runner_pid = @runner_pid,
           runner_attached_at = @runner_attached_at,
           runner_superseded_keys = @runner_superseded_keys,
           runner_refused_keys = @runner_refused_keys,
           runner_cut_at = @runner_cut_at
       WHERE id = @id AND namespace = @namespace`
    )
    .run({
      id: sessionId,
      namespace,
      runner_key: record.runnerKey,
      runner_started_by: record.startedBy,
      runner_pid: record.pid,
      runner_attached_at: record.attachedAt,
      runner_superseded_keys: JSON.stringify(
        capRunnerKeys(record.supersededKeys)
      ),
      runner_refused_keys: JSON.stringify(capRunnerKeys(record.refusedKeys)),
      runner_cut_at: record.cutAt,
    });
  return result.changes === 1;
}

/** R15's cut-off mark: sets `runner_cut_at` only. */
export function setRunnerCutAt(
  db: Database,
  sessionId: string,
  cutAt: number | null
): boolean {
  const result = db
    .prepare("UPDATE sessions SET runner_cut_at = ? WHERE id = ?")
    .run(cutAt, sessionId);
  return result.changes === 1;
}

/**
 * Adds a refused (or would-be-refused) newcomer's key, newest last, capped
 * at 16. A key already on the list moves to the end rather than taking a
 * second slot. Two plain statements, no deferred transaction (the store's
 * busy rule, server/CLAUDE.md); sets `runner_refused_keys` only.
 */
export function addRefusedRunnerKey(
  db: Database,
  sessionId: string,
  namespace: string,
  key: string
): boolean {
  const row = db
    .prepare(
      "SELECT runner_refused_keys FROM sessions WHERE id = ? AND namespace = ?"
    )
    .get(sessionId, namespace) as
    | { runner_refused_keys: string | null }
    | undefined
    | null;
  if (row == null) return false;
  const keys = readRunnerKeys(row.runner_refused_keys).filter(k => k !== key);
  keys.push(key);
  const result = db
    .prepare(
      "UPDATE sessions SET runner_refused_keys = ? WHERE id = ? AND namespace = ?"
    )
    .run(JSON.stringify(capRunnerKeys(keys)), sessionId, namespace);
  return result.changes === 1;
}

/** Issue #6647: the seven runner columns of `sessions` (Task 2). */
export const RUNNER_COLUMNS = [
  "runner_key",
  "runner_started_by",
  "runner_pid",
  "runner_attached_at",
  "runner_superseded_keys",
  "runner_refused_keys",
  "runner_cut_at",
] as const;

/** Task 9: whether every runner column exists (the route's `columnsPresent`). */
export function runnerColumnsPresent(db: Database): boolean {
  const rows = db.prepare("PRAGMA table_info(sessions)").all() as Array<{
    name: string;
  }>;
  const names = new Set(rows.map(r => r.name));
  return RUNNER_COLUMNS.every(column => names.has(column));
}

/** The attach's own tag lookup (the newest row with this tag), id only. */
export function findSessionIdByTag(
  db: Database,
  tag: string,
  namespace: string
): string | null {
  const row = db
    .prepare(
      "SELECT id FROM sessions WHERE tag = ? AND namespace = ? ORDER BY created_at DESC LIMIT 1"
    )
    .get(tag, namespace) as { id: string } | undefined | null;
  return row?.id ?? null;
}
