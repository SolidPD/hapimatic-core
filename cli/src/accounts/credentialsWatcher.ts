// SPDX-License-Identifier: AGPL-3.0-only
import { readFile, stat, watch } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  validateStoredAccount,
  type StoredAccount,
  type ValidateAccountResult,
} from "@hapi/protocol/accounts";
import { logger } from "@/ui/logger";
import { delay } from "@/utils/time";
import { seedAccountConfigDir } from "@/accounts/accountConfigDir";
import { SupervisedLoop, type JobRegistry } from "@hapi/protocol";

/**
 * Auto-capture of manual Claude Code logins (issue #1449, Sub-Issue C of epic
 * #1446).
 *
 * When the user runs `claude /logout && claude /login` on the host, Claude Code
 * writes fresh OAuth credentials to `~/.claude/.credentials.json` (atomic
 * tmp+rename) and the matching identity to `~/.claude.json` `oauthAccount`.
 * This watcher detects that change, builds a {@link StoredAccount}, writes it
 * through Sub-Issue A's `AccountStore`, and emits a redacted
 * `account-captured` notice (relayed to a server-sent event) so the web UI can
 * live-update the account dropdown.
 *
 * Two non-obvious correctness points (both verified against Claude Code source
 * during research, #1449):
 * 1. Claude Code writes `.credentials.json` via ATOMIC RENAME, which swaps in a
 *    new inode. A single-file `fs.watch(path)` binds to the inode and silently
 *    stops firing after the first change. This watcher therefore watches the
 *    PARENT DIRECTORY and filters for the `.credentials.json` filename — the
 *    watch survives inode replacement (regression-guarded in the test suite).
 * 2. Token VALUES never reach the logger and never appear in the
 *    `account-captured` notice (R10/R5) — only `accountUuid`/`emailAddress`/
 *    `isNewAccount`.
 */

/**
 * Identity fields resolved for a capture — either read locally from
 * `~/.claude.json` `oauthAccount` (the common path) or fetched from the OAuth
 * profile endpoint as a fallback (see {@link CredentialsWatcherOptions.profileFetch}).
 * Only `accountUuid` is required; the rest degrade to empty strings in the
 * stored record when absent.
 */
export interface ResolvedIdentity {
  accountUuid: string;
  emailAddress?: string;
  organizationUuid?: string;
  organizationName?: string;
  displayName?: string;
  billingType?: string;
}

/**
 * Redacted capture notice broadcast on every successful capture (R5). Carries
 * identity ONLY — never a token. Mirrors the `account-captured` SyncEvent
 * payload in `shared/src/schemas.ts` minus the `type`/`namespace` wire fields.
 */
export interface AccountCaptureNotice {
  accountUuid: string;
  emailAddress: string;
  organizationName?: string;
  /** true = a new account; false = a re-login token refresh on an existing one. */
  isNewAccount: boolean;
}

/**
 * The slice of Sub-Issue A's `AccountStore` this watcher consumes. Declared
 * structurally (not as an import of the concrete class) so the watcher stays
 * decoupled from `cli/src/accounts/accountStore.ts` and tests can inject a fake.
 */
export interface AccountStoreLike {
  get(accountUuid: string): Promise<ValidateAccountResult | null>;
  put(account: StoredAccount): Promise<void>;
}

export interface CredentialsWatcherOptions {
  /** Sub-Issue A's account store (the real singleton in production). */
  accountStore: AccountStoreLike;
  /**
   * Broadcast a redacted capture notice (relays to the `account-captured` SSE
   * in production). Best-effort: a thrown/rejected notify does NOT roll back
   * the already-persisted account — the SSE is the live-update path only.
   */
  notify: (notice: AccountCaptureNotice) => Promise<void> | void;
  /** Defaults to `~/.claude/.credentials.json`. Overridden in tests. */
  credentialsPath?: string;
  /** Defaults to `~/.claude.json`. Overridden in tests. */
  claudeConfigPath?: string;
  /** Debounce window after a change event before capture runs. Default 750ms. */
  debounceMs?: number;
  /**
   * Interval (ms) for the poll-based reconciliation fallback that re-reads
   * credentialsPath mtime and triggers a capture when it advances. Runs
   * ALONGSIDE watchLoop() (Fallback Preservation Rule — additive, never a
   * replacement), so a silently-stalled inotify watch (issue #1512) can no
   * longer drop a login. Default 60,000ms. Set lower in tests.
   */
  pollIntervalMs?: number;
  /**
   * Optional OAuth-profile fallback (Option 3, hybrid local-first). Invoked
   * ONLY when local identity (`~/.claude.json`) lacks an `accountUuid`. Returns
   * `null` on any failure → capture skips gracefully (R7). Omit for local-only
   * (Option 1).
   */
  profileFetch?: (accessToken: string) => Promise<ResolvedIdentity | null>;
  /** Clock seam for deterministic tests. Default `Date.now`. */
  now?: () => number;
  /**
   * R6 defense-in-depth. When false, every capture is suppressed (no put, no
   * notify). Production relies on START ORDERING for R6 (the daemon awaits
   * `accountStore.list()` — which completes A's migration — before constructing
   * the watcher), so this defaults to `true`. Tests set it false to assert the
   * pre-migration suppression contract directly.
   */
  enabled?: boolean;
  /**
   * Issue #1551: seed the captured (host-default) account's isolated config dir
   * from the fresh host credentials. The captured account IS the host-default by
   * construction (identity comes from `~/.claude.json` `oauthAccount`), so every
   * capture re-seeds (`overwrite:true`) its isolated dir to keep it warm for the
   * moment the account later loses host status — the "capture → hand to the
   * isolated owner before native rotates past it" bootstrap (R3). Best-effort:
   * a seed failure never undoes the persisted account. Default = the real
   * {@link seedAccountConfigDir} with `overwrite:true`; tests inject a no-op.
   */
  seedConfigDir?: (account: StoredAccount) => Promise<void>;
  /**
   * #1964 (Sub-D): the daemon's runtime job registry. When provided, the poll
   * fallback runs under a SupervisedLoop that registers a `credentials-watcher`
   * row, self-heals, and stall-detects; the System Jobs portal surfaces it.
   * Omitted in tests => the poll still runs (SupervisedLoop without a registry).
   */
  jobRegistry?: JobRegistry;
  /** #1964: federation node label for the registered row. Default "standalone". */
  jobNode?: string;
}

/** Slice of `~/.claude/.credentials.json` C reads. `mcpOAuth` is NEVER read (R8). */
interface ClaudeAiOauthSlice {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
}
interface ClaudeCredentialsFile {
  claudeAiOauth?: ClaudeAiOauthSlice;
}

/** Slice of `~/.claude.json` C reads (identity + the `accountUuid` primary key). */
interface ClaudeConfigFile {
  oauthAccount?: {
    accountUuid?: string;
    emailAddress?: string;
    organizationUuid?: string;
    organizationName?: string;
    displayName?: string;
    billingType?: string;
  };
}

const DEFAULT_DEBOUNCE_MS = 750;
/**
 * Poll interval (ms) for the mtime-based reconciliation fallback that augments
 * the inotify watch (issue #1512 — the watch can silently stop delivering
 * events without throwing).
 */
const DEFAULT_POLL_INTERVAL_MS = 60_000;
/** Short retry delay for the defensive JSON-parse retry (R7-adjacent). */
const READ_RETRY_DELAY_MS = 150;
/** Restart backoff for transient directory-watch errors (mirrors startFileWatcher). */
const WATCH_RESTART_DELAY_MS = 1000;

export class CredentialsWatcher {
  private readonly accountStore: AccountStoreLike;
  private readonly notify: (
    notice: AccountCaptureNotice
  ) => Promise<void> | void;
  private readonly credentialsPath: string;
  private readonly claudeConfigPath: string;
  private readonly debounceMs: number;
  private readonly pollIntervalMs: number;
  private readonly profileFetch?: (
    accessToken: string
  ) => Promise<ResolvedIdentity | null>;
  private readonly now: () => number;
  private readonly enabled: boolean;
  private readonly seedConfigDir: (account: StoredAccount) => Promise<void>;

  private watching = false;
  private abortController?: AbortController;
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private capturing = false;
  private pendingRerun = false;
  private pollLoop?: SupervisedLoop;
  private readonly jobRegistry: JobRegistry | null;
  private readonly jobNode: string;
  /** mtime (ms) of credentialsPath at the last poll/capture; 0 = never seen. */
  private lastKnownMtimeMs = 0;
  /** Wall-clock (this.now()) of the last WATCH-path event; 0 = none yet (R5). */
  private lastWatchEventMs = 0;

  constructor(opts: CredentialsWatcherOptions) {
    this.accountStore = opts.accountStore;
    this.notify = opts.notify;
    this.credentialsPath =
      opts.credentialsPath ?? join(homedir(), ".claude", ".credentials.json");
    this.claudeConfigPath =
      opts.claudeConfigPath ?? join(homedir(), ".claude.json");
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.profileFetch = opts.profileFetch;
    this.now = opts.now ?? Date.now;
    this.enabled = opts.enabled ?? true;
    // Issue #5020: the re-seed writes under native Claude Code's refresh and
    // storage-write locks (inside `seedAccountConfigDir`), and leaves a file
    // whose pair is newer than the capture alone — native rotated past it.
    this.seedConfigDir =
      opts.seedConfigDir ??
      (account =>
        seedAccountConfigDir(account, {
          overwrite: true,
          writer: "credentials-watcher",
          skipIfOnDiskNewer: true,
        }).then(() => {}));
    this.jobRegistry = opts.jobRegistry ?? null;
    this.jobNode = opts.jobNode ?? "standalone";
  }

  /**
   * Begin watching the credentials directory. Idempotent — a second `start()`
   * while already watching is a no-op.
   */
  start(): void {
    if (this.watching) return;
    this.watching = true;
    this.abortController = new AbortController();
    void this.watchLoop();
    this.startPollFallback();
    logger.debug(
      `[CREDENTIALS_WATCHER] watching ${dirname(this.credentialsPath)} for ` +
        `${basename(this.credentialsPath)} changes (poll fallback: ${this.pollIntervalMs}ms)`
    );
  }

  /**
   * Stop watching and tear down the fs watch + any pending debounce timer (R9).
   * Idempotent — safe to call when not started or twice.
   */
  stop(): void {
    this.watching = false;
    this.abortController?.abort();
    this.abortController = undefined;
    if (this.pollLoop) {
      this.pollLoop.stop();
      this.pollLoop = undefined;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
  }

  /**
   * Directory watch with a restart-on-error loop (adapted from
   * `startFileWatcher`). Watching the DIRECTORY rather than the file is what
   * makes the watch survive Claude Code's atomic-rename writes (Key Finding 2).
   */
  private async watchLoop(): Promise<void> {
    const dir = dirname(this.credentialsPath);
    const target = basename(this.credentialsPath);
    while (this.watching) {
      try {
        const watcher = watch(dir, {
          persistent: true,
          signal: this.abortController?.signal,
        });
        for await (const event of watcher) {
          if (!this.watching || this.abortController?.signal.aborted) return;
          // Permanent instrumentation (R2): reveals whether inotify delivers
          // events at all, and what `filename` contains on Bun/Linux ARM64 — a
          // null filename would silently fail the target filter below.
          logger.debug(
            `[CREDENTIALS_WATCHER] raw watch event: eventType=${event.eventType}, ` +
              `filename=${event.filename === null ? "null" : JSON.stringify(event.filename)}`
          );
          if (event.filename === target) {
            // Stamp the last genuine watch-event time so the poll fallback can
            // distinguish a healthy watch from a stalled one (R5). Set HERE, not
            // in scheduleCapture(), because the poll path also calls
            // scheduleCapture() and must not masquerade as a watch event.
            this.lastWatchEventMs = this.now();
            this.scheduleCapture();
          }
        }
      } catch (err) {
        if (!this.watching || this.abortController?.signal.aborted) return;
        logger.debug(
          `[CREDENTIALS_WATCHER] watch error (restarting in ${WATCH_RESTART_DELAY_MS}ms): ${err instanceof Error ? err.message : String(err)}`
        );
        await delay(WATCH_RESTART_DELAY_MS);
      }
    }
  }

  /**
   * Start the poll-based reconciliation fallback (R3/R4). Runs ALONGSIDE
   * watchLoop() and never replaces it (Fallback Preservation Rule) — its job is
   * to catch a credential change that a silently-stalled inotify watch dropped
   * (issue #1512). Cleared by stop() (R7).
   */
  private startPollFallback(): void {
    // #1964 (Sub-D): run the poll fallback under a SupervisedLoop so a silent
    // stall of THIS loop is detected + alerted (and it self-restarts), and the
    // daemon job registry surfaces its status in the System Jobs portal. With no
    // registry (tests) it still polls — SupervisedLoop runs telemetry-free. The
    // fs.watch path is untouched (Fallback Preservation Rule).
    this.pollLoop = new SupervisedLoop({
      name: "credentials-watcher",
      node: this.jobNode,
      intervalMs: this.pollIntervalMs,
      registry: this.jobRegistry ?? undefined,
      tick: () => this.pollOnce(),
    });
    this.pollLoop.start();
  }

  /**
   * One poll tick: stat credentialsPath and, if its mtime advanced since the
   * last poll/capture, schedule a capture. If the advance also post-dates the
   * last watch event by more than the debounce window, the inotify watch has
   * likely stalled — surface a warning to error_logs (R5). Never throws: a
   * transient stat error (e.g. ENOENT during the atomic-rename window) is
   * swallowed so the interval keeps ticking.
   */
  private async pollOnce(): Promise<void> {
    if (!this.watching) return;
    try {
      const s = await stat(this.credentialsPath);
      if (s.mtimeMs <= this.lastKnownMtimeMs) return;
      if (
        this.lastKnownMtimeMs > 0 &&
        s.mtimeMs > this.lastWatchEventMs + this.debounceMs
      ) {
        const stalledMs = Math.round(s.mtimeMs - this.lastWatchEventMs);
        logger.debug(
          `[CREDENTIALS_WATCHER] poll caught an mtime change the watch missed ` +
            `(~${stalledMs}ms stale); triggering poll-driven capture`
        );
        logger.reportCaught(
          new Error(
            `CredentialsWatcher inotify watch may have stalled — mtime ` +
              `advanced ~${stalledMs}ms ago with no watch event`
          ),
          { category: "credentials-watcher-stall", severity: "warn" }
        );
      }
      this.lastKnownMtimeMs = s.mtimeMs;
      this.scheduleCapture();
    } catch {
      // ENOENT during the atomic-rename window, or any transient stat error —
      // ignore; the next interval re-checks. The timer must never throw.
    }
  }

  /** (Re)arm the debounce timer so a burst of events coalesces into one capture. */
  private scheduleCapture(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.captureOnce();
    }, this.debounceMs);
  }

  /**
   * Run a capture, guarding against overlap. If a change arrives while a
   * capture is in flight (possible when the network fallback is slow), the
   * capture re-runs once afterward so the change is not dropped.
   */
  private async captureOnce(): Promise<void> {
    if (this.capturing) {
      this.pendingRerun = true;
      return;
    }
    this.capturing = true;
    try {
      do {
        this.pendingRerun = false;
        await this.runCapture();
      } while (this.pendingRerun && this.watching);
    } finally {
      this.capturing = false;
    }
  }

  private async runCapture(): Promise<void> {
    // R6: suppress while A's initial-population migration is incomplete.
    // Production guarantees this via start ordering; the flag is the
    // defense-in-depth + test seam.
    if (!this.enabled) {
      logger.debug(
        "[CREDENTIALS_WATCHER] capture suppressed (watcher not enabled — migration in progress)"
      );
      return;
    }

    try {
      // 1. Read tokens from claudeAiOauth ONLY (R8). Atomic-rename means a
      //    complete file, but a defensive single retry covers any transient
      //    read/parse failure (R7-adjacent).
      const oauth = await this.readClaudeAiOauth();
      if (!oauth?.accessToken) {
        logger.debug(
          "[CREDENTIALS_WATCHER] no claudeAiOauth.accessToken in credentials; skipping"
        );
        return;
      }

      // 2. Resolve identity (Option 3, hybrid local-first).
      const identity = await this.resolveIdentity(oauth.accessToken);
      if (!identity?.accountUuid) {
        logger.debug(
          "[CREDENTIALS_WATCHER] accountUuid unresolvable (local absent, fallback null/omitted); skipping (R7)"
        );
        return;
      }

      // 3. New vs re-login. A's get() returns null (unknown), {ok:true}
      //    (valid), or {ok:false} (corrupt). A malformed accountUuid makes
      //    get()/put() throw InvalidAccountUuidError — caught below as a skip.
      const existing = await this.accountStore.get(identity.accountUuid);
      if (existing && !existing.ok) {
        logger.debug(
          `[CREDENTIALS_WATCHER] existing record for ${identity.accountUuid} is corrupt (${existing.error}); skipping`
        );
        return;
      }
      const existingAccount = existing?.ok ? existing.account : null;
      const isNewAccount = existing === null;

      // 4. Build the record (provenance mirrors A's migrateFromClaudeCredentials,
      //    issue #1447) and validate before persisting.
      const candidate = this.buildStoredAccount(
        oauth,
        identity,
        existingAccount,
        this.now()
      );
      const validation = validateStoredAccount(candidate);
      if (!validation.ok) {
        logger.debug(
          `[CREDENTIALS_WATCHER] built record failed validation (${validation.error}); skipping`
        );
        return;
      }

      // 5. Persist (R2/R3/R4).
      await this.accountStore.put(validation.account);
      logger.debug(
        `[CREDENTIALS_WATCHER] captured account ${identity.accountUuid} ` +
          `(email: ${validation.account.emailAddress ? "present" : "absent"}, new: ${isNewAccount})`
      );

      // Record the mtime we just captured so the poll fallback stays a true
      // fallback (issue #1512): it will NOT re-capture a change the watch path
      // already handled. Best-effort — if stat fails, the poll's own mtime
      // tracking still applies.
      try {
        const captured = await stat(this.credentialsPath);
        if (captured.mtimeMs > this.lastKnownMtimeMs) {
          this.lastKnownMtimeMs = captured.mtimeMs;
        }
      } catch {
        // non-fatal — poll-side mtime tracking remains authoritative
      }

      // 5.5 Issue #1551: seed the captured (host-default) account's isolated
      //     config dir from the fresh host credentials (overwrite:true), keeping
      //     it warm for the moment this account later loses host status (R3).
      //     Best-effort — a seed failure never undoes the persisted account.
      //
      //     Issue #1635 (R5/F1): GATE the overwrite seed on identity coherence.
      //     "The captured account IS the host-default by construction" holds
      //     only while `~/.claude.json` `oauthAccount` is stable. During a
      //     host-login transition, the credentials file (tokens) and the
      //     config file (identity) update at different instants — a capture
      //     straddling that window could overwrite-seed a NON-host account's
      //     natively-owned isolated dir with cross-account or superseded
      //     tokens, exactly the snapshot-clobber class #1635 eliminates.
      //     Re-read the local identity NOW: seed only when it still names the
      //     captured account. The store put above is unaffected — only the
      //     destructive overwrite seed is gated. The skipped seed self-heals:
      //     the post-transition capture (with coherent identity) re-seeds.
      try {
        const localNow = await this.readLocalIdentity().catch(() => undefined);
        if (localNow?.accountUuid !== identity.accountUuid) {
          logger.warn(
            `[CREDENTIALS_WATCHER] suppressing isolated-dir overwrite seed for ${identity.accountUuid}: host identity is now ${localNow?.accountUuid ?? "absent"} (mid-login transition — #1635 R5)`
          );
        } else {
          await this.seedConfigDir(validation.account);
        }
      } catch (err) {
        logger.debug(
          `[CREDENTIALS_WATCHER] isolated-dir seed failed (account stored; isolation warm-up skipped): ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // 6. Broadcast a redacted notice (R5). Best-effort — failure here does
      //    NOT undo the persisted account.
      try {
        await this.notify({
          accountUuid: identity.accountUuid,
          emailAddress: validation.account.emailAddress,
          organizationName: validation.account.organizationName || undefined,
          isNewAccount,
        });
      } catch (err) {
        logger.debug(
          `[CREDENTIALS_WATCHER] notify failed (account stored; live SSE skipped): ${err instanceof Error ? err.message : String(err)}`
        );
      }
    } catch (err) {
      // InvalidAccountUuidError (non-canonical accountUuid) or any unexpected
      // error — log and skip; the watcher must never crash the daemon.
      logger.debug(
        `[CREDENTIALS_WATCHER] capture failed (skipping): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Read `claudeAiOauth` (R8 — never `mcpOAuth`). One defensive retry on a
   * read/parse failure; returns undefined on a missing file (transient during
   * atomic rename) or persistent failure.
   */
  private async readClaudeAiOauth(): Promise<ClaudeAiOauthSlice | undefined> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await readFile(this.credentialsPath, "utf-8");
        const parsed = JSON.parse(raw) as ClaudeCredentialsFile;
        return parsed.claudeAiOauth;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        if (attempt === 0) {
          logger.debug(
            "[CREDENTIALS_WATCHER] credentials read/parse failed; retrying once after debounce"
          );
          await delay(READ_RETRY_DELAY_MS);
          continue;
        }
        logger.debug(
          "[CREDENTIALS_WATCHER] credentials read/parse failed after retry; skipping"
        );
        return undefined;
      }
    }
    return undefined;
  }

  /** Option 3: local `~/.claude.json` first, network profile fetch as fallback. */
  private async resolveIdentity(
    accessToken: string
  ): Promise<ResolvedIdentity | null> {
    const local = await this.readLocalIdentity();
    if (local?.accountUuid) return local;

    if (this.profileFetch) {
      try {
        const profile = await this.profileFetch(accessToken);
        if (profile?.accountUuid) return profile;
      } catch (err) {
        logger.debug(
          `[CREDENTIALS_WATCHER] profile-fetch fallback failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    return null;
  }

  /** Read identity from `~/.claude.json` `oauthAccount`. undefined when absent. */
  private async readLocalIdentity(): Promise<ResolvedIdentity | undefined> {
    try {
      const raw = await readFile(this.claudeConfigPath, "utf-8");
      const parsed = JSON.parse(raw) as ClaudeConfigFile;
      const o = parsed.oauthAccount;
      if (!o?.accountUuid) return undefined;
      return {
        accountUuid: o.accountUuid,
        emailAddress: o.emailAddress,
        organizationUuid: o.organizationUuid,
        organizationName: o.organizationName,
        displayName: o.displayName,
        billingType: o.billingType,
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Build a {@link StoredAccount}. Field provenance MIRRORS Sub-Issue A's
   * `AccountStore.migrateFromClaudeCredentials` (issue #1447) — identity from
   * `~/.claude.json` (or the network fallback), tokens + subscription from
   * `~/.claude/.credentials.json` `claudeAiOauth`. Kept in sync deliberately;
   * if A's schema gains a field, update both sites (a shared
   * `buildAccountFromLocalCredentials` helper is the eventual DRY home — see
   * the worker handoff).
   *
   * Timestamp policy: NEW account → `capturedAt=now`, `lastUsedAt=0`,
   * `lastRefreshedAt=0` (R3). RE-LOGIN → preserve `capturedAt`+`lastUsedAt`,
   * set `lastRefreshedAt=now` (R4).
   */
  private buildStoredAccount(
    oauth: ClaudeAiOauthSlice,
    identity: ResolvedIdentity,
    existing: StoredAccount | null,
    now: number
  ): StoredAccount {
    return {
      schema_version: 1,
      accountUuid: identity.accountUuid,
      emailAddress: identity.emailAddress ?? existing?.emailAddress ?? "",
      organizationUuid:
        identity.organizationUuid ?? existing?.organizationUuid ?? "",
      organizationName:
        identity.organizationName ?? existing?.organizationName ?? "",
      displayName: identity.displayName ?? existing?.displayName ?? "",
      billingType: identity.billingType ?? existing?.billingType ?? "",
      subscriptionType: oauth.subscriptionType ?? "",
      rateLimitTier: oauth.rateLimitTier ?? "",
      accessToken: oauth.accessToken ?? "",
      refreshToken: oauth.refreshToken ?? "",
      expiresAt: oauth.expiresAt ?? 0,
      scopes: oauth.scopes ?? [],
      capturedAt: existing ? existing.capturedAt : now,
      lastUsedAt: existing ? existing.lastUsedAt : 0,
      lastRefreshedAt: existing ? now : 0,
      // #1520: a fresh capture proves the account IS refreshable — explicitly clear
      // any prior sticky `unrefreshable` flag (do NOT carry it over from `existing`).
      // This is the recovery path for a host-default account poisoned before the
      // TokenRefreshService deferral landed: the next native re-login/refresh advances
      // the host credentials' mtime, the watcher captures, and the flag clears here.
      unrefreshable: false,
    };
  }
}
