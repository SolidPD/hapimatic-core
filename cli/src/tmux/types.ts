// SPDX-License-Identifier: AGPL-3.0-only
/**
 * tmux Integration Types
 *
 * Types for managing Claude sessions via tmux windows
 */

import type { OwnedWindowTarget } from "./windowOwnership";

/**
 * The daemon's default tmux session and socket name (`HAPI_TMUX_SESSION_NAME`
 * unset). Lives in this dependency-free module so a pure reader (the capacity
 * module) can share it without importing the `configuration` singleton
 * (#5202 U30).
 */
export const DEFAULT_TMUX_SESSION_NAME = "hapimatic";

export interface TmuxWindow {
  /** Window index within the session */
  index: number;

  /** Window name (e.g., "hapi-abc123") */
  name: string;

  /** Whether this is the currently active window */
  active: boolean;

  /** Number of panes in the window */
  paneCount: number;

  /** Whether the pane is dead (process exited, window remains due to remain-on-exit) */
  paneDead?: boolean;

  /** PID of the process running in the pane */
  panePid?: number;

  /**
   * Issue #2683: value of the `@hapi_archive` window user-option, `true` when the
   * window is a deliberate archive-for-reconnect (must NOT be reaped as an orphan).
   * A death-orphan window is untagged. Populated by `listWindows()`.
   */
  archiveTag?: boolean;

  /**
   * Issue #2683: the pane's ORIGINAL launch command (`#{pane_start_command}`),
   * which survives `exec bash`. A daemon-spawned session pane carries the
   * `hapi-spawn-<id>.sh` signature; the `ensureSession` placeholder window does
   * not. Used by the orphan reconciliation reaper to positively identify a
   * leaked SESSION window (never the placeholder/control window).
   */
  paneStartCommand?: string;

  /**
   * Issue #3734: the tmux `#{window_id}` (`@N`). Populated ONLY by
   * {@link TmuxManager.listWindowIdentities} — the dedicated space-separated
   * identity query — NEVER by `listWindows()` (whose 8-column `\x1f`-delimited
   * `-F` row deliberately omits it, so #1841's parser and #2245's field-7
   * `archiveTag` contract stay untouched). Undefined on any `listWindows()` row.
   */
  id?: string;

  /**
   * Issue #3732: value of the `@hapi_identity` window user-option — the session
   * TAG a window was spawned for. Populated ONLY by
   * {@link TmuxManager.listWindowIdentities}. This is the 1:N key: several
   * windows can carry the same identity (leaked duplicates), and the delete /
   * reconnect / reaper dedupe paths resolve them by exact-TAG equality.
   * Undefined (never set) or empty ("" → parsed to undefined) when the window
   * has no identity (e.g. the `control`/placeholder window).
   */
  identity?: string;
}

export interface TmuxSession {
  /** Session name (e.g., "hapimatic") */
  name: string;

  /** Whether the session is attached */
  attached: boolean;

  /** List of windows in the session */
  windows: TmuxWindow[];
}

/**
 * Result row from TmuxManager.findOrphanedSessions(). One per matching
 * window that should be reaped — i.e. its name matches the configured
 * remote-launcher prefix AND the daemon recorded in daemon.state.json
 * is dead (PID returns ESRCH from process.kill(pid, 0)).
 *
 * See issue #1428 (orphan tmux session reaper).
 */
export interface OrphanedSession {
  /** Window name (e.g. "hapi-remote-abc123"). */
  windowName: string;

  /** Window index within the remote tmux session. */
  windowIndex: number;

  /** Whether the window's pane is also dead (extra signal; informational). */
  paneDead: boolean;

  /** Daemon PID that owned this session (recorded at orphan-detection time). */
  deadDaemonPid: number;
}

export interface TmuxManagerOptions {
  /** tmux session name to use */
  sessionName: string;

  /** tmux -L socket name for per-instance server isolation */
  socketName?: string;

  /**
   * Issue #4153 (A1): an ABSOLUTE socket path, passed as `tmux -S <path>`. Takes
   * precedence over `socketName`. For `hapi doctor`'s read-only probe of the
   * daemon's RECORDED socket: a socket name resolves to a directory from the
   * caller's own uid and `TMUX_TMPDIR`. The window, ownership and containment
   * helpers key on `socketName` and treat a path-only manager as having none.
   */
  socketPath?: string;

  /** Working directory for new windows */
  defaultCwd?: string;

  /** Environment variables to pass to new windows */
  env?: Record<string, string>;
}

export interface CreateWindowOptions {
  /** Window name (must be unique within session) */
  name: string;

  /** Working directory for the window */
  cwd: string;

  /** Command to run in the window (optional, defaults to shell) */
  command?: string;

  /** Arguments for the command */
  args?: string[];
}

/**
 * Result of createWindow(), surfacing the captured window index.
 *
 * The index is captured race-free from `new-window -P -F #{window_index}` (#945).
 * Surfacing it lets callers use index-based targeting in subsequent lookups,
 * bypassing `list-windows -F` which returns stale data on tmux 3.4+ (#1315).
 */
export interface CreateWindowResult {
  /** Whether the window was created successfully */
  created: boolean;

  /** Window index captured from new-window -P -F (null on failure or unparseable output) */
  index: number | null;

  /**
   * Issue #3734: the session-unique tmux window id (`@N`, e.g. `@7`) captured
   * race-free alongside the index from `new-window -P -F '#{window_index}
   * #{window_id}'`. Unlike the NAME (derived from the linked-issue title, which
   * two same-issue sessions share) the `@N` id is unambiguous within ONE tmux
   * server — but a new server numbers from `@0` again, so a persisted id can
   * name another session's window after a server restart (#4218). It is the
   * ADDRESS persisted as `PersistedSession.tmuxWindowId`; ownership is
   * `@hapi_identity` (windowOwnership.ts). Null on parse failure or a pre-#3734
   * build; callers fall back to the identity query, then the name.
   */
  id: string | null;
}

export interface SendKeysOptions {
  /**
   * Window name or index to target — an `OwnedWindowTarget` minted by a
   * windowOwnership.ts producer (#4218). An argument bag, never stored.
   */
  target: OwnedWindowTarget;

  /** Keys to send (can include special keys like Enter) */
  keys: string;

  /** Whether to add Enter at the end */
  enter?: boolean;

  /**
   * Send keys literally via tmux's `-l` flag (raw characters, no key-name
   * interpretation). When true, the body is delivered exactly as written — a
   * single-token message that happens to match a tmux key name (e.g. "Up",
   * "Enter", "Tab") is sent as literal text rather than that key (#1599).
   *
   * 🔴 Do NOT combine `literal: true` with `enter: true`: under `-l` the
   * appended `Enter` argument is itself sent as the 5 literal characters
   * "Enter", not the Enter keypress. Submit flows that need a real Enter must
   * send it as a SEPARATE `sendKeys({ keys: "Enter" })` call (no `literal`).
   */
  literal?: boolean;
}

export const TMUX_WINDOW_PREFIX = "hapi-";

/**
 * Session/window naming for the tmux remote launcher (issue #1310).
 *
 * The remote launcher uses a SEPARATE tmux session name + window prefix
 * from the local-mode persistence launcher above. This isolation prevents
 * the local launcher's orphan-window scans from touching remote-launcher
 * windows, and prevents the deferred reaper (sibling sub-issue) from
 * touching local-mode persistence windows. Architect Q5.
 *
 * The session name can be overridden at runtime via the
 * `HAPI_TMUX_REMOTE_SESSION_NAME` env var (handled in `configuration.ts`).
 * The window prefix is load-bearing for the reaper's name-prefix match.
 */
export const TMUX_REMOTE_SESSION_NAME = "hapimatic-remote";
export const TMUX_REMOTE_WINDOW_PREFIX = "hapi-remote-";

/**
 * tmux USER OPTION carrying a window's human-meaningful identity (issue #1652).
 *
 * Surfaced to an attached operator via the remote session's pane-border /
 * window-status display formats (`#{@hapi_identity}`) WITHOUT touching the
 * window NAME — names are reap-load-bearing (`buildRemoteWindowCandidateNames`
 * exact-name kills, #1628; orphan-scan prefix matching). A user option is used
 * (not `pane_title`) because Claude Code's Ink TUI emits OSC 0/2 terminal-title
 * sequences that tmux writes into `pane_title`, and the `allow-set-title`
 * off-switch only exists in tmux ≥3.5 while the fleet runs 3.3a/3.4 — user
 * options are immune to those clobbering writes.
 */
export const TMUX_IDENTITY_USER_OPTION = "@hapi_identity";

/**
 * Issue #2683: window-scoped tmux user-option marking a deliberate
 * archive-for-reconnect window. Set (to `"1"`) by the daemon's `set-archive-tag`
 * RPC when the server archives a LIVE session for later reconnect; read back via
 * `list-windows -F '#{@hapi_archive}'` by the orphan reconciliation reaper so a
 * tagged window is preserved while an untagged death-orphan is reaped. A
 * window-scoped user-option (not a window-name suffix) is used deliberately: it
 * avoids the reconnect-by-name lookup and bi-directional rename-sync hazards and
 * is `tmux`-visible for operator triage (`show-options -w`).
 */
export const TMUX_ARCHIVE_USER_OPTION = "@hapi_archive";
