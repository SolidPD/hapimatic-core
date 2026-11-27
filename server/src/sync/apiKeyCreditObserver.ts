// SPDX-License-Identifier: AGPL-3.0-only
import { parseApiKeyRef } from "@hapi/protocol";
import type { SyncEvent } from "@hapi/protocol/types";
import { canonicalizeErrorType } from "@hapi/protocol/apiErrorClasses";
import type { ErrorLogger } from "../logging/errorLogger";
import {
  API_KEY_CREDIT_RESTAMP_WINDOW_MS,
  stampOutOfCredit,
} from "../services/apiKeyCreditStamp";
import type { SharedApiKeyService } from "../services/sharedApiKeyService";
import type { SyncEngine } from "./syncEngine";

/** The narrow engine surface this observer uses (test seam). */
export type ApiKeyCreditEngine = Pick<SyncEngine, "subscribe" | "getSession">;

/** The requesting-side surface the observer reports a foreign key through. */
export type ApiKeyCreditReporter = Pick<
  SharedApiKeyService,
  "selfNodeId" | "reportOutOfCredit"
>;

/** Outcomes that leave no window: the home was not reached, or could not
 *  answer, so the next exhausted event tries again. Every other refusal is
 *  final for now (an older home, an unknown one, a public URL, a key the home
 *  refused) and starts the window, so it costs one warn a minute at most. */
const RETRY_AT_ONCE_CODES: ReadonlySet<string> = new Set([
  "api_key_home_offline",
  "api_key_home_error",
  "internal",
]);

/** A home's refusal code reaches the log only in this shape (R-7): a code a
 *  peer chose is otherwise logged as `unexpected`. */
const LOGGABLE_CODE = /^[a-z_]{1,64}$/;

/**
 * API key budgets: records the provider's own "credit balance is too low"
 * answer on the vault key a session ran on, so the key's card says "Out of
 * credit" for certain rather than as an estimate.
 *
 * Subscribes to the `api-error` SyncEvent (published by the `/cli/error-reports`
 * bridge, which files the exhausted-credit text under `billing_error`) and, on
 * `phase: "exhausted"` with that class, stamps `outOfCreditAt` on the session's
 * key:
 *
 * - a key in THIS node's vault (a bare id, or a qualified ref homed here) is
 *   stamped here, through the one stamp write path (`apiKeyCreditStamp.ts`);
 * - a key used from this node but stored on another (`<id>@<home>`, issue
 *   #6978) is reported to its home, which stamps it with its own clock. A home
 *   that is older, offline, unknown or reached off-tailnet, or that refuses,
 *   leaves the key unstamped there; one `warn` names the ref and the outcome
 *   code, never a key, a mask or a response text.
 *
 * A ref is stamped or reported at most once per 60 s, the window starting on
 * an answer (see {@link RETRY_AT_ONCE_CODES}), with at most one call in flight
 * per ref. The stamp is superseded at read time by later spend, a budget edit
 * or a top-up (`computeApiKeyBudget`), so this never has to clear it.
 *
 * Mirrors `SpendLimitNoticeObserver`: one per-process subscriber; session state
 * is resolved via `engine.getSession`, never from `event.data`. Fail-open: an
 * error is logged, never thrown, and never blocks the session.
 */
export class ApiKeyCreditObserver {
  private unsubscribe: (() => void) | null = null;
  /** When each ref's window started (an answer), keyed by vault id for a local
   *  key and by the full ref for a foreign one. */
  private readonly answeredAt = new Map<string, number>();
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly engine: ApiKeyCreditEngine,
    private readonly settingsFile: string,
    private readonly errorLogger: ErrorLogger | null = null,
    /** Test seam — the stamp's clock. */
    private readonly now: () => number = Date.now,
    /** #6978: read late, because the observer is built before federation
     *  loads. Null ⇒ a foreign key is skipped with one warn. */
    private readonly getCreditReporter: () => ApiKeyCreditReporter | null = () =>
      null
  ) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.engine.subscribe(event => this.handle(event));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.answeredAt.clear();
    this.inFlight.clear();
  }

  /** The in-flight stamp or report, for tests. Never rejects. */
  pending: Promise<void> = Promise.resolve();

  private handle(event: SyncEvent): void {
    if (event.type !== "api-error" || !event.sessionId) return;
    const data = event.data as
      | { phase?: unknown; errorType?: unknown }
      | null
      | undefined;
    if (!data || typeof data !== "object" || data.phase !== "exhausted") return;
    if (typeof data.errorType !== "string") return;
    if (canonicalizeErrorType(data.errorType) !== "billing_error") return;

    const metadata = this.engine.getSession(event.sessionId)?.metadata;
    const apiKeyId = metadata?.apiKeyId;
    if (metadata?.authBinding?.kind !== "api-key") return;
    if (typeof apiKeyId !== "string" || !apiKeyId) return;
    const parsed = parseApiKeyRef(apiKeyId);
    if (!parsed) return;

    let reporter: ApiKeyCreditReporter | null = null;
    let selfId: string | null = null;
    try {
      reporter = this.getCreditReporter();
      selfId = reporter?.selfNodeId() ?? null;
    } catch {
      reporter = null;
    }
    const at = this.now();
    // Every writer of `apiKeyId` stores the bare id for a local key, so a
    // qualified ref homed here is hardening (R-5).
    if (parsed.homeNodeId === null || parsed.homeNodeId === selfId) {
      const key = parsed.id;
      if (!this.mayAct(key, at)) return;
      this.inFlight.add(key);
      this.pending = this.stampLocal(key, at, event.sessionId);
      return;
    }

    const ref = apiKeyId;
    if (!this.mayAct(ref, at)) return;
    const masked = metadata.apiKeyMasked;
    if (!reporter || typeof masked !== "string" || !masked) {
      // Nothing can be sent; the window keeps this to one warn a minute.
      this.answeredAt.set(ref, at);
      this.warnNotRecorded(
        ref,
        reporter ? "no_masked_key" : "no_reporter",
        event.sessionId
      );
      return;
    }
    this.inFlight.add(ref);
    this.pending = this.reportForeign(
      reporter,
      ref,
      masked,
      event.sessionId,
      at
    );
  }

  /** True when no call for `key` is in flight and its window is closed. */
  private mayAct(key: string, at: number): boolean {
    if (this.inFlight.has(key)) return false;
    const last = this.answeredAt.get(key);
    return last === undefined || at - last >= API_KEY_CREDIT_RESTAMP_WINDOW_MS;
  }

  private async stampLocal(
    keyId: string,
    at: number,
    sessionId: string
  ): Promise<void> {
    try {
      await stampOutOfCredit(this.settingsFile, keyId, at);
      this.answeredAt.set(keyId, at);
    } catch (err) {
      this.warn(
        `[ApiKeyCreditObserver] out-of-credit stamp failed for key ${keyId}: ${errorName(err)}`,
        sessionId
      );
    } finally {
      this.inFlight.delete(keyId);
    }
  }

  private async reportForeign(
    reporter: ApiKeyCreditReporter,
    ref: string,
    masked: string,
    sessionId: string,
    at: number
  ): Promise<void> {
    // try/catch/finally, never a bare promise: the server installs no
    // `unhandledRejection` handler and Bun exits on one (#4051).
    try {
      const out = await reporter.reportOutOfCredit(ref, masked, sessionId);
      if (out.ok) {
        this.answeredAt.set(ref, at);
        return;
      }
      if (!RETRY_AT_ONCE_CODES.has(out.code)) this.answeredAt.set(ref, at);
      const code = LOGGABLE_CODE.test(out.code) ? out.code : "unexpected";
      this.warnNotRecorded(ref, code, sessionId);
    } catch (err) {
      this.warnNotRecorded(ref, errorName(err), sessionId);
    } finally {
      this.inFlight.delete(ref);
    }
  }

  /** The one warn for a foreign report that left no stamp on the key's home.
   *  `why` is an outcome code in the R-7 shape or an error class, never a
   *  message text, a key or a mask. */
  private warnNotRecorded(ref: string, why: string, sessionId: string): void {
    this.warn(
      `[ApiKeyCreditObserver] out-of-credit report for ${ref} not recorded: ${why}`,
      sessionId
    );
  }

  private warn(message: string, sessionId: string): void {
    try {
      this.errorLogger?.warn(message, {
        category: "api-keys-credit",
        sessionId,
      });
    } catch {
      // A logger that throws must not turn a skipped stamp into a crash.
    }
  }
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "unknown";
}
