// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Orphaned-approval-grant detection (issue #3563, epic #3329 Sub-Issue L — the
 * PROACTIVE half of the 2026-09-04 incident fix). #3559 makes the user's re-send
 * work; THIS tells the user BEFORE they re-send.
 *
 * The USER-APPROVAL token gate mints a single-use grant inside the delivery path
 * (`approvalTokenHook.ts` `case "granted"`), but there is NO turn id at mint time
 * — the mint happens in `sendMessage` BEFORE the message is persisted, and the
 * turn only opens when Claude's UserPromptSubmit hook fires after delivery. So the
 * mint is recorded here keyed on `sessionId` (Task 1, {@link OrphanGrantStore}),
 * and correlated to a terminal signal later.
 *
 * A grant is ORPHANED when its minting turn ends in error/abort with the grant
 * still on disk unconsumed: the user approved, the agent never acted, and (unlike
 * a `replayed` re-send) there is no denial to explain it. {@link checkOrphanGrant}
 * re-checks the grant file BY NONCE (presence alone can match a newer grant for
 * the same issue) and, on a live match, posts a #3579 durable NOTICE
 * (`grant-orphaned`) — then DROPS the record. The drop is the dedup invariant: a
 * notice does not consume the grant file, so overlapping triggers would otherwise
 * double-post.
 *
 * Five terminal signals feed the ONE check (see the directive Key Decisions): the
 * `rateLimited` rising edge, the `api-error phase:"exhausted"` SyncEvent,
 * `orphanTrackedTurnsForSession` (account-switch / kill backstop), session
 * close/archive, and the {@link createOrphanGrantStep} FinalizeStep on a RAW CLI
 * `outcome !== "completed"`. `finalizeTurn` alone is NOT enough — a session-limit
 * 429 emits no `turn:finalize` under any launcher, which is the incident's own
 * trigger.
 *
 * FAIL-OPEN by construction: a server restart between mint and signal loses the
 * record → no notice (documented). No verify/mint/consume/re-run of any grant
 * (R5) — this module only READS grant files and posts a non-user-role notice.
 */
import { readFileSync } from "node:fs";
import type { DenialCopyParams } from "@hapi/protocol";
import type { ApprovalKey } from "../services/approvalTokens";
import type { FinalizeStep, FinalizeStepContext } from "./turnLifecycle";

/**
 * A recorded mint (R1). Keyed on `sessionId` in {@link OrphanGrantStore}. Carries
 * the `nonce` (the re-check is `readGrant(...)?.nonce === record.nonce` — presence
 * alone can match a NEWER grant for the same issue), the already-resolved
 * `repoPath` (spares every downstream trigger a metadata lookup `TurnLifecycle`
 * cannot do), and the resolved `grantPath` so a #3538 scope-keyed GLOBAL grant is
 * orphan-checkable identically to an issue-scoped one.
 */
export interface MintRecord {
  key: ApprovalKey;
  /** `grant.nonce` — the single-use nonce this mint authorized. */
  nonce: string;
  /** `grant.minted_at` (ISO instant) — rendered into the notice copy as `{at}`. */
  mintedAt: string;
  /** The gated session's validated absolute working dir. */
  repoPath: string;
  /** The resolved grant file (issue → `grantFile`, scope → `globalGrantFile`). */
  grantPath: string;
}

/**
 * Fail-soft read of a grant file's `nonce` (or null on any missing/unreadable/
 * malformed file). Mirrors `approvalTokens.readJson`'s tolerance: a null return
 * means "the grant is no longer present/valid" (consumed by the closer, replaced
 * by a newer grant, or gone) → the caller treats it as NOT an orphan and drops the
 * record. Reads only; never throws.
 */
export function readGrantNonceFromDisk(grantPath: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(grantPath, "utf8")) as {
      nonce?: unknown;
    };
    return typeof parsed.nonce === "string" ? parsed.nonce : null;
  } catch {
    return null;
  }
}

/**
 * In-memory mint store (R1). `Map<sessionId, MintRecord[]>` — an ARRAY because two
 * issues can be approved in one session; a single-entry map would overwrite. Bounded
 * per session (drops the oldest) so a pathological session cannot grow it unbounded;
 * the terminal signals drain it under normal operation. Not persisted — a server
 * restart loses it (fail-open, documented).
 */
export class OrphanGrantStore {
  private readonly bySession = new Map<string, MintRecord[]>();

  constructor(private readonly maxPerSession = 32) {}

  /** Record a fresh mint. De-dups a repeated identical nonce (idempotent re-record). */
  record(sessionId: string, rec: MintRecord): void {
    const list = this.bySession.get(sessionId);
    if (!list) {
      this.bySession.set(sessionId, [rec]);
      return;
    }
    if (list.some(r => r.nonce === rec.nonce)) return; // idempotent
    list.push(rec);
    while (list.length > this.maxPerSession) list.shift(); // bound (drop oldest)
  }

  /** A defensive copy of the session's records (callers must not mutate the store). */
  read(sessionId: string): MintRecord[] {
    const list = this.bySession.get(sessionId);
    return list ? [...list] : [];
  }

  /** Cheap existence probe (the FinalizeStep's common-case early-out). */
  has(sessionId: string): boolean {
    const list = this.bySession.get(sessionId);
    return !!list && list.length > 0;
  }

  /** Drop the record for `nonce` (called after every examine — the dedup invariant). */
  dropByNonce(sessionId: string, nonce: string): void {
    const list = this.bySession.get(sessionId);
    if (!list) return;
    const next = list.filter(r => r.nonce !== nonce);
    if (next.length === 0) this.bySession.delete(sessionId);
    else this.bySession.set(sessionId, next);
  }

  /** Drop every record for a session (session removal hygiene). */
  dropSession(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  /**
   * R3 bind-first clean-end drop: drop records whose mint the finalized turn
   * OPENED AT OR AFTER (`Date.parse(mintedAt) <= startedAtMs`). A record whose
   * mint is AFTER the turn start (a token queued into a PRE-EXISTING turn) is KEPT
   * — the token-bearing turn has not opened yet, and dropping it here would silently
   * discard the record on the exact incident shape this feature exists for.
   */
  dropOpenedAtOrAfter(sessionId: string, startedAtMs: number): void {
    const list = this.bySession.get(sessionId);
    if (!list) return;
    const kept = list.filter(r => {
      const mintedMs = Date.parse(r.mintedAt);
      // An unparseable mintedAt (should never happen — ISO second precision) is
      // conservatively KEPT so a bad timestamp cannot silently drop a live record.
      if (Number.isNaN(mintedMs)) return true;
      return mintedMs > startedAtMs; // keep only mints AFTER the turn opened
    });
    if (kept.length === 0) this.bySession.delete(sessionId);
    else this.bySession.set(sessionId, kept);
  }
}

/** Deps for the shared session-keyed orphan check ({@link checkOrphanGrant}). */
export interface OrphanNoticeDeps {
  readMintRecords: (sessionId: string) => MintRecord[];
  dropRecord: (sessionId: string, nonce: string) => void;
  /** Post the `grant-orphaned` notice through #3579's `persistGateNotice` surface. */
  persistNotice: (sessionId: string, params: DenialCopyParams) => void;
  /** Grant-file nonce reader (test seam; default {@link readGrantNonceFromDisk}). */
  readGrantNonce?: (grantPath: string) => string | null;
  log?: (message: string, context?: Record<string, unknown>) => void;
}

/**
 * THE single session-keyed orphan check (R2/R3), called from every terminal
 * signal. SYNCHRONOUS by construction — the grant re-check (`readFileSync`) and
 * the notice persist (`store.messages.addMessage` + fan-out) are both synchronous,
 * which is what lets it run inside the FinalizeStep's sync contract.
 *
 * For each recorded mint: re-check the grant file BY NONCE; on a live match, post
 * the durable `grant-orphaned` notice. Then DROP the record whether or not it
 * posted — that drop is the dedup invariant (a notice does NOT consume the grant
 * file, so a bare file re-check alone would double-post across overlapping
 * triggers). A throwing `persistNotice` is caught (fail-open) and the record is
 * still dropped, so a transient persist failure degrades to a missed notice, never
 * a stuck record that re-fires forever.
 */
export function checkOrphanGrant(
  sessionId: string,
  deps: OrphanNoticeDeps
): void {
  const readNonce = deps.readGrantNonce ?? readGrantNonceFromDisk;
  for (const rec of deps.readMintRecords(sessionId)) {
    const currentNonce = readNonce(rec.grantPath);
    if (currentNonce !== null && currentNonce === rec.nonce) {
      const params: DenialCopyParams = {};
      if (rec.key.kind === "issue") params.issueNumber = rec.key.issueNumber;
      if (rec.mintedAt) params.at = rec.mintedAt;
      try {
        deps.persistNotice(sessionId, params);
      } catch (err) {
        deps.log?.(
          `orphan-grant: persistNotice threw for session ${sessionId} (ignored)`,
          { error: err instanceof Error ? err.message : String(err) }
        );
      }
    }
    // Drop AFTER examining (posted or not) — one notice per mint across all triggers.
    deps.dropRecord(sessionId, rec.nonce);
  }
}

/** Deps for the finalize-leg step ({@link createOrphanGrantStep}). */
export interface OrphanGrantStepDeps {
  /** Cheap common-case early-out: is there any live mint record for this session? */
  hasRecords: (sessionId: string) => boolean;
  /** Abort leg → post-if-orphan + drop (the engine's {@link checkOrphanGrant} wrapper). */
  checkOrphanGrant: (sessionId: string) => void;
  /** R3 clean-end → drop records the finalized turn opened at/after. */
  dropOnCleanTurnEnd: (
    sessionId: string,
    finalizedTurnStartedAtMs: number | null
  ) => void;
  /** Resolve the finalized turn's `started_at_ms` (from the still-open DB row). */
  getOpenTurnStartedAtMs: (sessionId: string, seq: number) => number | null;
  log?: (message: string, context?: Record<string, unknown>) => void;
}

/**
 * The `finalizeTurn` leg (Task 2). A SYNCHRONOUS {@link FinalizeStep} that reads
 * the RAW `ctx.event.outcome` (which the server-synthesised `completed→errored`
 * upgrade can never reach — the status upgrade runs AFTER the step chain, at
 * `turnLifecycle.ts` `runFinalizeSteps` → status derivation). So `!== "completed"`
 * is a genuine abort (`interrupted` today; a raw CLI `errored` post-#3352), never
 * the "agent finished with a retried transient error" case (V4).
 *
 * On abort → {@link checkOrphanGrant} (post-if-orphan + drop). On a clean end →
 * R3 bind-first drop of records the finalized turn opened at/after. Both gated on
 * `hasRecords` so the 99.9% case (no mint record) is a single Map lookup. Returns
 * `{}` (no column enrichment) and NEVER throws (the runner's per-step try/catch
 * covers only the sync body — this respects the module's fail-open contract too).
 */
export function createOrphanGrantStep(deps: OrphanGrantStepDeps): FinalizeStep {
  return (ctx: FinalizeStepContext) => {
    try {
      const sid = ctx.hapiSessionId;
      if (!deps.hasRecords(sid)) return {}; // cheap early-out (common case)
      if (ctx.event.outcome !== "completed") {
        // interrupted (or a future raw CLI errored) → abort → post-if-orphan + drop
        deps.checkOrphanGrant(sid);
      } else {
        // clean end → R3 bind-first drop (never posts on a clean end)
        deps.dropOnCleanTurnEnd(sid, deps.getOpenTurnStartedAtMs(sid, ctx.seq));
      }
    } catch (err) {
      deps.log?.("orphan-grant finalize step failed (degraded)", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return {};
  };
}
