// SPDX-License-Identifier: AGPL-3.0-only
import type { SyncEvent } from "@hapi/protocol/types";
import {
  SPEND_LIMIT_VARIANTS,
  canonicalizeErrorType,
  type SpendLimitVariant,
} from "@hapi/protocol/apiErrorClasses";
import type { ErrorLogger } from "../logging/errorLogger";
import type { Session, SyncEngine } from "./syncEngine";

/** Recent request ids remembered per session (the dedupe window). */
const MAX_REQUEST_IDS_PER_SESSION = 8;
/** Sessions tracked at once; the oldest is evicted first. */
const MAX_TRACKED_SESSIONS = 256;
/** Without a request id, an identical (variant, resumesAt) repeat inside this
 *  window is treated as the same failure. */
const NO_REQUEST_ID_WINDOW_MS = 60_000;

interface SessionNoticeState {
  requestIds: string[];
  lastKey: string | null;
  lastAt: number;
}

/** The narrow engine surface this observer uses (test seam). */
export type SpendLimitNoticeEngine = Pick<
  SyncEngine,
  "subscribe" | "getSession" | "persistSpendLimitNotice"
>;

/**
 * The display-safe key label for a session's stop notice (#4936): the vault
 * key's LABEL recorded at spawn for an Anthropic `api-key` binding
 * (`authBinding.displayIdentity` — "NEVER a raw secret"), else the masked key
 * recorded at spawn (`apiKeyMasked`), else `null` (not key-bound). Reads
 * session metadata only — never the key vault.
 */
export function spendLimitKeyLabel(session: Session): string | null {
  const m = session.metadata;
  const binding = m?.authBinding;
  if (
    binding?.kind === "api-key" &&
    (binding.providerId ?? "anthropic") === "anthropic" &&
    binding.displayIdentity.trim() !== ""
  ) {
    return binding.displayIdentity;
  }
  if (m?.apiKeyId) {
    return m.apiKeyMasked?.trim() ? m.apiKeyMasked : null;
  }
  return null;
}

/**
 * Spend-limit stop-notice observer (#4936).
 *
 * Subscribes to the `api-error` SyncEvent and, on `phase: "exhausted"` with the
 * terminal `spend_limit_error` class, persists ONE durable in-thread notice
 * ("API spend cap reached for <key label> — resumes <date>") per
 * (session, requestId). The CLI reports the class (`ApiErrorDetector`,
 * all four launchers); the `/cli/error-reports` bridge re-classifies reports
 * from older CLIs. `AutoRecoveryService` separately refuses to recover the class
 * — this observer only writes the notice, so the highest-risk service's write
 * surface stays unchanged and the notice is independent of every auto-recover
 * preference by construction.
 *
 * Mirrors {@link OrphanGrantObserver}: one per-process subscriber; session state
 * is resolved via `engine.getSession`, never from `event.data`. An optional
 * `isRemoteOwned` predicate skips a remote-owned session (its owning node writes
 * the notice into its own store); the server wires none, because an
 * `exhausted` `api-error` event is published only by the local
 * `/cli/error-reports` route for a locally resolved session (the recovery
 * service's own `api-error` broadcasts are `recovered` / `give-up`), and bridged
 * federation events never reach local subscribers.
 * Fail-open: a write error is logged, never thrown.
 */
export class SpendLimitNoticeObserver {
  private unsubscribe: (() => void) | null = null;
  private readonly sessions = new Map<string, SessionNoticeState>();

  constructor(
    private readonly engine: SpendLimitNoticeEngine,
    private readonly errorLogger: ErrorLogger | null = null,
    /** Late-bound remote-owned skip (the `OrphanGrantObserver` pattern). */
    private readonly isRemoteOwned:
      | ((sessionId: string) => boolean)
      | null = null,
    /** Test seam — deterministic clock for the no-request-id window. */
    private readonly now: () => number = Date.now
  ) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.engine.subscribe(event => this.handle(event));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.sessions.clear();
  }

  private handle(event: SyncEvent): void {
    if (event.type === "session-removed") {
      if (event.sessionId) this.sessions.delete(event.sessionId);
      return;
    }
    if (event.type !== "api-error") return;
    const sessionId = event.sessionId;
    if (!sessionId) return;

    // Runtime narrowing (the AutoRecoveryService / OrphanGrantObserver rule).
    const data = event.data as
      | {
          phase?: unknown;
          errorType?: unknown;
          limitVariant?: unknown;
          resumesAt?: unknown;
          requestId?: unknown;
        }
      | null
      | undefined;
    if (!data || typeof data !== "object" || data.phase !== "exhausted") return;
    if (typeof data.errorType !== "string") return;
    if (canonicalizeErrorType(data.errorType) !== "spend_limit_error") return;

    if (this.isRemoteOwned?.(sessionId)) return;
    const session = this.engine.getSession(sessionId);
    if (!session) return;

    const variant: SpendLimitVariant =
      typeof data.limitVariant === "string" &&
      (SPEND_LIMIT_VARIANTS as readonly string[]).includes(data.limitVariant)
        ? (data.limitVariant as SpendLimitVariant)
        : "tier-cap";
    const resumesAt =
      typeof data.resumesAt === "number" &&
      Number.isFinite(data.resumesAt) &&
      data.resumesAt > 0
        ? data.resumesAt
        : null;
    const requestId =
      typeof data.requestId === "string" && data.requestId !== ""
        ? data.requestId
        : undefined;

    if (this.isDuplicate(sessionId, variant, resumesAt, requestId)) return;

    try {
      this.engine.persistSpendLimitNotice(sessionId, {
        variant,
        keyLabel: spendLimitKeyLabel(session),
        resumesAt,
        ...(requestId !== undefined ? { requestId } : {}),
      });
    } catch (err) {
      this.errorLogger?.warn(
        `[SpendLimitNoticeObserver] notice write failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { category: "spend-limit-notice", sessionId }
      );
    }
  }

  /** Records this failure and reports whether it was already noticed. */
  private isDuplicate(
    sessionId: string,
    variant: SpendLimitVariant,
    resumesAt: number | null,
    requestId: string | undefined
  ): boolean {
    let state = this.sessions.get(sessionId);
    if (!state) {
      if (this.sessions.size >= MAX_TRACKED_SESSIONS) {
        const oldest = this.sessions.keys().next().value;
        if (oldest !== undefined) this.sessions.delete(oldest);
      }
      state = { requestIds: [], lastKey: null, lastAt: 0 };
      this.sessions.set(sessionId, state);
    }
    const now = this.now();

    if (requestId !== undefined) {
      if (state.requestIds.includes(requestId)) return true;
      state.requestIds.push(requestId);
      if (state.requestIds.length > MAX_REQUEST_IDS_PER_SESSION) {
        state.requestIds.shift();
      }
      return false;
    }

    const key = `${variant}:${resumesAt ?? "none"}`;
    if (state.lastKey === key && now - state.lastAt < NO_REQUEST_ID_WINDOW_MS) {
      return true;
    }
    state.lastKey = key;
    state.lastAt = now;
    return false;
  }
}
