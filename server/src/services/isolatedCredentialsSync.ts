// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  SIGN_IN_MARKER_FILE,
  parseSignInMarker,
  parseSignInMarkerWrittenAt,
  type SignInMarker,
} from "@hapi/protocol";

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
 *
 * Issue #6161 (R3): the sign-in also writes its deadline,
 * `claudeAiOauth.refreshTokenExpiresAt`, and removes `loginEnded`. Before #6161
 * the spread kept the DEAD login's deadline and `loginEnded: "time_limit"`, so
 * Claude Code and every other instance on the machine read a stale end date.
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
  /**
   * Issue #6161 (R3): this sign-in's deadline (epoch ms, from `signInDeadline`).
   * REQUIRED, so no caller can omit it and leave the old login's value in place
   * through the spread below (the pre-#6161 bug). Written as a finite number,
   * never `null` or `0`. Its source tag never goes into `claudeAiOauth`: Claude
   * Code rebuilds that object from a fixed key list on every save.
   */
  refreshTokenExpiresAt: number;
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
  return firstFingerprint(readIsolatedLayouts(accountUuid, opts));
}

/** Issue #6997: one credentials file's chain facts — a hash and a time, never a token. */
export interface ChainLayoutFacts {
  /** sha256 hex of the file's refresh token, or null when it holds none. */
  fingerprint: string | null;
  /** The file's `claudeAiOauth.refreshTokenExpiresAt` (epoch ms), or null. */
  deadlineAt: number | null;
  /** An account folder layout, or the node's own `~/.claude` login. */
  source: "isolated" | "host";
}

/** Issue #6997: a sign-in marker's comparable facts. */
export interface ChainMarkerFacts {
  /** The refresh fingerprint the marker names, or null. */
  fingerprint: string | null;
  /** The marker's `writtenAt` (epoch ms), or null. */
  writtenAt: number | null;
}

/** Issue #6997: what this node reports for an account's chain (hashes and times only). */
export interface IsolatedChainFacts {
  /** Exactly {@link isolatedChainFingerprint}'s answer (the first folder layout with a token). */
  fingerprint: string | null;
  /** Every non-null fingerprint, across every folder layout and the host login. */
  layoutFingerprints: string[];
  /** The first existing folder layout's deadline, as {@link readFolderDeadline}. */
  deadlineAt: number | null;
  /** Each folder layout that exists (in order), then the host login when it is this account. */
  layouts: ChainLayoutFacts[];
  /** Every sign-in marker found beside a folder layout. */
  markers: ChainMarkerFacts[];
}

/** Issue #6997: the chain-facts reader's options. */
export interface ChainFactsOptions extends IsolatedCredentialsSyncOptions {
  /** The home whose `~/.claude` login is checked (default `homedir()`). */
  homeDir?: string;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** One parse of a credentials file: its fingerprint and deadline, or null when unreadable. */
function readCredentialFacts(
  path: string,
  source: ChainLayoutFacts["source"]
): ChainLayoutFacts | null {
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
        ? (parsed.claudeAiOauth as {
            refreshToken?: unknown;
            refreshTokenExpiresAt?: unknown;
          })
        : null;
    const refreshToken = oauth?.refreshToken;
    return {
      fingerprint:
        typeof refreshToken === "string" && refreshToken.length > 0
          ? createHash("sha256").update(refreshToken).digest("hex")
          : null,
      deadlineAt: finiteOrNull(oauth?.refreshTokenExpiresAt),
      source,
    };
  } catch {
    return null;
  }
}

/**
 * Every existing folder layout's facts, in {@link resolveIsolatedCredentialPaths}
 * order. An unreadable or corrupt file reads as no fingerprint and no deadline,
 * so it is skipped by the fingerprint's fall-through and stops the deadline's.
 */
function readIsolatedLayouts(
  accountUuid: string,
  opts: IsolatedCredentialsSyncOptions
): ChainLayoutFacts[] {
  const layouts: ChainLayoutFacts[] = [];
  for (const path of resolveIsolatedCredentialPaths(accountUuid, opts)) {
    if (!existsSync(path)) continue;
    layouts.push(
      readCredentialFacts(path, "isolated") ?? {
        fingerprint: null,
        deadlineAt: null,
        source: "isolated",
      }
    );
  }
  return layouts;
}

/** The first layout with a fingerprint — the fall-through #3784 always used. */
function firstFingerprint(layouts: ChainLayoutFacts[]): string | null {
  return layouts.find(l => l.fingerprint !== null)?.fingerprint ?? null;
}

/**
 * Issue #6997 (M5): the node's own `~/.claude` login chain when `~/.claude.json`
 * names this account (`oauthAccount.accountUuid`), else null. A holder running
 * on its host login is then covered and compared like a folder. Reads the
 * identity file for the uuid only, and the credentials file for a hash and a
 * time. Never throws.
 */
function readHostLoginFacts(
  accountUuid: string,
  homeDir: string
): ChainLayoutFacts | null {
  try {
    const identity = JSON.parse(
      readFileSync(join(homeDir, ".claude.json"), "utf-8")
    ) as { oauthAccount?: { accountUuid?: unknown } } | null;
    const named = identity?.oauthAccount?.accountUuid;
    if (
      typeof named !== "string" ||
      named.toLowerCase() !== accountUuid.toLowerCase()
    ) {
      return null;
    }
  } catch {
    return null;
  }
  const path = join(homeDir, ".claude", ".credentials.json");
  return existsSync(path) ? readCredentialFacts(path, "host") : null;
}

/** Every sign-in marker beside a folder layout, in path order. */
function readSignInMarkers(
  accountUuid: string,
  opts: IsolatedCredentialsSyncOptions
): ChainMarkerFacts[] {
  const markers: ChainMarkerFacts[] = [];
  for (const credentialsPath of resolveIsolatedCredentialPaths(
    accountUuid,
    opts
  )) {
    const path = join(dirname(credentialsPath), SIGN_IN_MARKER_FILE);
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, "utf-8");
      const facts = {
        fingerprint: parseSignInMarker(raw),
        writtenAt: parseSignInMarkerWrittenAt(raw),
      };
      if (facts.fingerprint !== null || facts.writtenAt !== null) {
        markers.push(facts);
      }
    } catch {
      continue;
    }
  }
  return markers;
}

/**
 * Issue #6997 (R3, Task 4): this node's chain facts for `accountUuid`, for the
 * cross-node independence check. Each folder layout's fingerprint and deadline
 * come from ONE parse of that layout's file, so a deadline always belongs to the
 * fingerprint beside it (M10). The node's own `~/.claude` login joins as one
 * more layout when it is this account (M5), and every sign-in marker is
 * reported (M2). The top-level `fingerprint` and `deadlineAt` keep
 * {@link isolatedChainFingerprint}'s and {@link readFolderDeadline}'s answers
 * for older callers. Hashes and times only; never returns or logs a token.
 */
export function isolatedChainFacts(
  accountUuid: string,
  opts: ChainFactsOptions = {}
): IsolatedChainFacts {
  if (!UUID_REGEX.test(accountUuid)) {
    return {
      fingerprint: null,
      layoutFingerprints: [],
      deadlineAt: null,
      layouts: [],
      markers: [],
    };
  }
  const isolated = readIsolatedLayouts(accountUuid, opts);
  const host = readHostLoginFacts(accountUuid, opts.homeDir ?? homedir());
  const layouts = host ? [...isolated, host] : isolated;
  return {
    fingerprint: firstFingerprint(isolated),
    layoutFingerprints: [
      ...new Set(
        layouts.flatMap(l => (l.fingerprint === null ? [] : [l.fingerprint]))
      ),
    ],
    deadlineAt: isolated[0]?.deadlineAt ?? null,
    layouts,
    markers: readSignInMarkers(accountUuid, opts),
  };
}

/**
 * Issue #6161 (Task 8, R8): the account folder's own deadline — the FIRST
 * existing credentials file, in {@link resolveIsolatedCredentialPaths} order, and
 * its `claudeAiOauth.refreshTokenExpiresAt` when that is a finite number. Claude
 * Code writes this value at its own sign-in and keeps it on a refresh.
 *
 * Unlike {@link isolatedChainFingerprint} there is NO fall-through: when the
 * first existing file is unreadable, malformed or holds no finite number, the
 * answer is null, never another layout's value. Never throws; never returns or
 * logs a token.
 */
export function readFolderDeadline(
  accountUuid: string,
  opts: IsolatedCredentialsSyncOptions = {}
): number | null {
  for (const path of resolveIsolatedCredentialPaths(accountUuid, opts)) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
      if (typeof parsed !== "object" || parsed === null) return null;
      const oauth = (parsed as ClaudeAiOauthFile).claudeAiOauth;
      if (typeof oauth !== "object" || oauth === null) return null;
      const value = (oauth as { refreshTokenExpiresAt?: unknown })
        .refreshTokenExpiresAt;
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Issue #6161 (DEC-1, Task 8): the time in the account folder's sign-in marker
 * ({@link SIGN_IN_MARKER_FILE}) as epoch ms — the first existing marker file in
 * {@link resolveIsolatedCredentialPaths} order decides — or null when there is
 * none or it does not parse. The credentials file need not exist: the marker is
 * written whenever the folder exists. Never throws.
 */
export function readFolderSignInAt(
  accountUuid: string,
  opts: IsolatedCredentialsSyncOptions = {}
): number | null {
  for (const credentialsPath of resolveIsolatedCredentialPaths(
    accountUuid,
    opts
  )) {
    const path = join(dirname(credentialsPath), SIGN_IN_MARKER_FILE);
    if (!existsSync(path)) continue;
    try {
      return parseSignInMarkerWrittenAt(readFileSync(path, "utf-8"));
    } catch {
      return null;
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
      // Issue #6161 (R3): drop `loginEnded`, which a dead login's clear wrote;
      // this sign-in is a live login.
      const keptOauth: Record<string, unknown> = { ...existingOauth };
      delete keptOauth.loginEnded;
      const next: ClaudeAiOauthFile = {
        ...parsed,
        claudeAiOauth: {
          // Preserve subscriptionType / rateLimitTier / any unknown key —
          // native Claude Code owns those and the login response has none.
          ...keptOauth,
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
          expiresAt: token.expiresAt,
          scopes: token.scopes,
          refreshTokenExpiresAt: token.refreshTokenExpiresAt,
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

/**
 * Issue #6800 (round 2, R2-1): leave the sign-in marker ({@link SIGN_IN_MARKER_FILE})
 * in every EXISTING folder of `accountUuid`, naming only the sha256 fingerprint of
 * the refresh token this sign-in produced. Another instance on this machine lifts
 * its own `host-chain-shared` flag only when the folder's token matches it.
 * Never creates a folder (the same #3541 reason as the write-through above).
 * Best-effort by contract: never throws; returns the marker paths written.
 */
export function writeSignInMarker(
  accountUuid: string,
  refreshToken: string,
  opts: IsolatedCredentialsSyncOptions = {},
  now: () => number = Date.now
): string[] {
  const written: string[] = [];
  if (!refreshToken) return written;
  const marker: SignInMarker = {
    version: 1,
    refreshFingerprint: createHash("sha256").update(refreshToken).digest("hex"),
    writtenAt: new Date(now()).toISOString(),
  };
  for (const credentialsPath of resolveIsolatedCredentialPaths(
    accountUuid,
    opts
  )) {
    const dir = dirname(credentialsPath);
    if (!existsSync(dir)) continue;
    try {
      const path = join(dir, SIGN_IN_MARKER_FILE);
      atomicWrite600(path, JSON.stringify(marker, null, 2));
      written.push(path);
    } catch {
      // Best-effort: a missing marker only leaves the flag on the other
      // instances until a sign-in there, which is the safe side.
    }
  }
  return written;
}

/** Atomic write via a per-call unique tmp sibling + rename (mode 0600). */
function atomicWrite600(finalPath: string, content: string): void {
  const tmpPath = `${finalPath}.tmp.${process.pid}.${randomUUID()}`;
  writeFileSync(tmpPath, content, { mode: 0o600 });
  renameSync(tmpPath, finalPath);
}
