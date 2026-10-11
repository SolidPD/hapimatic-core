// SPDX-License-Identifier: MIT
/**
 * Shared launcher constants and helpers used by both `claudePty.ts` (PTY-attach
 * launcher) and `claudeTmuxRemote.ts` (tmux backup launcher). Extracted from
 * `claudePty.ts` so both launchers see the same definitions byte-for-byte and
 * cannot drift between forks.
 *
 * Per issue #1310 architect-review Q3: the constants/helper are cross-launcher
 * concerns, not PTY-specific. Hosting them in a third module avoids
 * (a) cross-launcher imports between sibling files, and (b) the silent-drift
 * risk of duplicating the values in two places.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { configuration } from "@/configuration";
import {
  AGENT_FORBIDDEN_ENV_VARS,
  buildHarnessChildEnv,
} from "@/sandbox/secretEnvVars";
import { TmuxManager } from "@/tmux/TmuxManager";
import { remoteLauncherWindowTarget } from "@/tmux/windowOwnership";
import { createSessionStore } from "@/sessionPersistence/sessionStore";
import { TMUX_REMOTE_WINDOW_PREFIX } from "@/tmux/types";
import type { OrphanedSession, TmuxWindow } from "@/tmux/types";
import { shellEscape } from "@/utils/shellEscape";

/**
 * Environment variables that signal "Agent SDK invocation" to Anthropic's
 * billing classifier. The PTY/tmux launchers spawn `claude` as a user-driven
 * process and MUST NOT leak any of these — leaking even one risks classifying
 * the session as SDK-billed (post-2026-06-15 100× billing change).
 */
export const SDK_SIGNAL_ENV_VARS = new Set([
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_ACTION",
  "CLAUDE_CODE_REMOTE",
  "CLAUDE_CODE_REMOTE_SESSION_ID",
  "CLAUDE_CODE_CONTAINER_ID",
  "ANTHROPIC_API_KEY",
]);

/**
 * Per-session ACCOUNT-BINDING env vars (issue #1645, #1651). Each of these
 * binds a spawned `claude` process to a specific account / credential dir:
 * - `CLAUDE_CODE_OAUTH_TOKEN` — env-token binding (#1446); when present, native
 *   Claude Code runs INFERENCE-ONLY (`refreshToken: null`) and SKIPS persisting
 *   rotated tokens, so an isolated dir's refresh-token head is never replenished.
 * - `CLAUDE_CONFIG_DIR` — isolated-config-dir binding (#1551).
 * - `HAPI_ACCOUNT_UUID` — the Hapimatic-internal account selector read by the
 *   spawn worker during launcher resolution (`accountTokenInjection.ts`,
 *   `sessionFactory.ts`, `session.ts`); never needed by the `claude` child.
 * - `HAPI_API_KEY_ID` / `HAPI_API_KEY_MASKED` (#4568) — the API-key selector the
 *   wrapper checks against the vault (`verifyApiKeyForSession`). Like
 *   `HAPI_ACCOUNT_UUID` it is a binding: an inherited copy would silently re-bill
 *   a later session to someone's key, so only the daemon's explicit export may
 *   carry it. The KEY itself is never in any environment: Claude Code reads it
 *   from the session's `apiKeyHelper` (`hapi api-key-helper`, F1).
 *
 * Unlike {@link SDK_SIGNAL_ENV_VARS}, these are stripped from the AMBIENT
 * `process.env` copy ONLY and are NOT re-stripped after the `extra` merge:
 * explicit per-session injection via `withAccountToken` / `withAccountConfigDir`
 * (which lands in `extra`) remains the AUTHORITATIVE binding path. The ambient
 * strip severs cross-session contamination from a tmux server whose process env
 * was fixed by a prior env-token-bound session (the #1651 class — a tmux server
 * is created with the env of its FIRST creator, and every later pane spawned in
 * it inherits that env; without this strip, `buildLauncherEnv` would copy a
 * leaked `CLAUDE_CODE_OAUTH_TOKEN` into a SUBSEQUENT isolated spawn, forcing
 * native inference-only and breaking durable refresh-token replenishment — the
 * #1635 "consume-and-blank" symptom under the H-A contamination mechanism).
 */
export const BINDING_ENV_VARS = new Set([
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "HAPI_ACCOUNT_UUID",
  "HAPI_API_KEY_ID",
  "HAPI_API_KEY_MASKED",
]);

/**
 * `claude` CLI flags that also set CLAUDE_CODE_ENTRYPOINT=sdk-cli internally
 * (per Claude Code source `entrypoints/print.ts`). The launchers reject these
 * flags at spawn time so a stray operator override cannot bypass the env-scrub.
 */
export const FORBIDDEN_CLAUDE_ARGS = new Set([
  "-p",
  "--print",
  "--output-format",
  "--input-format",
]);

/**
 * Build a launcher-safe environment by stripping the sets listed below from the
 * current process.env and applying the standard terminal defaults (`TERM`,
 * `COLORTERM`, `LANG`, `DISABLE_AUTOUPDATER`). Extra vars supplied by the caller
 * (`claudeEnvVars` on the launcher options) are layered on AFTER the strip.
 *
 * Six distinct strip semantics:
 *  - {@link SDK_SIGNAL_ENV_VARS}: stripped from ambient AND re-stripped after the
 *    `extra` merge — R21 (#1429): a caller cannot re-introduce a billing-signal
 *    var via `extra`, even accidentally.
 *  - `SECRET_ENV_VARS` (#1734, OmniBox Phase 0a): the agent-secret set, stripped
 *    from ambient ONLY (NOT re-stripped), and ONLY when the sandbox kill-switch
 *    `configuration.omniboxSandboxEnabled` is ON. Sandbox OFF ⇒ byte-identical to
 *    pre-#1734 (R6). Ambient-only so a future caller can re-inject one via
 *    `extra` (mirrors {@link BINDING_ENV_VARS}, not {@link SDK_SIGNAL_ENV_VARS}).
 *    Issue #3813: this strip is now the CLAUDE view of the shared per-flavor helper
 *    {@link buildHarnessChildEnv} (claude `keepSecrets` `[]` ⇒ the whole set),
 *    applied to the AMBIENT `process.env` BELOW so the ambient-only semantics are
 *    preserved byte-for-byte.
 *  - {@link BINDING_ENV_VARS}: stripped from ambient ONLY, NOT re-stripped. The
 *    ambient copy of an account-binding var is contamination (it leaked in from a
 *    tmux server fixed by a prior session — #1651); but EXPLICIT injection via
 *    `extra` (`withAccountToken` / `withAccountConfigDir`) is the authoritative
 *    binding path and MUST survive. So a bound session still receives its
 *    `CLAUDE_CODE_OAUTH_TOKEN` / `CLAUDE_CONFIG_DIR` from `extra`, while an
 *    isolated session no longer inherits a stray ambient `CLAUDE_CODE_OAUTH_TOKEN`
 *    that would force native inference-only (the #1635 H-A symptom).
 *  - `AGENT_FORBIDDEN_ENV_VARS` (#2383, W3 of epic #2385): daemon-only bootstrap
 *    secrets. Stripped from ambient (via {@link buildHarnessChildEnv}, #3813) AND
 *    re-stripped after `extra` (the loop below), and — unlike `SECRET_ENV_VARS` —
 *    **UNGATED**, because the exposure exists precisely on a default-configured
 *    cloud VM where the sandbox switch is OFF. No caller has a legitimate reason to
 *    re-introduce one via `extra`, hence the re-strip.
 *  - {@link API_KEY_HELPER_OUTRANKING_ENV_VARS} (#4884): the inherited
 *    `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`, stripped from ambient ONLY
 *    (mirrors {@link BINDING_ENV_VARS}). Both outrank every subscription
 *    credential, and the PTY/tmux launchers run only subscription sessions (they
 *    refuse a key session, #4568), so no child here may inherit either.
 *    `ANTHROPIC_API_KEY` is also an {@link SDK_SIGNAL_ENV_VARS} member, so it
 *    stays re-stripped after `extra` as before.
 *  - {@link SUBSCRIPTION_SESSION_STRIP_ENV_VARS} (#4884, PM ruling): the inherited
 *    `ANTHROPIC_BASE_URL`, stripped from ambient ONLY. These launchers run only
 *    subscription sessions, which talk to Anthropic directly.
 *
 * Returns a plain string-to-string map suitable for `Bun.spawn({env})` or for
 * use as a shell-command env prefix (after escaping).
 */
export function buildLauncherEnv(
  extra?: Record<string, string>
): Record<string, string> {
  // #3813: the SECRET (gated) + AGENT_FORBIDDEN (ungated) AMBIENT strips are the
  // CLAUDE view of the shared per-flavor helper. Applied to `process.env` BEFORE the
  // loop so the SECRET strip stays AMBIENT-ONLY (a SECRET re-injected via `extra`
  // still survives — the documented #1734 semantic) and OFF stays byte-identical
  // (R6). SDK_SIGNAL + BINDING keep their own ambient strip below; the #2383
  // re-strip after `extra` is retained at the function tail.
  const ambient = buildHarnessChildEnv("claude", process.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(ambient)) {
    if (value === undefined) continue;
    if (SDK_SIGNAL_ENV_VARS.has(key)) continue;
    // #1645: sever ambient account-binding contamination from a tmux-server
    // env fixed by a prior session. Explicit `extra` injection re-adds the
    // binding vars below and is deliberately NOT re-stripped.
    if (BINDING_ENV_VARS.has(key)) continue;
    // #4884: an inherited ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY outranks the
    // session's subscription credential, so it would bill the wrong account.
    if (API_KEY_HELPER_OUTRANKING_ENV_VARS.has(key)) continue;
    // #4884 (PM ruling): an inherited ANTHROPIC_BASE_URL would send the
    // subscription sign-in to whatever address it names.
    if (SUBSCRIPTION_SESSION_STRIP_ENV_VARS.has(key)) continue;
    env[key] = value;
  }
  env.DISABLE_AUTOUPDATER = "1";
  if (!env.TERM) env.TERM = "xterm-256color";
  if (!env.COLORTERM) env.COLORTERM = "truecolor";
  if (!env.LANG) env.LANG = "en_US.UTF-8";
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      env[key] = value;
    }
  }
  // R21 (#1429): defense-in-depth re-strip. Without this, a caller passing
  // `claudeEnvVars` containing any SDK_SIGNAL_ENV_VARS key would silently
  // re-introduce it after the initial strip — directly contradicting the
  // docstring's "cannot accidentally re-introduce" claim. The re-strip
  // enforces the promise at the function boundary.
  for (const key of SDK_SIGNAL_ENV_VARS) {
    delete env[key];
  }
  // #2383 (W3): re-strip after `extra` too. Unlike BINDING_ENV_VARS — where an
  // explicit `extra` injection is the AUTHORITATIVE binding path and must survive —
  // no caller has a legitimate reason to hand a daemon bootstrap secret to a child,
  // so the boundary promise is enforced at the function boundary (mirrors the
  // SDK_SIGNAL_ENV_VARS re-strip above).
  for (const key of AGENT_FORBIDDEN_ENV_VARS) {
    delete env[key];
  }
  return env;
}

/**
 * Issue #3731 (R1/R2): build the `claude` child env for the launchers that spawn
 * from a copy of the wrapper's `process.env` — the DEFAULT `sdk` launcher
 * (`sdk/query.ts`) and the local launcher (`claudeLocal.ts`) — with the
 * {@link BINDING_ENV_VARS} semantics {@link buildLauncherEnv} already applies to
 * the pty/tmux launchers: strip EVERY binding var from the ambient copy, then layer
 * the launcher's EXPLICIT set (`claudeEnvVars` — the `withAccountToken` /
 * `withAccountConfigDir` result) on top.
 *
 * Why a rebuild and not a presence-keyed delete: by the time the sdk launcher
 * copies `process.env`, it is "ambient ∪ explicit" (`claudeRemote.ts` writes
 * `claudeEnvVars` into `process.env` for the wrapper's own config resolution). A
 * rule like "delete the token when `CLAUDE_CONFIG_DIR` is present" would delete an
 * EXPLICIT env-token binding whenever an AMBIENT `CLAUDE_CONFIG_DIR` exists — the
 * same bug mirrored. Rebuilding from the explicit set is correct in both
 * directions:
 *  - explicit `CLAUDE_CONFIG_DIR` + ambient token → dir only (the ms1 bug: an
 *    ambient token forces native inference-only and overrides the isolated
 *    credentials, billing the wrong account);
 *  - explicit token + ambient `CLAUDE_CONFIG_DIR` → token only (R2);
 *  - nothing explicit → no binding var at all. An UNBOUND session's instance
 *    credential is delivered explicitly upstream (`resolveAccountTokenForSession`,
 *    #3731 R2b), so it arrives in `explicit`, not ambiently.
 *
 * Issue #4884: the ambient copy also drops {@link API_KEY_HELPER_OUTRANKING_ENV_VARS}
 * (`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`) for EVERY session. Claude Code ranks
 * both above every subscription credential, so an inherited copy would bill whoever
 * owns it instead of the session's own account. Like the binding vars, an EXPLICIT
 * copy still layers back (no production caller supplies one); an API-key session
 * additionally drops the explicit copy (`apiKeyHelperSession`, #4568 F1).
 *
 * Issue #4884 (PM ruling): a subscription session's ambient copy also drops
 * {@link SUBSCRIPTION_SESSION_STRIP_ENV_VARS} (`ANTHROPIC_BASE_URL`), ambient-only
 * like the credential pair. Two callers keep it: an API-key session
 * (`apiKeyHelperSession`), whose behaviour is unchanged, and the daemon's direct
 * arm (`wrapperEnv`), which builds the env of the `hapi` WRAPPER rather than of a
 * Claude child. The wrapper keeps the URL so a key session's wrapper can pass it
 * on; its own Claude-child build (`sdk/query.ts`) applies the subscription strip.
 *
 * `HAPI_ACCOUNT_UUID` is stripped too — the child never reads it. Returns a NEW
 * record; the input is never mutated (it may BE `process.env`, which
 * `withBunRuntimeEnv` returns unchanged outside a compiled binary). Generic over the
 * value type so it composes over `NodeJS.ProcessEnv` without a cast, mirroring the
 * `strip*EnvVars` family.
 */
export function buildSdkSpawnEnv<V>(
  env: Record<string, V>,
  explicit?: Record<string, string>,
  options: { apiKeyHelperSession?: boolean; wrapperEnv?: boolean } = {}
): Record<string, V | string> {
  const subscriptionChild = !options.apiKeyHelperSession && !options.wrapperEnv;
  const result: Record<string, V | string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (BINDING_ENV_VARS.has(key)) continue;
    // Issue #4884: an inherited env credential outranks every subscription
    // credential Hapimatic injects (Anthropic precedence: AUTH_TOKEN > API_KEY >
    // apiKeyHelper > CLAUDE_CODE_OAUTH_TOKEN > /login), so no child inherits one.
    if (API_KEY_HELPER_OUTRANKING_ENV_VARS.has(key)) continue;
    // Issue #4884 (PM ruling): a subscription session talks to Anthropic directly.
    if (subscriptionChild && SUBSCRIPTION_SESSION_STRIP_ENV_VARS.has(key)) {
      continue;
    }
    result[key] = value;
  }
  if (explicit) {
    for (const [key, value] of Object.entries(explicit)) {
      result[key] = value;
    }
  }
  // Issue #4568 (F1): an API-key session's ONLY credential is its `apiKeyHelper`.
  // Drop, after the explicit layer too, every env credential Claude Code ranks
  // above the helper — measured on 2.1.280, an inherited `ANTHROPIC_API_KEY`
  // replaces the helper's key and an `ANTHROPIC_AUTH_TOKEN` is sent as the bearer
  // credential, so either would bill someone else's credential and sit in every
  // hook and Bash environment.
  if (options.apiKeyHelperSession) {
    for (const key of API_KEY_HELPER_OUTRANKING_ENV_VARS) delete result[key];
  }
  return result;
}

/**
 * Issue #4568 (F1): the env credentials Claude Code ranks above `apiKeyHelper`
 * (`ANTHROPIC_AUTH_TOKEN` > `ANTHROPIC_API_KEY` > `apiKeyHelper`). An API-key
 * session's child must carry neither.
 *
 * Issue #4884: both also outrank every subscription credential
 * (`CLAUDE_CODE_OAUTH_TOKEN`, an isolated `CLAUDE_CONFIG_DIR` login, `/login`), so
 * NO Claude child inherits either, on any launcher: {@link buildSdkSpawnEnv} and
 * {@link buildLauncherEnv} drop the ambient copy, the per-pane `unset` in
 * {@link buildTmuxEnvFileCommand} drops an inherited one, and the tmux server seed
 * and global-table scrub (`TmuxManager.ts`) keep them out of the tmux server.
 */
export const API_KEY_HELPER_OUTRANKING_ENV_VARS: ReadonlySet<string> = new Set([
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
]);

/**
 * Issue #4884 (PM ruling, a derived consequence of the operator's ruling): env
 * vars a SUBSCRIPTION session's Claude child never inherits. An inherited
 * `ANTHROPIC_BASE_URL` would send the session's subscription sign-in to whatever
 * address it names; a subscription session talks to Anthropic directly. An
 * API-key session keeps an inherited one, as before (a gateway in front of a key
 * is a key-owner's choice).
 *
 * Stripped where a subscription Claude child's env is built: {@link buildLauncherEnv}
 * (the PTY/tmux launchers run only subscription sessions), {@link buildSdkSpawnEnv}
 * unless `apiKeyHelperSession` or `wrapperEnv`, and the tmux launcher's per-pane
 * `unset` ({@link buildTmuxEnvFileCommand} `subscriptionClaudePane`). NOT in the tmux
 * server seed, the global-table scrub or the daemon→wrapper hop: those carry every
 * session kind's wrapper, and a key session's wrapper must keep it.
 */
export const SUBSCRIPTION_SESSION_STRIP_ENV_VARS: ReadonlySet<string> = new Set(
  ["ANTHROPIC_BASE_URL"]
);

/**
 * Shell single-quote escape, shared by the tmux launchers' command builders.
 * Re-exported alias of the consolidated {@link shellEscape} (issue #3748, Sub
 * H) — kept as a named export because `codexTmuxLauncher.ts` imports it and the
 * security-critical env-file command pattern in {@link buildTmuxEnvFileCommand}
 * uses it. The single shared impl cannot drift between launchers.
 */
export const shellSingleQuote = shellEscape;

/**
 * Build the tmux command string + matching 0600 env-file body for a launcher
 * that delivers its environment OUT-OF-BAND (issue #1505).
 *
 * Both tmux launchers used to interpolate the launcher env -- including
 * CLAUDE_CODE_OAUTH_TOKEN under multi-account binding (#1446) -- directly into
 * the `tmux send-keys` command string, leaking the token via `ps auxww` /
 * `/proc/<pid>/cmdline` of the launched shell AND into the tmux pane
 * scrollback. This helper instead returns an `envFileBody` (the caller writes
 * it to a 0600 temp file at `envFilePath`) and a `fullCommand` that sources
 * then `rm`s that file before running claude. No env VALUE ever appears on the
 * command line or in scrollback -- parity with the pty/sdk launchers'
 * `Bun.spawn({ env })` channel.
 *
 * `spawnCommand` is the already-escaped command that runs claude AFTER the env
 * file is sourced+removed. It differs per launcher:
 * - remote (`claudeTmuxRemote.ts`): `exec '<claudePath>' '<arg>' ...`
 * - local/daemon (`claudeTmuxLauncher.ts`): `claude '<arg>' ...` (bare, PATH-resolved)
 *
 * Pure + exported for unit testing.
 */
export function buildTmuxEnvFileCommand(opts: {
  launcherEnv: Record<string, string>;
  cwd: string;
  spawnCommand: string;
  envFilePath: string;
  /**
   * #4884 (PM ruling): the pane runs a SUBSCRIPTION session's `claude` directly
   * (the tmux launcher), so its `unset` also clears
   * {@link SUBSCRIPTION_SESSION_STRIP_ENV_VARS}. Omitted by the daemon→wrapper hop,
   * whose pane starts every session kind's wrapper.
   */
  subscriptionClaudePane?: boolean;
}): { fullCommand: string; envFileBody: string } {
  const envFileBody =
    Object.entries(opts.launcherEnv)
      .map(([key, value]) => `export ${key}=${shellSingleQuote(String(value))}`)
      .join("\n") + "\n";
  // #1692 (load-bearing): per-pane scrub of every SDK_SIGNAL_ENV_VARS member.
  // The shared `hapimatic-remote` tmux server snapshots the environment of its
  // FIRST creator; if that was an SDK-context process, CLAUDE_CODE_ENTRYPOINT=
  // sdk-ts (etc.) is frozen into the server's global env table and INHERITED by
  // every pane spawned afterward — silently re-billing a genuine subscription
  // session at per-token Agent-SDK rates (the 2026-06-15 P0). The env file only
  // `export`s a buildLauncherEnv-stripped set and never `unset`s, so it cannot
  // remove a var the pane shell already inherited from the server. Prepending an
  // explicit `unset` (run in the pane shell BEFORE `exec`) guarantees the
  // exec'd `claude` inherits NONE of the 7, regardless of what the server /
  // global table contributed. Semantics-independent of tmux's env-merge
  // precedence, and safe-by-construction: the unset runs BEFORE the env file is
  // sourced, so it can only remove inherited contamination — anything the env
  // file exports is re-applied after it. The names are
  // validated identifiers (uppercase + underscore) so no shell-quoting is
  // needed, and `unset` of an absent var is a successful no-op in POSIX shells
  // so the `&&` chain is never broken. Derived from the canonical
  // SDK_SIGNAL_ENV_VARS set (never hardcoded) to stay in lockstep with it.
  //
  // #3731 (R3): the unset ALSO covers every BINDING_ENV_VARS member
  // (CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CONFIG_DIR, HAPI_ACCOUNT_UUID). A cloud VM's
  // daemon-created server froze the onboarding token into its global table, every
  // pane inherited it, and native Claude Code preferred it over the bound
  // account's isolated credentials — the wrong-account billing bug. The unset
  // runs BEFORE the env file is sourced, so an EXPLICIT binding the caller
  // exports (the daemon's HAPI_ACCOUNT_UUID, an unbound spawn's instance token —
  // #3731 R0b — or a launcher's `withAccountToken` / `withAccountConfigDir`
  // result) is re-applied, while an INHERITED copy never survives. This applies
  // to BOTH consumers: the tmux launcher (`claudeTmuxRemote.ts`) and the
  // daemon→wrapper hop (`tmuxSpawnAdapter.ts`).
  //
  // #4884: the unset ALSO covers API_KEY_HELPER_OUTRANKING_ENV_VARS. A server
  // whose global table holds an ANTHROPIC_AUTH_TOKEN (e.g. created by a daemon
  // whose env carried one) handed it to every pane, and it outranked the
  // session's subscription credential. The union is de-duplicated, because
  // ANTHROPIC_API_KEY is in SDK_SIGNAL_ENV_VARS too.
  //
  // #4884 (PM ruling): a subscription Claude pane also clears an inherited
  // ANTHROPIC_BASE_URL (`subscriptionClaudePane`); the wrapper hop keeps it for
  // key sessions.
  const unsetNames = new Set([
    ...SDK_SIGNAL_ENV_VARS,
    ...BINDING_ENV_VARS,
    ...API_KEY_HELPER_OUTRANKING_ENV_VARS,
    ...(opts.subscriptionClaudePane ? SUBSCRIPTION_SESSION_STRIP_ENV_VARS : []),
  ]);
  const unsetClause = `unset ${[...unsetNames].join(" ")} && `;
  const fullCommand =
    unsetClause +
    `cd ${shellSingleQuote(opts.cwd)} && ` +
    `. ${shellSingleQuote(opts.envFilePath)} && ` +
    `rm -f ${shellSingleQuote(opts.envFilePath)} && ` +
    opts.spawnCommand;
  return { fullCommand, envFileBody };
}

/**
 * Result of {@link reapOrphanedSessions}. Reported to operators via
 * `hapi launcher reap` (human or `--json` output).
 */
export interface ReapResult {
  /** Was the daemon alive when probed? (true = no reaping done) */
  daemonAlive: boolean;
  /** Daemon PID read from state file (null if state missing/corrupt). */
  daemonPid: number | null;
  /** Orphan candidates identified by TmuxManager.findOrphanedSessions(). */
  orphans: OrphanedSession[];
  /** Number of orphans actually killed (0 in dryRun mode). */
  killed: number;
  /** True if invoked with options.dryRun. */
  dryRun: boolean;
  /**
   * Count of windows skipped because their pane HAPI_SESSION_ID belongs to
   * another instance on the shared socket — never reaped (#1655).
   */
  foreignSkipped: number;
  /**
   * Count of windows skipped because their pane tag was unreadable (dead pane /
   * process-tree walk failed) and `includeDead` was not set (#1655).
   */
  deadSkipped: number;
}

/**
 * Read the daemon PID from {@link configuration.daemonStateFile} without
 * probing the PID. Returns null when the state file is missing, unreadable,
 * has no `pid` field, or any error occurs. Conservative by design.
 */
async function readDaemonPidFromState(
  stateFile: string
): Promise<number | null> {
  try {
    if (!existsSync(stateFile)) return null;
    const state = JSON.parse(await readFile(stateFile, "utf-8")) as {
      pid?: number;
    };
    return typeof state.pid === "number" ? state.pid : null;
  } catch {
    return null;
  }
}

/**
 * Probe whether the daemon recorded in {@link configuration.daemonStateFile}
 * is alive (PID exists per process.kill(pid, 0)). Conservative by design:
 * returns true ("alive") on any uncertainty (missing file, corrupt JSON,
 * missing pid field, EPERM probe result). False is returned ONLY when the
 * PID probe explicitly raises ESRCH (PID does not exist).
 */
async function isDaemonAliveFromState(stateFile: string): Promise<boolean> {
  try {
    if (!existsSync(stateFile)) return true; // unknown → conservative: assume alive
    const state = JSON.parse(await readFile(stateFile, "utf-8")) as {
      pid?: number;
    };
    if (typeof state.pid !== "number") return true;
    try {
      process.kill(state.pid, 0);
      return true;
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ESRCH") return false;
      return true; // EPERM or unknown → conservative
    }
  } catch {
    return true;
  }
}

/**
 * Find and (optionally) kill orphaned remote tmux windows. Wraps
 * {@link TmuxManager.findOrphanedSessions} + {@link TmuxManager.killWindow}.
 *
 * Uses {@link configuration.tmuxRemoteSessionName} (env-overridable via
 * `HAPI_TMUX_REMOTE_SESSION_NAME`), NOT the types.ts constant — see issue
 * #1428 R5 (env override compatibility).
 *
 * Pattern source: claude-i §8 of the #1352 synthesis doc. claude-i has a
 * `reap` subcommand that kills orphaned `claude-i-*` tmux sessions; this is
 * the Hapimatic analogue for `hapi-remote-*` windows.
 */
export async function reapOrphanedSessions(options?: {
  dryRun?: boolean;
  includeDead?: boolean;
}): Promise<ReapResult> {
  const dryRun = options?.dryRun ?? false;
  const includeDead = options?.includeDead ?? false;
  const tmux = new TmuxManager({
    sessionName: configuration.tmuxRemoteSessionName,
    socketName: configuration.tmuxRemoteSessionName,
  });

  // Build THIS instance's owned-tag set so the reaper never kills another
  // instance's live windows on the shared `hapimatic-remote` socket (#1655).
  // Ownership = pane HAPI_SESSION_ID in this instance's persisted session store;
  // configuration.happyHomeDir is HAPI_HOME-derived, so the set is per-instance.
  // Scoping is on-by-default here; findOrphanedSessions' optional param exists
  // only to keep the low-level reaper unit tests valid (R5).
  const store = createSessionStore(configuration.happyHomeDir);
  const ownedTags = new Set((await store.getAll()).map(s => s.hapiSessionId));

  const { orphans, foreignSkipped, deadSkipped } =
    await tmux.findOrphanedSessions(
      configuration.daemonStateFile,
      TMUX_REMOTE_WINDOW_PREFIX,
      { ownedTags, includeDead }
    );
  // orphans is empty both when the daemon is alive AND when the daemon is
  // dead but no OWNED windows match. Disambiguate by re-reading the state file
  // here (cheap; both reads are post-probe — no race).
  const daemonAlive =
    orphans.length === 0
      ? await isDaemonAliveFromState(configuration.daemonStateFile)
      : false;
  const daemonPid =
    orphans.length > 0
      ? orphans[0].deadDaemonPid
      : await readDaemonPidFromState(configuration.daemonStateFile);

  let killed = 0;
  if (!dryRun) {
    for (const o of orphans) {
      // #4218: a remote-socket window from the #1655 owned-tag-filtered set.
      const target = remoteLauncherWindowTarget(tmux, o.windowName);
      if (await tmux.killWindow(target)) killed++;
    }
  }
  return {
    daemonAlive,
    daemonPid,
    orphans,
    killed,
    dryRun,
    foreignSkipped,
    deadSkipped,
  };
}

/**
 * One row of the remote-launcher window enumeration (issue #1652). Surfaced by
 * `hapi launcher attach` (human table / `--json`). Cross-instance windows —
 * those whose pane tag is not in THIS instance's session store — carry
 * `displayName: null` and are still listed (NEVER hidden): an operator may be
 * hunting a prod window from a dev shell (directive Research #3).
 */
export interface RemoteWindowRow {
  /** tmux window name (always `hapi-remote-<serverUuid>` — load-bearing, #1628). */
  windowName: string;
  /** Window index within the remote session (#1609-safe target). */
  windowIndex: number;
  /** Pane `HAPI_SESSION_ID` tag (null when the pane env is unreadable, e.g. dead pane). */
  hapiSessionId: string | null;
  /** Human session name from the local store, or null for unresolved/cross-instance rows. */
  displayName: string | null;
  /** Whether the window's pane is dead (process exited; window kept by remain-on-exit). */
  paneDead: boolean;
}

/**
 * Pure shaping of remote-launcher window rows (issue #1652) — extracted from
 * {@link listRemoteLauncherWindows} for unit testing without tmux/store I/O
 * (cli/CLAUDE.md no-mock convention). Filters to {@link TMUX_REMOTE_WINDOW_PREFIX}
 * and joins each window to its pre-resolved tag + display name. Null-tag and
 * null-displayName rows are PRESERVED — cross-instance windows must never be
 * hidden (directive Research #3).
 */
export function assembleRemoteWindowRows(
  windows: Array<Pick<TmuxWindow, "name" | "index" | "paneDead">>,
  resolved: Map<
    number,
    { hapiSessionId: string | null; displayName: string | null }
  >
): RemoteWindowRow[] {
  return windows
    .filter(w => w.name.startsWith(TMUX_REMOTE_WINDOW_PREFIX))
    .map(w => {
      const r = resolved.get(w.index) ?? {
        hapiSessionId: null,
        displayName: null,
      };
      return {
        windowName: w.name,
        windowIndex: w.index,
        hapiSessionId: r.hapiSessionId,
        displayName: r.displayName,
        paneDead: w.paneDead ?? false,
      };
    });
}

/**
 * Enumerate live remote-launcher windows on the `hapimatic-remote` socket and
 * join them to human session names (issue #1652). Data layer for
 * `hapi launcher attach`.
 *
 * Mirrors `reapRemoteLauncherWindows` / {@link reapOrphanedSessions} TmuxManager
 * construction (`configuration.tmuxRemoteSessionName`, env-overridable #1428 R5)
 * and the `tmuxSpawnAdapter.ts` reap join chain: `listWindows()` → filter
 * {@link TMUX_REMOTE_WINDOW_PREFIX} → resolve the pane tag via
 * `getWindowHapiSessionId(window.index)` (index targeting, #1609) → join
 * `SessionStore.get(tag).tmuxWindow` (the wrapper window name Hapimatic keeps
 * synced to the session's human name — works offline, no server round-trip).
 */
export async function listRemoteLauncherWindows(): Promise<RemoteWindowRow[]> {
  const tmux = new TmuxManager({
    sessionName: configuration.tmuxRemoteSessionName,
    socketName: configuration.tmuxRemoteSessionName,
  });
  const store = createSessionStore(configuration.happyHomeDir);
  const windows = await tmux.listWindows();

  const resolved = new Map<
    number,
    { hapiSessionId: string | null; displayName: string | null }
  >();
  for (const window of windows) {
    if (!window.name.startsWith(TMUX_REMOTE_WINDOW_PREFIX)) continue;
    const hapiSessionId = await tmux.getWindowHapiSessionId(window.index);
    let displayName: string | null = null;
    if (hapiSessionId) {
      try {
        const session = await store.get(hapiSessionId);
        displayName = session?.tmuxWindow ?? null;
      } catch {
        // Cross-instance / unreadable store row — list with tag-only identity.
        displayName = null;
      }
    }
    resolved.set(window.index, { hapiSessionId, displayName });
  }

  return assembleRemoteWindowRows(windows, resolved);
}

/**
 * Resolve a single session's human display name from the local store (issue
 * #1652) — used by the remote launcher to set/refresh `@hapi_identity`. Returns
 * `PersistedSession.tmuxWindow` (the Hapimatic-synced human name) or null when
 * the session is not in this instance's store (cross-instance / before the
 * session has been named).
 */
export async function resolveRemoteSessionDisplayName(
  hapiSessionId: string
): Promise<string | null> {
  try {
    const store = createSessionStore(configuration.happyHomeDir);
    const session = await store.get(hapiSessionId);
    return session?.tmuxWindow ?? null;
  } catch {
    return null;
  }
}

/**
 * Pure fuzzy-match of remote-launcher rows against an operator query (issue
 * #1652). Extracted from `runAttach` for unit testing. Two match modes (union):
 *  - case-insensitive substring of the display name;
 *  - when the query is all digits, an exact `#NNNN` issue-number match anywhere
 *    in the display name (so `attach 1652` finds a session named `#1652 …`).
 * Rows with a null display name never match a query (no searchable identity) —
 * they still appear in the unfiltered listing.
 */
export function matchRemoteWindowRows(
  rows: RemoteWindowRow[],
  query: string
): RemoteWindowRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  const isBareNumber = /^\d+$/.test(q);
  return rows.filter(row => {
    const name = row.displayName?.toLowerCase();
    if (!name) return false;
    if (name.includes(q)) return true;
    if (isBareNumber) {
      const m = name.match(/#(\d+)/);
      if (m && m[1] === q) return true;
    }
    return false;
  });
}

/**
 * Return a copy of the input env map with the supplied sentinel keys
 * removed. Use case (claude-i §8 pattern — `.github/issue-assets/1352/...`):
 * the parent tmux shell prefix delivers sentinels via the shell-command
 * string; sibling subprocesses spawned alongside the tmux launcher
 * (loggers, hook-forwarders, etc.) must NOT see those sentinels in their
 * `env` kwarg. Caller supplies the sentinel set per spawn site; this
 * helper holds no module-level constant.
 *
 * Orthogonal to {@link buildLauncherEnv}: that function strips SDK
 * billing-classifier keys ({@link SDK_SIGNAL_ENV_VARS}) from
 * `process.env` to build the tmux SHELL-PREFIX env. This function strips
 * arbitrary caller-defined sentinel keys from an already-built env to
 * construct a sibling SUBPROCESS env. Both concerns are independent
 * strip sets with opposite consumers; do not merge them.
 *
 * R15 (#1429) ships this primitive without a module-level sentinel set.
 * Hapimatic doesn't currently have a concrete `CLAUDE_I_SENTINEL` analog —
 * the test demonstrates the contract works with a caller-supplied
 * sentinel; designating an actual sentinel set is deferred until
 * Hapimatic genuinely needs one.
 *
 * The input `env` is NOT mutated — the caller's map is preserved verbatim.
 */
export function buildSubprocessEnvWithoutSentinels(
  env: Record<string, string>,
  sentinels: Set<string>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (sentinels.has(key)) continue;
    result[key] = value;
  }
  return result;
}
