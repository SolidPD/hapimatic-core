// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- Grandfathered god-file (Epic 0, #2077); decomposition verdict tracked in claudedocs/architecture-hotspot-review.md. */
/**
 * tmux Spawn Adapter for Daemon
 *
 * Spawns Claude sessions in tmux windows (via TmuxManager) within the daemon's
 * spawnSession flow, instead of as direct child processes.
 */

import fs from "fs/promises";
import { accessSync, realpathSync } from "fs";
import os from "os";
import { join, resolve as resolvePath, sep, dirname } from "path";

import { configuration } from "@/configuration";
import { TmuxManager } from "@/tmux";
import {
  TMUX_REMOTE_WINDOW_PREFIX,
  TMUX_ARCHIVE_USER_OPTION,
} from "@/tmux/types";
import type { TmuxWindow } from "@/tmux/types";
import {
  describeOwnershipFailure,
  reaperWindowTarget,
  remoteLauncherWindowTarget,
  resolveOwnedWindow,
  spawnedWindowTarget,
} from "@/tmux/windowOwnership";
import type {
  OwnedWindowTarget,
  OwnershipResult,
} from "@/tmux/windowOwnership";
import { createSessionStore } from "@/sessionPersistence";
import type { PersistedSession } from "@/sessionPersistence";
import { generateSessionId, generateShortId } from "@/utils/id";
import { shellEscape } from "@/utils/shellEscape";
import { logger } from "@/ui/logger";
import { killProcessTree } from "@/utils/processTree";
import { getProjectPath } from "@/claude/utils/path";
import { buildSystemPrompt } from "@/claude/utils/systemPrompt";
import { getDefaultClaudeCodePath } from "@/claude/sdk/utils";
import { MAX_RETRY_BUDGET } from "@/claude/claudeTmuxRemoteLauncher";
import { buildTmuxEnvFileCommand } from "@/claude/launcherShared";
import { getActiveEgressBrokerPort } from "@/sandbox/egressBroker";
import { buildCodexCommand } from "@/extensions/agent-codex/codex/codexTmuxLauncher";
import {
  resolveHarnessManifest,
  resolveHostJailAxis,
  type AgentFlavor,
} from "@hapi/protocol";

// K1 (#4218): `windowOwnedBy` is DEFINED in windowOwnership.ts (one definition)
// and re-exported here so #4038 / #4080 keep the pinned import path.
export { windowOwnedBy } from "@/tmux/windowOwnership";

export interface TmuxSpawnOptions {
  /** Working directory for the session */
  directory: string;

  /**
   * Agent type. #1082 widened tmux persistence to Codex (Tier 2). The union
   * also admits gemini/opencode so the R7 runtime guard in spawnSessionInTmux
   * can reject them with a STRUCTURED error rather than a throw — the daemon's
   * gate at sessionSpawner.ts:742 already routes non-claude/codex to the
   * direct-spawn path, so this is defense-in-depth.
   */
  agent?: "claude" | "codex" | "gemini" | "opencode";

  /** Enable YOLO mode */
  yolo?: boolean;

  /** Issue #1633: launch the claude child with --safe-mode (scaffolding disabled) */
  safeMode?: boolean;

  /** Issue #1633: explicit model mode ("sonnet" | "opus" | "fable") — threaded
   *  as --hapi-model-mode so a model-switch respawn preserves the selection */
  modelMode?: string;

  /** Issue #2456: reasoning-effort level — threaded as --hapi-effort so a
   *  model/effort-switch respawn preserves the selection. */
  effort?: string;

  /** Issue #2456: a specific pinned raw Claude model id ("More models") —
   *  threaded as --hapi-raw-model; takes precedence over modelMode. */
  rawModel?: string;

  /** Issue #2155: role-scoped `@`-include profile — threaded as
   *  --hapi-session-role so runClaude merges the role's claudeMdExcludes into
   *  the hook-settings file, AND injected as HAPI_SESSION_ROLE for in-session
   *  telemetry. Typed as string (mirrors modelMode) — validated upstream by
   *  SessionRoleSchema. */
  sessionRole?: string;

  /** Issue #2626 (D): per-session output style name ("default" | "Explanatory"
   *  | "Learning" or a custom style) — threaded as --hapi-output-style so
   *  runClaude injects it into the generated --settings file (the choke point
   *  every launcher delivers) and a model/account-switch respawn preserves it. */
  outputStyle?: string;

  /** OAuth token for authentication */
  token?: string;

  /** Issue #1082: OpenRouter gateway model id ("provider/model", #1733) for a
   *  codex session — threaded into buildCodexCommand as --hapi-model. Undefined
   *  for claude (which uses modelMode). */
  model?: string;

  /** Issue #1082 (ruling D4): durable session-scoped CODEX_HOME for a codex
   *  tmux session — set as the CODEX_HOME env var AND persisted on the
   *  PersistedSession so cleanup/GC can find it. Undefined for claude. */
  codexHome?: string;

  /**
   * Session ID to resume. For claude → threaded as `--resume`. For codex → the
   * codex session id, threaded as CODEX_TMUX_RESUME_FLAG (remote mode ignores
   * `--resume`, resume happens via findCodexResumeFile; #1082 finding 1082-1).
   */
  resumeSessionId?: string;

  /** HAPI session ID to reuse (for reconnecting within the same session instance) */
  hapiSessionId?: string;

  /** Additional environment variables to pass to the spawned process (e.g., worktree vars) */
  extraEnv?: Record<string, string>;
  /** Session display name — used as tmux window name instead of random ID */
  name?: string;
  /** Fork the Claude session (create new session ID with full conversation history) */
  forkSession?: boolean;

  /**
   * Issue #1661: when reusing an EXISTING tmux window (reconnect / switch /
   * token-refresh / model-restart), whether `respawn-pane -k` may kill whatever
   * occupies the pane. Default `true` preserves the #1555 always-respawn
   * behavior for switch/refresh/restart (they intentionally replace a live
   * process). reconnectSession passes `false` ONLY when the daemon-authoritative
   * liveness RPC was uncertain (null) — in that case the adapter consults
   * `isWrapperAlive` for a fresh daemon-local re-check before killing.
   */
  killLivePane?: boolean;

  /**
   * Issue #1661: daemon-local liveness checker injected by run.ts (it closes
   * over the live `pidToTrackedSession` map, which this module cannot reach
   * directly). Consulted ONLY when `killLivePane === false`. Returns true iff
   * the window's wrapper is tracked AND its pane is not dead → the adapter
   * re-attaches (skips respawn). On false / absent the adapter respawns
   * (Fallback Preservation Rule).
   */
  isWrapperAlive?: (windowName: string) => Promise<boolean>;
}

export interface TmuxSpawnResult {
  type: "success" | "error";
  sessionId?: string;
  hapiSessionId?: string;
  tmuxWindow?: string;
  /**
   * Window index captured race-free from `new-window -P -F` (#945).
   * Surfaced so `run.ts`'s post-spawn PID lookup can use index-based targeting
   * (`getWindowPidByIndex`) instead of `getTmuxSessionPid` (which goes through
   * the broken-on-tmux-3.4 `list-windows -F` path). See issue #1315.
   * Null on reconnect (reused-existing-window) or on parse failure.
   */
  tmuxWindowIndex?: number | null;
  /**
   * Issue #3734: the session-unique tmux window id (`@N`) captured race-free at
   * create (or resolved for a reused window on reconnect). The collision-safe
   * 1:1 lifecycle key persisted as `PersistedSession.tmuxWindowId` /
   * `TrackedSession.tmuxWindowId`. Null when the id could not be captured/resolved
   * (parse fault, or a legacy reused window with neither an id nor an identity
   * row) — consumers then fall back to the identity query, then the name.
   */
  tmuxWindowId?: string | null;
  /**
   * Issue #1661: set true when a reconnect into a reused window found the
   * wrapper genuinely alive and SKIPPED the respawn (re-attach). Signals run.ts
   * to short-circuit success BEFORE the child-detect/webhook flow — a re-attach
   * spawns no fresh process and emits no webhook, so the 60s webhook timeout
   * (which calls stopTmuxSession) must not run against the live session.
   */
  reattached?: boolean;
  errorMessage?: string;
}

/**
 * Resolve a unique tmux window name by appending an incremental suffix
 * if the desired name is already taken. Follows OS-style deduplication:
 * "test" → "test 1" → "test 2" (finds lowest available number).
 *
 * Fetches the window list ONCE and checks against a Set — avoids the
 * repeated tmux subprocess calls that windowExists() would incur in a loop.
 *
 * `reserved` (#4443) holds names that in-flight spawns have claimed but not
 * yet created; they count as taken. The listing is strict: a tmux fault is
 * retried within the same 5 attempts and rethrown after the last, never read
 * as "no windows" (a fault read as empty would hand out a name a live window
 * holds).
 */
export async function resolveUniqueWindowName(
  tmux: TmuxManager,
  baseName: string,
  reserved: ReadonlySet<string> = new Set()
): Promise<string> {
  return dedupWindowName(tmux, baseName, reserved, null);
}

/**
 * The dedup loop. When `claim` is given, the picked name is added to it in the
 * same synchronous segment as the pick (#4443): an `await` between the two
 * would let a concurrent caller pick the same name.
 */
async function dedupWindowName(
  tmux: TmuxManager,
  baseName: string,
  reserved: ReadonlySet<string>,
  claim: Set<string> | null
): Promise<string> {
  // Retry to handle tmux versions (e.g. 3.4) where list-windows may not
  // immediately reflect a just-created window. 100ms × 5 covers the
  // observed race on GitHub Actions CI where 50ms × 3 was insufficient.
  // (#945, #959)
  let listedNames: Set<string> | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const windows = await tmux.listWindows(true);
      listedNames = new Set(windows.map(w => w.name));
    } catch (error) {
      if (attempt === 4) throw error;
      logger.warn(
        `[TmuxSpawnAdapter] Window listing failed during name dedup (attempt ${attempt + 1}/5): ${error}`
      );
    }
    // Only a successful listing may end the loop: after a fault `listedNames`
    // is null, and a pick from `reserved` alone ignores live windows.
    if (
      listedNames !== null &&
      (listedNames.has(baseName) || reserved.has(baseName))
    )
      break;
    if (attempt < 4) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  const name = pickUniqueWindowName(
    baseName,
    new Set([...(listedNames ?? []), ...reserved])
  );
  claim?.add(name);
  return name;
}

/** Lowest free OS-style name ("x", "x 1", "x 2", …) against `taken`. */
function pickUniqueWindowName(baseName: string, taken: Set<string>): string {
  if (!taken.has(baseName)) {
    return baseName;
  }

  let suffix = 1;
  while (taken.has(`${baseName} ${suffix}`)) {
    suffix++;
  }

  const resolvedName = `${baseName} ${suffix}`;
  logger.info(
    `[TmuxSpawnAdapter] Window name "${baseName}" already exists, using "${resolvedName}"`
  );
  return resolvedName;
}

/**
 * #4443: names claimed by in-flight named spawns, keyed by tmux socket +
 * session. A claim lives from dedup until the spawn returns — for a created
 * window that is after the post-create pane check, at least ~1.5 s after
 * `new-window` — so two concurrent spawns of the same base name in one daemon
 * never pick the same name. (Visibility to `list-windows` after release is
 * assumed from that delay, not checked; on tmux 3.4 a lagging listing can
 * still yield a duplicate NAME, never a kill.)
 */
const reservedWindowNames = new Map<string, Set<string>>();

export interface WindowNameReservation {
  name: string;
  /** Drop the claim. Idempotent. */
  release(): void;
}

/**
 * Resolve a unique window name AND claim it for this process (#4443).
 *
 * The free name is picked and added to the reservation set with no `await`
 * in between, so in single-threaded JS no concurrent caller can pick the same
 * name. The caller must `release()` once its window exists or its spawn has
 * failed.
 */
export async function reserveUniqueWindowName(
  tmux: TmuxManager,
  baseName: string
): Promise<WindowNameReservation> {
  const key = `${tmux.socket ?? ""}\0${tmux.session}`;
  const reserved = reservedWindowNames.get(key) ?? new Set<string>();
  reservedWindowNames.set(key, reserved);

  // The pick reads `reserved` after the last listing await and claims the
  // name before yielding, so it sees every claim made while it was listing.
  const name = await dedupWindowName(tmux, baseName, reserved, reserved);

  let released = false;
  return {
    name,
    release(): void {
      if (released) return;
      released = true;
      // The set itself is never dropped from the map: a concurrent reserve
      // may hold it across its listing await and must claim into the live set.
      reserved.delete(name);
    },
  };
}

/**
 * Issue #1575: forward the account-config-isolation kill-switch from the
 * daemon's env into the tmux-persisted worker's spawn env.
 *
 * Under tmux persistence the worker inherits the persistent `tmux -L hapimatic-*`
 * server's env (which survives daemon restarts via KillMode=process and predates
 * any systemd drop-in), NOT the daemon's env. So a
 * `Environment=HAPI_ACCOUNT_CONFIG_ISOLATION=0` drop-in reaches the daemon MainPID
 * but never the worker, where the gate (accountTokenInjection.ts
 * `resolveAccountConfigDirForSession`) reads it. Forwarding it explicitly here —
 * the same channel as HAPI_HOME / HAPI_ACCOUNT_UUID — makes the documented
 * activation method (daemon Environment= + daemon restart) actually engage the
 * env-token path.
 *
 * Issue #1643: ALSO forwards the SHARED-dir kill-switch
 * `HAPI_ACCOUNT_CONFIG_SHARED` on the SAME channel and for the SAME reason —
 * `configuration.accountConfigsDir` is computed once at the worker process's
 * construction, and the worker inherits the persistent tmux server's env (not
 * the daemon's), so a daemon `Environment=HAPI_ACCOUNT_CONFIG_SHARED=0` reaches
 * the worker (where `configuration` reads it) ONLY via this forward. Without it,
 * the shared-dir kill-switch would silently fail to engage under tmux persistence
 * exactly as the isolation kill-switch did pre-#1575.
 *
 * Each var is forwarded ONLY when present, so the default behavior is
 * byte-identical when neither kill-switch is configured. Values are forwarded
 * verbatim — `configuration` / the resolver own the falsy parse (0/false/no/off).
 */
export function buildAccountConfigIsolationEnv(
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const out: Record<string, string> = {};
  const isolation = env.HAPI_ACCOUNT_CONFIG_ISOLATION;
  if (isolation !== undefined) out.HAPI_ACCOUNT_CONFIG_ISOLATION = isolation;
  const shared = env.HAPI_ACCOUNT_CONFIG_SHARED;
  if (shared !== undefined) out.HAPI_ACCOUNT_CONFIG_SHARED = shared;
  return out;
}

/**
 * Issue #3632: convert the OWNING SERVER's message-hook stage snapshot (threaded
 * to the daemon in the spawn RPC) into the child-env marker the rp1-home mint
 * fallback reads. This is a PURE builder (mirrors {@link buildAccountConfigIsolationEnv})
 * applied UNCONDITIONALLY at each spawn-env site — the fail-closed OMIT semantics
 * live HERE, not at the call site:
 *
 * - `undefined` → `{}` (OMIT): the server did not stamp a value (daemon-local
 *   `POST /spawn-session`, or a rolling-deploy window where an old server talks
 *   to a new daemon). The marker is absent from the child env → the rp1-home
 *   client (`user-approval-mint-fallback.py`) DEFERS. NEVER default to `"0"`.
 * - `true`  → `{ HAPI_MESSAGE_HOOKS: "1" }` (server stage ON).
 * - `false` → `{ HAPI_MESSAGE_HOOKS: "0" }` (server stage OFF — written EXPLICITLY,
 *   because the client accepts ONLY the literal `"0"` as OFF; a line-absent OFF
 *   reads as ambiguous → DEFER, so the fallback would never unlock).
 *
 * Emitted as the literal `"1"`/`"0"` ONLY — never `true`/`false`/`on`/`off`.
 */
export function buildMessageHooksEnv(
  enabled: boolean | undefined
): Record<string, string> {
  if (enabled === undefined) return {};
  return { HAPI_MESSAGE_HOOKS: enabled ? "1" : "0" };
}

/**
 * Issue #1734 (OmniBox Phase 0b): forward the sandbox kill-switch into the
 * tmux-persisted worker AND, when the sandbox is on with a live broker, inject
 * the loopback egress-proxy vars.
 *
 * - `HAPI_OMNIBOX_SANDBOX` is forwarded for the SAME reason
 *   {@link buildAccountConfigIsolationEnv} forwards its kill-switches (#1575):
 *   `configuration.omniboxSandboxEnabled` is read once at the worker process's
 *   construction, and the worker inherits the FROZEN tmux-server env (not the
 *   daemon's), so a daemon `Environment=HAPI_OMNIBOX_SANDBOX=1` reaches the
 *   worker — where `buildLauncherEnv` / the sdk strip read it — ONLY via this
 *   forward.
 * - `HTTP(S)_PROXY` point the agent's outbound traffic at the daemon-owned
 *   loopback broker. `NO_PROXY` exempts loopback so the `hapi` MCP server +
 *   wrapper↔server channel bypass the broker (R5, no false-block). These three
 *   are in none of the launcher strip sets, so they pass through to the claude
 *   child on all three launchers.
 *
 * Gated: with the sandbox OFF — or the broker failed to start (`brokerPort` null,
 * fail-open per OR-3) — only the (absent) kill-switch forward applies, so the
 * spawn env is byte-identical to pre-#1734 (R6).
 */
export function buildSandboxEnv(
  env: NodeJS.ProcessEnv = process.env,
  brokerPort: number | null = getActiveEgressBrokerPort()
): Record<string, string> {
  const out: Record<string, string> = {};
  const sandbox = env.HAPI_OMNIBOX_SANDBOX;
  if (sandbox !== undefined) out.HAPI_OMNIBOX_SANDBOX = sandbox;
  // #3748 (Sub H, R8): forward the Tier-0 kill-switch the SAME way. The
  // tmux-persisted Claude worker calls buildSystemPrompt in its OWN process and
  // inherits the FROZEN tmux-server env, not the daemon's, so a daemon
  // `Environment=HAPI_CAPABILITY_TIER0=0` reaches the worker only via this forward.
  const capabilityTier0 = env.HAPI_CAPABILITY_TIER0;
  if (capabilityTier0 !== undefined)
    out.HAPI_CAPABILITY_TIER0 = capabilityTier0;
  if (configuration.omniboxSandboxEnabled && brokerPort) {
    const proxyUrl = `http://127.0.0.1:${brokerPort}`;
    out.HTTP_PROXY = proxyUrl;
    out.HTTPS_PROXY = proxyUrl;
    out.NO_PROXY = "127.0.0.1,localhost,::1";
  }
  return out;
}

/**
 * Issue #3179 (K7): stable deployed-fix marker. #3184 greps the deployed
 * sl7 binary and the daemon log for it — do NOT reword.
 */
export const OMNIBOX_CWD_MASK_WARNING =
  "[OMNIBOX] cwd covers the $HOME mask — cwd bind skipped, session cwd is an ephemeral tmpfs (#3179)";

/**
 * Issue #3179: true when binding `cwd` AFTER `--tmpfs $HOME` would re-expose
 * the at-rest credential file, i.e. `cwd` is an ancestor-or-equal of
 * `<home>/.config/hapimatic/env` ($HOME, `/home`, `/`, `~/.config`,
 * `~/.config/hapimatic`). Lexical only (normalises `/home/x/`, `.`, `..`);
 * symlinks are resolved by `resolveCwdCoversHomeMask` at the call site.
 */
export function cwdCoversHomeMask(cwd: string, homeDir: string): boolean {
  const credential = join(resolvePath(homeDir), ".config", "hapimatic", "env");
  const c = resolvePath(cwd);
  return (
    credential === c ||
    credential.startsWith(c.endsWith(sep) ? c : `${c}${sep}`)
  );
}

/** Call-site variant: realpath BOTH sides (symlinked cwd or $HOME). */
export async function resolveCwdCoversHomeMask(
  cwd: string,
  homeDir: string
): Promise<boolean> {
  const real = (p: string): Promise<string> =>
    fs.realpath(p).catch(() => resolvePath(p));
  const [realCwd, realHome] = await Promise.all([real(cwd), real(homeDir)]);
  return (
    cwdCoversHomeMask(cwd, homeDir) || cwdCoversHomeMask(realCwd, realHome)
  );
}

/**
 * Issue #2646 (OmniBox Phase-1): wrap the inner agent-launch command in a
 * bubblewrap (`bwrap`) filesystem + PID-namespace jail, closing the two at-rest
 * credential read paths ADR-0004 ratified against:
 *   - Path 1 (R1): a `--tmpfs $HOME` mask hides `~/.config/hapimatic/env` (the
 *     daemon's at-rest credential file), re-exposing ONLY the session's
 *     legitimate `$HOME` paths (cwd, HAPI_HOME, account-configs, `~/.claude`,
 *     git identity). The credential `env` file is a SIBLING of `account-configs/`,
 *     so re-exposing the config dirs never re-exposes it.
 *   - Path 2 (R2): `--unshare-pid --proc /proc` gives the agent a fresh PID
 *     namespace + fresh `/proc`, so the daemon's `/proc/<pid>/environ` is
 *     unreachable from inside the jail.
 *
 * 🔴 R8 (liveness invariant — load-bearing): this wraps ONLY the inner
 * `spawnCommand` (the `hapi claude` launch). The CALLER keeps the env-file
 * `cd`/source/`rm -f` prelude AND the trailing `; exec bash` (`initialProcessCmd`)
 * OUTSIDE the jail. That placement preserves the `hasActiveChildren(panePid)`
 * host-tree signal that `decideWrapperAlive`, `computeEffectiveCount`, and the
 * #2683 `reconcileOrphanWindows` / `reapDeadPaneWindow` reapers all key off:
 * while the jailed agent runs, `bwrap` is a live host-side child of the pane
 * shell (children present → alive); when the agent exits, `bwrap` exits (its
 * `--unshare-pid` child is PID 1 in the ns), the pane shell runs `; exec bash`
 * and becomes CHILDLESS → respawn + orphan-reap fire correctly. An OUTER wrap
 * (enclosing `; exec bash`) would keep `bwrap` alive forever after the agent
 * exits — the #1661/#1682 zombie-session regression class. See the "#2646
 * CONTRACT" block on `reconcileOrphanWindows`.
 *
 * Fresh-`/tmp` note: the 0600 env file + the tmpScript both live in `os.tmpdir()`
 * and are sourced + `rm -f`'d host-side BEFORE `bwrap` starts, so the jail's
 * fresh-tmpfs `/tmp` never has to contain them (Task 2).
 *
 * Credential DELIVERY is unaffected: the env file is sourced into the pane shell
 * (outside the jail) and `bwrap` inherits that env (no `--clearenv`), so the
 * jailed agent still receives `CLI_API_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN` via
 * env. The jail closes only the AT-REST file/proc read paths — orthogonal to the
 * in-env delivery channel.
 *
 * Pure + exported for unit testing (mirrors `buildSandboxEnv` /
 * `buildTmuxSpawnEnv`). `innerCommand` MUST already be shell-escaped by the
 * caller; every path here is escaped via `escapeShellArg`.
 */
export function buildBwrapJailCommand(
  innerCommand: string,
  opts: {
    cwd: string;
    homeDir: string;
    hapiHome: string;
    accountConfigsDir: string;
    claudePath?: string;
    execPath: string;
    // Issue #3179: precomputed at the call site (realpaths both sides). When
    // omitted, the builder recomputes lexically via `cwdCoversHomeMask`.
    cwdCoversMask?: boolean;
    // Issue #3813 — per-flavor host-jail re-exposes (all narrow, never widen):
    //  - `reexposeHomeDirs`: home-relative dirs RW-bound over the $HOME mask, IN
    //    ADDITION to the always-bound `~/.claude` (codex → `[".codex"]`). Deduped
    //    against `.claude` so claude's declared `[".claude"]` is a no-op.
    //  - `codexHome`: the session's OWN CODEX_HOME to RW-bind (K-CODEX-HOME forward
    //    contract for #3808's per-account dir); bind ONLY this dir, never a broader
    //    tree.
    //  - `harnessBinPrefix`: an install prefix (nvm node version dir) RO-bound so a
    //    non-self-contained flavor binary (codex + its `node`) resolves in the jail.
    reexposeHomeDirs?: readonly string[];
    codexHome?: string;
    harnessBinPrefix?: string;
  }
): string {
  const q = escapeShellArg;
  const roBind = (p: string) => `--ro-bind-try ${q(p)} ${q(p)}`;
  const rwBind = (p: string) => `--bind-try ${q(p)} ${q(p)}`;
  const args = [
    // Read-only OS. `--ro-bind /usr` is required; the rest are `-try` so a
    // usrmerge layout (Ubuntu 24 / Debian 12: /bin,/lib → /usr/*) or a missing
    // /lib64 (arm64) never hard-fails the jail.
    `--ro-bind ${q("/usr")} ${q("/usr")}`,
    roBind("/etc"),
    roBind("/bin"),
    roBind("/sbin"),
    roBind("/lib"),
    roBind("/lib64"),
    roBind("/opt"),
    // Fresh /dev + fresh /proc (R2) + fresh /tmp (delivery files already
    // consumed host-side, so the jail never needs them).
    "--dev /dev",
    "--proc /proc",
    "--tmpfs /tmp",
    // R1: mask $HOME (hides ~/.config/hapimatic/env), then re-expose the
    // session's legitimate $HOME paths. Order matters — the tmpfs mask must
    // precede the re-expose binds so the later binds win.
    `--tmpfs ${q(opts.homeDir)}`,
    // Session worktree/cwd — RW (the agent edits code). Issue #3179: when the
    // cwd covers the $HOME mask ($HOME in any spelling, an ancestor of it,
    // ~/.config, ~/.config/hapimatic) the bind would re-mount the real dir over
    // the tmpfs mask above and re-expose ~/.config/hapimatic/env (V8 /
    // ADR-0004) — so skip it; the session then runs on the ephemeral tmpfs.
    ...(opts.cwdCoversMask || cwdCoversHomeMask(opts.cwd, opts.homeDir)
      ? []
      : [rwBind(opts.cwd)]),
    // HAPI_HOME state dir — RW (worker logs/state; also covers a per-instance
    // <HAPI_HOME>/account-configs/<uuid> when the shared-dir kill-switch is set).
    rwBind(opts.hapiHome),
    // Default ~/.claude — RW. Holds Claude Code's own config/projects AND (on
    // rp1-home) the absolute-path hooks/skills every in-session hook invokes, so
    // masking it would break hook execution. Re-exposes the host-default
    // credential set (the fallback identity, per R1). #3813: `~/.claude` is ALWAYS
    // bound (every tmux-path session — claude AND codex — runs hooks); the flavor's
    // `reexposeHomeDirs` ADD its own home(s) (codex → `~/.codex`). Deduped via a Set
    // so claude's declared `[".claude"]` is a no-op — the claude argv stays
    // byte-identical (the #3179/Task 0 golden), and codex gains exactly `.codex`.
    ...[...new Set([".claude", ...(opts.reexposeHomeDirs ?? [])])].map(d =>
      rwBind(join(opts.homeDir, d))
    ),
    // #3813 (K-CODEX-HOME): the session's OWN CODEX_HOME. Placed AFTER both tmpfs
    // masks (/tmp above, $HOME above) so it re-exposes correctly whether the dir is
    // under $HOME or /tmp; bind ONLY this dir — never a broader tree. The whole
    // HAPI_HOME + account-configs are already RW-bound above (the pre-existing
    // NEW-3813-16 exposure) — narrow, never widen.
    ...(opts.codexHome ? [rwBind(opts.codexHome)] : []),
    // Shared account-config dirs — RW so the worker's per-account
    // CLAUDE_CONFIG_DIR resolution + rotated-token persistence works. The
    // credential FILE (~/.config/hapimatic/env) is a SIBLING of account-configs/
    // and stays masked. Phase-2 tightening: this re-exposes ALL account config
    // dirs on the node; narrowing to the session's own <uuid> requires the daemon
    // to resolve/pre-create it pre-wrap (deferred — see runbook §8).
    rwBind(opts.accountConfigsDir),
    // Git identity — RO.
    roBind(join(opts.homeDir, ".gitconfig")),
    roBind(join(opts.homeDir, ".ssh")),
    // #3813: on nvm hosts a non-self-contained flavor binary (codex + its `node`
    // runtime + lib/node_modules) lives under ~/.nvm/... — masked by --tmpfs $HOME.
    // RO-bind the resolved install prefix so `codex`/`node` resolve inside the jail.
    // /usr-layout hosts resolve outside $HOME (already covered by --ro-bind /usr,…)
    // and pass nothing (undefined). Claude is self-contained → its claudePath below
    // suffices; no prefix.
    ...(opts.harnessBinPrefix ? [roBind(opts.harnessBinPrefix)] : []),
    // The claude + hapi binaries must be reachable inside the jail.
    ...(opts.claudePath ? [roBind(opts.claudePath)] : []),
    roBind(opts.execPath),
    // Start in the session cwd; propagate signals; unshare a PID namespace (R2).
    `--chdir ${q(opts.cwd)}`,
    "--die-with-parent",
    "--unshare-pid",
  ];
  return `bwrap ${args.join(" ")} -- ${innerCommand}`;
}

/**
 * Issue #3813: resolve the RO-bind install prefix for a jail-eligible flavor whose
 * binary is NOT self-contained. Claude is a self-contained binary (its `claudePath`
 * is RO-bound directly) → no prefix. Codex is a shim needing `node` + its
 * `lib/node_modules/@openai/codex` beside it; on nvm hosts
 * (`~/.nvm/versions/node/<v>/bin/codex`) the whole version prefix is masked by
 * `--tmpfs $HOME`, so RO-bind it. On a /usr-layout host the binary is outside $HOME
 * (the jail already ro-binds /usr,/bin,/lib,/opt) → no bind needed.
 *
 * Returns undefined when no bind is needed OR the binary cannot be resolved
 * (defensive — a genuinely unresolved codex surfaces as ENOENT in the live V-check,
 * per the runbook harness-binary prerequisite, rather than a spawn-time throw).
 * `Bun.which` is Bun-runtime only; under vitest the pure `buildBwrapJailCommand` is
 * exercised with an explicit `harnessBinPrefix` opt, so this is never called there.
 */
function resolveHarnessBinPrefix(
  agent: AgentFlavor,
  homeDir: string
): string | undefined {
  if (agent !== "codex") return undefined;
  if (typeof Bun === "undefined") return undefined;
  const which = Bun.which("codex");
  if (!which) return undefined;
  let real: string;
  try {
    real = realpathSync(which);
  } catch {
    real = which;
  }
  const homePrefix = homeDir.endsWith(sep) ? homeDir : `${homeDir}${sep}`;
  // Only bind when the binary lives under $HOME (masked); /usr-layout: no bind.
  if (!which.startsWith(homePrefix) && !real.startsWith(homePrefix)) {
    return undefined;
  }
  // nvm layout: `which` = ~/.nvm/versions/node/<v>/bin/codex → the node version dir
  // is the PATH location's grandparent, holding bin/{codex,node} +
  // lib/node_modules. Derive from `which` (the PATH shim), NOT `real` (which may
  // resolve into node_modules and miss `node`).
  return dirname(dirname(which));
}

/**
 * Spawn a session in a tmux window
 *
 * This is designed to work alongside the daemon's tracking system.
 * Unlike direct child process spawning, tmux sessions persist independently.
 */
/**
 * Issue #1661: pure decision for the reused-window respawn-vs-reattach branch.
 *
 * Returns `"reattach"` iff the caller explicitly opted OUT of killing a live
 * pane (`killLivePane === false`) AND a daemon-local liveness check confirmed
 * the wrapper is alive. Every other case — `killLivePane` true/undefined
 * (switch / token-refresh / model-restart / dead-session reconnect), OR an
 * uncertain/dead `wrapperAlive` — returns `"respawn"` (the #1555 default +
 * Fallback Preservation Rule).
 *
 * 🔴 `wrapperAlive` MUST couple pane non-death with `pidToTrackedSession`
 * membership (the `isTmuxWindowWrapperAlive` helper in run.ts), NOT a bare
 * `!isPaneDead`: the launch command ends in `; exec bash`, so a vacated pane
 * reports `pane_dead=0` while holding only an idle shell. A bash-occupied,
 * Claude-dead pane is therefore `wrapperAlive=false` → `"respawn"` — the
 * regression case this guard exists for.
 *
 * Extracted as a pure function so the branch is unit-testable without a live
 * tmux server (the I/O — `respawnPane` / `store.get` — is verified live in the
 * worktree instance, matching this file's #1349/#1575/#1600 convention).
 */
export function decideReusedWindowAction(
  killLivePane: boolean | undefined,
  wrapperAlive: boolean
): "respawn" | "reattach" {
  if (killLivePane === false && wrapperAlive) return "reattach";
  return "respawn";
}

/**
 * Issue #1682: pure liveness decision for `isTmuxWindowWrapperAlive`.
 *
 * Tightens the #1661 base predicate (`tracked AND !paneDead`) with an
 * active-children check so a just-dead Claude (idle `exec bash` pane,
 * `pane_dead=0`) reports NOT alive immediately — without waiting for the 60s
 * orphan-cleanup heartbeat that is the only other thing that untracks it.
 *
 * Why the children signal is correct: panes launch as `claude …; exec bash`
 * (NOT `exec claude`). While Claude runs it is a child of the pane shell →
 * `hasActiveChildren` true. After Claude exits, `exec bash` replaces the shell
 * (same pid, no children) → `hasActiveChildren` false. Same signal the
 * orphan-cleanup idle-shell check uses at `run.ts` (`windowPid && !hasChildren`,
 * Issue #633).
 *
 * 🔴 Null-tolerant fault path (load-bearing): a falsy `windowPid`
 * (`getWindowPid` fault/0) preserves the prior `!paneDead` verdict (alive).
 * The tightening only fires on a POSITIVE empty-children read with a truthy
 * pid — mirroring the orphan-cleanup `windowPid && !hasActiveChildren` shape.
 * `hasActiveChildren` returns `false` on ANY proc-read fault, so without the
 * `windowPid &&` guard a transient fault on a LIVE Claude would route both
 * callers (the `is-session-alive` RPC and the re-attach guard) to "respawn" —
 * reintroducing the #1661 live-session-kill class. Do not loosen this.
 */
export function decideWrapperAlive(
  tracked: boolean,
  paneDead: boolean,
  windowPid: number | null,
  hasChildren: boolean
): boolean {
  if (!tracked) return false;
  if (paneDead) return false;
  if (windowPid && !hasChildren) return false; // idle bash, Claude dead
  return true; // alive, or fault → preserve prior !paneDead verdict
}

/**
 * Issue #3732/#3734 (ruling D1, Option C′): resolve the window to REUSE on
 * reconnect by IDENTITY, never by the collision-prone name. Returns
 * `{ name, id, target }` for the session's OWN window, or null when no window
 * belongs to this session (→ the caller creates fresh; a same-titled sibling is
 * never cross-adopted).
 *
 * #4218 (F4): every tier requires OWNERSHIP via `resolveOwnedWindow`
 * (`@hapi_identity === hapiSessionId`, or the pane tree's `HAPI_SESSION_ID`
 * for an identity-less window). An `@N` is unique only within one tmux-server
 * lifetime, so after a server restart the persisted id can address ANOTHER
 * session's live window, and a name can be held by a same-titled one; neither
 * is reused, and its `@hapi_identity` is never overwritten. Tiers, in order,
 * each tried only when the previous one found no owned window:
 *
 *  (1) the persisted `@N` (`existingSession.tmuxWindowId`), probed directly.
 *      An absent id reads as `window-gone`, a foreign one as
 *      `foreign-identity` (logged) — both fall through.
 *  (2) the `@hapi_identity == hapiSessionId` row of a fresh listing — a legacy
 *      record with no persisted id, or a stale one.
 *  (3) the stored NAME, resolved to the `@N` of the window holding it — owned
 *      only when that window carries this session's identity (or, for an
 *      identity-less window, its pane tree's `HAPI_SESSION_ID`).
 *
 * A tmux fault in any tier reads as "no owned window" here, so the caller
 * creates a fresh window next to the session's own (the pre-existing fallback).
 * The returned `target` is the owned window's `@N`, minted for the reused
 * branch's mutators; it lives only for this spawn.
 */
export async function resolveReusableWindow(
  tmux: TmuxManager,
  existingSession: Pick<PersistedSession, "tmuxWindowId" | "tmuxWindow"> | null,
  hapiSessionId: string
): Promise<{ name: string; id: string; target: OwnedWindowTarget } | null> {
  if (!existingSession) return null;
  const accept = (
    result: OwnershipResult,
    name: string
  ): { name: string; id: string; target: OwnedWindowTarget } | null =>
    result.kind === "owned"
      ? { name, id: String(result.target), target: result.target }
      : null;

  // (1) persisted @N fast path — exists AND owned
  if (existingSession.tmuxWindowId) {
    const byId = await resolveOwnedWindow(
      tmux,
      existingSession.tmuxWindowId,
      hapiSessionId
    );
    const hit = accept(
      byId,
      existingSession.tmuxWindow || existingSession.tmuxWindowId
    );
    if (hit) return hit;
    if (byId.kind === "not-owned" && byId.reason === "foreign-identity") {
      logger.warn(
        `[TmuxSpawnAdapter] #4218: reconnect of ${hapiSessionId} — persisted window id ${existingSession.tmuxWindowId} now belongs to ${byId.identity ?? "another session"} (tmux server restarted?) — not reusing it`
      );
    }
  }
  // (2) @hapi_identity dedicated-query fallback (legacy record / stale id)
  const rows = await tmux.listWindowIdentities();
  const match = rows.find(r => r.identity === hapiSessionId && r.id);
  if (match?.id) {
    const hit = accept(
      await resolveOwnedWindow(tmux, match.id, hapiSessionId),
      existingSession.tmuxWindow || match.id
    );
    if (hit) return hit;
  }
  // (3) legacy NAME tier — only a window this session owns, resolved to its @N
  if (existingSession.tmuxWindow) {
    const hit = accept(
      await resolveOwnedWindow(tmux, existingSession.tmuxWindow, hapiSessionId),
      existingSession.tmuxWindow
    );
    if (hit) return hit;
  }
  return null;
}

export async function spawnSessionInTmux(
  options: TmuxSpawnOptions
): Promise<TmuxSpawnResult> {
  const {
    directory,
    agent = "claude",
    yolo = true,
    safeMode = false,
    modelMode,
    effort,
    rawModel,
    sessionRole,
    outputStyle,
    token,
    model,
    codexHome,
    resumeSessionId,
    hapiSessionId: providedHapiSessionId,
    extraEnv,
    name,
    forkSession,
    killLivePane,
    isWrapperAlive,
  } = options;

  // Debug logging for reconnect investigation
  logger.info(
    `[TmuxSpawnAdapter] spawnSessionInTmux called with agent: ${agent}, resumeSessionId: ${resumeSessionId ?? "NOT PROVIDED"}, hapiSessionId: ${providedHapiSessionId ?? "NOT PROVIDED"}`
  );

  // Issue #1082 (R7): defense-in-depth. #1081 narrowed the type to "claude";
  // #1082 widened it to include codex for tmux persistence. The daemon gate at
  // sessionSpawner.ts:742 already routes only claude/codex here, but guard at
  // runtime so a future caller passing gemini/opencode/unknown gets a
  // STRUCTURED error rather than falling through the claude-shaped body.
  const isCodex = agent === "codex";
  if (agent !== "claude" && !isCodex) {
    logger.warn(
      `[TmuxSpawnAdapter] Unsupported agent for tmux persistence: ${String(agent)}`
    );
    return {
      type: "error",
      errorMessage: `Unsupported agent for tmux persistence: ${String(agent)}`,
    };
  }

  const tmux = new TmuxManager({
    sessionName: configuration.tmuxSessionName,
    socketName: configuration.tmuxSessionName,
    defaultCwd: directory,
  });

  const store = createSessionStore(configuration.happyHomeDir);

  // Check tmux is available
  if (!(await tmux.isTmuxAvailable())) {
    logger.warn("[TmuxSpawnAdapter] tmux is not available on this system");
    return {
      type: "error",
      errorMessage:
        "tmux is not available on this system. Install tmux or disable HAPI_TMUX_PERSISTENCE.",
    };
  }

  // #4443: a named spawn's claim on its window name, held until this function
  // returns (released in the `finally` below).
  let nameReservation: WindowNameReservation | null = null;

  try {
    // Use provided session ID (for reconnect) or generate a new one
    const hapiSessionId = providedHapiSessionId ?? generateSessionId();
    const isReconnect = !!providedHapiSessionId;

    // For reconnects, try to reuse the existing tmux window
    let tmuxWindowName: string;
    // #3734/#3732 (ruling D1): the persisted @N of the window being reused on
    // reconnect. Every reused-branch op targets THIS id, never the (collision-
    // prone) name — so a same-title collision can never reuse / respawn-pane -k
    // INTO another session's live window (the #3732/#3734 hijack class).
    let reusedWindowId: string | null = null;
    // #4218: the reused window as an OWNED target (minted by
    // resolveReusableWindow) — the only value the reused branch's mutators
    // accept. Null when a fresh window is created.
    let reusedTarget: OwnedWindowTarget | null = null;
    let reusingExistingWindow = false;

    if (isReconnect) {
      // Look up existing session to get its tmux window
      const existingSession = await store.get(hapiSessionId);
      // #3732 Task 3 / #4218: resolve the reused window by IDENTITY and
      // OWNERSHIP, never by name. (1) the persisted @N, only if this session
      // owns it — after a tmux-server restart the same id can name another
      // session's live window, which is never adopted; (2) the
      // @hapi_identity == hapiSessionId row; (3) the legacy name, only for an
      // owned window. No owned window → create fresh.
      const resolved = await resolveReusableWindow(
        tmux,
        existingSession,
        hapiSessionId
      );
      if (resolved) {
        tmuxWindowName = resolved.name;
        reusedWindowId = resolved.id;
        reusedTarget = resolved.target;
        reusingExistingWindow = true;
        logger.info(
          `[TmuxSpawnAdapter] Reconnect: reusing existing tmux window: ${tmuxWindowName} (id=${reusedWindowId})`
        );
      } else {
        // Existing window doesn't exist — use provided name (e.g., branch
        // label from the branch dialog) before falling back to hapiSessionId.
        // Note: run.ts always pre-generates a hapiSessionId before calling
        // here, so isReconnect is true even for brand-new sessions (branch,
        // create).  The store lookup above distinguishes true reconnects
        // (existing window found) from new sessions with pre-assigned IDs.
        tmuxWindowName = name ?? hapiSessionId;
        logger.info(
          `[TmuxSpawnAdapter] Reconnect: existing window not found, creating new: ${tmuxWindowName}`
        );
      }
    } else {
      // New session (no hapiSessionId provided at all — defensive fallback)
      tmuxWindowName = name ?? hapiSessionId;
    }

    // Auto-increment name on conflict (issue #816)
    // Only for new windows with user-provided names. Session IDs are globally
    // unique and don't need deduplication.
    // #4443: the name is reserved, not just deduped, so a concurrent spawn of
    // the same base name in this daemon picks the next suffix. A dedup listing
    // fault throws to the catch below instead of reading as "no windows".
    if (!reusingExistingWindow && name) {
      const originalName = tmuxWindowName;
      nameReservation = await reserveUniqueWindowName(tmux, tmuxWindowName);
      tmuxWindowName = nameReservation.name;

      // If name was adjusted, record the deduplication to prevent server→tmux
      // rename from undoing it before the CLI reports the adjusted name.
      if (tmuxWindowName !== originalName) {
        recordDeduplication(hapiSessionId);
      }
    }

    logger.debug(
      `[TmuxSpawnAdapter] ${isReconnect ? "Reconnecting to" : "Creating"} session: ${hapiSessionId}`
    );
    logger.debug(
      `[TmuxSpawnAdapter] tmux window: ${tmuxWindowName} (reusing: ${reusingExistingWindow})`
    );
    logger.debug(`[TmuxSpawnAdapter] Working directory: ${directory}`);

    // Defense-in-depth: verify CWD exists before building the tmux command.
    // Without this, the `cd` in the shell script fails silently inside tmux. (#956)
    try {
      await fs.access(directory);
    } catch {
      logger.warn(
        `[TmuxSpawnAdapter] Working directory does not exist: ${directory}`
      );
      return {
        type: "error",
        errorMessage: `Working directory does not exist: ${directory}`,
      };
    }

    // Ensure project directory exists
    const projectDir = getProjectPath(directory);
    await fs.mkdir(projectDir, { recursive: true });

    // Ensure tmux session exists
    await tmux.ensureSession();

    // Issue #3179: when the sandbox is ON and the session cwd covers the $HOME
    // mask, buildBwrapJailCommand skips the cwd bind so ~/.config/hapimatic/env
    // stays masked; the session then runs on the empty, ephemeral --tmpfs $HOME.
    // Compute once (realpaths both sides, matching the jail's os.homedir() mask),
    // warn loudly (K7 marker — #3184 greps the daemon log for it), and thread the
    // notice into the session's appended system prompt below.
    const jailCwdCoversMask = configuration.omniboxSandboxEnabled
      ? await resolveCwdCoversHomeMask(directory, os.homedir())
      : false;
    if (jailCwdCoversMask) {
      logger.warn(OMNIBOX_CWD_MASK_WARNING);
      logger.debug(
        `[TmuxSpawnAdapter] #3179: cwd '${directory}' covers the $HOME mask; skipping the cwd bind`
      );
    }

    // Build the HAPI-wrapper command. #1082: codex uses buildCodexCommand
    // (remote mode; resume is threaded as CODEX_TMUX_RESUME_FLAG and resolved
    // via findCodexResumeFile, NOT `--resume` which remote mode ignores). The
    // claude branch is byte-identical to pre-#1082 (R6). The variable name
    // stays `claudeArgs` because it feeds the shared spawn flow + the
    // PersistedSession.claudeArgs field (the persisted respawn argv) for both.
    const claudeArgs = isCodex
      ? buildCodexCommand({
          yolo,
          model,
          codexResumeSessionId: resumeSessionId,
        })
      : buildClaudeCommand({
          yolo,
          safeMode,
          modelMode,
          effort,
          rawModel,
          sessionRole,
          outputStyle,
          projectDir,
          directory,
          resumeSessionId,
          forkSession,
          // Issue #3179: surface the ephemeral-cwd consequence to the session
          // (one extra appended-system-prompt paragraph) when the cwd bind was
          // skipped. undefined ⇒ byte-identical appended prompt.
          sandboxCwdNotice: jailCwdCoversMask
            ? OMNIBOX_CWD_MASK_WARNING
            : undefined,
        });
    logger.info(
      `[TmuxSpawnAdapter] ${isCodex ? "Codex" : "Claude"} args: ${claudeArgs.join(" ")}`
    );

    // Build environment variables
    const envVars: Record<string, string> = {
      DISABLE_AUTOUPDATER: "1",
      // Pass the server URL so spawned CLI connects to the correct instance
      HAPI_SERVER_URL: configuration.serverUrl,
      // CRITICAL: Pass HAPI_HOME so spawned process uses the same home directory
      // Without this, the spawned process defaults to ~/.hapi and sends the
      // session-started webhook to the wrong daemon
      HAPI_HOME: configuration.happyHomeDir,
      // Pass session ID for reconnect scenarios - the spawned CLI will use this
      // as its tag to reuse the existing session instead of creating a new one
      HAPI_SESSION_ID: hapiSessionId,
      // Pass tmux window name so spawned CLI can use it as the default session name
      // This enables name synchronization between Hapimatic sessions and tmux windows
      HAPI_TMUX_WINDOW: tmuxWindowName,
      // Resolve the path to the vanilla claude CLI binary and pass it so the
      // spawned process can find claude without relying on PATH (which may be
      // incomplete if bash hasn't finished sourcing .bashrc).
      // Note: This must be the vanilla claude binary, NOT the Hapimatic wrapper,
      // because the SDK spawns it as a child process with claude-specific args.
      // Uses try/catch because the daemon itself may have minimal PATH.
      ...resolveClaudePath(),
      // Issue #2155: expose the spawn-time role to in-session hooks (the
      // rp1-home telemetry_logger.py reads it, like HAPI_SESSION_ID) so each
      // telemetry event carries the real session_role (#2154's nullable column).
      ...(sessionRole ? { HAPI_SESSION_ROLE: sessionRole } : {}),
      // Issue #1082: tag the pane's process env so RecoveryService and the
      // /proc/<pid>/environ walk can identify a codex window (R4), and deliver
      // the durable per-session CODEX_HOME (ruling D4) when the caller supplies
      // one. Any provider secret (OPENROUTER_API_KEY) arrives via `extraEnv`
      // from the Task 6 helper and is merged below. Claude sets neither.
      ...(isCodex ? { HAPI_AGENT: "codex" } : {}),
      ...(isCodex && codexHome ? { CODEX_HOME: codexHome } : {}),
    };

    // Add CLI_API_TOKEN for Hapimatic authentication
    if (configuration.cliApiToken) {
      envVars.CLI_API_TOKEN = configuration.cliApiToken;
    }

    // Add OAuth token if provided
    if (token) {
      envVars.CLAUDE_CODE_OAUTH_TOKEN = token;
    }

    // Issue #1575: forward the account-config-isolation kill-switch (read from
    // the daemon's own env) so it reaches the worker under tmux persistence.
    // Without this, a systemd Environment= drop-in on the daemon never reaches
    // the worker (it inherits the stale persistent tmux server's env), and the
    // gate in accountTokenInjection.ts keeps isolation default-ON.
    Object.assign(envVars, buildAccountConfigIsolationEnv());

    // Issue #1734 (OmniBox Phase 0b): forward the sandbox kill-switch + inject
    // the loopback egress-proxy vars (gated on the sandbox + a live broker).
    Object.assign(envVars, buildSandboxEnv());

    // Merge additional environment variables (e.g., worktree vars)
    if (extraEnv) {
      Object.assign(envVars, extraEnv);
    }

    // #1734 (OmniBox Phase 0a — in-path security fix, UNGATED): deliver the
    // spawn env — including CLI_API_TOKEN and CLAUDE_CODE_OAUTH_TOKEN —
    // OUT-OF-BAND via a 0600 env file that the launch shell sources + `rm -f`s
    // BEFORE exec, instead of interpolating the secrets as a cleartext env-prefix
    // into the spawn-script body.
    //
    // The old `envPrefix` embedded both tokens into the `0700` tmpScript BODY,
    // and because `bash <tmpScript>` blocks for the entire session, that script
    // (with the cleartext tokens) survived on disk — readable by the same-uid
    // YOLO agent via `cat /tmp/hapi-spawn-*.sh` — for the WHOLE session, not just
    // the spawn window (`0o700` is owner-only, but the agent IS the owner uid).
    // Routing through `buildTmuxEnvFileCommand` (the same helper the tmux
    // launchers use — `claudeTmuxRemote.ts`) shrinks the secrets' on-disk
    // lifetime to the milliseconds between write and the pre-exec `rm -f`, and
    // the persistent tmpScript now carries NO token value.
    let spawnCommand = `${escapeShellArg(process.execPath)} ${claudeArgs.join(" ")}`;
    // Issue #2646 (OmniBox Phase-1): when the sandbox gate is ON, wrap ONLY the
    // inner agent-launch command in a bwrap fs+PID jail (buildBwrapJailCommand).
    // The env-file `cd`/source/`rm -f` prelude below and the trailing
    // `; exec bash` (initialProcessCmd) stay OUTSIDE the jail — the R8 liveness
    // invariant (see buildBwrapJailCommand's docstring). Gate OFF ⇒ spawnCommand
    // is byte-identical to pre-#2646 (R6).
    if (configuration.omniboxSandboxEnabled) {
      // Issue #3813: thread the spawned flavor's host-jail axis into the builder.
      // The tmux path admits only claude + codex (guarded above), both `native`.
      const hostJail = resolveHostJailAxis(resolveHarnessManifest(agent));
      spawnCommand = buildBwrapJailCommand(spawnCommand, {
        cwd: directory,
        homeDir: os.homedir(),
        hapiHome: configuration.happyHomeDir,
        accountConfigsDir: configuration.accountConfigsDir,
        claudePath: envVars.HAPI_CLAUDE_PATH,
        execPath: process.execPath,
        // Issue #3179: reuse the call-site predicate (realpaths both sides)
        // rather than the builder's lexical fallback.
        cwdCoversMask: jailCwdCoversMask,
        // Issue #3813: per-flavor re-exposes (claude → `.claude` no-op; codex →
        // `.codex`), the session's own CODEX_HOME (set only for codex, :829), and
        // the nvm install prefix so `codex`/`node` resolve inside the jail.
        reexposeHomeDirs: hostJail.reexposeHomeDirs,
        codexHome: envVars.CODEX_HOME,
        harnessBinPrefix: resolveHarnessBinPrefix(agent, os.homedir()),
      });
    }
    const envFilePath = join(
      os.tmpdir(),
      `hapi-spawn-env-${generateShortId()}.sh`
    );
    const { fullCommand, envFileBody } = buildTmuxEnvFileCommand({
      launcherEnv: envVars,
      cwd: directory,
      spawnCommand,
      envFilePath,
    });
    // `flag: "wx"` (O_EXCL) refuses to follow a pre-existing symlink — a
    // symlink-redirect attack fails closed; `0o600` is owner read/write only.
    await fs.writeFile(envFilePath, envFileBody, { mode: 0o600, flag: "wx" });

    logger.debug(`[TmuxSpawnAdapter] Full command: ${fullCommand}`);

    // Write the command to a temp script to avoid tmux send-keys newline
    // issues.  The --append-system-prompt argument contains literal newlines
    // (paragraph breaks).  When sent character-by-character through tmux
    // send-keys, those newlines are interpreted as Enter keypresses by the
    // terminal, breaking the single-quoted argument into separate commands.
    // In a script file, bash correctly handles multi-line single-quoted
    // strings. The script no longer carries any secret (those moved to the
    // 0600 env file above); `flag: "wx"` closes the TOCTOU/symlink window and
    // `bash <file>` needs no exec bit, so `0o600` (no +x) suffices.
    const tmpScript = join(os.tmpdir(), `hapi-spawn-${generateShortId()}.sh`);
    await fs.writeFile(tmpScript, `#!/bin/bash\n${fullCommand}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    logger.debug(`[TmuxSpawnAdapter] Temp script: ${tmpScript}`);

    const launchCmd = `bash ${escapeShellArg(tmpScript)} ; rm -f ${escapeShellArg(tmpScript)}`;
    // When used as a window's initial process (new-window or respawn-pane),
    // drop into an interactive shell after the hapi process exits.  This
    // gives a visible command prompt as a visual indicator that the session
    // is disconnected, and keeps the pane alive for reconnect via send-keys.
    const initialProcessCmd = `${launchCmd} ; exec bash`;

    // Captured index from new-window -P -F. Surfaced in the return value so
    // run.ts's post-spawn PID lookup can bypass the broken-on-tmux-3.4
    // `list-windows -F` path. See #1315 + Task 4 of issue-1315 directive.
    let capturedWindowIndex: number | null = null;
    // #3734: the session-unique @N — captured at create, or the resolved id of
    // the reused window on reconnect. Persisted as tmuxWindowId (the 1:1 key).
    let capturedWindowId: string | null = reusedWindowId;
    // #4218: the window THIS spawn created, as an owned target (null when
    // reusing). Every mutation of the fresh window goes through it.
    let createdTarget: OwnedWindowTarget | null = null;

    if (!reusingExistingWindow) {
      // For NEW windows: pass the launch command directly to tmux
      // new-window.  This runs the script as the window's initial process,
      // bypassing interactive shell initialization entirely.  Avoids the
      // race condition where send-keys fires before bash's readline is
      // ready (manifests as `-bash: Not: command not found` on slow Pi
      // nodes where .bashrc takes >1.5s to load).
      // #1585: an UNNAMED spawn (window name = its unique hapiSessionId)
      // replaces a stale same-named survivor instead of erroring — that window
      // can only be an orphan of this session (live reconnects use respawnPane,
      // #1555). #4443: a NAMED spawn never replaces. Its name came from a dedup,
      // so a same-named window here is another live window (a concurrent spawn
      // outside this daemon, or a server→tmux rename that landed in the gap),
      // and killing it by name would kill that session. The error-return
      // fallback below is preserved for a genuine, unresolvable failure.
      const createResult = await tmux.createOrReplaceWindow(
        {
          name: tmuxWindowName,
          cwd: directory,
          command: initialProcessCmd,
        },
        { onNameConflict: nameReservation ? "fail" : "replace" }
      );

      if (!createResult.created) {
        await fs.unlink(tmpScript).catch(() => {});
        await fs.unlink(envFilePath).catch(() => {});
        // Do not re-dedup and retry: HAPI_TMUX_WINDOW already carries this name
        // in the env file the launch script reads.
        const nameTaken =
          nameReservation !== null &&
          (await tmux.listWindows()).some(w => w.name === tmuxWindowName);
        return {
          type: "error",
          errorMessage: nameTaken
            ? `Failed to create tmux window: name "${tmuxWindowName}" was taken concurrently`
            : `Failed to create tmux window: ${tmuxWindowName}`,
        };
      }

      capturedWindowIndex = createResult.index;
      capturedWindowId = createResult.id; // #3734: persist the @N (1:1 key)
      createdTarget = spawnedWindowTarget(createResult, tmuxWindowName);

      // #3732 Task 2: tag the window with the session identity so the 1:N
      // paths (delete kill-all, reconnect dedupe, heartbeat reaper, recovery
      // fallback) can find every window belonging to this session by exact TAG.
      // Set on the captured @N, else the captured INDEX — both are addressed
      // WITHOUT listWindows() (resolveDualTarget returns an @N verbatim and an
      // index as <session>:<index>); passing the NAME would ride listWindows()
      // → [] on tmux 3.4 and silently no-op (the whole point of C′). The name
      // is the last resort (Fallback Preservation Rule). Best-effort —
      // setWindowIdentity never throws.
      await tmux.setWindowIdentity(createdTarget, hapiSessionId);

      // Defense-in-depth: createWindow() already sets automatic-rename off
      // using the captured window index (#945), but this redundant call
      // guards against edge cases where the index capture might fail.
      await tmux.setWindowOption(createdTarget, "automatic-rename", "off");
    } else if (reusedTarget !== null && reusedWindowId !== null) {
      // For REUSED windows (reconnect / account-switch / token-refresh restart):
      // ALWAYS respawn the pane — never send-keys into it. (#1555)
      //
      // The previous logic only respawned when isPaneDead was true and otherwise
      // typed the launch command into the pane via send-keys. That was unreliable
      // for a respawn on a session whose old claude is still alive in the pane —
      // exactly the account-switch and token-refresh-restart cases:
      // switchAccount() / restartBoundSession() call archiveSession() → killSession,
      // which is fire-and-forget/async (registerKillSessionHandler does
      // `void killThisHappy()`), so the OLD claude is frequently still running when
      // this respawn fires. isPaneDead is then false — and in fact the pane is
      // almost never "dead", because the launch script ends in `; exec bash`, so a
      // vacated pane becomes an interactive shell rather than a dead pane. The code
      // therefore took the send-keys arm and typed the launch command straight into
      // the live/dying claude's TUI, where it was swallowed as keystrokes. The new
      // claude never started, so waitForAnyChild (run.ts) either timed out
      // (45s → switchAccount R4 rollback → HTTP 409) or latched onto the stale
      // dying child under the same pane PID (awaitWebhook:false fast-return → a
      // FALSE success that left the session dead). Either way the first-attempt
      // switch failed.
      //
      // respawn-pane -k deterministically replaces WHATEVER occupies the pane (dead
      // pane, idle shell, or a live/dying claude) with the fresh launch command, so
      // the new claude reliably starts in the reused window. This is safe even
      // though the new claude shares the pane PID with the old one: killSession
      // terminates the OLD wrapper's OWN process tree (lifecycle.cleanupAndExit),
      // not the pane, so it cannot reach the freshly-respawned wrapper. respawn-pane
      // was already the trusted path here (used directly for dead panes and as the
      // send-keys-failure fallback), so this promotes it to the sole path and drops
      // only the fragile "alive pane ⇒ send-keys" fast-path. Preserved unchanged:
      // switchAccount's R4 rollback (a genuine respawn failure still returns an
      // error from here, which the rollback handles) and run.ts's awaitWebhook:false
      // fast-return (which now returns on a REAL new child instead of a stale one).
      // Issue #1661: gate the respawn-kill on caller intent (the defense-in-depth
      // chokepoint for the respawn-kill-on-reconnect bug). Only a reconnect whose
      // daemon-authoritative liveness RPC was UNCERTAIN (null) sets
      // `killLivePane === false`; there we do a fresh daemon-local re-check and,
      // if the wrapper is genuinely alive, RE-ATTACH (skip the respawn) so an
      // in-flight Claude turn is never SIGTERM-killed. Everything else (switch /
      // token-refresh / model-restart / server-confirmed-dead reconnect) keeps the
      // #1555 always-respawn behavior. The respawn-vs-reattach decision is the
      // pure, unit-tested `decideReusedWindowAction` predicate.
      //
      // #2245 [2245-5]: a window reused for a live session must NOT keep a stale
      // `@hapi_archive` tag. If this window was previously archived-for-reconnect
      // (#2683 tagged it), reusing it now for a fresh/resumed live session means it
      // is no longer an archived-idle window — clear the tag so a LATER crash of
      // THIS session is classified `needs-reconnect` by RecoveryService, not
      // mistaken for an archived window and left offline. Idempotent no-op when
      // the tag is absent (account-switch / token-refresh restart never tag it).
      // Runs before the reattach/respawn decision so both paths clear it.
      // #3734/#4218: target the reused window by its OWNED @N (reusedTarget),
      // never the ambiguous name — clearing the tag on the wrong window would
      // mis-classify a sibling on a later crash.
      await tmux.setWindowOption(reusedTarget, TMUX_ARCHIVE_USER_OPTION, "0");

      // #3732 Task 3: (re-)assert @hapi_identity on the reused window (by @N) so
      // a window whose identity was never set (legacy) or lost regains it before
      // the respawn / dedupe / recovery paths rely on exact-TAG resolution.
      // Best-effort — never throws.
      await tmux.setWindowIdentity(reusedTarget, hapiSessionId);

      let wrapperAlive = false;
      if (killLivePane === false) {
        // Only probe daemon-local liveness when the caller opted out of killing
        // a live pane (avoids an extra tmux round-trip on the default path).
        // #3734: probe by the reused window's @N, not the name.
        wrapperAlive = isWrapperAlive
          ? await isWrapperAlive(reusedWindowId).catch(() => false)
          : false;
      }
      if (decideReusedWindowAction(killLivePane, wrapperAlive) === "reattach") {
        // Re-attach: the live launcher wrapper keeps relaying pane output via its
        // FIFO regardless of web-client connection, and SSE is decoupled from any
        // respawn — the re-subscribing client resumes the in-flight stream with no
        // process spawn. Return reattached:true so run.ts short-circuits BEFORE
        // the child-detect/webhook flow (whose 60s timeout would otherwise
        // stopTmuxSession this very live session).
        await fs.unlink(tmpScript).catch(() => {});
        await fs.unlink(envFilePath).catch(() => {});
        const existing = await store.get(hapiSessionId);
        logger.info(
          `[TmuxSpawnAdapter] #1661 re-attach: window "${tmuxWindowName}" wrapper is alive — skipping respawn, reusing the live pane`
        );
        return {
          type: "success",
          sessionId: hapiSessionId,
          hapiSessionId,
          tmuxWindow: tmuxWindowName,
          tmuxWindowIndex: existing?.tmuxWindowIndex ?? null,
          // #3734: carry the reused window's @N so run.ts seeds the tracking
          // map (and later lifecycle ops) with the collision-safe id.
          tmuxWindowId: reusedWindowId,
          reattached: true,
        };
      }
      if (killLivePane === false) {
        logger.info(
          `[TmuxSpawnAdapter] #1661: killLivePane=false but window "${tmuxWindowName}" wrapper is NOT alive (dead / untracked / uncertain) — falling back to respawn (Fallback Preservation Rule)`
        );
      }

      // #3734: probe and respawn the reused window by its @N (reusedTarget),
      // never the ambiguous name — this is the site of the #3732/#3734 hijack
      // (respawn-pane -k INTO another session's live pane under a title collision).
      const paneDead = await tmux.isPaneDead(reusedWindowId);
      logger.info(
        `[TmuxSpawnAdapter] Reconnect respawn for window "${tmuxWindowName}" (id=${reusedWindowId}, paneDead=${paneDead}) — using respawn-pane to guarantee a clean launch (#1555/#1661)`
      );
      const respawned = await tmux.respawnPane(
        reusedTarget,
        initialProcessCmd,
        directory
      );

      if (!respawned) {
        await fs.unlink(tmpScript).catch(() => {});
        await fs.unlink(envFilePath).catch(() => {});
        return {
          type: "error",
          errorMessage: `Failed to respawn pane in tmux window: ${tmuxWindowName}`,
        };
      }
    } else {
      // Unreachable: resolveReusableWindow returns an id AND an owned target
      // together. Fail closed rather than run with no window.
      await fs.unlink(tmpScript).catch(() => {});
      await fs.unlink(envFilePath).catch(() => {});
      return {
        type: "error",
        errorMessage: `Reconnect resolved no owned window for: ${tmuxWindowName}`,
      };
    }

    // Poll for early-exit detection: if the pane dies quickly, the spawn
    // failed.  On slow nodes (WSL2/SL7), Claude Code may take several
    // seconds to initialize.  We don't check whether Claude is *running*
    // (that's the webhook's job) — only whether the launch script exited
    // immediately, which signals a hard failure (binary not found,
    // permission denied, etc.).
    //
    // Why isPaneDead instead of isWindowAlive:
    //   isWindowAlive checks pane_pid via process.kill(pid, 0), but the
    //   initialProcessCmd ends with "; exec bash" — so the pane PID is
    //   always alive (bash shell), even after Claude exits.  isPaneDead
    //   queries tmux's own #{pane_dead} flag, which is authoritative.
    const POLL_INTERVAL_MS = 500;

    // Initial wait — give the process a moment to start before polling
    await sleep(1000);

    // #3734: probe/kill by the captured @N (create) or reused @N (reconnect),
    // falling back to the name only for a legacy reused window with no id.
    const spawnTarget: string = capturedWindowId ?? tmuxWindowName;
    let paneDied = false;
    for (let i = 0; i < 2; i++) {
      const dead = await tmux.isPaneDead(spawnTarget);
      if (dead) {
        paneDied = true;
        break;
      }
      // Pane is alive — launch script is still running (good sign).
      // After the first successful check, the process has survived 1s +
      // one poll interval — no need to keep polling.  The webhook /
      // session-started mechanism confirms actual Claude startup later.
      if (i >= 1) {
        break;
      }
      await sleep(POLL_INTERVAL_MS);
    }

    if (paneDied) {
      await fs.unlink(tmpScript).catch(() => {});
      await fs.unlink(envFilePath).catch(() => {});
      logger.warn(
        `[TmuxSpawnAdapter] Launch script exited immediately in window ${tmuxWindowName}`
      );
      // Only cleanup the window if we created it (not if reusing). #3734: kill
      // by the captured @N so a failed fresh spawn can never kill a same-named
      // sibling.
      if (createdTarget !== null) {
        await tmux.killWindow(createdTarget);
      }
      return {
        type: "error",
        errorMessage: "Claude process failed to start in tmux window",
      };
    }

    // Persist session to store
    const persistedSession: PersistedSession = {
      hapiSessionId,
      claudeSessionId: null, // Will be updated when Claude reports via webhook
      // Issue #1082: tag the agent so RecoveryService routes per-agent logic
      // (R4). codexSessionId seeds from resumeSessionId (present on a respawn,
      // null on a fresh spawn — codex reports its id later, opportunistically
      // persisted by sessionTracker). codexHome is persisted so cleanup/GC can
      // find the durable dir (ruling D4). Claude omits all three (undefined),
      // preserving byte-identical legacy records (R6).
      ...(isCodex
        ? {
            agent: "codex" as const,
            codexSessionId: resumeSessionId ?? null,
            ...(codexHome ? { codexHome } : {}),
          }
        : {}),
      cwd: directory,
      tmuxWindow: tmuxWindowName,
      tmuxWindowIndex: capturedWindowIndex, // #1316
      tmuxWindowId: capturedWindowId, // #3734: collision-safe 1:1 key
      createdAt: new Date().toISOString(),
      claudeArgs: claudeArgs,
      status: "active",
      namespace: "default",
    };

    await store.save(persistedSession);

    logger.info(
      `[TmuxSpawnAdapter] Session ${isReconnect ? "reconnected" : "created"}: ${hapiSessionId} in window ${tmuxWindowName}`
    );

    return {
      type: "success",
      sessionId: hapiSessionId,
      hapiSessionId,
      tmuxWindow: tmuxWindowName,
      tmuxWindowIndex: capturedWindowIndex,
      tmuxWindowId: capturedWindowId, // #3734
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn(`[TmuxSpawnAdapter] Failed to spawn session: ${errorMessage}`);
    return {
      type: "error",
      errorMessage: `Failed to spawn tmux session: ${errorMessage}`,
    };
  } finally {
    // #4443: by now the window exists (the post-create pane check ran) or the
    // spawn failed — either way the claim is no longer needed.
    nameReservation?.release();
  }
}

/**
 * Pure predicate for the #1600 remote-launcher reap: decide whether a window in
 * the `hapimatic-remote` tmux session belongs to the session being torn down.
 *
 * A window is reaped iff its name carries the launcher prefix AND its pane's
 * `HAPI_SESSION_ID` (resolved via `getWindowHapiSessionId`, passed here as
 * `windowTag`) equals the DELETE path's session tag. The tag — NOT the window
 * name — is the discriminator: the name embeds the SERVER session id (so a name
 * match would miss), while every per-attempt-suffixed variant (`-r1`, ...) shares
 * the same tag. A `null` `windowTag` (e.g. a `remain-on-exit` dead pane whose env
 * is unreadable) never matches — see the reap function's "Known edge" note.
 *
 * Extracted as a pure function so the matching logic is unit-testable without a
 * live tmux server (the I/O wrapper `reapRemoteLauncherWindows` is verified
 * end-to-end against a real worktree instance, matching this file's #1349/#1575
 * test convention).
 */
export function shouldReapRemoteWindow(
  windowName: string,
  windowTag: string | null,
  sessionTag: string
): boolean {
  return (
    windowName.startsWith(TMUX_REMOTE_WINDOW_PREFIX) && windowTag === sessionTag
  );
}

/**
 * Candidate window names for a session's remote-launcher window (#1628).
 *
 * The launcher names window B `hapi-remote-<serverSessionId>` on attempt 0
 * and appends `-r1`..`-r<budget>` on burst-load retries
 * (claudeTmuxRemote.ts R14/#1429). The ACTUAL retry budget is resolved
 * launcher-side (`--retries` / `HAPI_TMUX_LAUNCHER_RETRIES`) and is not
 * visible at the kill site, so the probe set is bounded by the exported hard
 * clamp `MAX_RETRY_BUDGET` — correct for every configuration (no window can
 * ever carry a higher suffix), at ≤ 1 + MAX_RETRY_BUDGET O(1) server-side
 * probes, teardown path only. Pure function — unit-tested without tmux.
 */
export function buildRemoteWindowCandidateNames(
  serverSessionId: string
): string[] {
  const base = `${TMUX_REMOTE_WINDOW_PREFIX}${serverSessionId}`;
  const names = [base];
  for (let i = 1; i <= MAX_RETRY_BUDGET; i++) {
    names.push(`${base}-r${i}`);
  }
  return names;
}

/**
 * Reap the tmux-LAUNCHER's remote window for a session tag (issue #1600).
 *
 * Under `HAPI_CLAUDE_LAUNCHER=tmux` the real `claude` runs in a SEPARATE tmux
 * session (`configuration.tmuxRemoteSessionName`, default `hapimatic-remote`),
 * in a window named `hapi-remote-<serverSessionId>` with `remain-on-exit` ON.
 * That window's claude is parented by the remote tmux server — NOT the
 * `hapi claude` wrapper — so neither archiveSession's fire-and-forget killSession
 * (which kills the wrapper's own descendant tree) nor the DELETE path's window-A
 * teardown below (which operates on `configuration.tmuxSessionName`) reaps it.
 * The periodic reconciliation (`detectTmuxNameChanges` / `cleanupGhostWindows`)
 * also only scans `configuration.tmuxSessionName`, and the sole other reaper —
 * `reapOrphanedSessions` (`hapi launcher reap`, #1428) — no-ops while the daemon
 * is alive. So an archive->delete of a tmux-launcher session left the real claude
 * PID + its window orphaned with no automatic backstop, draining the bound
 * account's credits over time.
 *
 * Matching is by the pane's `HAPI_SESSION_ID` env (via `getWindowHapiSessionId`,
 * which walks the pane process tree) — NOT by window NAME, because the window
 * name embeds the SERVER session id while the DELETE path only carries the
 * session TAG (`HAPI_SESSION_ID`). This also matches every per-attempt-suffixed
 * variant (`-r1`, `-r2`, ...) that carries the same tag. The pane process tree
 * is killed BEFORE the window (the #849 rationale: `tmux kill-window` only
 * SIGHUPs the foreground process; MCP children in other groups survive).
 *
 * Best-effort: every tmux failure is logged and swallowed so a remote-reap
 * failure can never abort the broader DELETE teardown. Purely additive — it does
 * NOT touch `cleanupGhostWindows` / `detectTmuxNameChanges` (whose claim-set
 * filter was reverted after the #1349 archive+restart regression).
 *
 * Known edge (documented, out of scope per #1600 D1 / tracked by #1603): a window
 * whose claude has ALREADY exited is a `remain-on-exit` dead pane with no readable
 * `HAPI_SESSION_ID`, so it cannot be tag-matched here. This is window-only (no live
 * process / no credit drain) and is NOT produced by the archive->delete path —
 * window B's claude is reliably alive at delete time (the wrapper kill cannot reach
 * it). It remains covered by `hapi launcher reap` — and, when the caller can
 * supply `serverSessionId`, by the #1628 direct path below (exact-name kill
 * never reads the pane env, so dead panes ARE reapable there).
 *
 * #1628: when `serverSessionId` is provided (threaded from the server through
 * the `cleanup-tmux-session` / `reap-remote-window` RPCs — the server is where
 * the window-name-embedded UUID originates), a DIRECT exact-name kill path
 * runs BEFORE the enumeration sweep. The sweep itself stays UNCONDITIONAL: it
 * is the only path for callers without a UUID — the two daemon-internal
 * `stopTmuxSession` callers (run.ts worktree-rollback and daemon-stop)
 * INTENTIONALLY omit `serverSessionId` because the daemon holds no server
 * UUID at those points; do not invent a UUID lookup for them. Old-server →
 * new-daemon version skew likewise degrades safely (param absent →
 * enumeration-only → pre-#1628 behavior).
 */
export async function reapRemoteLauncherWindows(
  hapiSessionId: string,
  serverSessionId?: string
): Promise<number> {
  const remoteTmux = new TmuxManager({
    sessionName: configuration.tmuxRemoteSessionName,
    socketName: configuration.tmuxRemoteSessionName,
  });

  let reaped = 0;
  try {
    if (!(await remoteTmux.sessionExists())) {
      return 0;
    }

    // #1628 DIRECT PATH (runs FIRST when the caller supplied the server
    // session UUID): kill the deterministically-named window(s) via tmux
    // server-side exact-name resolution (`<session>:=<name>`), bypassing the
    // client-side list-windows output that is blind to fresh windows in the
    // daemon process context on tmux 3.4+ (SL7/WSL2 — the #1628 root cause).
    // Safety invariant: only per-session launcher windows live in
    // `hapimatic-remote`, and every candidate name embeds the TARGET
    // session's own UUID — an exact-name kill cannot resolve to another
    // session's window, so tag verification is deliberately skipped (it
    // would re-add the /proc walk AND make remain-on-exit dead panes
    // unreapable here). Probe ALL candidates without breaking on first hit:
    // a dead -r1 pane and a live -r2 can momentarily coexist during
    // burst-load retries. Any error falls through to the enumeration sweep
    // below (Fallback Preservation Rule) — never return early.
    if (serverSessionId) {
      try {
        for (const name of buildRemoteWindowCandidateNames(serverSessionId)) {
          const panePid = await remoteTmux.getWindowPidByExactName(name);
          if (panePid) {
            try {
              const result = await killProcessTree(panePid);
              if (result.killed.length > 0) {
                logger.info(
                  `[TmuxSpawnAdapter] #1628: killed ${result.killed.length} descendant process(es) of remote-launcher pane PID ${panePid} for window "${name}" (direct path)`
                );
              }
              if (result.survived.length > 0) {
                logger.warn(
                  `[TmuxSpawnAdapter] #1628: ${result.survived.length} remote-launcher process(es) survived kill: ${result.survived.join(", ")}`
                );
              }
            } catch (error) {
              logger.debug(
                `[TmuxSpawnAdapter] #1628: error killing remote-launcher process tree for PID ${panePid}:`,
                error
              );
            }
          }
          const killed = await remoteTmux.killWindowByExactName(
            remoteLauncherWindowTarget(remoteTmux, name)
          );
          if (killed) {
            reaped++;
            logger.info(
              `[TmuxSpawnAdapter] #1628: reaped orphan remote-launcher window "${name}" for session ${hapiSessionId} (direct path)`
            );
          }
        }
      } catch (error) {
        logger.warn(
          `[TmuxSpawnAdapter] #1628: direct-path reap for ${serverSessionId} hit an error (falling through to enumeration):`,
          error
        );
      }
    }

    const windows = await remoteTmux.listWindows();
    for (const window of windows) {
      if (!window.name.startsWith(TMUX_REMOTE_WINDOW_PREFIX)) continue;

      // The window NAME embeds the server session id; the canonical tag lives in
      // the pane's HAPI_SESSION_ID env — match on that (what the DELETE path has).
      // #1609: per-window ops use the row's own INDEX, not its name — name-based
      // lookups re-run list-windows, which is stale on tmux 3.4+ from the daemon
      // process context (the same root cause as the SL7 spawn failure).
      const windowTag = await remoteTmux.getWindowHapiSessionId(window.index);
      if (!shouldReapRemoteWindow(window.name, windowTag, hapiSessionId))
        continue;

      // Kill the pane process tree (real claude + MCP children) BEFORE the window.
      const panePid = await remoteTmux.getWindowPid(window.index);
      if (panePid) {
        try {
          const result = await killProcessTree(panePid);
          if (result.killed.length > 0) {
            logger.info(
              `[TmuxSpawnAdapter] #1600: killed ${result.killed.length} descendant process(es) of remote-launcher pane PID ${panePid} for ${hapiSessionId}`
            );
          }
          if (result.survived.length > 0) {
            logger.warn(
              `[TmuxSpawnAdapter] #1600: ${result.survived.length} remote-launcher process(es) survived kill: ${result.survived.join(", ")}`
            );
          }
        } catch (error) {
          logger.debug(
            `[TmuxSpawnAdapter] #1600: error killing remote-launcher process tree for PID ${panePid}:`,
            error
          );
        }
      }

      const killed = await remoteTmux.killWindow(
        remoteLauncherWindowTarget(remoteTmux, window.index)
      );
      if (killed) {
        reaped++;
        logger.info(
          `[TmuxSpawnAdapter] #1600: reaped orphan remote-launcher window "${window.name}" for session ${hapiSessionId}`
        );
      } else {
        logger.warn(
          `[TmuxSpawnAdapter] #1600: failed to kill remote-launcher window "${window.name}" for session ${hapiSessionId} (window may already be gone)`
        );
      }
    }
  } catch (error) {
    // Best-effort: a remote-reap failure must never abort the DELETE teardown.
    logger.warn(
      `[TmuxSpawnAdapter] #1600: remote-launcher reap for ${hapiSessionId} hit an error (continuing):`,
      error
    );
  }

  return reaped;
}

/**
 * Issue #1731: reap a genuinely-dead (paneDead) daemon-tracked tmux window.
 *
 * Called from the orphan-cleanup heartbeat's `paneDead` branch
 * (`daemon/run.ts`) AFTER the session is removed from `pidToTrackedSession`.
 * Returns `true` iff a window was killed.
 *
 * SAFE-BY-SCOPE (KD2): callers invoke this ONLY when `isPaneDead` is already
 * `true`, so it never touches a live-child window (R2) or an idle-shell
 * archive-for-reconnect window (R3, pane NOT dead). `archiveSession`
 * deliberately leaves window A as an idle `; exec bash` shell (`pane_dead=0`),
 * which is the idle-shell branch — never this one.
 *
 * Best-effort: `TmuxManager.killWindow` is already idempotent (returns `false`
 * on a missing window) and self-catching, but the try/catch here is
 * defense-in-depth so a future `killWindow` exception-contract change can never
 * abort the daemon's 60s heartbeat loop (mirrors the #1349 pattern above).
 *
 * Scope boundary (R4): this only reaps the per-instance daemon tmux window
 * inventory — it does NOT change the record-based count surfaces
 * (`sessions list`, web UI, `/federation/info`). See issue #1731 KD-A.
 */
export async function reapDeadPaneWindow(
  tmux: TmuxManager,
  // #4218 R13: an OWNED target only — the caller mints it with
  // resolveOwnedWindow(tmux, session.tmuxWindowId ?? session.tmuxWindow, tag).
  // A persisted @N is not enough: after a tmux-server restart it can name
  // another session's window.
  windowTarget: OwnedWindowTarget
): Promise<boolean> {
  try {
    return await tmux.killWindow(windowTarget);
  } catch (error) {
    logger.debug(
      `[TmuxSpawnAdapter] #1731: reapDeadPaneWindow("${windowTarget}") error:`,
      error
    );
    return false;
  }
}

/**
 * Issue #2683: set the `@hapi_archive` window user-option on a session's window,
 * marking it a DELIBERATE archive-for-reconnect so the orphan reconciliation
 * reaper (`reconcileOrphanWindows`) preserves it. Mirrors `renameTmuxWindow`'s
 * sessionId→window resolution via the persisted session store. Called by the
 * server BEFORE `killSession` for a live-session archive (see
 * sessionLifecycleOps.archiveSession `preserveForReconnect`). Best-effort +
 * idempotent (re-applying the option is a ms-scale no-op).
 */
export async function setArchiveTag(
  hapiSessionId: string
): Promise<{ success: boolean; message?: string }> {
  const tmux = new TmuxManager({
    sessionName: configuration.tmuxSessionName,
    socketName: configuration.tmuxSessionName,
  });
  const store = createSessionStore(configuration.happyHomeDir);
  const session = await store.get(hapiSessionId);
  const windowName = session?.tmuxWindow;
  if (!windowName) {
    logger.debug(
      `[TmuxSpawnAdapter] #2683 setArchiveTag: no tmux window for session ${hapiSessionId}`
    );
    return { success: false, message: "Session has no tmux window" };
  }
  // #3734/#4218: tag only a window this session OWNS — tagging another
  // session's window (a same-named sibling, or the holder of a recycled @N
  // after a tmux-server restart) would let it survive an orphan reap it should
  // not, and mis-classify it on a later crash.
  const owned = await resolveOwnedWindow(
    tmux,
    session?.tmuxWindowId ?? windowName,
    hapiSessionId
  );
  if (owned.kind !== "owned") {
    const why = describeOwnershipFailure(owned);
    logger.warn(
      `[TmuxSpawnAdapter] #2683 setArchiveTag: window "${windowName}" is not provably session ${hapiSessionId}'s (${why}) — not tagging`
    );
    return {
      success: false,
      message: `Session window is not owned by this session (${why})`,
    };
  }
  const ok = await tmux.setWindowOption(
    owned.target,
    TMUX_ARCHIVE_USER_OPTION,
    "1"
  );
  if (ok) {
    logger.info(
      `[TmuxSpawnAdapter] #2683 tagged archive-for-reconnect window "${windowName}" (session ${hapiSessionId})`
    );
  } else {
    logger.warn(
      `[TmuxSpawnAdapter] #2683 setArchiveTag failed to tag window "${windowName}" (session ${hapiSessionId})`
    );
  }
  return { success: ok };
}

/**
 * Issue #2683: signature the pane-start-command of a daemon-spawned SESSION
 * window carries (`bash /tmp/hapi-spawn-<id>.sh ; … ; exec bash`). It survives
 * the trailing `exec bash`, so it positively distinguishes a leaked session
 * window from the `ensureSession` placeholder / any non-session window.
 */
export const HAPI_SPAWN_PANE_SIGNATURE = "hapi-spawn-";

/**
 * Issue #2683: consecutive maintenance-loop ticks (~60s each) a window must be
 * observed as a death-orphan before it is reaped. The debounce gives a just-
 * archived window time for its `@hapi_archive` tag write to land and absorbs a
 * transient `hasActiveChildren` proc-read fault.
 */
export const ORPHAN_REAP_DEBOUNCE_TICKS = 2;

/**
 * Issue #2683: the LEAK FIX. Reconcile the FULL daemon tmux inventory against the
 * set of active tracked windows + the `@hapi_archive` tag, reaping death-orphan
 * idle-shell windows the `pidToTrackedSession`-only maintenance loop can never
 * see (they were untracked by the idle-shell branch WITHOUT being reaped, or
 * leaked by a failed `cleanup-tmux-session` delete — #2683 findings 1/6).
 *
 * SAFETY (load-bearing — this runs on prod):
 *  - Only touches windows POSITIVELY identified as leaked session panes via the
 *    `hapi-spawn-` `pane_start_command` signature — NEVER the placeholder window.
 *  - NEVER touches a live-child window: the idle-shell gate (`!hasActiveChildren`)
 *    means Claude has already exited (`exec bash` → childless pane PID). Worst
 *    case a mis-reap kills only an idle bash shell; the reconnect path respawns
 *    fresh via `--resume` (session context preserved). It can NOT kill a live
 *    Claude — the fundamental invariant, same signal as #633/#1682.
 *  - Preserves deliberate archive-for-reconnect windows via `@hapi_archive`.
 *  - Preserves active sessions via `activeWindowIndexes` (by INDEX, not name —
 *    #3734 Task 2(d): a same-named leaked duplicate has a different index, so
 *    name-keying would spare it; and it kills by index, never a name first-match).
 *  - Requires ORPHAN_REAP_DEBOUNCE_TICKS consecutive observations before reaping.
 *  - Does NOT touch `decideWrapperAlive` / the `!paneDead` predicate.
 *
 * #2646 CONTRACT (semantic hasActiveChildren invariant): this reaper — like
 * `decideWrapperAlive` and `computeEffectiveCount` — depends on the pane running
 * `<launchCmd> ; exec bash` so a dead Claude leaves a childless pane PID. #2646's
 * bwrap jail MUST wrap only `launchCmd` and keep `; exec bash` host-side, else a
 * dead session's pane keeps the jail child forever and this predicate never
 * matches. #2683's churn test MUST run with HAPI_OMNIBOX_SANDBOX=1 to guard it.
 *
 * Returns the names of reaped windows. Mutates `debounce` in place. Best-effort:
 * a `killWindow` failure never throws (mirrors reapDeadPaneWindow #1731).
 */
export async function reconcileOrphanWindows(
  tmux: Pick<TmuxManager, "hasActiveChildren" | "killWindow">,
  windows: TmuxWindow[],
  activeWindowIndexes: Set<number>,
  debounce: Map<number, number>
): Promise<string[]> {
  const reaped: string[] = [];
  const candidatesThisTick = new Set<number>();

  for (const w of windows) {
    // Dead panes are owned by the #1731 paneDead reaper — never here.
    if (w.paneDead) continue;
    // Positive session-window identification (excludes placeholder / control).
    if (!w.paneStartCommand?.includes(HAPI_SPAWN_PANE_SIGNATURE)) continue;
    // #3734 Task 2(d): preserve the active tracked windows by INDEX, not name.
    // A leaked duplicate that shares a tracked session's NAME has a DIFFERENT
    // index, so name-keying would wrongly SPARE it (leak); index-keying reaps
    // it. Index is stable per window (renumber-windows off) and collision-free.
    if (activeWindowIndexes.has(w.index)) continue;
    // Deliberate archive-for-reconnect — positively tagged, preserve.
    if (w.archiveTag) continue;
    // Idle-shell gate (mirrors the #633/#1682 predicate): a falsy pane PID is a
    // tmux fault → preserve; a live child means Claude is running → NEVER reap.
    if (!w.panePid) continue;
    if (await tmux.hasActiveChildren(w.panePid)) {
      debounce.delete(w.index);
      continue;
    }
    // Death-orphan candidate. Require sustained observation before reaping.
    candidatesThisTick.add(w.index);
    const ticks = (debounce.get(w.index) ?? 0) + 1;
    if (ticks < ORPHAN_REAP_DEBOUNCE_TICKS) {
      debounce.set(w.index, ticks);
      continue;
    }
    debounce.delete(w.index);
    try {
      // #3734 Task 2(d): kill by the specific window INDEX, not the name.
      // killWindow(w.name) resolves by first-match, which could target a
      // DIFFERENT same-named window than the orphan `w` the reaper identified —
      // including a live one. The index addresses exactly `w`.
      const killed = await tmux.killWindow(reaperWindowTarget(w));
      if (killed) {
        reaped.push(w.name);
        logger.info(
          `[TmuxSpawnAdapter] #2683 reaped orphan idle-shell window "${w.name}" (index ${w.index}, untagged, no active session, ${ORPHAN_REAP_DEBOUNCE_TICKS} ticks)`
        );
      }
    } catch (error) {
      // Best-effort — a reap failure must never abort the maintenance loop.
      logger.debug(
        `[TmuxSpawnAdapter] #2683 reconcileOrphanWindows killWindow(index ${w.index}) error:`,
        error
      );
    }
  }

  // Reset the debounce for windows that stopped being candidates (recovered,
  // vanished, or gained children) so a reused index starts fresh next time.
  for (const idx of Array.from(debounce.keys())) {
    if (!candidatesThisTick.has(idx)) debounce.delete(idx);
  }

  return reaped;
}

/** Why the delete path refused to kill a window (#4218 Task 2). */
export type DeleteRefusalReason =
  | "window-gone-with-id"
  | "window-gone"
  | `foreign-identity:${string}`
  | "ambiguous"
  | "unverifiable";

/**
 * Issue #4218 (pure, CI): the NAME tier of the delete resolver — reached only
 * for a legacy record with no persisted `@N`. `matches` are the windows whose
 * name equals the record's `tmuxWindow`; `procTag` is the `HAPI_SESSION_ID` in
 * the single match's pane tree (read only when its identity is empty). Accepts
 * exactly one match that `tag` owns; everything else refuses with a reason.
 */
export function decideNameKillOwnership(input: {
  matches: ReadonlyArray<{ id: string; identity: string | null }>;
  tag: string;
  procTag: string | null;
}): { accept: string } | { refuse: DeleteRefusalReason } {
  if (input.matches.length === 0) return { refuse: "window-gone" };
  if (input.matches.length > 1) return { refuse: "ambiguous" };
  const only = input.matches[0]!;
  if (only.identity) {
    return only.identity === input.tag
      ? { accept: only.id }
      : { refuse: `foreign-identity:${only.identity}` };
  }
  if (input.procTag === input.tag) return { accept: only.id };
  return input.procTag
    ? { refuse: `foreign-identity:${input.procTag}` }
    : { refuse: "unverifiable" };
}

function refusalFromResult(
  result: Exclude<OwnershipResult, { kind: "owned" }>,
  hadId: boolean
): DeleteRefusalReason {
  if (result.kind === "fault") return "unverifiable";
  if (result.reason === "window-gone") {
    return hadId ? "window-gone-with-id" : "window-gone";
  }
  if (result.reason === "foreign-identity") {
    return `foreign-identity:${result.identity ?? "unknown"}`;
  }
  return "unverifiable";
}

/**
 * Issue #3734/#4218: resolve the window a DELETE may kill — only a window the
 * session OWNS (`@hapi_identity === tag`, or for an identity-less window the
 * pane tree's `HAPI_SESSION_ID === tag`). Tiers, in order:
 *
 *  1. the persisted `@N` — accepted only if it exists AND is owned. An `@N` is
 *     an address within ONE tmux-server lifetime: after a server restart the
 *     same id can name another session's live window (#4238), so existence
 *     alone proves nothing. A stale or recycled id falls through to tier 2.
 *  2. the `@hapi_identity === tag` row (unchanged from #3732).
 *  3. the record's window NAME — only when no `@N` was ever persisted (a
 *     legacy record), and only for exactly one match that is owned
 *     ({@link decideNameKillOwnership}). Never reached for a record that had an
 *     id, so a stale record cannot reach a same-titled live window by name.
 *
 * Anything else refuses with a reason. ⚠️ Legacy windows: ownership of an
 * identity-less window is provable only while Claude (or bwrap) still runs
 * under the pane — an idle `exec bash` pane has no `HAPI_SESSION_ID`, so the
 * common legacy delete REFUSES and `reconcileOrphanWindows` reclaims the window
 * after its debounce. Never kills, never mutates; a tmux fault refuses
 * (`unverifiable`).
 */
export async function resolveOwnedWindowForDelete(
  tmux: TmuxManager,
  session: Pick<PersistedSession, "tmuxWindowId" | "tmuxWindow">,
  tag: string
): Promise<{ id: OwnedWindowTarget } | { refuse: DeleteRefusalReason }> {
  let idTierRefusal: DeleteRefusalReason | null = null;
  if (session.tmuxWindowId) {
    const byId = await resolveOwnedWindow(tmux, session.tmuxWindowId, tag);
    if (byId.kind === "owned") return { id: byId.target };
    if (byId.kind === "fault") {
      logger.warn(
        `[TmuxSpawnAdapter] #4218: ownership read for ${session.tmuxWindowId} (session ${tag}) failed — not killing: ${byId.error}`
      );
      return { refuse: "unverifiable" };
    }
    idTierRefusal = refusalFromResult(byId, true);
    if (byId.reason !== "window-gone") {
      logger.warn(
        `[TmuxSpawnAdapter] #4218: persisted window id ${session.tmuxWindowId} for ${tag} is not this session's window (${idTierRefusal}) — stale id from an earlier tmux-server lifetime?`
      );
    }
  }

  const rows = await tmux.listWindowIdentities();
  const own = rows.find(r => r.identity === tag && r.id);
  if (own?.id) {
    const byIdentity = await resolveOwnedWindow(tmux, own.id, tag);
    if (byIdentity.kind === "owned") return { id: byIdentity.target };
  }

  if (idTierRefusal) return { refuse: idTierRefusal };
  if (!session.tmuxWindow) return { refuse: "window-gone" };

  let matches: Array<{ id: string; identity: string | null }>;
  try {
    matches = (await tmux.listWindowsWithIdentity()).filter(
      w => w.name === session.tmuxWindow
    );
  } catch (error) {
    logger.warn(
      `[TmuxSpawnAdapter] #4218: name lookup for "${session.tmuxWindow}" (session ${tag}) failed — not killing: ${error}`
    );
    return { refuse: "unverifiable" };
  }
  const single = matches.length === 1 ? matches[0] : undefined;
  const procTag =
    single && !single.identity
      ? await tmux.getWindowHapiSessionId(single.id)
      : null;
  const decision = decideNameKillOwnership({ matches, tag, procTag });
  if ("refuse" in decision) return decision;
  const byName = await resolveOwnedWindow(tmux, decision.accept, tag);
  if (byName.kind === "owned") return { id: byName.target };
  return { refuse: refusalFromResult(byName, false) };
}

/**
 * Issue #849/#3734/#4218: kill a window AND its full process tree. The choke
 * point every daemon-socket kill-with-tree goes through: it RE-CHECKS
 * ownership first (`resolveOwnedWindow` on the `@N`), so a stale `@N` that now
 * names another session's window is never killed — the window of exposure
 * shrinks to a tmux-server restart between this check and the kill. Any result
 * but `owned` refuses; a tmux fault is logged as a fault, never as a stale id
 * (the refusal is the same, the diagnosis is not). killProcessTree runs
 * BEFORE kill-window because kill-window only SIGHUPs the pane's foreground
 * process — MCP servers in other process groups survive (#849). Returns true
 * only after a real kill. Best-effort throughout (never throws).
 *
 * DAEMON socket only — never call it for a `hapimatic-remote` window, where
 * `@hapi_identity` is a display name (`reapRemoteLauncherWindows` matches those
 * by `HAPI_SESSION_ID` instead).
 */
export async function killWindowWithTree(
  tmux: TmuxManager,
  target: OwnedWindowTarget,
  tag: string
): Promise<boolean> {
  const owned =
    typeof target === "string"
      ? await resolveOwnedWindow(tmux, target, tag)
      : null;
  if (owned?.kind !== "owned") {
    let why: string;
    if (owned === null) {
      why = "a numeric target cannot be ownership-checked";
    } else if (
      owned.kind === "not-owned" &&
      owned.reason === "foreign-identity"
    ) {
      why = `${describeOwnershipFailure(owned)} — stale id from an earlier tmux-server lifetime`;
    } else {
      why = describeOwnershipFailure(owned);
    }
    logger.warn(
      `[TmuxSpawnAdapter] #4218: window ${target} is not provably ${tag}'s (${why}) — not killing`
    );
    return false;
  }
  // Act on the window that was CHECKED: the verified `@N`, never the original
  // target (a name would re-resolve to the FIRST same-named window, which can
  // be a sibling's).
  const verified = owned.target;
  const panePid = await tmux.getWindowPid(verified);
  if (panePid) {
    try {
      const result = await killProcessTree(panePid);
      if (result.killed.length > 0) {
        logger.info(
          `[TmuxSpawnAdapter] Killed ${result.killed.length} descendant processes of PID ${panePid}`
        );
      }
      if (result.survived.length > 0) {
        logger.warn(
          `[TmuxSpawnAdapter] ${result.survived.length} processes survived kill: ${result.survived.join(", ")}`
        );
      }
    } catch (error) {
      logger.debug(
        `[TmuxSpawnAdapter] Error killing process tree for PID ${panePid}:`,
        error
      );
    }
  }
  await tmux.resetWindowTerminal(verified);
  await sleep(100);
  return tmux.killWindow(verified);
}

/**
 * Issue #3732 Task 4: reap EVERY window carrying this session's `@hapi_identity`
 * (leaked duplicates whose kill RPC missed — the ms1 6-window case), EXCEPT the
 * window already handled (`exceptId`). Exact-TAG equality only — never touches
 * another session's window. Each target is minted by `resolveOwnedWindow` and
 * killed via {@link killWindowWithTree} (which re-checks ownership). Returns
 * the count actually reaped.
 */
async function reapWindowsByIdentity(
  tmux: TmuxManager,
  hapiSessionId: string,
  exceptId: string | null
): Promise<number> {
  let reaped = 0;
  const rows = await tmux.listWindowIdentities();
  for (const row of rows) {
    if (row.identity !== hapiSessionId) continue;
    if (!row.id || row.id === exceptId) continue;
    const owned = await resolveOwnedWindow(tmux, row.id, hapiSessionId);
    if (owned.kind !== "owned") {
      logger.warn(
        `[TmuxSpawnAdapter] #4218: identity reap skipped window ${row.id} for ${hapiSessionId} (${describeOwnershipFailure(owned)})`
      );
      continue;
    }
    logger.info(
      `[TmuxSpawnAdapter] #3732 delete-dedupe: reaping leaked duplicate window ${row.id} for session ${hapiSessionId}`
    );
    if (await killWindowWithTree(tmux, owned.target, hapiSessionId)) reaped++;
  }
  return reaped;
}

/**
 * Stop a tmux-backed session
 */
export async function stopTmuxSession(
  hapiSessionId: string,
  serverSessionId?: string
): Promise<boolean> {
  const tmux = new TmuxManager({
    sessionName: configuration.tmuxSessionName,
    socketName: configuration.tmuxSessionName,
  });
  const store = createSessionStore(configuration.happyHomeDir);

  // #1600: reap the tmux-LAUNCHER's remote window FIRST — unconditionally,
  // BEFORE the window-A store-record early-return below. Under
  // HAPI_CLAUDE_LAUNCHER=tmux the real claude lives in a separate
  // `hapimatic-remote` window that the window-A teardown never touches; this
  // is the only DELETE-path reaper for it. Running it before the `!session`
  // guard guarantees the remote window is reaped even when the window-A store
  // record is already gone (e.g. a prior partial cleanup).
  await reapRemoteLauncherWindows(hapiSessionId, serverSessionId);

  const session = await store.get(hapiSessionId);
  if (!session) {
    logger.debug(`[TmuxSpawnAdapter] Session not found: ${hapiSessionId}`);
    return false;
  }

  // #3734/#3732/#4218: kill only a window this session OWNS — never one found
  // by the collision-prone name, and never a persisted `@N` that a tmux-server
  // restart handed to another session (the bug #4218 fixes). Kill the window's
  // process tree BEFORE the window (kill-window only SIGHUPs the foreground —
  // MCP servers in other process groups survive, #849), then reap EVERY leaked
  // duplicate carrying this session's @hapi_identity (#3732 Task 4a).
  //
  // Refuse-path contract (#4218 R1): a refusal skips ONLY the kill. The
  // identity reap below, the codexHome cleanup and the store removal still
  // run, and the call still returns true — a record left behind with a
  // recycled `@N` would hand the rename detector another wrong kill. No early
  // return here.
  const resolved = await resolveOwnedWindowForDelete(
    tmux,
    session,
    hapiSessionId
  );
  // Set only after a REAL kill: a kill that did not happen (a transient fault
  // on the choke point's re-check) leaves the window for the identity reap.
  let handledId: string | null = null;
  if ("id" in resolved) {
    const killed = await killWindowWithTree(tmux, resolved.id, hapiSessionId);
    if (killed) handledId = String(resolved.id);
    logger.debug(
      `[TmuxSpawnAdapter] ${killed ? "Reset and killed" : "Could not kill"} tmux window ${resolved.id} (session ${hapiSessionId})`
    );
  } else {
    logger.warn(
      `[TmuxSpawnAdapter] #4218: delete of ${hapiSessionId} refused to kill a window (${resolved.refuse}) — removing the record; the refused window is not killed by this delete (if a tmux fault hid this session's own window, it keeps running — #4453)`
    );
  }

  // #3732 Task 4a: reap any REMAINING windows carrying this session's identity
  // (leaked duplicates whose kill RPC missed). Skips the window already handled
  // above (handledId). Exact-TAG equality — never another session's window.
  const dupsReaped = await reapWindowsByIdentity(
    tmux,
    hapiSessionId,
    handledId
  );
  if (dupsReaped > 0) {
    logger.info(
      `[TmuxSpawnAdapter] #3732 delete-dedupe: reaped ${dupsReaped} leaked duplicate window(s) for session ${hapiSessionId}`
    );
  }

  // Issue #1082 (ruling D4): remove the durable per-session CODEX_HOME on
  // delete (holds auth.json/config.toml + the sessions/ resume JSONL). This is
  // the counterpart to #1733's delete-on-exit for the direct-spawn path — for
  // tmux the dir is SESSION-lifetime, so it's reclaimed here (and orphan-GC'd
  // by recovery for crash cases). Best-effort — must not block teardown.
  if (session.codexHome) {
    await fs
      .rm(session.codexHome, { recursive: true, force: true })
      .catch(err => {
        logger.debug(
          `[TmuxSpawnAdapter] Failed to remove codexHome ${session.codexHome}: ${err}`
        );
      });
  }

  // Remove from store
  await store.remove(hapiSessionId);
  logger.info(
    `[TmuxSpawnAdapter] Session stopped and removed: ${hapiSessionId}`
  );

  return true;
}

// ==================== Window ownership routing (issue #4038) ====================
//
// A persisted `@N` is unique only within ONE tmux-server lifetime: after a
// server restart tmux numbers windows from `@0` again, so an old record's `@N`
// can address ANOTHER session's live window. The rename detector used to read
// that window's title and push it onto the old session (the cross-write), the
// rename sync renamed the other session's window (the reverse cross-write), and
// the detector stale-kill could kill it. Every one of these sites now checks
// ownership with `resolveOwnedWindow` (K1); the read, rename and rehabilitate
// paths route through the pure decisions below.
//
// A not-owned id is KEPT, never cleared (operator ruling on the #4218 close):
// a cleared id makes the record look id-less, so the next daemon start
// (`markAllOffline` resets the status) would let `RecoveryService` reach the
// NAME tier — a same-titled live window. The identity row, when one exists, is
// the only replacement for the persisted id.

/** The K1 outcome of one `resolveOwnedWindow` call, flattened for the pure deciders. */
export type OwnershipKind =
  | "owned"
  | "window-gone"
  | "foreign-identity"
  | "unverifiable"
  | "fault";

export function ownershipKind(result: OwnershipResult): OwnershipKind {
  if (result.kind === "not-owned") return result.reason;
  return result.kind;
}

/**
 * How to reach an id-tracked session's OWN window (the rename detector's id
 * branch and `renameTmuxWindow`).
 *
 *  - `use`: the persisted `@N` is owned (`adoptId` null), or it is not but a
 *    fresh listing has this session's `@hapi_identity` row (`adoptId` = that
 *    row's `@N`, persisted by the caller — `RecoveryService` tier 2 does the
 *    same). Never by name.
 *  - `stale-kept`: no owned window. Push no rename, rename nothing, keep the
 *    id. `log` is false for `window-gone` (an absent window is a disappearance
 *    for recovery, not a recycle).
 *  - `fault`: the ownership read on the persisted `@N` failed, or the identity
 *    listing failed while that `@N` was not owned — do nothing this pass (the
 *    next one retries), and never call it a stale id.
 */
export type TrackedWindowRoute =
  | { kind: "use"; adoptId: string | null }
  | { kind: "stale-kept"; log: boolean }
  | { kind: "fault" };

export function decideTrackedWindowRoute(input: {
  byId: OwnershipKind;
  /** `@N` of the listing row whose `@hapi_identity` is this tag; null when none. */
  identityRowId: string | null;
  /** The identity listing was needed and faulted (so "no row" proves nothing). */
  listingFaulted?: boolean;
}): TrackedWindowRoute {
  if (input.byId === "owned") return { kind: "use", adoptId: null };
  if (input.byId === "fault") return { kind: "fault" };
  if (input.identityRowId) return { kind: "use", adoptId: input.identityRowId };
  if (input.listingFaulted) return { kind: "fault" };
  return { kind: "stale-kept", log: input.byId !== "window-gone" };
}

/**
 * The rename detector's verdict for one id-tracked session: a rename is pushed
 * ONLY for a window the session owns whose name differs from the stored one.
 * Anything else (stale, foreign, faulted) pushes nothing.
 */
export function decideDetectorAction(input: {
  route: TrackedWindowRoute;
  currentName: string | null;
  storedName: string;
}): "rename" | "none" {
  if (input.route.kind !== "use") return "none";
  return input.currentName && input.currentName !== input.storedName
    ? "rename"
    : "none";
}

/**
 * Issue #1351 rehabilitation (`error` → `active`), gated on OWNERSHIP: server
 * presence alone is not enough, because an old record can be on the server
 * while its window is long gone and its `@N` now names another session's
 * window. `rows` is the sweep's shared `listWindowsWithIdentity()` snapshot
 * (re-fetched after a stale-kill; null when it faulted → keep `error`; the next
 * sweep retries).
 *
 *  - an `@hapi_identity === tag` row → rehabilitate (adopting its `@N`);
 *  - otherwise an identity-less candidate window (legacy, pre-identity) →
 *    `probe` it with `resolveOwnedWindow` (the pane env arm); the candidate is
 *    the persisted `@N`, or — only for a record that never had an `@N` — the
 *    single window holding the stored name (#4218 F2: a record whose id went
 *    stale never reaches a window by name);
 *  - anything else stays `error`.
 */
export type RehabilitationDecision =
  | { kind: "rehabilitate"; adoptId: string }
  | { kind: "probe"; target: string }
  | { kind: "keep-error" };

export function decideRehabilitation(input: {
  tag: string;
  tmuxWindowId?: string | null;
  tmuxWindow?: string;
  rows: ReadonlyArray<{
    id: string;
    identity: string | null;
    name: string;
  }> | null;
}): RehabilitationDecision {
  const { rows, tag } = input;
  if (!rows) return { kind: "keep-error" };
  const own = rows.find(r => r.identity === tag && r.id);
  if (own) return { kind: "rehabilitate", adoptId: own.id };
  let candidate: { id: string; identity: string | null } | undefined;
  if (input.tmuxWindowId) {
    candidate = rows.find(r => r.id === input.tmuxWindowId);
  } else if (input.tmuxWindow) {
    const named = rows.filter(r => r.name === input.tmuxWindow && r.id);
    candidate = named.length === 1 ? named[0] : undefined;
  }
  if (candidate && !candidate.identity) {
    return { kind: "probe", target: candidate.id };
  }
  return { kind: "keep-error" };
}

/**
 * `stale window id` warnings already logged, keyed `<tag> <@N>`. The detector
 * runs every 60 s and a kept stale id stays stale, so it warns ONCE per
 * (session, id) — the same wording as `RecoveryService`'s line, so
 * `grep -F "stale window id"` finds both.
 */
const loggedStaleWindowIds = new Set<string>();

function warnStaleWindowIdOnce(tag: string, windowId: string): void {
  const key = `${tag} ${windowId}`;
  if (loggedStaleWindowIds.has(key)) return;
  loggedStaleWindowIds.add(key);
  logger.warn(
    `[TmuxSpawnAdapter] stale window id ${windowId} for ${tag} (tmux server restarted?) — kept; identity tier only`
  );
}

/**
 * A tmux fault on a tracked id's ownership read leaves that session's renames
 * unsynced until tmux recovers — warn once per (session, id), so a persistent
 * fault is visible without a line every 60 s.
 */
function warnOwnershipFaultOnce(
  tag: string,
  windowId: string,
  reason: string
): void {
  const key = `fault ${tag} ${windowId}`;
  if (loggedStaleWindowIds.has(key)) return;
  loggedStaleWindowIds.add(key);
  logger.warn(
    `[TmuxSpawnAdapter] ownership read failed for window ${windowId} of ${tag} — skipping rename sync until it succeeds (${reason})`
  );
}

/** Test-only: forget which stale ids / faults were already logged. */
export function resetStaleWindowIdLogForTest(): void {
  loggedStaleWindowIds.clear();
}

/**
 * The `@N` of this tag's `@hapi_identity` row in a listing, or null.
 */
function identityRowIdFor(
  rows: ReadonlyArray<{ id: string; identity: string | null }> | null,
  tag: string
): string | null {
  return rows?.find(r => r.identity === tag && r.id)?.id ?? null;
}

type IdentityRows = Array<{
  id: string;
  identity: string | null;
  name: string;
}>;

/** One identity listing; a tmux fault reads as null (every caller then takes its safe branch). */
async function listIdentityRowsSafe(
  tmux: TmuxManager,
  site: string
): Promise<IdentityRows | null> {
  try {
    return await tmux.listWindowsWithIdentity();
  } catch (error) {
    logger.warn(
      `[TmuxSpawnAdapter] ${site}: identity listing failed: ${error}`
    );
    return null;
  }
}

/**
 * Route an id-tracked session to its OWN window — the one ownership sequence
 * the rename detector and `renameTmuxWindow` share: K1 on the persisted `@N`,
 * then (only when it is not owned) the `@hapi_identity` row, never the name.
 * Warns once when the id is kept stale. `getRows` lets the detector reuse its
 * per-sweep listing.
 */
async function routeTrackedWindow(
  tmux: TmuxManager,
  windowId: string,
  tag: string,
  getRows: () => Promise<IdentityRows | null>
): Promise<{ byId: OwnershipResult; route: TrackedWindowRoute }> {
  const byId = await resolveOwnedWindow(tmux, windowId, tag);
  const rows = byId.kind === "not-owned" ? await getRows() : undefined;
  const route = decideTrackedWindowRoute({
    byId: ownershipKind(byId),
    identityRowId: rows ? identityRowIdFor(rows, tag) : null,
    listingFaulted: rows === null,
  });
  if (route.kind === "stale-kept" && route.log) {
    warnStaleWindowIdOnce(tag, windowId);
  } else if (route.kind === "fault" && byId.kind === "fault") {
    // The listing-fault case is already warned by listIdentityRowsSafe.
    warnOwnershipFaultOnce(tag, windowId, describeOwnershipFailure(byId));
  }
  return { byId, route };
}

/**
 * Rename a tmux window associated with a session
 */
export async function renameTmuxWindow(
  hapiSessionId: string,
  newName: string
): Promise<{ success: boolean; message?: string }> {
  const tmux = new TmuxManager({
    sessionName: configuration.tmuxSessionName,
    socketName: configuration.tmuxSessionName,
  });
  const store = createSessionStore(configuration.happyHomeDir);

  // Skip server→tmux renames for sessions that were recently deduplicated.
  // The server may push its original name (e.g., "test") before the CLI
  // reports the adjusted name (e.g., "test 1"), which would undo deduplication.
  if (wasRecentlyDeduplicated(hapiSessionId)) {
    logger.info(
      `[TmuxSpawnAdapter] Skipping server→tmux rename for recently-deduplicated session ${hapiSessionId}`
    );
    return {
      success: true,
      message: "Skipped — recently deduplicated (dedup protection)",
    };
  }

  const session = await store.get(hapiSessionId);
  if (!session) {
    logger.debug(
      `[TmuxSpawnAdapter] Session not found for rename: ${hapiSessionId}`
    );
    return { success: false, message: "Session not found in tmux store" };
  }

  const oldName = session.tmuxWindow;
  if (!oldName) {
    logger.debug(
      `[TmuxSpawnAdapter] Session has no tmux window: ${hapiSessionId}`
    );
    return { success: false, message: "Session has no tmux window" };
  }

  // #3734 + #4038: rename only the session's OWN window. An id-tracked record
  // is checked on its @N, then — if that id is stale (a tmux-server restart
  // recycled it onto another session's window) — on its `@hapi_identity` row;
  // never by name, because a cross-written record's name is the live holder's
  // title (the reverse cross-write). A record that never had an @N resolves its
  // stored name to the single window holding it — or, among several
  // same-named windows, the one whose identity is this session — else refused.
  let owned: OwnershipResult;
  let adoptId: string | null = null;
  if (session.tmuxWindowId) {
    const { byId, route } = await routeTrackedWindow(
      tmux,
      session.tmuxWindowId,
      hapiSessionId,
      () => listIdentityRowsSafe(tmux, `rename sync for ${hapiSessionId}`)
    );
    // Mint the brand on the adopted id; every other route keeps byId, which is
    // `owned` only on the owned-@N route (a stale or faulted id refuses below).
    adoptId = route.kind === "use" ? route.adoptId : null;
    owned = adoptId
      ? await resolveOwnedWindow(tmux, adoptId, hapiSessionId)
      : byId;
  } else {
    owned = await resolveOwnedWindow(tmux, oldName, hapiSessionId);
  }
  if (owned.kind !== "owned") {
    logger.warn(
      `[TmuxSpawnAdapter] Not renaming tmux window "${oldName}" (${session.tmuxWindowId ?? "no @N"}) for session ${hapiSessionId}: no owned window (${describeOwnershipFailure(owned)})`
    );
    return {
      success: false,
      message: `Session owns no tmux window to rename (${describeOwnershipFailure(owned)})`,
    };
  }

  const success = await tmux.renameWindow(owned.target, newName);
  if (success) {
    // Update the session store with the new window name (and the adopted @N
    // when the persisted one was stale).
    session.tmuxWindow = newName;
    if (adoptId) session.tmuxWindowId = adoptId;
    await store.save(session);

    // Record this rename to prevent bi-directional sync loop
    // Phase 2: When polling detects this change, it will skip syncing it back
    recordHapimaticRename(hapiSessionId);

    logger.info(
      `[TmuxSpawnAdapter] Renamed tmux window "${oldName}" to "${newName}" for session ${hapiSessionId}`
    );
    return { success: true };
  }

  return { success: false, message: "Failed to rename tmux window" };
}

/**
 * Check if a session ID is a tmux-backed session
 */
export async function isTmuxSession(sessionId: string): Promise<boolean> {
  const store = createSessionStore(configuration.happyHomeDir);
  const session = await store.get(sessionId);
  return session !== null;
}

// ==================== Bi-directional Sync (Phase 2) ====================

/**
 * Track when Hapimatic renamed a tmux window to prevent sync loops.
 * Key: hapiSessionId, Value: timestamp of last rename by Hapimatic
 */
const lastRenamedByHapimatic: Map<string, number> = new Map();

/**
 * Debounce time in ms - if Hapimatic renamed within this window, skip sync
 * Set to 60 seconds to be safe (allows for network delays)
 */
const RENAME_DEBOUNCE_MS = 60_000;

/**
 * Track sessions whose tmux window name was deduplicated during spawn.
 * The server initially has the user-provided name and may push it to tmux
 * via rename-tmux-window RPC before the CLI reports the adjusted name.
 * This debounce prevents that server→tmux rename from undoing deduplication.
 * Key: hapiSessionId, Value: timestamp of deduplication
 */
const recentlyDeduplicatedSessions: Map<string, number> = new Map();
const DEDUP_DEBOUNCE_MS = 30_000; // 30 seconds

/**
 * Record that a session's tmux window name was deduplicated during spawn.
 */
function recordDeduplication(hapiSessionId: string): void {
  recentlyDeduplicatedSessions.set(hapiSessionId, Date.now());
  logger.debug(
    `[TmuxSpawnAdapter] Recorded deduplication for session ${hapiSessionId}`
  );
}

/**
 * Check if a session was recently deduplicated (within debounce window).
 * If true, server→tmux renames should be skipped to preserve the dedup name.
 */
function wasRecentlyDeduplicated(hapiSessionId: string): boolean {
  const timestamp = recentlyDeduplicatedSessions.get(hapiSessionId);
  if (!timestamp) return false;

  const elapsed = Date.now() - timestamp;
  if (elapsed < DEDUP_DEBOUNCE_MS) {
    return true;
  }

  recentlyDeduplicatedSessions.delete(hapiSessionId);
  return false;
}

/**
 * Record that Hapimatic just renamed a session's tmux window.
 * Call this after a successful Hapimatic → Tmux rename to prevent loop.
 */
export function recordHapimaticRename(hapiSessionId: string): void {
  lastRenamedByHapimatic.set(hapiSessionId, Date.now());
  logger.debug(
    `[TmuxSpawnAdapter] Recorded Hapimatic rename for session ${hapiSessionId}`
  );
}

/**
 * Check if a rename was recently initiated by Hapimatic (within debounce window).
 * If true, we should NOT sync back to prevent infinite loops.
 */
function wasRecentlyRenamedByHapimatic(hapiSessionId: string): boolean {
  const timestamp = lastRenamedByHapimatic.get(hapiSessionId);
  if (!timestamp) return false;

  const elapsed = Date.now() - timestamp;
  if (elapsed < RENAME_DEBOUNCE_MS) {
    logger.debug(
      `[TmuxSpawnAdapter] Session ${hapiSessionId} was renamed by Hapimatic ${elapsed}ms ago, skipping sync`
    );
    return true;
  }

  // Cleanup old entry
  lastRenamedByHapimatic.delete(hapiSessionId);
  return false;
}

/**
 * Check all tmux sessions for name changes and return list of changes to sync.
 * This is the core of bi-directional sync: detect if user renamed via tmux CLI.
 */
export async function detectTmuxNameChanges(
  serverSessionTags?: Set<string>
): Promise<
  Array<{
    hapiSessionId: string;
    oldName: string;
    newName: string;
  }>
> {
  const store = createSessionStore(configuration.happyHomeDir);
  const tmux = new TmuxManager({
    sessionName: configuration.tmuxSessionName,
    socketName: configuration.tmuxSessionName,
  });

  const changes: Array<{
    hapiSessionId: string;
    oldName: string;
    newName: string;
  }> = [];

  // Check if tmux session exists
  if (!(await tmux.sessionExists())) {
    return changes;
  }

  // Get all windows in the tmux session
  const windows = await tmux.listWindows();
  const windowNames = new Set(windows.map(w => w.name));

  // #4038: ONE identity listing per sweep (not one per session), fetched only
  // when a session needs it. null = the listing faulted → every decision that
  // depends on it takes its safe branch (no rehabilitation, no adoption).
  // Invalidated after a stale-kill so a later read never sees a killed window.
  let identityRows: IdentityRows | null | undefined;
  const getIdentityRows = async (): Promise<IdentityRows | null> => {
    if (identityRows === undefined) {
      identityRows = await listIdentityRowsSafe(tmux, "rename detector");
    }
    return identityRows;
  };

  // Get all persisted sessions
  let sessions = await store.getAll();

  // First pass:
  //   - Stale-mark active/recovering sessions whose tags are NOT on the server.
  //   - Rehabilitate error sessions whose tags ARE on the server (issue #1351).
  // The two branches operate on disjoint statuses AND a single tag-membership
  // check, so a single sweep can never both stale-mark and rehabilitate the
  // same session.
  const updatedSessions: PersistedSession[] = [];
  const SPAWN_GRACE_PERIOD_MS = 30_000; // 30 seconds — matches webhook timeout
  if (serverSessionTags) {
    for (const session of sessions) {
      const tagOnServer = serverSessionTags.has(session.hapiSessionId);

      if (session.status === "active" || session.status === "recovering") {
        // Skip sessions created within the grace period — the server may not have
        // received the webhook yet (spawn takes ~2s, webhook timeout is 30s)
        const sessionAge = Date.now() - new Date(session.createdAt).getTime();
        if (sessionAge < SPAWN_GRACE_PERIOD_MS) {
          logger.debug(
            `[TmuxSpawnAdapter] Skipping stale check for recently-spawned session: ${session.hapiSessionId} (age: ${Math.round(sessionAge / 1000)}s)`
          );
          continue;
        }

        if (!tagOnServer) {
          logger.info(
            `[TmuxSpawnAdapter] Marking stale session as error (not on server): ${session.hapiSessionId}`
          );
          session.status = "error";
          updatedSessions.push(session);

          // #1349: Kill the now-orphan tmux window. Best-effort — killWindow
          // internally catches its own errors and returns boolean, so a tmux
          // failure here cannot abort the broader reconciliation sweep. The
          // try/catch is defense-in-depth in case a future killWindow refactor
          // changes the exception contract. cleanupGhostWindows (R5) is the
          // safety net for any window this miss.
          try {
            // #3734: kill the SPECIFIC stale window by its @N when known — a
            // name first-match could kill a live same-titled sibling.
            // #4038: and only a window this session OWNS. A recycled @N can
            // name another session's live window, and the name fallback can
            // name a same-titled one; resolveOwnedWindow refuses both.
            const staleTarget = session.tmuxWindowId ?? session.tmuxWindow;
            const owned = await resolveOwnedWindow(
              tmux,
              staleTarget,
              session.hapiSessionId
            );
            if (owned.kind !== "owned") {
              if (
                owned.kind === "not-owned" &&
                owned.reason === "window-gone"
              ) {
                logger.debug(
                  `[TmuxSpawnAdapter] No orphan tmux window to kill for stale session ${session.hapiSessionId} (${staleTarget} is gone)`
                );
              } else {
                logger.warn(
                  `[TmuxSpawnAdapter] Not killing tmux window "${session.tmuxWindow}" (${staleTarget}) for stale session ${session.hapiSessionId}: not owned (${describeOwnershipFailure(owned)})`
                );
              }
              continue;
            }
            const killed = await tmux.killWindow(owned.target);
            identityRows = undefined;
            if (killed) {
              logger.info(
                `[TmuxSpawnAdapter] Killed orphan tmux window "${session.tmuxWindow}" (${staleTarget}) for stale session ${session.hapiSessionId}`
              );
            } else {
              logger.warn(
                `[TmuxSpawnAdapter] Failed to kill orphan tmux window "${session.tmuxWindow}" (${staleTarget}) for stale session ${session.hapiSessionId} (window may not exist or tmux command failed)`
              );
            }
          } catch (error) {
            logger.warn(
              `[TmuxSpawnAdapter] Unexpected throw from killWindow for ${session.hapiSessionId}:`,
              error
            );
          }
        }
      } else if (session.status === "error" && tagOnServer) {
        // Issue #1351: rehabilitate error sessions whose tags are on the server.
        // Sessions whose server row is genuinely gone (e.g. #1349 silent-delete
        // victims) stay error because tagOnServer is false.
        // #4038: server presence alone is not enough — an old record is on the
        // server long after its window died, and rehabilitating it put its
        // (possibly recycled) @N into the rename poll below. Rehabilitate only
        // with a window this session OWNS; otherwise it stays error (which
        // also keeps it out of RecoveryService.recoverAllSessions).
        const decision = decideRehabilitation({
          tag: session.hapiSessionId,
          tmuxWindowId: session.tmuxWindowId,
          tmuxWindow: session.tmuxWindow,
          rows: await getIdentityRows(),
        });
        let adoptId: string | null = null;
        let faultReason: string | null = null;
        if (decision.kind === "rehabilitate") {
          adoptId = decision.adoptId;
        } else if (decision.kind === "probe") {
          const probed = await resolveOwnedWindow(
            tmux,
            decision.target,
            session.hapiSessionId
          );
          if (probed.kind === "owned") {
            adoptId = decision.target;
          } else if (probed.kind === "fault") {
            faultReason = `ownership probe of ${decision.target} failed (${describeOwnershipFailure(probed)})`;
          }
        } else if (identityRows === null) {
          faultReason = "identity listing failed";
        }
        if (!adoptId) {
          if (faultReason) {
            logger.warn(
              `[TmuxSpawnAdapter] Not rehabilitating error session ${session.hapiSessionId}: ${faultReason} — retrying next sweep`
            );
          } else {
            logger.debug(
              `[TmuxSpawnAdapter] Not rehabilitating error session ${session.hapiSessionId}: on the server but owns no tmux window`
            );
          }
          continue;
        }
        logger.info(
          `[TmuxSpawnAdapter] Rehabilitating error session to active (server confirms presence, owns window ${adoptId}): ${session.hapiSessionId}`
        );
        session.status = "active";
        session.tmuxWindowId = adoptId;
        updatedSessions.push(session);
      }
      // Other statuses (offline, needs-reconnect) are owned by their own
      // state-machine paths and left untouched here.
    }
    if (updatedSessions.length > 0) {
      await store.saveAll(updatedSessions);
      // Refresh sessions list after first pass for the second pass
      sessions = await store.getAll();
    }
  }

  // Second pass: Detect renames for active sessions
  const sessionsToUpdate: PersistedSession[] = [];
  for (const session of sessions) {
    if (session.status !== "active" && session.status !== "recovering") {
      continue; // Only check active sessions
    }

    const storedName = session.tmuxWindow;

    // Skip if Hapimatic recently renamed this session
    if (wasRecentlyRenamedByHapimatic(session.hapiSessionId)) {
      continue;
    }

    // #3734 (secondary Task-3 site): for an id-tracked session, resolve the
    // rename against THIS window by its @N — never by the stored name, which can
    // first-match a same-titled sibling. Read the window's CURRENT name: if it
    // differs from the stored name it was renamed out-of-band → sync it; if the
    // window is gone (@N absent → null) leave it to recovery, don't misclassify
    // a disappearance as a rename.
    //
    // #4038: the @N must be OWNED by this session. A tmux-server restart
    // recycles @N onto a new window, and reading that window's name here is
    // what copied a new session's title onto an old, unrelated session. A
    // stale id falls to this session's `@hapi_identity` row (adopted), never
    // to the name; with no owned window nothing is pushed and the id is kept.
    if (session.tmuxWindowId) {
      const tag = session.hapiSessionId;
      const { route } = await routeTrackedWindow(
        tmux,
        session.tmuxWindowId,
        tag,
        getIdentityRows
      );
      const windowId =
        route.kind === "use" ? (route.adoptId ?? session.tmuxWindowId) : null;
      const currentName = windowId ? await tmux.getWindowName(windowId) : null;
      if (
        decideDetectorAction({ route, currentName, storedName }) === "rename"
      ) {
        changes.push({
          hapiSessionId: tag,
          oldName: storedName,
          newName: currentName!,
        });
        logger.info(
          `[TmuxSpawnAdapter] Detected tmux rename (by @N ${windowId}): "${storedName}" → "${currentName}" for session ${tag}`
        );
        session.tmuxWindow = currentName!;
      }
      if (route.kind === "use" && route.adoptId) {
        logger.info(
          `[TmuxSpawnAdapter] Adopted window ${route.adoptId} for ${tag} by @hapi_identity (stale id ${session.tmuxWindowId})`
        );
        session.tmuxWindowId = route.adoptId;
      }
      if (
        session.tmuxWindow !== storedName ||
        (route.kind === "use" && route.adoptId)
      ) {
        sessionsToUpdate.push(session);
      }
      continue;
    }

    // Legacy session (no persisted @N): name-based detection (unchanged).
    // Check if the stored window name still exists in tmux
    if (windowNames.has(storedName)) {
      // Window still exists with same name - no change
      continue;
    }

    // Window with stored name doesn't exist - find the window by verifying
    // HAPI_SESSION_ID in the process environment (prevents cross-contamination
    // from tmux-resurrect ghost windows or non-deterministic matching)
    let foundWindowName: string | null = null;

    for (const window of windows) {
      if (window.name === "control") continue;
      const windowSessionId = await tmux.getWindowHapiSessionId(window.name);
      if (windowSessionId === session.hapiSessionId) {
        foundWindowName = window.name;
        break;
      }
    }

    if (foundWindowName && foundWindowName !== storedName) {
      // Record the change
      changes.push({
        hapiSessionId: session.hapiSessionId,
        oldName: storedName,
        newName: foundWindowName,
      });

      logger.info(
        `[TmuxSpawnAdapter] Detected tmux rename: "${storedName}" → "${foundWindowName}" for session ${session.hapiSessionId}`
      );

      // Update the local session store immediately
      session.tmuxWindow = foundWindowName;
      sessionsToUpdate.push(session);
    }
  }

  if (sessionsToUpdate.length > 0) {
    await store.saveAll(sessionsToUpdate);
  }

  return changes;
}

/**
 * Get tmux window PID for a session
 */
export async function getTmuxSessionPid(
  hapiSessionId: string
): Promise<number | null> {
  const store = createSessionStore(configuration.happyHomeDir);
  const session = await store.get(hapiSessionId);

  if (!session) {
    return null;
  }

  const tmux = new TmuxManager({
    sessionName: configuration.tmuxSessionName,
    socketName: configuration.tmuxSessionName,
  });

  // #3734: prefer the persisted @N so a same-named collision returns THIS
  // session's pane pid, not a sibling's first-name-match.
  return tmux.getWindowPid(session.tmuxWindowId ?? session.tmuxWindow);
}

/**
 * Clean up ghost tmux windows (e.g. from tmux-resurrect) that don't belong
 * to any known session. Kills windows where the process is dead or where
 * HAPI_SESSION_ID doesn't match any persisted session.
 */
export async function cleanupGhostWindows(): Promise<number> {
  const store = createSessionStore(configuration.happyHomeDir);
  const tmux = new TmuxManager({
    sessionName: configuration.tmuxSessionName,
    socketName: configuration.tmuxSessionName,
  });

  if (!(await tmux.sessionExists())) {
    return 0;
  }

  const windows = await tmux.listWindows();
  const sessions = await store.getAll();
  const knownSessionIds = new Set(sessions.map(s => s.hapiSessionId));
  // #3734 Task 2(e): spare claimed windows by INDEX (precise) for modern
  // sessions, falling back to NAME only for legacy sessions with no captured
  // index. A ghost that shares a modern session's NAME has a different index, so
  // index-keying no longer wrongly spares it (the spare-direction leak); a
  // legacy session (no index) is still spared by name — no regression, no
  // wrong-kill.
  const claimedWindowIndexes = new Set<number>();
  const legacyClaimedNames = new Set<string>();
  for (const s of sessions) {
    if (typeof s.tmuxWindowIndex === "number") {
      claimedWindowIndexes.add(s.tmuxWindowIndex);
    } else if (s.tmuxWindow) {
      legacyClaimedNames.add(s.tmuxWindow);
    }
  }

  let cleaned = 0;

  for (const window of windows) {
    if (window.name === "control") continue;

    // Skip windows that are claimed by a persisted session (by index; legacy
    // sessions without an index are spared by name).
    if (claimedWindowIndexes.has(window.index)) continue;
    if (legacyClaimedNames.has(window.name)) continue;

    // Unclaimed window — check if it has a live process with a valid session ID.
    // #3734: address the SPECIFIC window by its index, not a name first-match.
    const windowSessionId = await tmux.getWindowHapiSessionId(window.index);
    if (windowSessionId && knownSessionIds.has(windowSessionId)) {
      // Valid process for a known session — don't kill
      continue;
    }

    // Ghost window: either dead process or unknown session ID. #3734: kill the
    // SPECIFIC window by index, never a name first-match (which could hit a
    // same-named claimed window).
    logger.info(
      `[TmuxSpawnAdapter] Cleaning up ghost tmux window "${window.name}" (index ${window.index}, sessionId=${windowSessionId ?? "none"})`
    );
    await tmux.killWindow(reaperWindowTarget(window));
    cleaned++;
  }

  if (cleaned > 0) {
    logger.info(
      `[TmuxSpawnAdapter] Cleaned up ${cleaned} ghost tmux window(s)`
    );
  }

  return cleaned;
}

// ==================== Helper Functions ====================

export interface BuildCommandOptions {
  yolo: boolean;
  safeMode?: boolean;
  modelMode?: string;
  effort?: string;
  rawModel?: string;
  sessionRole?: string;
  outputStyle?: string;
  projectDir: string;
  directory: string;
  resumeSessionId?: string;
  forkSession?: boolean;
  // Issue #3179: when set, appended as one extra paragraph to the session's
  // system prompt (the ephemeral-cwd notice). undefined ⇒ byte-identical argv.
  sandboxCwdNotice?: string;
}

export function buildClaudeCommand(options: BuildCommandOptions): string[] {
  const args: string[] = [];

  // Starting mode and source
  args.push("--hapi-starting-mode", "remote");
  args.push("--started-by", "daemon");

  // YOLO mode (skip permissions)
  if (options.yolo) {
    args.push("--yolo");
  }

  // Issue #1633: Safe Mode — the claude child launches with --safe-mode and
  // the launchers suppress Hapimatic's own injections (hapi MCP, hook
  // settings, allowedTools, append-system-prompt). Persisted via claudeArgs
  // so daemon recovery preserves it.
  if (options.safeMode) {
    args.push("--safe-mode");
  }

  // Issue #1633: explicit model mode (validated against the enum in run.ts) —
  // runClaude seeds its model state from this so the selection survives a
  // model-switch respawn / recovery.
  if (options.modelMode) {
    args.push("--hapi-model-mode", options.modelMode);
  }

  // Issue #2456: reasoning-effort level. Hapimatic-internal flag — commands/
  // claude.ts consumes it and seeds runClaude's effort state (which reaches the
  // claude child as --effort). Threaded like --hapi-model-mode so a respawn
  // preserves the selection.
  if (options.effort) {
    args.push("--hapi-effort", options.effort);
  }

  // Issue #2456: specific pinned raw Claude model id ("More models"). Hapimatic-
  // internal — commands/claude.ts seeds runClaude's currentModel (precedence over
  // modelMode). Threaded like --hapi-model-mode so a respawn preserves the pin.
  if (options.rawModel) {
    // Issue #2626 security: escaped — this arg is `.join(" ")`-ed into a shell
    // string and run via bash, so an unescaped value would inject shell commands.
    args.push("--hapi-raw-model", escapeShellArg(options.rawModel));
  }

  // Issue #2155: role-scoped `@`-include profile. Hapimatic-internal flag —
  // commands/claude.ts consumes it (validating against SessionRoleSchema) and
  // does NOT forward it to the claude child; runClaude merges the role's
  // claudeMdExcludes into the hook-settings file. Threaded like
  // --hapi-model-mode so a model/account-switch respawn preserves the role.
  if (options.sessionRole) {
    args.push("--hapi-session-role", options.sessionRole);
  }

  // Issue #2626 (D): per-session output style. Hapimatic-internal flag —
  // commands/claude.ts consumes it and seeds runClaude's outputStyle, which is
  // injected into the generated --settings file. Threaded like
  // --hapi-session-role so a model/account-switch respawn preserves the style.
  if (options.outputStyle) {
    // Issue #2626 security: escaped — this arg is `.join(" ")`-ed into a shell
    // string and run via bash, so an unescaped value would inject shell commands.
    args.push("--hapi-output-style", escapeShellArg(options.outputStyle));
  }

  // Resume existing session
  if (options.resumeSessionId) {
    args.push("--resume", escapeShellArg(options.resumeSessionId));
  }

  // Fork session (create new Claude session ID with inherited history)
  if (options.forkSession) {
    args.push("--fork-session");
  }

  // System prompt (with repo-aware default branch detection).
  // Issue #1633: suppressed under Safe Mode — the hapi tool instructions
  // would reference MCP tools that --safe-mode disables, and these args pass
  // through commands/claude.ts into the child argv VERBATIM (the launcher
  // suppression only gates the launcher's own buildSystemPrompt addition).
  if (!options.safeMode) {
    const systemPrompt = buildSystemPrompt(options.directory);
    args.push(
      "--append-system-prompt",
      escapeShellArg(
        // Issue #3179: append the ephemeral-cwd notice as one extra paragraph
        // when the cwd bind was skipped; unset ⇒ byte-identical to pre-#3179.
        options.sandboxCwdNotice
          ? `${systemPrompt}\n\n${options.sandboxCwdNotice}`
          : systemPrompt
      )
    );
  }

  return args;
}

/**
 * Resolve the claude CLI path for env propagation to spawned sessions.
 * Returns an object to spread into envVars — either { HAPI_CLAUDE_PATH: path }
 * or {} if the path can't be resolved (daemon may have minimal PATH).
 */
function resolveClaudePath(): Record<string, string> {
  try {
    const claudePath = getDefaultClaudeCodePath();

    // Defense-in-depth: only propagate absolute paths to spawned sessions.
    // Bare commands (e.g., "claude") cause ENOENT when the child process's
    // PATH doesn't include the binary's directory (#862).
    if (!claudePath.startsWith("/") && process.platform !== "win32") {
      logger.warn(
        `[TmuxSpawnAdapter] getDefaultClaudeCodePath() returned non-absolute "${claudePath}", not propagating`
      );
      // Fall through to well-known path below
    } else {
      logger.debug(
        `[TmuxSpawnAdapter] Resolved claude path for spawned sessions: ${claudePath}`
      );
      return { HAPI_CLAUDE_PATH: claudePath };
    }
  } catch {
    // getDefaultClaudeCodePath() threw — daemon may have minimal PATH
  }

  // Fall back to well-known location: ~/.local/bin/claude
  const homedir = os.homedir();
  const fallbackPath = join(homedir, ".local", "bin", "claude");
  try {
    accessSync(fallbackPath);
    logger.debug(
      `[TmuxSpawnAdapter] Using fallback claude path: ${fallbackPath}`
    );
    return { HAPI_CLAUDE_PATH: fallbackPath };
  } catch {
    // Fallback path doesn't exist
  }
  logger.warn(
    "[TmuxSpawnAdapter] Could not resolve claude path — spawned sessions will rely on PATH"
  );
  return {};
}

// Consolidated single-quote escaper (issue #3748, Sub H). The local alias keeps
// the 7 call sites (:349/:724/:773/:2030/:2049/:2054/:2070) unchanged while
// routing them through the one shared implementation in @/utils/shellEscape.
const escapeShellArg = shellEscape;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
