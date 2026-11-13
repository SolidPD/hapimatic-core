// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #1734 (Hapimatic OmniBox Phase 0a) — the canonical set of secret env
 * vars that must never reach a spawned agent (`claude`) child process, plus a
 * pure strip helper.
 *
 * **Why a dedicated module.** Hapimatic spawns `claude` via three launchers
 * (`sdk` | `pty` | `tmux`). The `pty`/`tmux` launchers route their child env
 * through `buildLauncherEnv` (`@/claude/launcherShared`), but the DEFAULT `sdk`
 * launcher bypasses it entirely and spawns the child with the wrapper's full
 * `process.env` (`@/claude/sdk/query`). A single shared strip set + helper here
 * lets all three launchers — and the web terminal (`@/terminal/TerminalManager`)
 * — strip the same canonical set with no duplicated literals (the silent-drift
 * trap that `SDK_SIGNAL_ENV_VARS`/`BINDING_ENV_VARS` were extracted to avoid).
 *
 * **Relationship to the existing strip sets** (`launcherShared.ts`):
 * - {@link SDK_SIGNAL_ENV_VARS} — Agent-SDK billing-classifier signals.
 * - {@link BINDING_ENV_VARS} — per-session account-binding vars.
 * - {@link SECRET_ENV_VARS} (this module) — secrets the agent should never read.
 *
 * **Why `ANTHROPIC_API_KEY` is NOT here.** It is already a billing-signal var in
 * `SDK_SIGNAL_ENV_VARS` and is intentionally managed by the launcher billing
 * paths; the agent-secret strip deliberately does not touch it (double-listing
 * would be harmless but adds nothing for the agent paths). Every Claude launcher
 * drops an inherited `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`, ungated, via
 * `API_KEY_HELPER_OUTRANKING_ENV_VARS` (#4884), and an API-key session's
 * credential is its `apiKeyHelper` (#4568). The web
 * terminal still strips `ANTHROPIC_API_KEY` — it derives its filter from
 * `SECRET_ENV_VARS ∪ AGENT_FORBIDDEN_ENV_VARS ∪ {ANTHROPIC_API_KEY}`
 * (`TerminalManager.ts`, both sets since #5847).
 *
 * **Why `CLAUDE_CODE_OAUTH_TOKEN` is NOT here.** The agent legitimately needs it
 * for inference on the env-token account-binding path (#1446); it lives in
 * {@link BINDING_ENV_VARS}, not in the secret-strip set.
 *
 * The whole strip is gated behind the OmniBox kill-switch
 * (`configuration.omniboxSandboxEnabled`, `HAPI_OMNIBOX_SANDBOX`, default OFF) at
 * each call site — so when the sandbox is OFF, behavior is byte-identical to
 * pre-#1734 (R6).
 *
 * Issue #3813 adds {@link buildHarnessChildEnv} — the PER-FLAVOR wrapper→child seam
 * helper that owns the gate internally and derives the strip set from the flavor's
 * `hostJail.keepSecrets` axis, so codex/gemini children keep their own provider key.
 */

import { configuration } from "@/configuration";
import {
  resolveHarnessManifest,
  resolveHostJailAxis,
  type AgentFlavor,
} from "@hapi/protocol";

/**
 * Secrets that must never reach a spawned agent (`claude`) child. Seeded from
 * `TerminalManager.SENSITIVE_ENV_KEYS` minus `ANTHROPIC_API_KEY` (see module
 * docstring). `CLI_API_TOKEN` is the load-bearing one: the daemon actively
 * injects it at spawn (`tmuxSpawnAdapter.ts`) and it is wrapper-only (the agent
 * never reads it) — yet today the default `sdk` launcher passes it through to
 * the child verbatim (runtime-verified, #1734 research). `HAPI_SERVER_URL` /
 * `HAPI_HTTP_MCP_URL` are wrapper↔server / wrapper↔MCP coordinates the agent
 * reaches via its MCP config + loopback, not these env vars.
 */
export const SECRET_ENV_VARS: ReadonlySet<string> = new Set([
  "CLI_API_TOKEN",
  "HAPI_SERVER_URL",
  "HAPI_HTTP_MCP_URL",
  "TELEGRAM_BOT_TOKEN",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  // #2672 (D999-10): a GitHub PAT (gh's native token env). Membership HERE puts it in
  // the sandbox-gated tmux strip (`omniboxServerEnvStrip`). The web-terminal filter and
  // the tmux seed env and global-table scrub consume BOTH sets since #5847, so they
  // strip it either way. ALSO in AGENT_FORBIDDEN_ENV_VARS (deliberate dual membership —
  // see that set's doc).
  "GH_TOKEN",
]);

/**
 * Env vars that must NEVER reach a spawned agent by ANY route, on ANY launcher,
 * regardless of the OmniBox kill-switch (issue #2383, W3 of epic #2385).
 *
 * **Why a fourth set instead of extending an existing one.** Neither existing set
 * fits, and picking the wrong one is a silent no-op:
 *
 * - NOT {@link SECRET_ENV_VARS}: that whole strip is gated on
 *   `configuration.omniboxSandboxEnabled` (`HAPI_OMNIBOX_SANDBOX`, default OFF).
 *   A provisioned cloud VM does not enable it, so adding the var there would be a
 *   **no-op on every real VM** — the exact deployment #2383 identifies as the only
 *   exposure.
 * - NOT `BINDING_ENV_VARS` (`launcherShared.ts`): those are *per-session
 *   account-binding* vars whose ambient copy is contamination but whose explicit
 *   `extra` injection is authoritative. This var is a **daemon-only bootstrap
 *   secret that no child ever legitimately reads** — it has no explicit form, so it
 *   belongs here, not in the binding set. (Since #3731 the `sdk` and local launchers
 *   apply the binding set too, via `buildSdkSpawnEnv`: ambient binding vars are
 *   stripped and the launcher's EXPLICIT set — including an env-token binding's
 *   `CLAUDE_CODE_OAUTH_TOKEN` — is layered back, so the former "the sdk child reads
 *   the token from ambient `process.env`" premise no longer holds.)
 *
 * **Why ungated.** The whole point is that this must hold on a default-configured
 * VM. Gating it behind the sandbox switch would reproduce the bug.
 *
 * **Applied at**: `buildLauncherEnv` (`pty`/`tmux`) and `sdk/query.ts` (the DEFAULT
 * launcher), plus the codex and gemini child spawns — `codexLocal.ts`,
 * `codexMcpClient.ts` and the gemini `registerAgent.ts` — all via
 * {@link buildHarnessChildEnv}. The LOCAL claude launcher (`claudeLocal.ts`)
 * does not apply it yet — tracked in #4125 — and neither does the opencode
 * runner (`agent/runners/opencode.ts` `buildEnv`) — tracked in #4057. The
 * daemon additionally deletes the var from its own
 * `process.env` after consuming it (`daemon/run.ts`) — that source-removal is the
 * primary fix; these strips are defence in depth for a tmux server whose env was
 * frozen by an older daemon (`KillMode=process` preserves it across restarts).
 *
 * Issue #5847: the tmux and web-terminal paths apply it too, ungated, because a
 * frozen tmux server hands its global table to every new pane: the tmux server
 * seed env (`TmuxManager` `buildTmuxSpawnEnv`, on every tmux command), the
 * global-table scrub (`buildServerGlobalScrubSet`, inside `createWindow` and
 * `respawnPane`), the
 * per-pane `unset` and env file of `buildTmuxEnvFileCommand` (`launcherShared.ts`,
 * which covers the daemon→wrapper hop and so the wrapper's local-mode child), and
 * the web terminal filter (`TerminalManager` `buildFilteredEnv`).
 */
export const AGENT_FORBIDDEN_ENV_VARS: ReadonlySet<string> = new Set([
  "HAPI_ONBOARDING_OAUTH_TOKENS",
  // #2554: the gateway-delivered account identity payload (base64-JSON of
  // uuid/email/tier). Not a token, but onboarding-transient and carries PII — a
  // spawned agent has no reason to see it. The daemon deletes it at source
  // (run.ts); this is the defence-in-depth strip for a tmux server whose env was
  // frozen by an older daemon (same rationale as the tokens var above).
  "HAPI_ONBOARDING_ACCOUNT_IDENTITY",
  // #2672 (D999-10): a GitHub PAT must NEVER reach a spawned agent on ANY launcher,
  // OmniBox ON or OFF — an agent-readable `repo`-scoped classic PAT on a cloud VM was
  // the exposure (onboarding formerly planted one; branch A removed the plant, this
  // strip is belt-and-suspenders for a VM still carrying a legacy env entry). This var
  // is DELIBERATELY in BOTH sets — the one sanctioned exception to their disjointness:
  // membership here gives the ungated agent strip; membership in SECRET_ENV_VARS puts it
  // in the sandbox-gated tmux strip (`omniboxServerEnvStrip`). Since #5847 the
  // web-terminal filter and the tmux seed env and global-table scrub consume both sets.
  // At the agent spawn sites the double-strip is redundant but harmless. Legitimate
  // server/daemon consumers (githubRest.ts token resolution) read their OWN process
  // env, which these per-child strips never touch.
  "GH_TOKEN",
  // #5348 (R15): `hapi selftest argv`'s report mode. A child that inherited it would
  // write a report and exit 86 instead of starting; only the selftest sets it, on the
  // binary it runs itself.
  "HAPI_SELFTEST_ARGV_REPORT",
  // #5764: the mesh-wide federation bearer. Only the server reads it
  // (server/src/config/federationConfig.ts); the daemon never does, and deletes
  // it from its own env at start (daemon/run.ts) — unlike the onboarding vars it
  // never consumes it first. This strip is defence in depth for a tmux server an
  // older daemon created (its frozen env survives KillMode=process) and for any
  // other route that leaves it in a wrapper's env. It is not a boundary against a
  // same-user process reading settings.json.
  "FEDERATION_API_TOKEN",
  // #5781: an operator node's bearer for the gateway's central feedback sink (#2911).
  // Since #5858 it no longer opens the inbox: resolveFeedbackInboxConfig reads it only
  // to refuse an equal node token. Only the server reads it (resolveFeedbackSinkConfig /
  // resolveFeedbackInboxConfig, server/src/config/serverSettings.ts); the daemon never
  // does, and deletes it from its own env at start (daemon/run.ts). Not in
  // SECRET_ENV_VARS: since #5847 every surface that consumes that set also applies this
  // one, ungated, so a second membership would add no strip (the #5764 precedent). It is
  // not a boundary against a same-user process reading the operator's env file.
  "FEEDBACK_INBOX_TOKEN",
  // #5858 R1: an operator node's OWN token for the gateway's feedback inbox (#2912),
  // split from the sink bearer above so a node that only forwards cannot read the
  // inbox. Only the server reads it (resolveFeedbackInboxConfig); the daemon deletes it
  // from its own env at start (daemon/run.ts). Kept out of SECRET_ENV_VARS for the same
  // #5847 reason as FEEDBACK_INBOX_TOKEN.
  "FEEDBACK_INBOX_NODE_TOKEN",
  // #5781 (D7): a cloud VM's per-VM bearer for the gateway feedback relay (#2667), which
  // also redeems backup restore grants (#2509). Only the server reads it
  // (serverSettings.ts, buildWebApp.ts). VMs provisioned before #5926 also carry its
  // drop-in (21-feedback.conf) on the daemon unit, until the reconcile feedback-relay
  // repair removes that copy, so without this every agent on such a VM inherits it. Keep
  // it after that repair too: the repair restarts only the daemon (KillMode=process), so a
  // tmux server started by an older daemon can still hold the variable.
  // The daemon deletes it from its own env at start (daemon/run.ts). restore-backup.sh
  // reads it from the server unit's drop-in FILE, never from an environment, so the
  // strip cannot break a restore.
  "FEEDBACK_RELAY_TOKEN",
  // #6156: not a secret, but the slice-pressure watchdog's victim marker. Claude Code
  // sets CLAUDECODE=1 only for the processes it runs, so a process carrying it (and a
  // HAPI_SESSION_ID) is an agent-run tool the watchdog may kill. A daemon or tmux
  // server started from inside a session would hand it to every pane, making each
  // session's wrapper and claude a valid victim. The daemon deletes it from its own
  // env at start (daemon/run.ts); this strips it from a tmux server an older or
  // session-started daemon created. claude itself never needs it inherited (it
  // marks a nested session).
  "CLAUDECODE",
  // #5304: a cloud VM's per-VM key for verifying the gateway's Google sign-in hand-off
  // token. Only the server reads it (googleHandoffSecret, serverSettings.ts); the daemon
  // deletes it from its own env at start (daemon/run.ts). VMs provisioned before #5304
  // also carry it in the daemon unit's 20-handoff.conf until the reconcile
  // handoff-placement repair removes that line. Keep it after that repair too: a tmux
  // server started by an older daemon (KillMode=process) can still hold an old value.
  // Not in SECRET_ENV_VARS, for the #5847 reason given at FEEDBACK_INBOX_TOKEN. It is
  // not a boundary against a same-user process reading the drop-in or /proc environ.
  "HAPI_GOOGLE_HANDOFF_SECRET",
]);

/**
 * Server-only secrets the daemon deletes from its own `process.env` at start
 * (`startDaemon`, daemon/run.ts), before recovery, tmux or any spawn runs. Only the
 * server reads each one, and every child the daemon spawns copies its environment
 * (sessionSpawner.ts), so a daemon unit that sets one would hand it to the
 * direct-spawn wrapper and to the routes that skip the agent strip (#4125, #4057).
 * Deleting it changes neither the launch snapshot in /proc/<pid>/environ nor what a
 * same-user process can read from a drop-in or settings.json; it stops the value
 * being handed to children. That holds for Node's spawn and for any call that
 * passes `env: process.env`, but NOT for `Bun.spawn`/`Bun.spawnSync` without an
 * `env` option, which passes the ORIGINAL launch environment; so every such call
 * in cli/src passes `env` (pinned by a source scan in secretEnvVars.test.ts).
 *
 * - `FEDERATION_API_TOKEN` (#5764): server/src/config/federationConfig.ts.
 * - `FEEDBACK_INBOX_TOKEN` (#5781) and `FEEDBACK_INBOX_NODE_TOKEN` (#5858 R1): the
 *   feedback sink and inbox bearers (serverSettings.ts).
 * - `FEEDBACK_RELAY_TOKEN` (#5781 D7): VMs provisioned before #5926 still carry
 *   21-feedback.conf on the daemon unit.
 * - `HAPI_GOOGLE_HANDOFF_SECRET` (#5304): VMs provisioned before #5304 carry it in
 *   the daemon unit's 20-handoff.conf.
 *
 * A strict subset of {@link AGENT_FORBIDDEN_ENV_VARS} (pinned by a test): the
 * onboarding vars are consumed before they are deleted, the daemon reads its own
 * `GH_TOKEN`, and `CLAUDECODE` (#6156, not a secret) is deleted by startDaemon's
 * own Defense #1 loop, so none of them belongs here.
 */
export const DAEMON_DELETE_AT_START_ENV_VARS: ReadonlySet<string> = new Set([
  "FEDERATION_API_TOKEN",
  "FEEDBACK_INBOX_TOKEN",
  "FEEDBACK_INBOX_NODE_TOKEN",
  "FEEDBACK_RELAY_TOKEN",
  "HAPI_GOOGLE_HANDOFF_SECRET",
]);

/**
 * Return a COPY of `env` with every {@link AGENT_FORBIDDEN_ENV_VARS} key removed.
 * The input is NOT mutated. Generic over the value type so it composes over both a
 * plain `Record<string, string>` (the `buildLauncherEnv` output) and a
 * `NodeJS.ProcessEnv` (the `sdk` launcher spawn env) with no cast at the call site
 * — mirrors {@link stripSecretEnvVars}.
 */
export function stripAgentForbiddenEnvVars<V>(
  env: Record<string, V>
): Record<string, V> {
  const result: Record<string, V> = {};
  for (const [key, value] of Object.entries(env)) {
    if (AGENT_FORBIDDEN_ENV_VARS.has(key)) continue;
    result[key] = value;
  }
  return result;
}

/**
 * Return a COPY of `env` with every {@link SECRET_ENV_VARS} key removed. The
 * input is NOT mutated (mirrors `buildSubprocessEnvWithoutSentinels` in
 * `launcherShared.ts`).
 *
 * Generic over the value type so it composes over both a plain
 * `Record<string, string>` (the `buildLauncherEnv` output) and a
 * `NodeJS.ProcessEnv` (`Record<string, string | undefined>`, the `sdk` launcher
 * spawn env) without a cast at the call site.
 */
export function stripSecretEnvVars<V>(
  env: Record<string, V>
): Record<string, V> {
  const result: Record<string, V> = {};
  for (const [key, value] of Object.entries(env)) {
    if (SECRET_ENV_VARS.has(key)) continue;
    result[key] = value;
  }
  return result;
}

/**
 * Issue #3813: build the env for a spawned HARNESS CHILD process at a wrapper→child
 * seam, applying the per-flavor secret strip. This is the ONE helper called at all
 * FIVE wrapper→child seams (`launcherShared.buildLauncherEnv`, `claude/sdk/query`,
 * `agent-codex/codexMcpClient`, `agent-codex/codexLocal`,
 * `agent-gemini/registerAgent`) — NEVER the daemon→wrapper hop, whose env belongs
 * to the `hapi` WRAPPER and must keep `CLI_API_TOKEN`/`HAPI_SERVER_URL` (the #3813-1
 * layering finding: the wrapper's own token source is `process.env.CLI_API_TOKEN`).
 *
 * Two composed strips:
 *  - UNGATED {@link stripAgentForbiddenEnvVars} (the #2383 set) — reaches EVERY
 *    flavor's child regardless of the OmniBox switch. This is the ONE OFF-path
 *    behaviour change vs pre-#3813 (ruling D2): codex/gemini children now lose the
 *    #2383 set exactly as Claude children already did (the same change #2672 shipped
 *    for the Claude launcher).
 *  - GATED on `configuration.omniboxSandboxEnabled`: the per-flavor view
 *    `SECRET_ENV_VARS − hostJail.keepSecrets(flavor)`. A Claude child (keepSecrets
 *    `[]`) loses the whole `SECRET_ENV_VARS` set — identical to today's Claude
 *    seams; a Codex child KEEPS `OPENAI_API_KEY`; a Gemini child KEEPS
 *    `GEMINI_API_KEY`/`GOOGLE_API_KEY`; EVERY child still loses `CLI_API_TOKEN`,
 *    `HAPI_SERVER_URL`, `HAPI_HTTP_MCP_URL`, `TELEGRAM_BOT_TOKEN`, `GH_TOKEN` and
 *    the rest. The
 *    {@link SECRET_ENV_VARS} constant is untouched (subtraction, not a rewrite), so a
 *    future member joins every child's loss set automatically.
 *
 * Generic over the value type (mirrors {@link stripSecretEnvVars} /
 * {@link stripAgentForbiddenEnvVars}) so it composes over both a plain
 * `Record<string, string>` and a `NodeJS.ProcessEnv` with no cast at the call site.
 * The input is NOT mutated.
 */
export function buildHarnessChildEnv<V>(
  flavor: AgentFlavor,
  env: Record<string, V>
): Record<string, V> {
  // (a) UNGATED #2383 strip — reaches every flavor's child (ruling D2).
  const stripped = stripAgentForbiddenEnvVars(env);
  // (b) GATED per-flavor secret strip — only when the OmniBox sandbox is ON.
  if (!configuration.omniboxSandboxEnabled) return stripped;
  const keep = new Set(
    resolveHostJailAxis(resolveHarnessManifest(flavor)).keepSecrets
  );
  const result: Record<string, V> = {};
  for (const [key, value] of Object.entries(stripped)) {
    if (SECRET_ENV_VARS.has(key) && !keep.has(key)) continue;
    result[key] = value;
  }
  return result;
}
