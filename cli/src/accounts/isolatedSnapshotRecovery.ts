// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Spawn-time validation + tiered recovery for isolated account snapshots
 * (issue #1635, R1 — the core fix).
 *
 * Background: a non-host account's isolated `.credentials.json` can be
 * server-side REVOKED while showing a future `expiresAt` — Anthropic OAuth uses
 * rotating refresh tokens with per-account revocation (#1546 Tier-1), so any
 * sibling holder of the same family (another instance's isolated dir, a stale
 * store copy, a force-refresh) that rotates first supersedes this snapshot.
 * Pre-#1635, `resolveAccountConfigDirForSession` returned an existing isolated
 * dir with ZERO validation ("native owns it"), so the spawned `claude` 401'd on
 * its first API call with no recovery path.
 *
 * This module makes spawns self-healing:
 *   1. PROBE — non-destructive GET of the OAuth profile endpoint with the
 *      isolated access token (pattern: `oauthProfile.ts`). 2xx → healthy;
 *      401/403 → revoked; anything else (network/timeout/5xx/429) →
 *      indeterminate → proceed OPTIMISTICALLY (never block spawns offline).
 *   2. RECOVERY (probe-revoked or clock-expired only), under a per-account
 *      cross-process file lock so concurrent spawns never double-recover:
 *      a. RE-READ — a concurrent spawn may have already recovered; trust a
 *         changed refresh token.
 *      b. ROTATE THE FILE'S TOKEN (issue #4423, file first) — ONE rotation of
 *         the isolated refresh token, routed through
 *         `TokenRefreshService.forceRefresh` (compare-and-swap under
 *         `.rotate.lock`; writes back to the isolated dir + mirrors the store;
 *         flags `unrefreshable` only while the rejected token is still on disk).
 *         Rotation is only ever attempted on an already-dead snapshot — see
 *         #1635 KD-1 for why an unconditional spawn-time rotation is forbidden
 *         (it would revoke live sibling-instance sessions' in-memory tokens,
 *         and `restartBoundSessions` is local-instance-only).
 *      c. LAST-RESORT SEED — the store head is seeded over the file only after
 *         the file's token is permanently rejected, or when the file is
 *         unreadable / refresh-less, and only if it differs from the token that
 *         failed; then one more rotation (or, for an unreadable file, a live
 *         store token is used as-is). Pre-#4423 this tier ran whenever the two
 *         tokens merely differed and put stale, consumed store tokens back over
 *         live files — the RP1 re-login incidents of 2026-09-26/27.
 *   3. FAIL LOUD — when recovery is impossible, return "fallback": the caller
 *      returns null and the env-token path throws the precise "re-login"
 *      error. This function NEVER throws (the resolver's documented contract
 *      and the Fallback Preservation Rule both depend on it).
 *
 * Residual (documented, accepted): the probe is TOCTOU — a sibling can rotate
 * in the probe→first-turn gap. The window shrinks from hours (snapshot age) to
 * seconds; the launcher-side auth fail-fast (#1635 R3/R4) bounds the worst
 * case to one clear error. Token VALUES never reach the logger.
 *
 * Issue #1643 (R7): the isolated dir is now machine-global SHARED. Every path
 * below routes through `accountConfigDirFor(uuid)` (= `configuration.accountConfigsDir`),
 * so the dir, the seed/write targets, AND the per-account `.recovery.lock` all
 * relocate to the shared base with NO code change here — and the lock becomes a
 * desirable MACHINE-GLOBAL per-account lock: concurrent spawns from prod + dev +
 * any worktree now share ONE recovery for an account (previously each instance
 * recovered its own per-instance dir independently). The probe is non-destructive,
 * and rotation still fires only on an already-dead snapshot (#1635 KD-1). Note
 * (#4423): "dead" includes a token inside its last five minutes (the expiry
 * buffer below), which a live sibling may still be using — so the shared lock
 * CAN serialize a rotation against a sibling's in-memory token. That is why the
 * rotation itself is compare-and-swap and why the store head is a last resort.
 */

import type { StoredAccount } from "@hapi/protocol/accounts";
import {
  readIsolatedCredentials,
  seedAccountConfigDir,
} from "@/accounts/accountConfigDir";
import { accountStore } from "@/accounts/accountStore";
import {
  RECOVERY_LOCK_NAME,
  ROTATE_LOCK_NAME,
  refreshTokenFingerprint,
  withAccountCredentialLock,
} from "@/accounts/machineRotator";
import {
  TokenRefreshService,
  type ForceRefreshOutcome,
} from "@/accounts/tokenRefreshService";
import { logger } from "@/ui/logger";

/** OAuth profile endpoint — same wire target as `oauthProfile.ts` (CC source). */
export const PROBE_URL = "https://api.anthropic.com/api/oauth/profile";

/**
 * Probe timeout. Deliberately SHORTER than `oauthProfile.ts`'s 10s — the probe
 * sits on the spawn hot path, and the tmux launcher's burst-load window is 5s
 * (`BURST_LOAD_WINDOW_MS`); a slow probe must not push spawn latency into
 * burst-classification territory.
 */
export const PROBE_TIMEOUT_MS = 4_000;

/** Mirror of the refresh services' expiry buffer (5 min before `expiresAt`). */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/**
 * In-process healthy-verdict cache. The resolver runs in several places per
 * spawn (launcher + scanner + spawn adapter); one probe per spawn is enough.
 */
const HEALTHY_CACHE_TTL_MS = 15_000;
const healthyCache = new Map<string, number>();

export type ProbeOutcome = "healthy" | "revoked" | "indeterminate";

/** Narrow fetch slice (test seam — mirrors `tokenRefreshService.FetchLike`). */
export type ProbeFetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export interface SnapshotRecoveryDeps {
  /** Injectable fetch for offline probe tests. */
  fetchImpl?: ProbeFetchLike;
  /** Clock seam. Defaults to `Date.now`. */
  now?: () => number;
  /** Refresh-service seam (tests inject one with a stubbed `refreshFn`). */
  refreshService?: Pick<TokenRefreshService, "forceRefresh">;
  /**
   * Issue #1644: acquire the cross-machine rotation lease before the DESTRUCTIVE
   * tier-b rotation. Returns true ⇒ this node may rotate; false ⇒ another node
   * holds the lease, so defer (return `"fallback"`, do NOT rotate). Default
   * `async () => true` keeps recovery byte-equivalent to #1635 (R2/R6). The
   * daemon injects the feature-gated `RotationLeaseClient.acquireRotationLease`.
   */
  acquireRotationLease?: (accountUuid: string) => Promise<boolean>;
  /** Seed seam. Defaults to the real {@link seedAccountConfigDir}. */
  seedFn?: typeof seedAccountConfigDir;
  /** Probe timeout override (tests). */
  probeTimeoutMs?: number;
}

/**
 * Non-destructive access-token validity probe. Distinguishes the three
 * outcomes the recovery tiering needs; NEVER throws.
 */
export async function probeAccessToken(
  accessToken: string,
  deps: SnapshotRecoveryDeps = {}
): Promise<ProbeOutcome> {
  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const res = await doFetch(PROBE_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS),
    });
    if (res.ok) return "healthy";
    if (res.status === 401 || res.status === 403) return "revoked";
    // 5xx / 429 / unexpected — says nothing about THIS token's validity.
    return "indeterminate";
  } catch {
    // Network failure or timeout — proceed optimistically (offline spawns
    // must keep working; the launcher fail-fast bounds the downside).
    return "indeterminate";
  }
}

/** Test hook: clear the in-process healthy cache between test cases. */
export function clearHealthyProbeCache(): void {
  healthyCache.clear();
}

/**
 * Validate an account's isolated snapshot and recover it when dead.
 *
 * Returns `"ok"` when the isolated dir is safe to hand to native, `"fallback"`
 * when the caller should fall through to the env-token path (which owns the
 * loud failure surface). NEVER throws.
 */
export async function validateAndRecoverIsolatedSnapshot(
  account: StoredAccount,
  deps: SnapshotRecoveryDeps = {}
): Promise<"ok" | "fallback"> {
  const now = deps.now ?? Date.now;
  const accountUuid = account.accountUuid;
  try {
    const cachedAt = healthyCache.get(accountUuid);
    if (cachedAt !== undefined && now() - cachedAt < HEALTHY_CACHE_TTL_MS) {
      return "ok";
    }

    const oauth = await readIsolatedCredentials(accountUuid);
    if (!oauth) {
      // Dir exists per the caller's check but the credentials are unreadable,
      // malformed, or refresh-less (readIsolatedCredentials' both-tokens
      // contract returns null). This is UNCOMMON — not the steady post-session
      // state. CORRECTION (#1645): native does NOT blank an isolated
      // CLAUDE_CONFIG_DIR. The live 2x2 persistence probe on 2.1.170 (#1645
      // PROBE_VERDICTS) measured: under a CLEAN env native refreshes and
      // PERSISTS the rotated pair back to the dir (atomic tmp+rename); under
      // CLAUDE_CODE_OAUTH_TOKEN env-token contamination native runs
      // inference-only and SKIPS persisting, leaving the seeded file untouched
      // (still readable). The earlier #1635 "consumes-and-blanks" reading is
      // superseded — env contamination (now severed by #1645 Task 5A's
      // buildLauncherEnv binding-var strip), not native blanking, drove the
      // apparent token burn. So this branch fires only on genuine
      // malformation/partial writes — enter recovery rather than bailing (the
      // store may hold a fresher head, e.g. a CredentialsWatcher capture from a
      // host re-login of this account).
      logger.warn(
        `[SNAPSHOT_RECOVERY] isolated credentials unreadable/malformed for ${accountUuid} — entering recovery (#1635)`
      );
    } else if (oauth.expiresAt - now() > EXPIRY_BUFFER_MS) {
      const probe = await probeAccessToken(oauth.accessToken, deps);
      if (probe !== "revoked") {
        // healthy, or indeterminate (optimistic — never block spawns offline)
        healthyCache.set(accountUuid, now());
        return "ok";
      }
      logger.warn(
        `[SNAPSHOT_RECOVERY] isolated access token for ${accountUuid} is server-side revoked despite future expiresAt — entering recovery (#1635)`
      );
    } else {
      logger.info(
        `[SNAPSHOT_RECOVERY] isolated access token for ${accountUuid} is clock-expired — entering recovery (#1635)`
      );
    }

    // ── Recovery (snapshot is dead) — per-account cross-process lock so
    // concurrent spawns of the same account share one recovery. The helper
    // creates the dir first (a direct caller may validate before any seed) and
    // uses the same heartbeat + budgets as `.rotate.lock` (#4423): this hold
    // contains a wait on `.rotate.lock` and up to two rotations.
    return await withAccountCredentialLock(
      accountUuid,
      RECOVERY_LOCK_NAME,
      async () => {
        // Tier a0: re-read — a concurrent spawn may have recovered while we
        // waited on the lock. A changed (or newly-readable) refresh token =
        // a fresher family head.
        const fresh = await readIsolatedCredentials(accountUuid);
        if (fresh && (!oauth || fresh.refreshToken !== oauth.refreshToken)) {
          healthyCache.set(accountUuid, now());
          return "ok";
        }

        // Issue #4423 (R3): FILE FIRST. A readable file's own refresh token is
        // rotated before anything else; the store head is a LAST RESORT, seeded
        // only once the file's token has failed (or the file is unreadable /
        // refresh-less). The pre-#4423 tier a re-seeded the store head whenever
        // the two tokens merely differed — after a sibling rotation that put a
        // stale, consumed store token back over the live file, and the next
        // rotation died with `invalid_grant` (the #4423 killing step).
        let svc: Pick<TokenRefreshService, "forceRefresh"> | undefined;
        const ctx: RecoveryContext = {
          account,
          deps,
          now,
          refreshService: () =>
            (svc ??=
              deps.refreshService ?? new TokenRefreshService({ accountStore })),
          seed: deps.seedFn ?? seedAccountConfigDir,
          acquireRotationLease: deps.acquireRotationLease ?? (async () => true),
        };
        const verdict = fresh
          ? await recoverReadableFile(ctx, fresh.refreshToken)
          : await recoverUnreadableFile(ctx);
        if (verdict === "ok") healthyCache.set(accountUuid, now());
        return verdict;
      }
    );
  } catch (err) {
    // Transient FS/lock error — the env-token path is still a valid spawn
    // (Fallback Preservation Rule). NEVER throw into the resolver.
    logger.warn(
      `[SNAPSHOT_RECOVERY] validation failed for ${accountUuid}; falling back: ${err instanceof Error ? err.message : String(err)}`
    );
    return "fallback";
  }
}

// --- Recovery tiers (issue #4423: file first, store head last) ------------------

/** Everything the recovery tiers share, resolved once per recovery. */
interface RecoveryContext {
  account: StoredAccount;
  deps: SnapshotRecoveryDeps;
  now: () => number;
  /** Built lazily: most recoveries that rotate need it, a0 / a cached ok never does. */
  refreshService: () => Pick<TokenRefreshService, "forceRefresh">;
  seed: typeof seedAccountConfigDir;
  acquireRotationLease: (accountUuid: string) => Promise<boolean>;
}

/** True when the store record carries both tokens and a refresh token other than `onDisk`. */
function storeHeadDiffers(
  account: StoredAccount,
  onDiskRefreshToken: string | null
): boolean {
  return (
    !!account.accessToken &&
    !!account.refreshToken &&
    account.refreshToken !== onDiskRefreshToken
  );
}

/**
 * The last-resort seed condition: the store head differs from the token on
 * disk AND is not itself the token recorded as failed (#4423 Task 6 — a flagged
 * record whose fingerprint matches its own refresh token is a known-dead head).
 */
function storeHeadSeedable(
  account: StoredAccount,
  onDiskRefreshToken: string | null
): boolean {
  if (!storeHeadDiffers(account, onDiskRefreshToken)) return false;
  return !(
    account.unrefreshable === true &&
    !!account.refreshToken &&
    account.unrefreshableTokenFingerprint ===
      refreshTokenFingerprint(account.refreshToken)
  );
}

/** Seed the store head over the file, with `overwrite: true`, and log it. */
async function lastResortSeed(ctx: RecoveryContext): Promise<void> {
  await ctx.seed(ctx.account, { overwrite: true });
  logger.info(
    `[SNAPSHOT_RECOVERY] last-resort seed for ${ctx.account.accountUuid}`
  );
}

/**
 * Issue #1644: acquire the cross-machine family lease BEFORE a destructive
 * rotation. A non-holder must NOT rotate — it would detonate the lease holder's
 * live token (the cross-machine ping-pong). Defer to the env-token path instead
 * (KD-E accepted residual). Default seam `async () => true` ⇒ byte-equivalent
 * #1635 (R2/R6). The non-destructive tiers (a0 re-read, the unreadable-file
 * seed with a live store token) never consult it.
 */
async function leaseGranted(ctx: RecoveryContext): Promise<boolean> {
  const uuid = ctx.account.accountUuid;
  if (await ctx.acquireRotationLease(uuid)) return true;
  logger.info(
    `[SNAPSHOT_RECOVERY] deferred tier-b rotation for ${uuid} — family lease held by another node; falling back to env-token path`
  );
  return false;
}

/**
 * ONE rotation via `forceRefresh` → `forceRefreshIsolated` (compare-and-swap
 * under `.rotate.lock`: writes back to the isolated dir, mirrors the store,
 * flags `unrefreshable` only when the rejected token is still on disk).
 */
async function rotateOnce(ctx: RecoveryContext): Promise<ForceRefreshOutcome> {
  const uuid = ctx.account.accountUuid;
  const outcome = await ctx.refreshService().forceRefresh(uuid);
  if (outcome.kind === "success") {
    logger.info(
      `[SNAPSHOT_RECOVERY] rotated isolated token for ${uuid} — recovered`
    );
  }
  return outcome;
}

function exhausted(
  ctx: RecoveryContext,
  outcome: ForceRefreshOutcome
): "fallback" {
  logger.warn(
    `[SNAPSHOT_RECOVERY] recovery exhausted for ${ctx.account.accountUuid} (${outcome.kind}${"detail" in outcome ? `: ${outcome.detail}` : ""}); falling back to env-token path`
  );
  return "fallback";
}

/**
 * The file is readable (both tokens present). Never seed over it: rotate the
 * FILE's token first (step 1). Only a PERMANENT rejection of that token opens
 * the last resort (step 2): under `.rotate.lock`, re-read — a failed rotation
 * does not rewrite the file, and the CAS reports `permanent` only while the
 * rejected token is still on disk — and seed the store head if it differs and
 * is not the recorded failed token; then rotate once more (it rotates the seeded
 * token, or adopts a newer head that landed meanwhile). A transient failure or
 * not-found says nothing about the file's token: fall back without seeding
 * (step 3).
 */
async function recoverReadableFile(
  ctx: RecoveryContext,
  fileRefreshToken: string
): Promise<"ok" | "fallback"> {
  const uuid = ctx.account.accountUuid;
  if (storeHeadDiffers(ctx.account, fileRefreshToken)) {
    logger.info(
      `[SNAPSHOT_RECOVERY] store head not seeded for ${uuid} — the file's token has not failed`
    );
  }
  if (!(await leaseGranted(ctx))) return "fallback";
  const first = await rotateOnce(ctx);
  if (first.kind === "success") return "ok";
  if (first.kind !== "permanent") return exhausted(ctx, first);

  // The rejected token: the CAS reports its fingerprint; a mocked or older
  // refresh service may not, so fall back to the token this recovery read.
  const rejectedFp =
    first.rejectedTokenFingerprint ?? refreshTokenFingerprint(fileRefreshToken);
  const step = await withAccountCredentialLock(
    uuid,
    ROTATE_LOCK_NAME,
    async (): Promise<"changed" | "seeded" | "none"> => {
      const onDisk = await readIsolatedCredentials(uuid);
      // R3: a readable file holding a token OTHER than the rejected one was
      // written after the rejection (a native refresh, a re-login write-through)
      // — its token has not failed, so it is never seeded over.
      if (
        onDisk &&
        refreshTokenFingerprint(onDisk.refreshToken) !== rejectedFp
      ) {
        return "changed";
      }
      if (!storeHeadSeedable(ctx.account, onDisk?.refreshToken ?? null)) {
        return "none";
      }
      await lastResortSeed(ctx);
      return "seeded";
    }
  );
  if (step === "changed") {
    // Same trust as tier a0: a changed refresh token is a fresher family head.
    logger.info(
      `[SNAPSHOT_RECOVERY] ${uuid}: the credentials file changed after the rejection — a newer head is on disk; not seeded`
    );
    return "ok";
  }
  if (step === "none") return exhausted(ctx, first);
  const second = await rotateOnce(ctx);
  return second.kind === "success" ? "ok" : exhausted(ctx, second);
}

/**
 * The file is unreadable or holds no refresh token (step 4): the last resort
 * applies directly. Under `.rotate.lock`, re-read — if a writer made the file
 * readable meanwhile, do not seed; continue as a readable file. Otherwise seed a
 * seedable store head; if its access token is still live (unexpired and not
 * probed `revoked`), that is enough — no rotation, no lease. Otherwise rotate
 * once under the lease. A store record with no tokens falls through to the
 * rotation, which finds nothing to rotate (`not-found` → fallback).
 */
async function recoverUnreadableFile(
  ctx: RecoveryContext
): Promise<"ok" | "fallback"> {
  const uuid = ctx.account.accountUuid;
  const step = await withAccountCredentialLock(
    uuid,
    ROTATE_LOCK_NAME,
    async (): Promise<
      { kind: "readable"; refreshToken: string } | { kind: "seeded" | "none" }
    > => {
      const onDisk = await readIsolatedCredentials(uuid);
      if (onDisk)
        return { kind: "readable", refreshToken: onDisk.refreshToken };
      if (!storeHeadSeedable(ctx.account, null)) return { kind: "none" };
      await lastResortSeed(ctx);
      return { kind: "seeded" };
    }
  );
  if (step.kind === "readable") {
    return recoverReadableFile(ctx, step.refreshToken);
  }
  if (step.kind === "seeded") {
    const storeTokenLive =
      ctx.account.expiresAt - ctx.now() > EXPIRY_BUFFER_MS &&
      (await probeAccessToken(ctx.account.accessToken, ctx.deps)) !== "revoked";
    if (storeTokenLive) {
      logger.info(
        `[SNAPSHOT_RECOVERY] re-seeded ${uuid} from a fresher store snapshot — recovered without rotation`
      );
      return "ok";
    }
  }
  if (!(await leaseGranted(ctx))) return "fallback";
  const outcome = await rotateOnce(ctx);
  return outcome.kind === "success" ? "ok" : exhausted(ctx, outcome);
}
