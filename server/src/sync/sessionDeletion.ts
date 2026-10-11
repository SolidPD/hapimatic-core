// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Session deletion delegate (issue #2080 — extracted from syncEngine.ts).
 *
 * Owns the two deletion flows — `deleteSession` (single) and `deleteSessions`
 * (bulk). Each performs tmux-window cleanup (#1628 direct-reap ride-along),
 * worktree cleanup (with the #1364 sibling-ownership guard), DB/cache removal,
 * file-claim release (#1968/#2088), and MCP batch-coordinator state teardown
 * (#1102). Refs #1349/#1364/#1628/#1968/#2088/#1102.
 *
 * 🔴 These are PARALLEL SIBLINGS, NOT an orchestration: `deleteSessions` runs its
 * own batch cleanup whose #1364 sibling check treats WITHIN-batch siblings as
 * non-blockers (a shared worktree of two co-deleted sessions IS cleaned up),
 * which differs from single-`deleteSession` semantics (any sibling blocks). Both
 * bodies are moved verbatim; `deleteSessions` is NEVER a loop over `deleteSession`.
 *
 * Behaviour-preserving move: bodies are byte-identical to the pre-extraction
 * `SyncEngine` methods; only the enclosing `this` changed. All collaborators are
 * the SAME object references the facade holds (so test spies on
 * `engine.rpcGateway.cleanupTmuxSession` / `engine.mcpBatchCoordinator.clear`
 * still apply).
 */

import type { SessionCache } from "./sessionCache";
import type { RpcGateway } from "./rpcGateway";
import type { McpBatchCoordinator } from "./mcpBatchCoordinator";
import type { Store } from "../store";
import type { ErrorLogger } from "../logging/errorLogger";
import type { LoopCronLifecycleCoupler } from "./loopCronLifecycle";

export interface SessionDeletionDeps {
  sessionCache: SessionCache;
  rpcGateway: RpcGateway;
  store: Store;
  mcpBatchCoordinator: McpBatchCoordinator;
  errorLogger?: ErrorLogger | null;
  /**
   * Issue #2453 (Task 7): lazy read — the loop-cron lifecycle coupler. Purges
   * a deleted session's bound loops (D1: a `purge` removes the crontab line AND
   * the state dir, so the server never `rm -rf`s a state dir itself).
   */
  getLoopCronCoupler?: () => LoopCronLifecycleCoupler | null;
  /**
   * Issue #1969 (R1): fired after a delete releases a session's claims, wired to
   * `SyncEngine.emitFileClaimDelta()` so peers converge. The dominant path is a
   * no-op — a deletable session is inactive, so its claims are already absent
   * from published snapshots; the residual `expireInactive` liveness-flip case
   * heals via the ≤15 s anti-entropy poll by design. Optional / best-effort.
   */
  onClaimsChanged?: () => void;
  /**
   * Issue #1905 (1905-4): fired once per actually-deleted session (single +
   * bulk), wired to prune `SyncEngine`'s in-memory per-session dedupe Sets
   * (`ceilingBreached`, `downgradeNotified`) so they do not leak one entry per
   * deleted session. Optional / best-effort — a throwing callback must never
   * break a deletion.
   */
  onSessionDeleted?: (sessionId: string) => void;
}

export class SessionDeletion {
  private readonly sessionCache: SessionCache;
  private readonly rpcGateway: RpcGateway;
  private readonly store: Store;
  private readonly mcpBatchCoordinator: McpBatchCoordinator;
  private readonly errorLogger?: ErrorLogger | null;
  private readonly getLoopCronCoupler: () => LoopCronLifecycleCoupler | null;
  private readonly onClaimsChanged: () => void;
  private readonly onSessionDeleted: (sessionId: string) => void;

  constructor(deps: SessionDeletionDeps) {
    this.sessionCache = deps.sessionCache;
    this.rpcGateway = deps.rpcGateway;
    this.store = deps.store;
    this.mcpBatchCoordinator = deps.mcpBatchCoordinator;
    this.errorLogger = deps.errorLogger ?? null;
    this.getLoopCronCoupler = deps.getLoopCronCoupler ?? (() => null);
    this.onClaimsChanged = deps.onClaimsChanged ?? (() => {});
    this.onSessionDeleted = deps.onSessionDeleted ?? (() => {});
  }

  /**
   * #1905: best-effort per-session prune hook after a delete. A throwing callback
   * must never break a deletion (mirrors {@link emitClaimsChanged}).
   */
  private notifySessionDeleted(sessionId: string): void {
    try {
      this.onSessionDeleted(sessionId);
    } catch (err) {
      this.errorLogger?.warn(
        `Failed to run onSessionDeleted hook for ${sessionId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { category: "sync", sessionId }
      );
    }
  }

  /**
   * #1969 (R1): best-effort claim-delta emit after a delete releases claims.
   * #2088 discipline — an emit failure must never break a deletion.
   */
  private emitClaimsChanged(context: string): void {
    try {
      this.onClaimsChanged();
    } catch (err) {
      this.errorLogger?.warn(
        `Failed to emit file-claim delta on ${context}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { category: "sync" }
      );
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    // Get session metadata to find machineId for tmux cleanup
    const session = this.sessionCache.getSession(sessionId);
    const machineId = session?.metadata?.machineId;

    // Get the session's tag - this is the daemon's hapiSessionId used in the tmux session store
    // The server's sessionId is a UUID, but the daemon stores sessions by the tag
    // (which is the HAPI_SESSION_ID env var passed when spawning)
    const sessionTag = this.sessionCache.getSessionTag(sessionId);

    // Clean up tmux window if we know the machine and have a valid tag
    if (machineId && sessionTag) {
      // #1628: sessionId (the server UUID) rides along so the daemon can
      // direct-kill the exact-named remote window where enumeration is blind.
      const result = await this.rpcGateway.cleanupTmuxSession(
        machineId,
        sessionTag,
        sessionId
      );
      if (result.success) {
        this.errorLogger?.info(
          `Tmux cleanup for session ${sessionId} (tag: ${sessionTag}): ${result.message ?? "no message"}`,
          { category: "sync", sessionId }
        );
      } else {
        // #1349: log at `error` severity so orphan accumulation is detectable
        // in production logs. DB-row removal still proceeds — reconciliation
        // backstops the orphan within one heartbeat cycle (~60s).
        this.errorLogger?.error(
          `Tmux cleanup failed for session ${sessionId} (tag: ${sessionTag}): ${result.errorKind ?? "unknown"} — orphan tmux window may exist; reconciliation will reclaim within ~60s`,
          {
            category: "sync-delete",
            sessionId,
            context: {
              sessionTag,
              errorKind: result.errorKind,
              originalError: result.originalError,
            },
          }
        );
      }
    }

    // Clean up worktree directory + branch if this was a worktree session
    const worktree = session?.metadata?.worktree;
    if (machineId && worktree?.basePath && worktree?.branch) {
      // #1364: Refuse to destroy the worktree CWD when another live session
      // still owns it (via metadata.path or metadata.worktree.worktreePath).
      // Tmux cleanup + DB cleanup still proceed below — only the on-disk
      // worktree-cleanup RPC is skipped.
      const siblings = worktree.worktreePath
        ? this.sessionCache.findOtherSessionsByCwd(
            worktree.worktreePath,
            sessionId
          )
        : [];
      if (siblings.length > 0) {
        this.errorLogger?.warn(
          `Skipping worktree cleanup for ${sessionId}: ${siblings.length} other session(s) still own ${worktree.worktreePath}`,
          {
            category: "sync",
            sessionId,
            context: { siblings: siblings.map(s => s.id) },
          }
        );
      } else {
        const result = await this.rpcGateway.cleanupWorktree(machineId, {
          basePath: worktree.basePath,
          worktreePath: worktree.worktreePath,
          branch: worktree.branch,
          sessionId,
        });
        this.errorLogger?.info(
          `Worktree cleanup for session ${sessionId} (branch: ${worktree.branch}): ${result.message ?? "no message"}`,
          { category: "sync", sessionId }
        );
      }
    }

    await this.sessionCache.deleteSession(sessionId);

    // #2453 (Task 7): purge this session's bound loops (D1). Fire-and-forget
    // best-effort — the coupler reads loop configs by session_uuid (independent
    // of the just-deleted cache entry) and absorbs its own failures. Delete
    // bypasses handleSessionEnd, so this is delete's own purge hook.
    void this.getLoopCronCoupler()?.onDelete(sessionId);

    // #1968 (R3): release file claims for the deleted session (delete bypasses
    // handleSessionEnd). Idempotent with the handleSessionEnd release.
    // #2088: best-effort — never let advisory-claim cleanup break session delete.
    let releasedClaims = 0;
    try {
      releasedClaims = this.store.fileClaims.releaseClaimsBySession(sessionId);
    } catch (err) {
      this.errorLogger?.warn(
        `Failed to release file claims on session delete for ${sessionId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { category: "sync", sessionId }
      );
    }
    // #1969 (R1): ONLY when the delete actually released claims does the live
    // snapshot change → publish it for peer convergence (best-effort). The
    // dominant path is a no-op (a deletable session is inactive, so its claims
    // are already released → 0 released → no emit).
    if (releasedClaims > 0) {
      this.emitClaimsChanged(`session delete for ${sessionId}`);
    }

    // Drop coordinator's per-session batch state — the session no longer
    // exists, so any in-flight reconciliation is moot. Without this, the
    // coordinator's `states` Map leaks one entry per deleted session and
    // can surface stale "in-flight batch" snapshots for ghost sessions.
    // See #1102.
    this.mcpBatchCoordinator.clear(sessionId);

    // #1905 (1905-4): prune SyncEngine's per-session dedupe Sets. Last, so it
    // runs only after the session is actually gone.
    this.notifySessionDeleted(sessionId);
  }

  async deleteSessions(
    sessionIds: string[],
    namespace: string
  ): Promise<{ deleted: string[]; skipped: string[] }> {
    // Gather tmux cleanup info before deleting from cache
    const tmuxCleanups: {
      machineId: string;
      sessionTag: string;
      serverSessionId: string; // #1628: window-name UUID for the direct reap path
    }[] = [];
    const worktreeCleanups: {
      machineId: string;
      worktreeInfo: {
        basePath: string;
        worktreePath?: string;
        branch: string;
        sessionId?: string;
      };
    }[] = [];
    for (const id of sessionIds) {
      const session = this.sessionCache.getSession(id);
      const machineId = session?.metadata?.machineId;
      const sessionTag = this.sessionCache.getSessionTag(id);
      if (machineId && sessionTag) {
        tmuxCleanups.push({ machineId, sessionTag, serverSessionId: id });
      }
      const worktree = session?.metadata?.worktree;
      if (machineId && worktree?.basePath && worktree?.branch) {
        // #1364: Skip per-entry if any sibling OUTSIDE this batch still owns
        // the worktree. Siblings within sessionIds are NOT blockers — bulk-
        // delete of two CWD-sharing sessions should still clean up the
        // shared worktree (no orphan left behind).
        if (worktree.worktreePath) {
          const externalSiblings = this.sessionCache
            .findOtherSessionsByCwd(worktree.worktreePath, id)
            .filter(s => !sessionIds.includes(s.id));
          if (externalSiblings.length > 0) {
            this.errorLogger?.warn(
              `Bulk-delete: skipping worktree cleanup for ${id} — ${externalSiblings.length} external sibling(s) still own ${worktree.worktreePath}`,
              {
                category: "sync",
                sessionId: id,
                context: { siblings: externalSiblings.map(s => s.id) },
              }
            );
            continue;
          }
        }
        worktreeCleanups.push({
          machineId,
          worktreeInfo: {
            basePath: worktree.basePath,
            worktreePath: worktree.worktreePath,
            branch: worktree.branch,
            sessionId: id,
          },
        });
      }
    }

    // Bulk delete from DB + cache
    const result = this.sessionCache.deleteSessions(sessionIds, namespace);

    // Drop coordinator state for actually-deleted sessions only — `skipped`
    // entries (e.g. namespace mismatch) are still live and must keep their
    // batch state. See #1102.
    let totalReleasedClaims = 0; // #1969: gate the once-after-loop emit on this.
    for (const id of result.deleted) {
      this.mcpBatchCoordinator.clear(id);
      // #1905 (1905-4): prune SyncEngine's per-session dedupe Sets for each
      // actually-deleted session (skipped ids are still live — do NOT prune).
      this.notifySessionDeleted(id);
      // #2453 (Task 7): purge each deleted session's bound loops (D1). Only
      // actually-deleted ids (skipped sessions are still live). Best-effort.
      void this.getLoopCronCoupler()?.onDelete(id);
      // #1968 (R3): release file claims for each actually-deleted session
      // (skipped sessions are still live — do NOT release theirs).
      // #2088: per-session try/catch so one DB error doesn't abort releasing
      // the rest of the batch (and never breaks bulk delete).
      try {
        totalReleasedClaims += this.store.fileClaims.releaseClaimsBySession(id);
      } catch (err) {
        this.errorLogger?.warn(
          `Failed to release file claims on bulk delete for ${id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { category: "sync", sessionId: id }
        );
      }
    }
    // #1969 (R1): emit ONCE after the bulk loop (not per-id) — but ONLY if the
    // batch actually released claims, so a bulk delete of claimless sessions
    // changes nothing and emits nothing. Best-effort.
    if (totalReleasedClaims > 0) {
      this.emitClaimsChanged(
        `bulk delete of ${result.deleted.length} session(s)`
      );
    }

    // Fire tmux cleanup in parallel and surface failures (#1349).
    // Previously this was `void Promise.allSettled(...)` which discarded
    // failure information — orphan tmux windows accumulated invisibly.
    // Bulk delete still completes regardless of per-cleanup outcome
    // (best-effort intent preserved); reconciliation backstops orphans
    // within ~60s via the daemon's heartbeat cycle.
    if (tmuxCleanups.length > 0) {
      const tmuxResults = await Promise.allSettled(
        tmuxCleanups.map(({ machineId, sessionTag, serverSessionId }) =>
          this.rpcGateway.cleanupTmuxSession(
            machineId,
            sessionTag,
            serverSessionId
          )
        )
      );
      tmuxResults.forEach((r, i) => {
        const { machineId, sessionTag } = tmuxCleanups[i];
        if (r.status === "rejected") {
          this.errorLogger?.error(
            `Bulk tmux cleanup rejected for tag ${sessionTag}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
            {
              category: "sync-delete",
              context: { machineId, sessionTag, rejection: String(r.reason) },
            }
          );
        } else if (!r.value.success) {
          this.errorLogger?.error(
            `Bulk tmux cleanup failed for tag ${sessionTag}: ${r.value.errorKind ?? "unknown"} — orphan tmux window may exist; reconciliation will reclaim within ~60s`,
            {
              category: "sync-delete",
              context: {
                machineId,
                sessionTag,
                errorKind: r.value.errorKind,
                originalError: r.value.originalError,
              },
            }
          );
        }
      });
    }

    // Fire worktree cleanup in parallel and surface failures (#1349 — same
    // observability treatment as tmuxCleanups above).
    if (worktreeCleanups.length > 0) {
      const worktreeResults = await Promise.allSettled(
        worktreeCleanups.map(({ machineId, worktreeInfo }) =>
          this.rpcGateway.cleanupWorktree(machineId, worktreeInfo)
        )
      );
      worktreeResults.forEach((r, i) => {
        const { machineId, worktreeInfo } = worktreeCleanups[i];
        if (r.status === "rejected") {
          this.errorLogger?.error(
            `Bulk worktree cleanup rejected for branch ${worktreeInfo.branch}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
            {
              category: "sync-delete",
              context: {
                machineId,
                worktreeBranch: worktreeInfo.branch,
                sessionId: worktreeInfo.sessionId,
                rejection: String(r.reason),
              },
            }
          );
        } else if (!r.value.success) {
          this.errorLogger?.error(
            `Bulk worktree cleanup failed for branch ${worktreeInfo.branch}: ${r.value.message ?? "no message"} — worktree may persist on disk`,
            {
              category: "sync-delete",
              context: {
                machineId,
                worktreeBranch: worktreeInfo.branch,
                sessionId: worktreeInfo.sessionId,
              },
            }
          );
        }
      });
    }

    return result;
  }
}
