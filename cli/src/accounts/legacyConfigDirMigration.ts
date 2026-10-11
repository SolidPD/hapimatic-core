// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Lazy migration of legacy per-instance isolated config dirs into the
 * machine-global SHARED dir (issue #1643, R2).
 *
 * Before #1643, every Hapimatic instance (prod `~/.hapimatic-private`, dev
 * `~/.hapimatic-dev`, each worktree `~/.hapimatic-wt-<port>`) held its OWN
 * `account-configs/<uuid>/` isolated dir + `.credentials.json` for the SAME
 * server-side refresh-token family — up to N dirs per account. #1643 collapses
 * those to ONE shared dir per account at `configuration.accountConfigsDir` (now
 * `${XDG_CONFIG_HOME:-~/.config}/hapimatic/account-configs`, outside every
 * `HAPI_HOME`).
 *
 * This module performs the per-account migration LAZILY: the resolver
 * (`accountTokenInjection.resolveAccountConfigDirForSession`) calls it on the
 * spawn path when the shared dir is not yet populated, BEFORE bootstrap-seeding
 * from the store. It picks the LIVE family head among the legacy dirs (the
 * snapshot native kept freshest — NOT the frozen store copy, which may be
 * revoked) and seeds the shared dir from it, so no account needs re-login solely
 * because of the relocation.
 *
 * NON-destructive: the probe is a read-only profile GET (`probeAccessToken`), and
 * seeding writes the EXISTING tokens (`seedAccountConfigDir`, `overwrite:false`) —
 * NO rotation, no force-refresh, no login flip. It is therefore safe to run even
 * against the migrating session's own bound account (OR-1 kill-vector applies only
 * to destructive token-family ops, which this module never performs).
 *
 * Contract: NEVER throws (Fallback Preservation Rule) — any error returns
 * `"skipped"` and the resolver falls through to its existing bootstrap-seed path.
 * Token VALUES never reach the logger. `accountUuid` is gated through
 * {@link UUID_REGEX} before any path `join` (path-traversal defense, same as the
 * rest of the account subsystem).
 */

import { readdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  StoredAccount,
  ValidateAccountResult,
} from "@hapi/protocol/accounts";
import { configuration } from "@/configuration";
import { logger } from "@/ui/logger";
import { UUID_REGEX } from "@/accounts/accountStore";
import { accountStore } from "@/accounts/accountStore";
import {
  hasIsolatedConfigDir,
  seedAccountConfigDir,
  type IsolatedClaudeAiOauth,
} from "@/accounts/accountConfigDir";
import {
  probeAccessToken,
  type ProbeFetchLike,
  type ProbeOutcome,
} from "@/accounts/isolatedSnapshotRecovery";
import {
  RECOVERY_LOCK_NAME,
  withAccountCredentialLock,
} from "@/accounts/machineRotator";

/** Outcome of a single-account migration attempt. */
export type LegacyMigrationOutcome = "migrated" | "none" | "skipped";

/**
 * Offline test seams + the Task 9 sweep's opt-in delete. Every field is
 * optional and defaults to the real production wiring.
 */
export interface LegacyConfigDirMigrationDeps {
  /** Home dir to scan for `~/.hapimatic-*` instance homes. Defaults to `homedir()`. */
  homeDir?: string;
  /** This instance's `HAPI_HOME`. Defaults to {@link configuration.happyHomeDir}. */
  happyHomeDir?: string;
  /**
   * The shared destination base (excluded from the legacy-source scan). Defaults
   * to {@link configuration.accountConfigsDir}.
   */
  sharedBaseDir?: string;
  /**
   * Whether the shared layout is active. Defaults to
   * {@link configuration.accountConfigsShared}. When false (kill-switch engaged),
   * there is no shared dir to migrate into, so migration no-ops.
   */
  sharedModeActive?: boolean;
  /** Injectable fetch for the offline probe (forwarded to {@link probeAccessToken}). */
  probeFetch?: ProbeFetchLike;
  /** Seed seam. Defaults to the real {@link seedAccountConfigDir}. */
  seedFn?: typeof seedAccountConfigDir;
  /** Store-read seam (for identity). Defaults to `accountStore.get`. */
  storeGet?: (accountUuid: string) => Promise<ValidateAccountResult | null>;
  /**
   * Task 9 sweep opt-in: after a successful migration, delete the legacy
   * per-account dirs whose head was migrated. Default `false` — the lazy
   * resolver path leaves legacy dirs in place (KD-6 Option A: the deprecation
   * sweep is what eventually deletes them, conservatively).
   */
  deleteLegacyAfterMigrate?: boolean;
}

/** A legacy candidate that read + probed successfully. */
interface LegacyHead {
  credPath: string;
  oauth: IsolatedClaudeAiOauth;
  probe: ProbeOutcome;
}

/**
 * Enumerate legacy `.credentials.json` paths for an account — prefix-bound to
 * `~/.hapimatic-<instance>/account-configs` (the same enumeration shape as
 * `isIsolatedAccountAnywhere`, never a generic glob), plus this instance's
 * `<HAPI_HOME>/account-configs` (covers a non-standard `HAPI_HOME` outside
 * `~/.hapimatic-*`). The shared destination base is EXCLUDED — it is where we
 * migrate INTO, not a legacy source.
 */
async function enumerateLegacyCredentialPaths(
  accountUuid: string,
  deps: LegacyConfigDirMigrationDeps
): Promise<string[]> {
  const home = deps.homeDir ?? homedir();
  const happyHome = deps.happyHomeDir ?? configuration.happyHomeDir;
  const sharedBase = deps.sharedBaseDir ?? configuration.accountConfigsDir;

  const bases = new Set<string>();
  const entries = await readdir(home, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.isDirectory() && e.name.startsWith(".hapimatic-")) {
      bases.add(join(home, e.name, "account-configs"));
    }
  }
  // Non-standard HAPI_HOME (outside ~/.hapimatic-*): the glob above misses it.
  bases.add(join(happyHome, "account-configs"));
  // The shared base is the destination, never a legacy source.
  bases.delete(sharedBase);

  return [...bases].map(base => join(base, accountUuid, ".credentials.json"));
}

/** Read a legacy `.credentials.json` at an explicit path. Never throws. */
async function readLegacyCredentials(
  credPath: string
): Promise<IsolatedClaudeAiOauth | null> {
  try {
    const raw = await readFile(credPath, "utf-8");
    const parsed = JSON.parse(raw) as { claudeAiOauth?: IsolatedClaudeAiOauth };
    const oauth = parsed.claudeAiOauth;
    if (!oauth?.accessToken || !oauth?.refreshToken) return null;
    return oauth;
  } catch {
    return null;
  }
}

/**
 * Migrate an account's legacy per-instance isolated dir(s) into the shared dir.
 *
 * Returns:
 *  - `"migrated"` — a live legacy head was seeded into the shared dir.
 *  - `"none"`     — no readable legacy dir exists (nothing to migrate; the
 *                   resolver's bootstrap-seed-from-store path handles seeding).
 *  - `"skipped"`  — a no-op for a benign reason (kill-switch engaged, shared dir
 *                   already populated, no live head, no store identity) OR an
 *                   error (NEVER throws).
 */
export async function migrateLegacyIsolatedDir(
  accountUuid: string,
  deps: LegacyConfigDirMigrationDeps = {}
): Promise<LegacyMigrationOutcome> {
  try {
    if (!UUID_REGEX.test(accountUuid)) {
      logger.warn(
        "[LEGACY_MIGRATION] refusing a non-canonical accountUuid; skipping"
      );
      return "skipped";
    }

    // Kill-switch engaged → per-instance layout; there is no shared dir to
    // migrate into (R5). A per-instance instance bootstraps from its OWN store,
    // never from a sibling's head.
    const sharedModeActive =
      deps.sharedModeActive ?? configuration.accountConfigsShared;
    if (!sharedModeActive) return "skipped";

    // Shared dir already populated (this instance, or a prior migration / spawn).
    if (await hasIsolatedConfigDir(accountUuid)) return "skipped";

    const credPaths = await enumerateLegacyCredentialPaths(accountUuid, deps);
    const heads: LegacyHead[] = [];
    for (const credPath of credPaths) {
      const oauth = await readLegacyCredentials(credPath);
      if (!oauth) continue;
      const probe = await probeAccessToken(oauth.accessToken, {
        fetchImpl: deps.probeFetch,
      });
      heads.push({ credPath, oauth, probe });
    }
    if (heads.length === 0) return "none";

    // Pick the LIVE head: prefer probe-healthy; among healthy take the latest
    // expiresAt. If none probe healthy, fall back to the latest expiresAt among
    // non-revoked heads (indeterminate counts as viable — offline tolerance: a
    // network failure must not abandon a possibly-live head).
    const healthy = heads.filter(h => h.probe === "healthy");
    const pool =
      healthy.length > 0 ? healthy : heads.filter(h => h.probe !== "revoked");
    if (pool.length === 0) {
      logger.warn(
        `[LEGACY_MIGRATION] all legacy heads for ${accountUuid} probe revoked; skipping (spawn-time recovery / re-login owns this)`
      );
      return "skipped";
    }
    const winner = pool.reduce((a, b) =>
      b.oauth.expiresAt > a.oauth.expiresAt ? b : a
    );

    // Identity for the seeded `.claude.json` comes from the store record; the
    // token fields are overridden with the LIVE legacy head.
    const storeGet = deps.storeGet ?? (uuid => accountStore.get(uuid));
    const res = await storeGet(accountUuid);
    if (!res || !res.ok) {
      logger.warn(
        `[LEGACY_MIGRATION] no usable store identity for ${accountUuid}; skipping (resolver bootstrap will seed)`
      );
      return "skipped";
    }
    const merged: StoredAccount = {
      ...res.account,
      accessToken: winner.oauth.accessToken,
      refreshToken: winner.oauth.refreshToken,
      expiresAt: winner.oauth.expiresAt,
      scopes: winner.oauth.scopes,
      subscriptionType: winner.oauth.subscriptionType,
      rateLimitTier: winner.oauth.rateLimitTier,
    };

    const seed = deps.seedFn ?? seedAccountConfigDir;

    // #4423: the same per-account helper (heartbeat + budgets) that spawn-time
    // recovery uses for `.recovery.lock` — with withFileLock's 10 s stale default
    // a migration could reap a live recovery lock (a recovery now holds it across
    // up to two rotations). The helper creates the shared dir first.
    const outcome = await withAccountCredentialLock<LegacyMigrationOutcome>(
      accountUuid,
      RECOVERY_LOCK_NAME,
      async () => {
        // Re-check inside the lock — a concurrent spawn/migration may have won.
        if (await hasIsolatedConfigDir(accountUuid)) return "skipped";
        const wrote = await seed(merged, { overwrite: false });
        if (wrote && deps.deleteLegacyAfterMigrate) {
          await deleteLegacyAccountDirs(heads.map(h => h.credPath));
        }
        return wrote ? "migrated" : "skipped";
      }
    );

    if (outcome === "migrated") {
      logger.info(
        `[LEGACY_MIGRATION] migrated ${accountUuid} into the shared dir from a live legacy head (probe=${winner.probe})`
      );
    }
    return outcome;
  } catch (err) {
    logger.warn(
      `[LEGACY_MIGRATION] migration failed for ${accountUuid}; skipping: ${err instanceof Error ? err.message : String(err)}`
    );
    return "skipped";
  }
}

/**
 * Conservatively delete the legacy per-account dirs whose head was migrated
 * (the dir CONTAINING each `.credentials.json`). Only called when
 * `deleteLegacyAfterMigrate` is set (Task 9 sweep). Best-effort — a failed
 * delete leaves a benign orphan (over-deferral self-heals per #1635); never
 * throws.
 */
async function deleteLegacyAccountDirs(credPaths: string[]): Promise<void> {
  for (const credPath of credPaths) {
    const accountDir = dirname(credPath);
    try {
      await rm(accountDir, { recursive: true, force: true });
      logger.info(
        `[LEGACY_MIGRATION] removed migrated legacy dir ${accountDir}`
      );
    } catch (err) {
      logger.warn(
        `[LEGACY_MIGRATION] could not remove legacy dir ${accountDir} (benign orphan): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

/**
 * True when ANY legacy per-instance dir still holds a readable
 * `.credentials.json` for the account — i.e. the transitional `~/.hapimatic-*`
 * fallback in `isIsolatedAccountAnywhere` would still match. Used by the sweep
 * to report the glob-retirement gate (`legacyRemaining === 0` ⇒ a follow-up PR
 * can safely delete the transitional scan). Existence-only — no probe, no
 * liveness judgment. Never throws.
 */
export async function hasLegacyConfigDir(
  accountUuid: string,
  deps: LegacyConfigDirMigrationDeps = {}
): Promise<boolean> {
  if (!UUID_REGEX.test(accountUuid)) return false;
  try {
    const credPaths = await enumerateLegacyCredentialPaths(accountUuid, deps);
    for (const credPath of credPaths) {
      if (await readLegacyCredentials(credPath)) return true;
    }
  } catch {
    // Enumeration failure → report no legacy (the deferral glob fails the same
    // way; over-/under-counting here only affects the advisory remaining count).
  }
  return false;
}

/** Per-account entry in a {@link LegacySweepResult}. */
export interface LegacySweepEntry {
  accountUuid: string;
  /** Actual outcome (non-dry-run) or projected action (dry-run). */
  outcome: LegacyMigrationOutcome | "would-migrate" | "would-skip";
  /** Whether a legacy dir still holds this account's creds AFTER the sweep step. */
  legacyStillPresent: boolean;
}

/** Aggregate result of a machine-wide migration sweep. */
export interface LegacySweepResult {
  dryRun: boolean;
  deleteLegacy: boolean;
  total: number;
  migrated: number;
  none: number;
  skipped: number;
  /**
   * Accounts still holding a legacy per-instance dir after the sweep. The
   * glob-retirement gate (#1643 KD-6 Option A): once this is `0` across a fully
   * upgraded machine, a follow-up PR can delete the transitional `~/.hapimatic-*`
   * scan from `isIsolatedAccountAnywhere`.
   */
  legacyRemaining: number;
  entries: LegacySweepEntry[];
}

/**
 * Issue #1643 Task 9 (KD-6 Option A — staged sweep): migrate EVERY store
 * account's legacy per-instance isolated dir into the shared dir, optionally
 * deleting the now-redundant legacy dirs, and report whether any legacy dirs
 * remain (the glob-retirement gate).
 *
 * Operator-invoked via `hapi accounts migrate-config-dirs` (NOT automatic at
 * daemon start — deleting a sibling instance's in-use legacy dir during a rolling
 * deployment is OR-2; deletion is opt-in via `--delete-legacy` and should run
 * only after ALL instances are upgraded). The per-account `.recovery.lock`
 * serializes each migration against a concurrent spawn; the migration is
 * NON-destructive to the token family, so the sweep is safe to run anytime.
 * NEVER throws per-account (each `migrateLegacyIsolatedDir` is internally
 * fail-soft); a store-list failure propagates to the caller.
 */
export async function sweepLegacyConfigDirs(
  opts: {
    deleteLegacy?: boolean;
    dryRun?: boolean;
    listAccounts?: () => Promise<{ accountUuid: string }[]>;
    migrate?: typeof migrateLegacyIsolatedDir;
    deps?: LegacyConfigDirMigrationDeps;
  } = {}
): Promise<LegacySweepResult> {
  const deleteLegacy = opts.deleteLegacy ?? false;
  const dryRun = opts.dryRun ?? false;
  const listAccounts = opts.listAccounts ?? (() => accountStore.list());
  const migrate = opts.migrate ?? migrateLegacyIsolatedDir;
  const deps = opts.deps ?? {};

  const accounts = await listAccounts();
  const entries: LegacySweepEntry[] = [];
  let migrated = 0;
  let none = 0;
  let skipped = 0;

  for (const { accountUuid } of accounts) {
    if (dryRun) {
      const sharedOwned = await hasIsolatedConfigDir(accountUuid).catch(
        () => false
      );
      const legacy = await hasLegacyConfigDir(accountUuid, deps);
      entries.push({
        accountUuid,
        outcome: !sharedOwned && legacy ? "would-migrate" : "would-skip",
        legacyStillPresent: legacy,
      });
      continue;
    }

    const outcome = await migrate(accountUuid, {
      ...deps,
      deleteLegacyAfterMigrate: deleteLegacy,
    });
    if (outcome === "migrated") migrated++;
    else if (outcome === "none") none++;
    else skipped++;
    entries.push({
      accountUuid,
      outcome,
      legacyStillPresent: await hasLegacyConfigDir(accountUuid, deps),
    });
  }

  return {
    dryRun,
    deleteLegacy,
    total: accounts.length,
    migrated,
    none,
    skipped,
    legacyRemaining: entries.filter(e => e.legacyStillPresent).length,
    entries,
  };
}
