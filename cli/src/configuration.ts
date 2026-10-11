// SPDX-License-Identifier: MIT
/**
 * Global configuration for HAPI CLI
 *
 * Centralizes all configuration including environment variables and paths
 * Environment files should be loaded using Node's --env-file flag
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import packageJson from "../package.json";
import { getCliArgs } from "@/utils/cliArgs";

/**
 * Issue #1643: resolve the per-account isolated-config base dir AND whether the
 * machine-global SHARED layout is active, from env + this instance's HAPI_HOME.
 *
 * DEFAULT (shared): `${XDG_CONFIG_HOME:-~/.config}/hapimatic/account-configs` —
 * ONE dir per account OUTSIDE every per-instance HAPI_HOME (collapses the #1635
 * multi-rotator race to one structural owner). KILL-SWITCH (R5):
 * `HAPI_ACCOUNT_CONFIG_SHARED` ∈ {0,false,no,off} (case-insensitive — falsy-parse
 * mirrors HAPI_ACCOUNT_CONFIG_ISOLATION) reverts to the exact legacy per-instance
 * `<HAPI_HOME>/account-configs` path WITHOUT disabling isolation.
 *
 * Extracted as a pure function so the default-path + kill-switch logic is
 * unit-testable without re-instantiating the {@link Configuration} singleton
 * (whose constructor reads `process.env` once at module load).
 */
export function resolveAccountConfigsDir(opts: {
  happyHomeDir: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): { dir: string; shared: boolean } {
  const env = opts.env ?? process.env;
  const home = opts.homeDir ?? homedir();
  const sharedFlag = (env.HAPI_ACCOUNT_CONFIG_SHARED ?? "").toLowerCase();
  const shared = !(
    sharedFlag === "0" ||
    sharedFlag === "false" ||
    sharedFlag === "no" ||
    sharedFlag === "off"
  );
  if (shared) {
    const xdgConfigBase = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
    return {
      dir: join(xdgConfigBase, "hapimatic", "account-configs"),
      shared: true,
    };
  }
  return { dir: join(opts.happyHomeDir, "account-configs"), shared: false };
}

/**
 * Issue #1724: resolve the tmux remote-launcher socket/session name.
 *
 * Derives the remote name from the (already per-instance) local socket name by
 * appending `-remote`, so prod / dev / every worktree get a DISTINCT `tmux -L`
 * server rather than all sharing one global `hapimatic-remote` server. A single
 * shared remote server hosts every instance's `claude` panes in ONE OS process,
 * which is cgroup-captured by whichever instance's daemon started it (the #1724
 * cross-instance wedge); per-instance servers each live in their own cgroup.
 *
 * The default is byte-identical to the historical constant: with the default
 * local name `"hapimatic"`, this returns `"hapimatic-remote"`. An explicit
 * `HAPI_TMUX_REMOTE_SESSION_NAME` override is honored verbatim.
 *
 * The `-remote` suffix is a contract shared with `scripts/hapi-worktree.sh`
 * (whose `stop_instance` kills `hapimatic-wt-<port>-remote` to empty the daemon
 * cgroup) — keep the two in sync.
 *
 * Extracted as a pure function (mirrors {@link resolveAccountConfigsDir}) so the
 * derivation is unit-testable without re-instantiating the {@link Configuration}
 * singleton.
 */
export function resolveTmuxRemoteSessionName(opts: {
  localSessionName: string;
  envOverride?: string;
}): string {
  return opts.envOverride || `${opts.localSessionName}-remote`;
}

class Configuration {
  public readonly serverUrl: string;
  private _cliApiToken: string;
  public readonly isDaemonProcess: boolean;

  // Directories and paths (from persistence)
  public readonly happyHomeDir: string;
  public readonly logsDir: string;
  public readonly accountsDir: string;
  public readonly accountConfigsDir: string;
  /**
   * Issue #1643: true when {@link accountConfigsDir} is the machine-global
   * SHARED base (the default), false when the `HAPI_ACCOUNT_CONFIG_SHARED`
   * kill-switch reverts it to the per-instance `<HAPI_HOME>/account-configs`
   * layout. Consumers that must behave differently across the two layouts —
   * notably `legacyConfigDirMigration`, which only migrates INTO a shared dir —
   * read this flag rather than re-parsing the env var.
   */
  public readonly accountConfigsShared: boolean;
  public readonly settingsFile: string;
  public readonly privateKeyFile: string;
  public readonly daemonStateFile: string;
  public readonly daemonLockFile: string;
  public readonly currentCliVersion: string;

  /**
   * Issue #1644: cross-machine rotation-lease feature gate (HAPI_ROTATION_LEASE).
   * Default OFF for the first ship (KD-F) — flip ON after the rp1↔sl7 soak. When
   * off, the daemon's rotationLeaseClient makes ZERO HTTP calls and rotation is
   * byte-equivalent to #1635 (R6).
   */
  public readonly rotationLeaseEnabled: boolean;

  /**
   * Issue #1806: idle non-host token-refresh backstop gate (HAPI_IDLE_REFRESH).
   * Default ON — it is the fix for the idle-decay incident (an idle non-host
   * isolated account has no rotator: the scheduler defers it to native, native
   * only rotates while a live session runs). Set to a falsy value
   * ({0,false,no,off}, case-insensitive) for an instant kill-switch with NO
   * redeploy. The daemon's 60s maintenance loop calls
   * {@link TokenRefreshService.refreshIdleIsolatedAccounts} only when this is true.
   * Issue #4423: the switch gates the backstop's ROTATION only — the stale-flag
   * clear ({@link TokenRefreshService.clearStaleUnrefreshableFlags}) runs on
   * every daemon regardless; it is also how a dev daemon opts out of the
   * machine-rotator role (its permanent drop-in sets it off).
   */
  public readonly idleRefreshEnabled: boolean;

  /**
   * Issue #3541: rotate-anyway sub-path gate for the idle-refresh backstop
   * (HAPI_IDLE_ROTATE_ANYWAY). When ON, a near-expiry isolated account with a
   * LOCALLY-bound, non-inferring, heartbeating session is rotated (and its bound
   * session restarted via `restartBoundSessions`) instead of being left to decay
   * to expiry by the #1645 P-REVOKE guard — the fix for the live-but-idle
   * deadlock. Default ON (inverted parse, mirroring {@link idleRefreshEnabled}):
   * it is the fix for an active production incident (a 57-min P-REVOKE deadlock
   * that killed a work account's token). Set to a falsy value
   * ({0,false,no,off}, case-insensitive) for an instant kill-switch with NO
   * redeploy — the backstop falls back to the pre-#3541 P-REVOKE skip. Nested
   * under {@link idleRefreshEnabled}: HAPI_IDLE_REFRESH=off disables the whole
   * backstop (including this sub-path). Passed to the service as the
   * `rotateBoundAtExpiry` option; the SERVICE-level default stays `false` so an
   * unconfigured service (tests / no daemon) is byte-equivalent to pre-#3541.
   */
  public readonly idleRotateAnywayEnabled: boolean;

  /**
   * Issue #3784: cross-node chain-independence rotation kill-switch
   * (HAPI_IDLE_ROTATE_REMOTE_INDEPENDENT). When ON, the idle-refresh backstop's
   * MIXED (local AND remote) near-expiry case may rotate THIS node's own chain +
   * restart its own session once {@link TokenRefreshService} proves this node's
   * refresh-token chain is a DISTINCT grant from every remote holder's — instead
   * of the unconditional P-REVOKE skip. Default **OFF** (truthy-enable, mirroring
   * {@link omniboxSandboxEnabled} / {@link rotationLeaseEnabled}): ship gated, flip
   * ON only after the #3784 controlled cross-node validation. OFF ⇒ byte-identical
   * to the pre-#3784 skip. Forwarded into the tmux worker like the sibling flags.
   */
  public readonly idleRotateWhenRemoteIndependentEnabled: boolean;

  /**
   * Issue #1734: OmniBox sandbox kill-switch (HAPI_OMNIBOX_SANDBOX). Default
   * **OFF** (KD-5) — ship gated; flip ON only after the runbook validation. When
   * OFF, behavior is **byte-identical** to pre-#1734: no agent-env secret strip
   * ({@link buildLauncherEnv} / SDK spawn env), no egress broker started, no
   * `HTTPS_PROXY`/`NO_PROXY` injected. Truthy-enable (mirror
   * {@link rotationLeaseEnabled}), NOT inverted — an absent/unset env keeps the
   * sandbox OFF so existing sessions are unaffected until explicitly enabled.
   *
   * The switch is forwarded into the tmux-persisted worker by `buildSandboxEnv()`
   * (`daemon/tmuxSpawnAdapter.ts`) — the worker inherits the FROZEN tmux-server
   * env, not the daemon env (#1575), so the forward is required for the switch to
   * engage inside a persisted worker.
   */
  public readonly omniboxSandboxEnabled: boolean;

  /**
   * Issue #3748 (Sub H): Tier-0 capability-catalog injection kill-switch
   * (`HAPI_CAPABILITY_TIER0`). Default **ON** — the MIRROR IMAGE of
   * {@link omniboxSandboxEnabled}, which is truthy-enable / default-OFF. Here an
   * absent/unset env leaves Tier-0 injection ENABLED; only `0`/`false`/`no`
   * disables it, restoring pre-H prompts byte-for-byte from
   * `LEGACY_BASE_SYSTEM_PROMPT` (Claude) / the folded-out block (every harness).
   * Do NOT "fix" the inverted default to match the omnibox precedent — the
   * inversion is deliberate (R8).
   *
   * Forwarded into the tmux-persisted Claude worker by `buildSandboxEnv()`
   * (`daemon/tmuxSpawnAdapter.ts`) exactly as `HAPI_OMNIBOX_SANDBOX` is — the
   * worker inherits the FROZEN tmux-server env, not the daemon env (#1575).
   */
  public readonly capabilityTier0Enabled: boolean;

  // tmux session persistence configuration
  public readonly tmuxPersistenceEnabled: boolean;
  public readonly tmuxSessionName: string;
  /**
   * Session name for the tmux remote launcher (issue #1310). Distinct from
   * `tmuxSessionName` to isolate the remote-mode tmux server from the
   * existing local-mode persistence server. Without this isolation, orphan
   * scans in `claudeTmuxLauncher` / `tmuxSpawnAdapter` would touch
   * remote-launcher windows, and the reaper (deferred sibling) would touch
   * local-mode windows. Architect Q5.
   *
   * Issue #1724: derived PER-INSTANCE from `tmuxSessionName` (via
   * {@link resolveTmuxRemoteSessionName} — `${tmuxSessionName}-remote`) so prod /
   * dev / every worktree get their OWN remote tmux server instead of all sharing
   * one global `hapimatic-remote` process (the shared server caused
   * cross-instance cgroup capture). The default stays `hapimatic-remote`
   * (byte-identical), and an explicit `HAPI_TMUX_REMOTE_SESSION_NAME` still wins.
   */
  public readonly tmuxRemoteSessionName: string;

  constructor() {
    // Server configuration
    this.serverUrl = process.env.HAPI_SERVER_URL || "http://localhost:3006";
    this._cliApiToken = process.env.CLI_API_TOKEN || "";

    // Check if we're running as daemon based on process args
    const args = getCliArgs();
    this.isDaemonProcess =
      args.length >= 2 && args[0] === "daemon" && args[1] === "start-sync";

    // Directory configuration - Priority: HAPI_HOME env > default home dir
    if (process.env.HAPI_HOME) {
      // Expand ~ to home directory if present
      const expandedPath = process.env.HAPI_HOME.replace(/^~/, homedir());
      this.happyHomeDir = expandedPath;
    } else {
      this.happyHomeDir = join(homedir(), ".hapi");
    }

    this.logsDir = join(this.happyHomeDir, "logs");
    // Per-instance accounts directory (issue #1447). Inherits prod/dev/worktree
    // isolation from happyHomeDir (HAPI_HOME) for free — mirrors logsDir. The
    // dir is created lazily by AccountStore at mode 0700, not here.
    this.accountsDir = join(this.happyHomeDir, "accounts");
    // Per-account isolated config dirs (issue #1551). Each non-host bound session
    // spawns native `claude` with CLAUDE_CONFIG_DIR=<accountConfigsDir>/<uuid>, so
    // native Claude Code owns and rotates that account's OAuth token in isolation
    // (the #1546 Path A true-fix). Per-account dirs are created lazily at mode 0700
    // by seedAccountConfigDir / snapshot recovery — never here.
    //
    // Issue #1643 — DEFAULT is now a MACHINE-GLOBAL SHARED base, ONE dir per
    // account OUTSIDE every per-instance HAPI_HOME, shared by prod/dev/all
    // worktrees. This collapses the N per-instance isolated dirs (each holding a
    // copy for the SAME server-side refresh-token family — the #1635 multi-rotator
    // race) down to a single structural owner, mirroring how the host ~/.claude dir
    // already serves multiple concurrent native sessions. Location:
    // `${XDG_CONFIG_HOME:-~/.config}/hapimatic/account-configs` (XDG-respecting; the
    // server already uses ~/.config/systemd, so the convention is not net-new).
    //
    // KILL-SWITCH (R5): `HAPI_ACCOUNT_CONFIG_SHARED` ∈ {0,false,no,off}
    // (case-insensitive — falsy-parse mirrors HAPI_ACCOUNT_CONFIG_ISOLATION in
    // accountTokenInjection.ts) reverts to the exact legacy per-instance
    // `<HAPI_HOME>/account-configs` path WITHOUT disabling isolation. Because the
    // spawn worker inherits the persistent tmux server's env (not the daemon's),
    // the daemon forwards this var into the worker spawn env (#1575 pattern —
    // tmuxSpawnAdapter `buildAccountConfigIsolationEnv`).
    const acctCfg = resolveAccountConfigsDir({
      happyHomeDir: this.happyHomeDir,
    });
    this.accountConfigsShared = acctCfg.shared;
    this.accountConfigsDir = acctCfg.dir;
    this.settingsFile = join(this.happyHomeDir, "settings.json");
    this.privateKeyFile = join(this.happyHomeDir, "access.key");
    this.daemonStateFile = join(this.happyHomeDir, "daemon.state.json");
    this.daemonLockFile = join(this.happyHomeDir, "daemon.state.json.lock");

    // Issue #1644: cross-machine rotation-lease feature gate (default OFF — KD-F).
    this.rotationLeaseEnabled = ["true", "1", "yes"].includes(
      process.env.HAPI_ROTATION_LEASE?.toLowerCase() || ""
    );

    // Issue #1806: idle-refresh backstop gate (default ON — it is the fix).
    // Inverted parse vs rotationLeaseEnabled: enabled UNLESS explicitly set to a
    // falsy value, so a bare/unset env keeps the backstop running (instant
    // kill-switch via HAPI_IDLE_REFRESH={0,false,no,off}, no redeploy).
    this.idleRefreshEnabled = !["false", "0", "no", "off"].includes(
      process.env.HAPI_IDLE_REFRESH?.toLowerCase() || ""
    );

    // Issue #3541: rotate-anyway sub-path gate (default ON — it is the fix for
    // the live-but-idle P-REVOKE deadlock). Inverted parse mirroring
    // idleRefreshEnabled: enabled UNLESS explicitly set falsy, so a bare/unset
    // env keeps the fix on (instant kill-switch via
    // HAPI_IDLE_ROTATE_ANYWAY={0,false,no,off}, no redeploy).
    this.idleRotateAnywayEnabled = !["false", "0", "no", "off"].includes(
      process.env.HAPI_IDLE_ROTATE_ANYWAY?.toLowerCase() || ""
    );

    // Issue #3784: cross-node chain-independence rotation (default OFF). Ship
    // gated; flip ON only after the controlled cross-node validation. Truthy-
    // enable (mirror omniboxSandboxEnabled / rotationLeaseEnabled), NOT inverted
    // — an absent/unset env keeps it OFF (byte-identical to the pre-#3784 skip).
    this.idleRotateWhenRemoteIndependentEnabled = [
      "true",
      "1",
      "yes",
      "on",
    ].includes(
      process.env.HAPI_IDLE_ROTATE_REMOTE_INDEPENDENT?.toLowerCase() || ""
    );

    // Issue #1734: OmniBox sandbox kill-switch (default OFF — KD-5). Ship gated;
    // flip ON after the runbook validation. Truthy-enable (mirror
    // rotationLeaseEnabled), NOT inverted — an absent/unset env keeps the sandbox
    // OFF so existing sessions are byte-identical to pre-#1734 until enabled.
    this.omniboxSandboxEnabled = ["true", "1", "yes"].includes(
      process.env.HAPI_OMNIBOX_SANDBOX?.toLowerCase() || ""
    );

    // Issue #3748 (Sub H): Tier-0 injection kill-switch (default ON). INVERTED
    // vs the omnibox precedent above — an absent/unset env keeps Tier-0 ENABLED;
    // only `0`/`false`/`no` disables it (R8 byte-for-byte restore). Do NOT
    // "normalize" this to truthy-enable.
    this.capabilityTier0Enabled = !["false", "0", "no"].includes(
      process.env.HAPI_CAPABILITY_TIER0?.toLowerCase() || ""
    );

    // tmux session persistence - enabled via environment variable
    this.tmuxPersistenceEnabled = ["true", "1", "yes"].includes(
      process.env.HAPI_TMUX_PERSISTENCE?.toLowerCase() || ""
    );
    this.tmuxSessionName = process.env.HAPI_TMUX_SESSION_NAME || "hapimatic";
    this.tmuxRemoteSessionName = resolveTmuxRemoteSessionName({
      localSessionName: this.tmuxSessionName,
      envOverride: process.env.HAPI_TMUX_REMOTE_SESSION_NAME,
    });

    this.currentCliVersion = packageJson.version;

    if (!existsSync(this.happyHomeDir)) {
      mkdirSync(this.happyHomeDir, { recursive: true });
    }
    // Ensure directories exist
    if (!existsSync(this.logsDir)) {
      mkdirSync(this.logsDir, { recursive: true });
    }
  }

  get cliApiToken(): string {
    return this._cliApiToken;
  }

  _setCliApiToken(token: string): void {
    this._cliApiToken = token;
  }
}

export const configuration: Configuration = new Configuration();
