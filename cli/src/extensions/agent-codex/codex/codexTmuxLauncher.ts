// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Codex tmux launcher helpers (issue #1082 — Multi-LLM Tier 2)
 *
 * Codex-specific pieces of the daemon tmux-persistence path. The agent-agnostic
 * spawn flow (window creation, out-of-band env-file secret delivery, session
 * persistence, bi-directional rename sync) lives in
 * `cli/src/daemon/tmuxSpawnAdapter.ts` and is REUSED via an agent branch in
 * `spawnSessionInTmux` — this module intentionally does NOT duplicate it (the
 * directive's Task 4/Task 5 "fold the codex branch into tmuxSpawnAdapter"
 * alternative, chosen to keep the diff auditable).
 *
 * `claudeTmuxLauncher.ts` does NOT exist at the pin — the real Claude template
 * is `tmuxSpawnAdapter.ts`:`spawnSessionInTmux`/`buildClaudeCommand`; the
 * `claudeTmuxRemote*.ts` files are the separate #1310 in-session backup
 * launcher, not this path.
 */

import fs from "fs/promises";
import { join } from "path";

import { configuration } from "@/configuration";
import { createSessionStore } from "@/sessionPersistence";
import type { PersistedSession } from "@/sessionPersistence";
import { shellSingleQuote } from "@/claude/launcherShared";
import { readSettings } from "@/persistence";
import {
  writeOpenRouterCodexHome,
  writeChatGptCodexHome,
} from "./utils/codexProviderConfig";
import { logger } from "@/ui/logger";

/**
 * Hapimatic-internal flag carrying the codex session id to resume, threaded
 * daemon → wrapper. Parsed by `commands/codex.ts` (NOT forwarded to the codex
 * binary — remote mode ignores CLI args anyway); seeds `runCodex`'s CodexSession
 * sessionId so `codexRemoteLauncher.findCodexResumeFile(session.sessionId)`
 * re-loads the prior conversation from `$CODEX_HOME/sessions`.
 *
 * NOT `codex resume <id>`: that subcommand (codexLocal.ts) is LOCAL-mode only;
 * daemon-started panes always run remote mode (finding 1082-1 CRITICAL).
 */
export const CODEX_TMUX_RESUME_FLAG = "--hapi-codex-resume";

export interface CodexTmuxCommandOptions {
  /** Skip approvals/sandbox (matches the direct-spawn `--yolo` push). */
  yolo: boolean;
  /**
   * OpenRouter gateway model id ("provider/model", #1733). Threaded as
   * `--hapi-model` so the codex child's EnhancedMode.model resolves to it;
   * provider routing itself comes from the CODEX_HOME config.toml.
   */
  model?: string;
  /**
   * Codex session id to resume (populated on a recovery respawn; absent on a
   * fresh spawn). Emitted as CODEX_TMUX_RESUME_FLAG.
   */
  codexResumeSessionId?: string;
}

/**
 * Build the HAPI-wrapper argv for a daemon-spawned Codex tmux pane. Mirrors the
 * direct-spawn arg build (sessionSpawner.ts) and buildClaudeCommand's structure:
 * the wrapper runs `hapi codex --hapi-starting-mode remote --started-by daemon`,
 * i.e. the codex remote launcher. Unlike buildClaudeCommand this PREPENDS the
 * `codex` subcommand (buildClaudeCommand relies on the registry's claude
 * default).
 */
export function buildCodexCommand(options: CodexTmuxCommandOptions): string[] {
  const args: string[] = [
    "codex",
    "--hapi-starting-mode",
    "remote",
    "--started-by",
    "daemon",
  ];

  // Codex has no `opencode`-style config-block YOLO; the CLI flag is honored.
  if (options.yolo) {
    args.push("--yolo");
  }

  // #1733: OpenRouter model id (codex-only — opencode gets its model from
  // OPENCODE_CONFIG_CONTENT, so opencode never reaches this builder).
  if (options.model) {
    args.push("--hapi-model", shellSingleQuote(options.model));
  }

  // Remote-mode resume: thread the codex session id as a HAPI-parsed flag
  // (finding 1082-1). Escaped for the shell join in spawnSessionInTmux.
  if (options.codexResumeSessionId) {
    args.push(
      CODEX_TMUX_RESUME_FLAG,
      shellSingleQuote(options.codexResumeSessionId)
    );
  }

  return args;
}

/**
 * All persisted sessions recoverable as Codex on daemon restart — those tagged
 * `agent === "codex"` in the SessionStore (Task 3 schema). There is no Claude
 * `getRecoverable*` sibling at the pin; this is a new helper, used by
 * RecoveryService and by tests to assert agent tagging.
 */
export async function getRecoverableCodexSessions(): Promise<
  PersistedSession[]
> {
  const store = createSessionStore(configuration.happyHomeDir);
  const sessions = await store.getAll();
  return sessions.filter(s => s.agent === "codex");
}

/**
 * Issue #1082 (ruling D4): set up a DURABLE session-scoped CODEX_HOME for a
 * codex session on the tmux-persistence path. Unlike #1733's direct-spawn
 * CODEX_HOME (an `os.tmpdir` mkdtemp DELETED on every child exit), this dir
 * lives under HAPI_HOME keyed by hapiSessionId so it survives child exit AND
 * daemon restart — codex writes its resume JSONL under `$CODEX_HOME/sessions`,
 * which Tier-2 resume depends on. Cleaned up on session delete
 * (stopTmuxSession) and orphan-GC'd by recovery (RecoveryService.initialize).
 *
 * Deliberately a SEPARATE helper from the #1733 direct-spawn setup (NOT a shared
 * refactor): re-shaping live credential-delivery code without empirical
 * verification (no `codex` binary on this host) risks regressing #1733's
 * working OpenRouter/ChatGPT sessions.
 *
 * Returns `null` when no per-session home is needed (a token-less + model-less
 * codex session uses codex's own durable `~/.codex` — resume works there with
 * no management). Returns `{error}` on a fail-fast condition (OpenRouter model
 * selected but no key configured — mirrors #1733).
 *
 * Security posture (D4): the OpenRouter branch writes NO secret to disk (the key
 * is env-only; config.toml is non-secret), fully preserving #1733's posture. The
 * ChatGPT-token branch writes auth.json 0600 (owner-only, same mode as #1733)
 * which persists for the SESSION lifetime; the scrub-on-exit hardening is gated
 * on the Task-1 spike (codex's auth.json re-read tolerance) and is a documented
 * follow-up.
 */
export async function setupCodexHomeForTmux(opts: {
  hapiSessionId: string;
  token?: string;
  openRouterModel?: string;
  /** Issue #3348: ChatGPT-token native model id (baked into config.toml `model`). */
  chatgptModel?: string;
  /** Issue #3348: codex reasoning effort (baked into `model_reasoning_effort`). */
  chatgptReasoningEffort?: string;
}): Promise<
  | { codexHome: string; extraEnv: Record<string, string> }
  | { error: string }
  | null
> {
  if (!opts.token && !opts.openRouterModel) {
    // A host-auth (token-less) codex keeps its own durable ~/.codex — no
    // CODEX_HOME override (a model selection there is a documented follow-up:
    // seeding host auth into a DURABLE tmux CODEX_HOME risks a stale token).
    return null;
  }

  const codexHome = join(
    configuration.happyHomeDir,
    "codex-homes",
    opts.hapiSessionId
  );
  await fs.mkdir(codexHome, { recursive: true, mode: 0o700 });

  if (opts.openRouterModel) {
    // R4: fail fast if OpenRouter is selected but no key is configured — never
    // fall through to a default provider or hang.
    const liveSettings = await readSettings();
    const openRouterApiKey = liveSettings.openRouterApiKey?.trim() || undefined;
    if (!openRouterApiKey) {
      logger.warn(
        "[DAEMON RUN] OpenRouter model requested (tmux) but no openRouterApiKey configured — failing spawn"
      );
      return {
        error:
          "OpenRouter model selected but no OpenRouter API key is configured on this node. Set `openRouterApiKey` in settings.json and retry.",
      };
    }
    // OpenRouter (R2/R3): config.toml provider table (NOT a secret) + env key.
    await writeOpenRouterCodexHome(codexHome, { model: opts.openRouterModel });
    return {
      codexHome,
      extraEnv: {
        CODEX_HOME: codexHome,
        OPENROUTER_API_KEY: openRouterApiKey,
      },
    };
  }

  if (opts.token) {
    // ChatGPT-auth codex: write the OAuth token to auth.json (0600, owner-only).
    const authPath = join(codexHome, "auth.json");
    await fs.writeFile(authPath, opts.token, { mode: 0o600 });
    await fs.chmod(authPath, 0o600).catch(() => {});
    // Issue #3348: bake the ChatGPT-token model + reasoning effort into
    // config.toml (codex's built-in openai provider; no provider table), in the
    // SAME CODEX_HOME as auth.json. Gated on a managed token being present so
    // this CODEX_HOME always carries auth. A model-less/effort-less codex session
    // writes only auth.json, byte-identical to pre-#3348.
    if (opts.chatgptModel || opts.chatgptReasoningEffort) {
      await writeChatGptCodexHome(codexHome, {
        model: opts.chatgptModel,
        reasoningEffort: opts.chatgptReasoningEffort,
      });
    }
  }
  // #3348 display marker: buildSessionMetadata stamps metadata.nativeModel from
  // HAPI_NATIVE_MODEL so the in-session UI shows the active codex model.
  const extraEnv: Record<string, string> = { CODEX_HOME: codexHome };
  if (opts.chatgptModel) {
    extraEnv.HAPI_NATIVE_MODEL = opts.chatgptModel;
  }
  return { codexHome, extraEnv };
}
