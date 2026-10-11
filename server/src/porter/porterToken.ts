// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from "node:crypto";
import type { PorterTokenState } from "@hapi/protocol/porter";

/**
 * Configuration Porter — in-memory tokenized-export store (issue #3446, epic
 * #3445 Sub A). Backs the `POST /api/porter/token` mint and the public
 * `GET /p/:token` (fetch) + `POST /p/:token/archive` (upload) legs.
 *
 * PER-PROCESS, in-memory by design (precedent: the single-use `usedJti` set +
 * unref'd eviction timer in `web/routes/google-oauth.ts:206,319-325`). The
 * server is single-process, so an in-memory `Map` is sufficient for single-use
 * upload enforcement; a restart resets every token (the browser re-mints, the
 * staged plan is TTL-swept). No persistence, no crypto beyond the token bytes.
 *
 * SHARED, NOT MODULE-LEVEL — the store is constructed once in `server.ts` and
 * INJECTED into BOTH one-liner factories (mint lives in the `/api` factory,
 * fetch/upload in the root-mounted public factory — two separate Hono apps). A
 * module-level singleton could not be shared between them and would leak state
 * across tests; the factory returns a fresh, isolated store per construction.
 *
 * Two independent legs (D2(b), K3):
 *  - FETCH leg — re-fetchable up to {@link DEFAULT_MAX_FETCHES} within the TTL
 *    (inspect-then-run and the future Claude-Code-paste path both fetch the
 *    public, secrets-free script more than once). `getForFetch` increments the
 *    counter on each successful serve.
 *  - UPLOAD leg — single-use; only it mutates server state (stages a plan).
 *    `getForUpload` gates on `!uploadConsumed`; `markUploaded` flips it.
 */

/** ~15-minute fetch-leg TTL. */
const DEFAULT_TTL_MS = 15 * 60 * 1000;
/** Max fetch-leg serves within the TTL (inspect-then-run + paste path). */
const DEFAULT_MAX_FETCHES = 5;
/** Background eviction cadence for expired entries. */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * One minted token. `namespace`/`userId` are captured AT MINT so the
 * `porter-token-received` SSE broadcast can carry the minting namespace and pass
 * `SSEManager.shouldSend()`'s namespace gate (a namespace-less broadcast would
 * be silently dropped for every browser). `scope` is a forward-compat marker.
 */
export interface PorterTokenEntry {
  token: string;
  namespace: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  fetchCount: number;
  uploadConsumed: boolean;
  stagingHandle?: string;
  scope: "porter";
}

/**
 * Internal status view returned by {@link PorterTokenStore.status}. Carries the
 * `stagingHandle` (not the plan) — the route handler resolves the handle to a
 * plan summary via the shared `PlanStore` before shaping the K4 wire response.
 */
export interface PorterTokenStatusView {
  state: PorterTokenState;
  expiresAt: number;
  fetchCount: number;
  stagingHandle?: string;
}

export interface PorterTokenStoreOptions {
  /** Fetch-leg TTL in ms (default {@link DEFAULT_TTL_MS}). */
  ttlMs?: number;
  /** Max fetch-leg serves (default {@link DEFAULT_MAX_FETCHES}). */
  maxFetches?: number;
  /** Clock seam for deterministic expiry tests (default `Date.now`). */
  now?: () => number;
  /** Disable the background sweep timer (tests construct many stores). */
  disableSweep?: boolean;
}

export interface PorterTokenStore {
  /** Mint a fresh token bound to the caller's namespace/user. */
  mint(input: { namespace: string; userId: string }): PorterTokenEntry;
  /**
   * Return the entry IFF unexpired and `fetchCount < maxFetches`, incrementing
   * `fetchCount`. `null` → 404 (unknown) or 410 (expired/over-fetched) upstream.
   */
  getForFetch(token: string): PorterTokenEntry | null;
  /** Return the entry IFF unexpired and not yet uploaded. `null` upstream → 410. */
  getForUpload(token: string): PorterTokenEntry | null;
  /** Mark the upload leg consumed and record the staged plan handle. */
  markUploaded(token: string, stagingHandle: string): boolean;
  /** Page-visible status (waiting → received → expired). `null` iff unknown. */
  status(token: string): PorterTokenStatusView | null;
  /**
   * Owner-scoped status for the JWT status endpoint: the page-visible status IFF
   * the token was minted by `namespace`; `null` otherwise (unknown OR a
   * cross-namespace probe — the two are indistinguishable, so no existence leak).
   */
  statusForOwner(
    token: string,
    namespace: string
  ): PorterTokenStatusView | null;
  /** Evict every expired entry (also run on an unref'd interval). */
  sweepExpired(): void;
  /** Stop the sweep timer (shutdown / tests). */
  stop(): void;
}

export function createPorterTokenStore(
  opts: PorterTokenStoreOptions = {}
): PorterTokenStore {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const maxFetches = opts.maxFetches ?? DEFAULT_MAX_FETCHES;
  const now = opts.now ?? (() => Date.now());
  const entries = new Map<string, PorterTokenEntry>();

  const isExpired = (e: PorterTokenEntry): boolean => now() >= e.expiresAt;

  function mint(input: {
    namespace: string;
    userId: string;
  }): PorterTokenEntry {
    // base64url of 24 random bytes → 32-char token with no `.` in the alphabet,
    // so the `.ps1` suffix split in GET /p/:token is unambiguous (K2/D1).
    const token = randomBytes(24).toString("base64url");
    const createdAt = now();
    const entry: PorterTokenEntry = {
      token,
      namespace: input.namespace,
      userId: input.userId,
      createdAt,
      expiresAt: createdAt + ttlMs,
      fetchCount: 0,
      uploadConsumed: false,
      scope: "porter",
    };
    entries.set(token, entry);
    return entry;
  }

  function getForFetch(token: string): PorterTokenEntry | null {
    const e = entries.get(token);
    if (!e) return null;
    if (isExpired(e)) return null;
    if (e.fetchCount >= maxFetches) return null;
    e.fetchCount += 1;
    return e;
  }

  function getForUpload(token: string): PorterTokenEntry | null {
    const e = entries.get(token);
    if (!e) return null;
    if (isExpired(e)) return null;
    if (e.uploadConsumed) return null;
    return e;
  }

  function markUploaded(token: string, stagingHandle: string): boolean {
    const e = entries.get(token);
    if (!e) return false;
    e.uploadConsumed = true;
    e.stagingHandle = stagingHandle;
    return true;
  }

  function status(token: string): PorterTokenStatusView | null {
    const e = entries.get(token);
    if (!e) return null;
    // `received` is terminal-happy: a consumed upload stays `received` even past
    // the token TTL (the plan was staged in time; its own staging TTL governs it).
    let state: PorterTokenState;
    if (e.uploadConsumed) state = "received";
    else if (isExpired(e)) state = "expired";
    else state = "waiting";
    return {
      state,
      expiresAt: e.expiresAt,
      fetchCount: e.fetchCount,
      stagingHandle: e.stagingHandle,
    };
  }

  function statusForOwner(
    token: string,
    namespace: string
  ): PorterTokenStatusView | null {
    const e = entries.get(token);
    if (!e || e.namespace !== namespace) return null;
    return status(token);
  }

  function sweepExpired(): void {
    for (const [token, e] of entries) {
      // Keep a received-but-TTL-passed entry so its status stays `received`
      // until the staging plan is swept; only evict never-received expirations.
      if (isExpired(e) && !e.uploadConsumed) entries.delete(token);
    }
  }

  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  if (!opts.disableSweep) {
    sweepTimer = setInterval(sweepExpired, SWEEP_INTERVAL_MS);
    // Never keep the process alive for the sweep (google-oauth.ts:325 pattern).
    (sweepTimer as unknown as { unref?: () => void }).unref?.();
  }

  function stop(): void {
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }

  return {
    mint,
    getForFetch,
    getForUpload,
    markUploaded,
    status,
    statusForOwner,
    sweepExpired,
    stop,
  };
}
