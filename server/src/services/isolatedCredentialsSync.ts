// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

/**
 * Write-through of a freshly-obtained OAuth token into an account's EXISTING
 * isolated credentials file(s).
 *
 * Why this exists: the web Add Account flow (`AccountLoginService.complete()`)
 * persists only the account store (`<dataDir>/accounts/<uuid>.json`), but every
 * token READER resolves the isolated dir FIRST and unconditionally —
 * `UsageService.resolveToken()` (`server/src/accounts/usageService.ts`) Tier 1,
 * and the cli-side `resolveAccountTokenForSession()`
 * (`cli/src/claude/accountTokenInjection.ts`). So a successful interactive
 * re-login was invisible to those readers: they kept serving the DEAD token
 * from the isolated dir, and the Usage card kept rendering "Re-login required"
 * after a login that had in fact succeeded. Observed on RP1 2026-09-04 — the
 * store was rewritten at 19:27:12Z with a token valid until 03:27Z, while the
 * isolated dir still held the expired one four and a half minutes later.
 *
 * A user who has just completed a full interactive OAuth login holds, by
 * definition, the newest generation of that refresh-token family — so writing
 * it over an older on-disk snapshot supersedes rather than races it. This is
 * the one write path where that is unambiguously true, which is why the
 * write-through lives here and not in a general-purpose store helper.
 *
 * 🔴 LOAD-BEARING INVARIANT — update-only, never create. This function writes
 * ONLY to a `.credentials.json` that already exists. Creating one would newly
 * mark the account as "isolated", and `TokenRefreshService.tick()`
 * (`cli/src/accounts/tokenRefreshService.ts`) DEFERS every isolated account to
 * native Claude Code — so creating a dir here would silently remove that
 * account from Hapimatic's proactive refresh coverage and expose it to the
 * starvation bug tracked in #3541. An account with no isolated dir is served
 * from the store (Tier 2), which this login path already wrote correctly.
 *
 * Merge semantics: only the four token fields are replaced. `subscriptionType`
 * and `rateLimitTier` — which native Claude Code writes and Hapimatic's login
 * response does not carry — are PRESERVED, as is any unrecognized key, so this
 * write never degrades identity metadata that another writer owns.
 */

/**
 * Canonical UUID format (8-4-4-4-12 hex). `accountUuid` is used as a filesystem
 * path component, so this is the path-traversal defense. Mirrors `UUID_REGEX`
 * in `accountService.ts` (the server package cannot import the cli-side store,
 * so the constant is duplicated exactly as that service duplicates it).
 */
const UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The token fields a completed login supersedes. */
export interface FreshOauthToken {
  accessToken: string;
  refreshToken: string;
  /** Unix epoch ms. */
  expiresAt: number;
  scopes: string[];
}

export interface IsolatedCredentialsSyncOptions {
  /**
   * Machine-global isolated-config base — mirrors `configuration.accountConfigsDir`
   * (`cli/src/configuration.ts`, #1643). Defaults to
   * `${XDG_CONFIG_HOME:-~/.config}/hapimatic/account-configs`.
   */
  accountConfigsDir?: string;
  /**
   * Per-instance legacy layout base (`<dataDir>/account-configs`), the
   * `HAPI_ACCOUNT_CONFIG_SHARED=0` kill-switch layout. Supplied via `dataDir`
   * unless overridden directly.
   */
  perInstanceConfigsDir?: string;
  /** `HAPI_HOME`-rooted data dir; used to derive `perInstanceConfigsDir`. */
  dataDir?: string;
}

/** The on-disk shape of a `.credentials.json`; unknown keys are preserved. */
interface ClaudeAiOauthFile {
  claudeAiOauth?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * The isolated credential paths a token reader would consult, in the SAME
 * priority order as `UsageService.resolveToken()` Tier 1 (machine-global first,
 * then the per-instance kill-switch layout). Exported for tests and for callers
 * that want to report which locations were considered.
 */
export function resolveIsolatedCredentialPaths(
  accountUuid: string,
  opts: IsolatedCredentialsSyncOptions = {}
): string[] {
  if (!UUID_REGEX.test(accountUuid)) return [];
  const xdgBase =
    process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  const bases: string[] = [
    opts.accountConfigsDir ?? join(xdgBase, "hapimatic", "account-configs"),
  ];
  const perInstance =
    opts.perInstanceConfigsDir ??
    (opts.dataDir ? join(opts.dataDir, "account-configs") : null);
  if (perInstance) bases.push(perInstance);
  return bases.map(base => join(base, accountUuid, ".credentials.json"));
}

/**
 * Issue #3784: the sha256-hex fingerprint of THIS node's isolated refresh-token
 * chain for `accountUuid` (the FIRST existing isolated credentials file, in the
 * same priority order as {@link resolveIsolatedCredentialPaths} / the daemon's
 * reader), or null when the account owns no readable isolated dir on this node.
 * NEVER returns or logs the raw token — only its fingerprint. Identical to the
 * cli `refreshTokenFingerprint` (`createHash("sha256")…digest("hex")`) so the
 * cross-node comparison in `TokenRefreshService` matches byte-for-byte.
 */
export function isolatedChainFingerprint(
  accountUuid: string,
  opts: IsolatedCredentialsSyncOptions = {}
): string | null {
  for (const path of resolveIsolatedCredentialPaths(accountUuid, opts)) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(
        readFileSync(path, "utf-8")
      ) as ClaudeAiOauthFile | null;
      const oauth =
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        typeof parsed.claudeAiOauth === "object" &&
        parsed.claudeAiOauth !== null
          ? (parsed.claudeAiOauth as { refreshToken?: unknown })
          : null;
      const refreshToken = oauth?.refreshToken;
      if (typeof refreshToken !== "string" || refreshToken.length === 0) {
        continue;
      }
      return createHash("sha256").update(refreshToken).digest("hex");
    } catch {
      // Unreadable/corrupt at this layout — try the next, else null (fail-safe:
      // a null here yields the caller's "unknown" ⇒ no rotation).
      continue;
    }
  }
  return null;
}

/**
 * Merge `token` into every EXISTING isolated credentials file for `accountUuid`
 * and return the paths actually updated (empty when the account owns no
 * isolated dir — the normal, correct outcome for a store-only account).
 *
 * Best-effort by contract: never throws. A login that succeeded must not be
 * reported as failed because a secondary cache could not be refreshed — the
 * store write already happened and is authoritative for a non-isolated account.
 */
export function syncIsolatedCredentials(
  accountUuid: string,
  token: FreshOauthToken,
  opts: IsolatedCredentialsSyncOptions = {}
): string[] {
  const updated: string[] = [];
  for (const path of resolveIsolatedCredentialPaths(accountUuid, opts)) {
    // Update-only: a missing file means this account is not isolated at this
    // layout. Creating it would change the account's refresh ownership (#3541).
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(
        readFileSync(path, "utf-8")
      ) as ClaudeAiOauthFile | null;
      // A non-object (or null) file is corrupt; overwriting it would discard
      // whatever a concurrent writer is mid-way through. Leave it for the
      // spawn-time recovery path, which probes and re-seeds under a lock.
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      )
        continue;
      const existingOauth =
        typeof parsed.claudeAiOauth === "object" &&
        parsed.claudeAiOauth !== null &&
        !Array.isArray(parsed.claudeAiOauth)
          ? parsed.claudeAiOauth
          : {};
      const next: ClaudeAiOauthFile = {
        ...parsed,
        claudeAiOauth: {
          // Preserve subscriptionType / rateLimitTier / any unknown key —
          // native Claude Code owns those and the login response has none.
          ...existingOauth,
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
          expiresAt: token.expiresAt,
          scopes: token.scopes,
        },
      };
      atomicWrite600(path, JSON.stringify(next, null, 2));
      updated.push(path);
    } catch {
      // Unreadable, unparseable, or unwritable — non-fatal. The store copy
      // still carries the fresh token and spawn-time recovery self-heals.
    }
  }
  return updated;
}

/** Atomic write via a per-call unique tmp sibling + rename (mode 0600). */
function atomicWrite600(finalPath: string, content: string): void {
  const tmpPath = `${finalPath}.tmp.${process.pid}.${randomUUID()}`;
  writeFileSync(tmpPath, content, { mode: 0o600 });
  renameSync(tmpPath, finalPath);
}
