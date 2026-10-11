// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { ModelMode, PermissionMode } from "@hapi/protocol/types";
import {
  BackgroundAgentsSnapshotSchema,
  ProviderUsageSnapshotMessageSchema,
  type BackgroundAgentsSnapshot,
  type ProviderUsageSnapshotWindow,
} from "@hapi/protocol/schemas";
import type { Store, StoredMessage, StoredSession } from "../../../store";
import type { SyncEvent } from "../../../sync/syncEngine";
import type { ErrorLogger } from "../../../logging/errorLogger";
import type {
  TurnOpenEvent,
  TurnFinalizeEvent,
} from "../../../sync/turnLifecycle";
import { extractTodoWriteTodosFromMessageContent } from "../../../sync/todos";
import type { SocketWithData } from "../../socketTypes";
import type { MessageWriteRetryQueue } from "./messageWriteRetryQueue";
import {
  MESSAGE_WRITE_CATEGORY,
  errorMessage,
  isSqliteBusy,
  sqliteErrorContext,
} from "./messageWriteRetryQueue";

type SessionAlivePayload = {
  sid: string;
  time: number;
  thinking?: boolean;
  mode?: "local" | "remote";
  permissionMode?: PermissionMode;
  modelMode?: ModelMode;
  // Issue #2456: live reasoning-effort level → session record → in-session tag.
  effort?: string;
  // Composer-chip pin integrity: pinned raw model id; `null` = pin cleared.
  rawModel?: string | null;
  resolvedModel?: string;
  contextWindowTokens?: number;
  contextUsedTokens?: number;
  contextPercentage?: number;
  // Issue #1647: rate-limited (429 session-limit) state riding the keepAlive
  // runtime. (blockedOnTuiPrompt also flows here untyped at runtime; rateLimited
  // is typed honestly so the handler forward is type-checked.)
  rateLimited?: {
    resetText: string;
    resetAt: number | null;
    since: number;
  } | null;
  // Issue #4383: background-agents snapshot riding the keepAlive runtime (K11 —
  // forwarded whole to syncEngine → sessionCache, which normalises null to absent).
  backgroundAgents?: BackgroundAgentsSnapshot | null;
};

type SessionEndPayload = {
  sid: string;
  time: number;
};

/**
 * Issue #3809: an OpenAI/codex pacing snapshot resolved to the session's bound
 * account. Forwarded to `ProviderUsageService` (NEVER `turnLifecycle`), so
 * provider usage stays out of turns/history/alerts by construction (D5 = C).
 */
export type ProviderUsageSnapshotEvent = {
  accountUuid: string;
  windows: ProviderUsageSnapshotWindow[];
};

type AccessErrorReason = "namespace-missing" | "access-denied" | "not-found";

type AccessResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: AccessErrorReason };

type ResolveSessionAccess = (sessionId: string) => AccessResult<StoredSession>;

type EmitAccessError = (
  scope: "session" | "machine",
  id: string,
  reason: AccessErrorReason
) => void;

const messageSchema = z.object({
  sid: z.string(),
  message: z.union([z.string(), z.unknown()]),
  localId: z.string().optional(),
});

/**
 * #3631: a successful message write that took at least this long slept on
 * busy_timeout (SQLite's busy ladder resolves at ~100 ms). Logged console-only
 * so the production contention profile is observed rather than assumed.
 */
const BUSY_WAIT_WARN_MS = 250;

const updateMetadataSchema = z.object({
  sid: z.string(),
  expectedVersion: z.number().int(),
  metadata: z.unknown(),
});

const updateStateSchema = z.object({
  sid: z.string(),
  expectedVersion: z.number().int(),
  agentState: z.unknown().nullable(),
});

// Issue #1664 (epic #1662, Sub B): per-turn telemetry payloads. `.passthrough()`
// tolerates the redundant client `kind` discriminator (the event name already
// discriminates) and any future additive field without rejecting the event.
const turnOpenSchema = z
  .object({
    sid: z.string(),
    turnLocalId: z.string(),
    startedAtMs: z.number(),
    ccSessionId: z.string().optional(),
    launcher: z.string().optional(),
    cwd: z.string().optional(),
    transcriptPath: z.string().optional(),
    // Sub D (#1666, CLI-wire git): working-tree state captured by the CLI
    // reporter at turn-open. Optional — a failed local probe sends nothing.
    gitShaStart: z.string().optional(),
    gitBranch: z.string().optional(),
    gitDirty: z.boolean().optional(),
  })
  .passthrough();

const turnFinalizeSchema = z
  .object({
    sid: z.string(),
    turnLocalId: z.string(),
    outcome: z.enum(["completed", "interrupted", "errored"]),
    endedAtMs: z.number(),
    durationMs: z.number(),
    spansSleep: z.boolean().optional(),
    ccSessionId: z.string().optional(),
    transcriptPath: z.string().optional(),
    // Sub D (#1666, CLI-wire git): working-tree state captured by the CLI
    // reporter at turn-finalize. Optional — a dead session sends no finalize.
    gitShaEnd: z.string().optional(),
    gitDirty: z.boolean().optional(),
    // Issue #3352: optional per-turn usage from a non-claude runner. Every field
    // is optional (R4 — an absent cache split is simply omitted, never a 0); the
    // whole block is absent on claude finalizes (R7). `.passthrough()` tolerates
    // any additive field a future runner adds.
    usage: z
      .object({
        modelId: z.string().optional(),
        modelProvider: z.string().optional(),
        tokIn: z.number().optional(),
        tokOut: z.number().optional(),
        tokCacheRead: z.number().optional(),
        tokCacheWrite: z.number().optional(),
        contextUsedTokens: z.number().optional(),
        contextWindowTokens: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type SessionHandlersDeps = {
  store: Store;
  resolveSessionAccess: ResolveSessionAccess;
  emitAccessError: EmitAccessError;
  onSessionAlive?: (payload: SessionAlivePayload) => void;
  onSessionEnd?: (payload: SessionEndPayload) => void;
  onWebappEvent?: (event: SyncEvent) => void;
  onTurnOpen?: (event: TurnOpenEvent) => void;
  onTurnFinalize?: (event: TurnFinalizeEvent) => void;
  /** Issue #3809: an OpenAI/codex pacing snapshot → ProviderUsageService. */
  onProviderUsageSnapshot?: (event: ProviderUsageSnapshotEvent) => void;
  /** #3631: logging channel for the fail-open `message` store write (optional — tests omit). */
  errorLogger?: ErrorLogger | null;
  /** #3631: deferred re-attempt queue for a SQLITE_BUSY message write (ruling D1). */
  messageWriteRetryQueue?: MessageWriteRetryQueue | null;
};

/**
 * #4657: bounds on a `session-alive` `backgroundAgents` snapshot, far above
 * what the CLI tracker sends (a 50-entry list that always keeps every running
 * agent and drops the oldest finished first, so max(50, running) entries;
 * descriptions capped at 200 chars) so a well-formed snapshot always
 * passes, while an oversized one is dropped before it reaches the cache.
 */
export const MAX_BACKGROUND_AGENTS = 500;
export const MAX_BACKGROUND_AGENT_STRING = 10_000;

const BACKGROUND_AGENT_STRING_FIELDS = [
  "id",
  "agentType",
  "description",
  "toolUseId",
  "parentAgentId",
] as const;

export type SanitizedBackgroundAgents =
  | { ok: true; value: BackgroundAgentsSnapshot | null | undefined }
  | { ok: false; reason: string };

/**
 * #4657: validate a CLI-supplied `backgroundAgents` snapshot at the socket
 * boundary. Absent / `null` pass through unchanged (old CLIs omit the field).
 * A snapshot that fails `BackgroundAgentsSnapshotSchema` or the bounds above is
 * rejected with a reason. On success the ORIGINAL object is returned (not the
 * parsed copy), so `.passthrough()` fields and identity are exactly as before.
 */
export function sanitizeBackgroundAgents(
  value: unknown
): SanitizedBackgroundAgents {
  if (value === undefined || value === null) {
    return { ok: true, value };
  }
  const parsed = BackgroundAgentsSnapshotSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") || "(root)";
    return { ok: false, reason: `${path}: ${issue?.message ?? "invalid"}` };
  }
  const { agents } = parsed.data;
  if (agents.length > MAX_BACKGROUND_AGENTS) {
    return {
      ok: false,
      reason: `agents: ${agents.length} entries exceeds ${MAX_BACKGROUND_AGENTS}`,
    };
  }
  for (let i = 0; i < agents.length; i += 1) {
    const agent = agents[i];
    for (const field of BACKGROUND_AGENT_STRING_FIELDS) {
      const fieldValue = agent[field];
      if (
        typeof fieldValue === "string" &&
        fieldValue.length > MAX_BACKGROUND_AGENT_STRING
      ) {
        return {
          ok: false,
          reason: `agents.${i}.${field}: length ${fieldValue.length} exceeds ${MAX_BACKGROUND_AGENT_STRING}`,
        };
      }
    }
  }
  return { ok: true, value: value as BackgroundAgentsSnapshot };
}

export function registerSessionHandlers(
  socket: SocketWithData,
  deps: SessionHandlersDeps
): void {
  const {
    store,
    resolveSessionAccess,
    emitAccessError,
    onSessionAlive,
    onSessionEnd,
    onWebappEvent,
    onTurnOpen,
    onTurnFinalize,
    onProviderUsageSnapshot,
    errorLogger,
    messageWriteRetryQueue,
  } = deps;

  // Issue #1664 (epic #1662, Sub B): per-turn telemetry boundaries. Both
  // handlers are FAIL-OPEN (R8) — a malformed/unknown payload is dropped
  // silently (tolerant Zod parse, no access-error noise) and any handler throw
  // is swallowed. Turn telemetry is a rebuildable index and must never disturb
  // the socket or the session. The server (turnLifecycle) allocates `seq`.
  socket.on("turn:open", (data: unknown) => {
    try {
      const parsed = turnOpenSchema.safeParse(data);
      if (!parsed.success) return;
      onTurnOpen?.({
        sid: parsed.data.sid,
        turnLocalId: parsed.data.turnLocalId,
        startedAtMs: parsed.data.startedAtMs,
        ccSessionId: parsed.data.ccSessionId,
        launcher: parsed.data.launcher,
        cwd: parsed.data.cwd,
        transcriptPath: parsed.data.transcriptPath,
        gitShaStart: parsed.data.gitShaStart,
        gitBranch: parsed.data.gitBranch,
        gitDirty: parsed.data.gitDirty,
      });
    } catch {
      // fail-open — never throw back to the socket
    }
  });

  socket.on("turn:finalize", (data: unknown) => {
    try {
      const parsed = turnFinalizeSchema.safeParse(data);
      if (!parsed.success) return;
      onTurnFinalize?.({
        sid: parsed.data.sid,
        turnLocalId: parsed.data.turnLocalId,
        outcome: parsed.data.outcome,
        endedAtMs: parsed.data.endedAtMs,
        durationMs: parsed.data.durationMs,
        spansSleep: parsed.data.spansSleep,
        ccSessionId: parsed.data.ccSessionId,
        transcriptPath: parsed.data.transcriptPath,
        gitShaEnd: parsed.data.gitShaEnd,
        gitDirty: parsed.data.gitDirty,
        // Issue #3352: forward the optional non-claude usage block (undefined on
        // claude → the finalize seam's cliUsageStep no-ops).
        usage: parsed.data.usage,
      });
    } catch {
      // fail-open — never throw back to the socket
    }
  });

  // Issue #3809: OpenAI/codex pacing-snapshot carrier. FAIL-OPEN (mirrors the
  // two turn:* siblings) — a malformed/unknown payload or an unattributable
  // session is dropped silently (no access-error noise). The snapshot is
  // attributed to the session's bound account (session.metadata.accountUuid —
  // the SAME key turnEnrichment stamps on turns.account_id, so OpenAI snapshots
  // and the Google turn-counter key identically) and forwarded to
  // ProviderUsageService, NEVER turnLifecycle — so provider usage stays out of
  // turns/history/alerts by construction (D5 = C).
  socket.on("provider-usage-snapshot", (data: unknown) => {
    try {
      const parsed = ProviderUsageSnapshotMessageSchema.safeParse(data);
      if (!parsed.success) return;
      const access = resolveSessionAccess(parsed.data.sid);
      if (!access.ok) return;
      // session.metadata is the loosely-typed store blob; accountUuid is the SAME
      // field turnEnrichment reads (turnEnrichment.ts: `m?.accountUuid`).
      const accountUuid = (
        access.value.metadata as { accountUuid?: string } | null | undefined
      )?.accountUuid;
      if (!accountUuid) return; // host-credential codex session — nothing to attribute
      onProviderUsageSnapshot?.({
        accountUuid,
        windows: parsed.data.windows,
      });
    } catch {
      // fail-open — never throw back to the socket
    }
  });

  // #3631: a store write that throws inside this socket.io listener is uncaught at
  // the process level (the server installs no uncaughtException handler) and exits
  // the server — 10 prod crashes on 2026-09-08 came from a SQLITE_BUSY thrown by
  // addMessage below. The listener is now exception-safe, modelled on the two
  // fail-open turn:* siblings above, with one difference (ruling D1): a busy write
  // is not dropped but handed to `messageWriteRetryQueue`, which re-attempts it off
  // the socket path and publishes with the REAL persisted seq. NEVER throw back to
  // the socket, and NEVER perform a store write inside a catch (error_logs lives on
  // the same contended connection; ErrorLogger guards its own persist).
  // `persist: false` = console (+ Sentry) only. A persisted error_logs row is an
  // autocommit INSERT on the SAME hapi.db connection: inside a held-lock window it
  // would block the event loop for up to busy_timeout again and then fail, so a
  // BUSY event is never persisted from here — the drainer writes the durable row
  // once the deferred write lands (lock free) or is finally dropped.
  const logMessageWrite = (
    severity: "error" | "warn",
    message: string,
    sid: string | null,
    context: Record<string, unknown>,
    persist = true
  ): void => {
    try {
      errorLogger?.[severity](message, {
        category: MESSAGE_WRITE_CATEGORY,
        sessionId: sid,
        context,
        persist,
      });
    } catch {
      // never let a logging failure surface to the socket
    }
  };

  // Post-write fan-out for a LANDED row: todo extraction, the `update` broadcast
  // and the `message-received` webapp event. Shared by the synchronous path and
  // the deferred-retry drainer, so both publish the same shape from the real seq.
  const publishStoredMessage = (
    sid: string,
    namespace: string,
    content: unknown,
    msg: StoredMessage
  ): void => {
    // The todo index is ancillary: its write failing must not suppress the
    // broadcast of a message that has already been persisted.
    try {
      const todos = extractTodoWriteTodosFromMessageContent(content);
      if (todos) {
        const updated = store.sessions.setSessionTodos(
          sid,
          todos,
          msg.createdAt,
          namespace
        );
        if (updated) {
          onWebappEvent?.({
            type: "session-updated",
            sessionId: sid,
            data: { sid },
          });
        }
      }
    } catch (error) {
      logMessageWrite(
        "warn",
        `session todo update failed after message ${msg.id} landed: ${errorMessage(error)}`,
        sid,
        { ...sqliteErrorContext(error), messageId: msg.id, seq: msg.seq }
      );
    }

    const update = {
      id: msg.id,
      seq: Date.now(),
      createdAt: Date.now(),
      body: {
        t: "new-message" as const,
        sid,
        message: {
          id: msg.id,
          seq: msg.seq,
          createdAt: msg.createdAt,
          localId: msg.localId,
          content: msg.content,
        },
      },
    };
    socket.to(`session:${sid}`).emit("update", update);

    onWebappEvent?.({
      type: "message-received",
      sessionId: sid,
      message: {
        id: msg.id,
        seq: msg.seq,
        localId: msg.localId,
        content: msg.content,
        createdAt: msg.createdAt,
      },
    });
  };

  const handleMessage = (data: unknown): void => {
    const parsed = messageSchema.safeParse(data);
    if (!parsed.success) {
      return;
    }

    const { sid, localId } = parsed.data;
    const raw = parsed.data.message;

    const content =
      typeof raw === "string"
        ? (() => {
            try {
              return JSON.parse(raw) as unknown;
            } catch {
              return raw;
            }
          })()
        : raw;

    // Extract generatedAt from message meta for chronological ordering (Issue #952)
    let generatedAt: number | undefined;
    if (content && typeof content === "object" && "meta" in content) {
      const meta = (content as Record<string, unknown>).meta;
      if (meta && typeof meta === "object" && "generatedAt" in meta) {
        const ts = (meta as Record<string, unknown>).generatedAt;
        if (typeof ts === "number" && ts > 0) {
          generatedAt = ts;
        }
      }
    }

    const sessionAccess = resolveSessionAccess(sid);
    if (!sessionAccess.ok) {
      emitAccessError("session", sid, sessionAccess.reason);
      return;
    }
    const session = sessionAccess.value;
    const namespace = session.namespace;
    const writeMessage = (): StoredMessage =>
      store.messages.addMessage(sid, content, localId, generatedAt);
    const publish = (msg: StoredMessage): void =>
      publishStoredMessage(sid, namespace, content, msg);

    let msg: StoredMessage;
    const startedAt = performance.now();
    try {
      // ONE blocking attempt (ruling D1): addMessage runs BEGIN IMMEDIATE, so a
      // contended write sleeps the event loop up to busy_timeout (5 s, connection-
      // wide) before throwing SQLITE_BUSY — a synchronous retry loop here would
      // multiply that stall across the whole server.
      msg = writeMessage();
    } catch (error) {
      const waitedMs = Math.round(performance.now() - startedAt);
      const busy = isSqliteBusy(error);
      const deferred = busy && messageWriteRetryQueue != null;
      // A busy failure means the lock is STILL held → console-only (see
      // logMessageWrite). A non-busy failure is persisted: it is not a lock event.
      logMessageWrite(
        deferred ? "warn" : "error",
        `message write ${deferred ? "deferred" : "failed"} for session ${sid} after ${waitedMs} ms: ${errorMessage(error)}`,
        sid,
        {
          ...sqliteErrorContext(error),
          localId: localId ?? null,
          generatedAt: generatedAt ?? null,
          waitedMs,
          busy,
          deferred,
          queueDepthBefore: messageWriteRetryQueue?.queueDepth ?? null,
        },
        !busy
      );
      if (busy && messageWriteRetryQueue) {
        messageWriteRetryQueue.enqueue({
          sid,
          localId: localId ?? null,
          write: writeMessage,
          publish,
        });
      }
      return;
    }
    const waitedMs = Math.round(performance.now() - startedAt);
    if (waitedMs >= BUSY_WAIT_WARN_MS) {
      // Observability for the prod hold profile: a write that succeeded only after
      // sleeping on busy_timeout. Console-only — the lock may still be contended.
      logMessageWrite(
        "warn",
        `message write waited ${waitedMs} ms on busy_timeout for session ${sid} (landed, seq ${msg.seq})`,
        sid,
        { waitedMs, localId: localId ?? null, seq: msg.seq },
        false
      );
    }
    publish(msg);
  };

  socket.on("message", (data: unknown) => {
    try {
      handleMessage(data);
    } catch (error) {
      // Last-resort net for anything outside the write itself (parse, access
      // resolution, broadcast) — fail-open, never throw back to the socket.
      logMessageWrite(
        "error",
        `socket message listener failed: ${errorMessage(error)}`,
        null,
        sqliteErrorContext(error)
      );
    }
  });

  socket.on(
    "update-metadata",
    (data: unknown, cb: (answer: unknown) => void) => {
      const parsed = updateMetadataSchema.safeParse(data);
      if (!parsed.success) {
        cb({ result: "error" });
        return;
      }

      const { sid, metadata, expectedVersion } = parsed.data;
      const sessionAccess = resolveSessionAccess(sid);
      if (!sessionAccess.ok) {
        cb({ result: "error", reason: sessionAccess.reason });
        return;
      }

      const result = store.sessions.updateSessionMetadata(
        sid,
        metadata,
        expectedVersion,
        sessionAccess.value.namespace
      );
      if (result.result === "success") {
        cb({
          result: "success",
          version: result.version,
          metadata: result.value,
        });
      } else if (result.result === "version-mismatch") {
        cb({
          result: "version-mismatch",
          version: result.version,
          metadata: result.value,
        });
      } else {
        cb({ result: "error" });
      }

      if (result.result === "success") {
        const update = {
          id: randomUUID(),
          seq: Date.now(),
          createdAt: Date.now(),
          body: {
            t: "update-session" as const,
            sid,
            metadata: { version: result.version, value: metadata },
            agentState: null,
          },
        };
        socket.to(`session:${sid}`).emit("update", update);
        onWebappEvent?.({
          type: "session-updated",
          sessionId: sid,
          data: { sid },
        });
      }
    }
  );

  socket.on("update-state", (data: unknown, cb: (answer: unknown) => void) => {
    const parsed = updateStateSchema.safeParse(data);
    if (!parsed.success) {
      cb({ result: "error" });
      return;
    }

    const { sid, agentState, expectedVersion } = parsed.data;
    const sessionAccess = resolveSessionAccess(sid);
    if (!sessionAccess.ok) {
      cb({ result: "error", reason: sessionAccess.reason });
      return;
    }

    const result = store.sessions.updateSessionAgentState(
      sid,
      agentState,
      expectedVersion,
      sessionAccess.value.namespace
    );
    if (result.result === "success") {
      cb({
        result: "success",
        version: result.version,
        agentState: result.value,
      });
    } else if (result.result === "version-mismatch") {
      cb({
        result: "version-mismatch",
        version: result.version,
        agentState: result.value,
      });
    } else {
      cb({ result: "error" });
    }

    if (result.result === "success") {
      const update = {
        id: randomUUID(),
        seq: Date.now(),
        createdAt: Date.now(),
        body: {
          t: "update-session" as const,
          sid,
          metadata: null,
          agentState: { version: result.version, value: agentState },
        },
      };
      socket.to(`session:${sid}`).emit("update", update);
      onWebappEvent?.({
        type: "session-updated",
        sessionId: sid,
        data: { sid },
      });
    }
  });

  // #4657: sessions whose malformed `backgroundAgents` was already warned about
  // on this socket — the CLI resends its keepalive every 2 s, so warn once.
  const warnedBackgroundAgents = new Set<string>();

  // #4657: FAIL-OPEN like its siblings. A throw here is uncaught at the process
  // level and exits the server (#3631), and the CLI resends every 2 s, so a bad
  // payload would crash-loop the hub. The `backgroundAgents` field is validated
  // at this boundary; an invalid one is dropped (the badge clears exactly as for
  // an absent field) and the rest of the keepalive is processed normally. No
  // store write may happen in the catch, hence `persist: false` (#3631).
  socket.on("session-alive", (data: SessionAlivePayload) => {
    let sid: string | null = null;
    try {
      if (
        !data ||
        typeof data.sid !== "string" ||
        typeof data.time !== "number"
      ) {
        return;
      }
      sid = data.sid;
      const sessionAccess = resolveSessionAccess(data.sid);
      if (!sessionAccess.ok) {
        emitAccessError("session", data.sid, sessionAccess.reason);
        return;
      }
      let payload = data;
      const agents = sanitizeBackgroundAgents(data.backgroundAgents);
      if (!agents.ok) {
        payload = { ...data, backgroundAgents: undefined };
        if (!warnedBackgroundAgents.has(data.sid)) {
          warnedBackgroundAgents.add(data.sid);
          errorLogger?.warn(
            "dropped malformed backgroundAgents on session-alive",
            {
              category: "session-alive",
              sessionId: data.sid,
              context: { reason: agents.reason },
              persist: false,
            }
          );
        }
      }
      onSessionAlive?.(payload);
    } catch (err) {
      try {
        errorLogger?.error("session-alive handler failed", {
          category: "session-alive",
          sessionId: sid,
          context: { error: errorMessage(err) },
          persist: false,
        });
      } catch {
        // never let a logging failure surface to the socket
      }
    }
  });

  socket.on("session-end", (data: SessionEndPayload) => {
    if (
      !data ||
      typeof data.sid !== "string" ||
      typeof data.time !== "number"
    ) {
      return;
    }
    const sessionAccess = resolveSessionAccess(data.sid);
    if (!sessionAccess.ok) {
      emitAccessError("session", data.sid, sessionAccess.reason);
      return;
    }
    onSessionEnd?.(data);
  });
}
