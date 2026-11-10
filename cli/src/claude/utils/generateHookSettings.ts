// SPDX-License-Identifier: MIT AND AGPL-3.0-only
/**
 * Generate temporary settings file with Claude hooks for session tracking.
 *
 * Creates a settings.json file that configures Claude's SessionStart hook
 * to notify our HTTP server when sessions change (new session, resume, compact, etc.).
 */

import { join, resolve } from "node:path";
import {
  writeFileSync,
  mkdirSync,
  unlinkSync,
  existsSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { NODE_DOCS_DIR_NAME, NODE_DOCS_VERSION_FILE } from "@hapi/protocol";
import { parseApiKeyRef } from "@hapi/protocol/apiKeyRef";
import { configuration } from "@/configuration";
import { logger } from "@/ui/logger";
import { getHappyCliCommand } from "@/utils/spawnHappyCLI";
import type { SessionMcpPolicy } from "./mcpSessionPolicy";

function shellQuote(value: string): string {
  if (value.length === 0) {
    return '""';
  }

  if (/^[A-Za-z0-9_\/:=-]+$/.test(value)) {
    return value;
  }

  return '"' + value.replace(/(["\\$`])/g, "\\$1") + '"';
}

function shellJoin(parts: string[]): string {
  return parts.map(shellQuote).join(" ");
}

/** Issue #4568: the vault reference an API-key session's helper reads by. */
export interface ApiKeyHelperBinding {
  apiKeyId: string;
  /** The mask recorded at spawn; the helper refuses a key that no longer matches. */
  masked?: string;
  /**
   * Issue #5127: the session tag (`HAPI_SESSION_ID`) a key homed on another
   * node is fetched for. Set only for a qualified ref.
   */
  sessionId?: string;
}

/**
 * Issue #5118: the prompt-cache TTL an API-key session's main conversation uses.
 * Claude Code 2.1.280 defaults an API-key credential to the 5-minute TTL (a
 * subscription within its limits gets 1 hour), so every idle gap of 5–60 min
 * re-wrote the whole cached context at the 1.25× write rate. The setting outranks
 * that default; env `CLAUDE_CODE_PROMPT_CACHE_TTL` still outranks the setting,
 * which is the operator's escape hatch. Requests outside the main conversation
 * (subagents, workflows, background and helper requests) keep Claude Code's own
 * default: 5 minutes unless `subagentPromptCacheTtl`,
 * `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` or `ENABLE_PROMPT_CACHING_1H` says
 * otherwise.
 */
export const API_KEY_SESSION_PROMPT_CACHE_TTL = "1h";

/**
 * Issue #4568 (F1): the `apiKeyHelper` command string for an API-key session.
 * Claude Code runs it through `/bin/sh` and reads the key from its stdout, so the
 * key is in no process environment. `HAPI_HOME` is pinned to THIS instance's
 * home so the helper reads the same vault the launcher checked, whatever the
 * child's environment holds. The string carries only the vault id and mask.
 *
 * Issue #5127: for a key homed on another node (a qualified ref) the helper
 * asks this instance's server for the key, so the string also pins
 * `HAPI_SERVER_URL` (the child's environment may name another server, and the
 * CLI default is `:3006`) and names the session (`--session`). A bare id builds
 * exactly the string above.
 */
export function buildApiKeyHelperCommand(
  binding: ApiKeyHelperBinding,
  deps: {
    happyHomeDir?: string;
    serverUrl?: string;
    cli?: { command: string; args: string[] };
  } = {}
): string {
  const shared = parseApiKeyRef(binding.apiKeyId)?.homeNodeId != null;
  const helperArgs = ["api-key-helper", "--id", binding.apiKeyId];
  if (binding.masked) helperArgs.push("--mask", binding.masked);
  if (shared && binding.sessionId) {
    helperArgs.push("--session", binding.sessionId);
  }
  const cli = deps.cli
    ? { command: deps.cli.command, args: [...deps.cli.args, ...helperArgs] }
    : getHappyCliCommand(helperArgs);
  const home = deps.happyHomeDir ?? configuration.happyHomeDir;
  // The assignment names must stay unquoted for sh to treat them as assignments.
  const serverPin = shared
    ? ` HAPI_SERVER_URL=${shellQuote(deps.serverUrl ?? configuration.serverUrl)}`
    : "";
  return `HAPI_HOME=${shellQuote(home)}${serverPin} ${shellJoin([cli.command, ...cli.args])}`;
}

/**
 * Characters refused in the docs path: glob and gitignore metacharacters,
 * which could make the rule wider than the folder, plus parentheses (as a
 * precaution) and C0, DEL and C1 control characters. A refused path gets no
 * rule, so reads prompt as before.
 */
const UNSAFE_RULE_PATH_CHARS = /[*?[\]{}()!\\#\x00-\x1f\x7f-\x9f]/;

/**
 * Whether `dir` is the docs folder Hapimatic wrote: a real directory, not a
 * symlink, holding the `.docs-version` stamp. #6219's writer treats a `docs`
 * folder without the stamp as someone else's and leaves it alone; so does
 * this rule. Never throws.
 */
function isNodeDocsDir(dir: string): boolean {
  try {
    return (
      lstatSync(dir).isDirectory() &&
      existsSync(join(dir, NODE_DOCS_VERSION_FILE))
    );
  } catch {
    return false;
  }
}

/** Seams for tests; every default reads the real machine. */
export interface NodeDocsReadRuleDeps {
  /** `HAPI_HOME` (default: the cli configuration's home dir). */
  homeDir?: string;
  /** The platform (default: `process.platform`). */
  platform?: NodeJS.Platform;
  /** Resolve symlinks; throws when it cannot (default: `realpathSync`). */
  realpath?: (path: string) => string;
  /** Whether a folder is Hapimatic's docs folder (default: `isNodeDocsDir`). */
  isNodeDocsDir?: (dir: string) => boolean;
}

/**
 * Issue #6321: the permission rules that let a session read this node's docs
 * folder, `<HAPI_HOME>/docs/`, with no prompt in the `default` and
 * `acceptEdits` modes. Read-only: the rule covers nothing but reads in the
 * folder, so an Edit or Write there, a mutating Bash command, and any read
 * outside the folder (its parent, a sibling such as `docs-old`, or a
 * `docs/../` path, which Claude Code normalises before matching) prompt as
 * they did before, unless another settings file, the working directory or
 * the permission mode already allows them. Read-only shell commands such as
 * `grep` over the folder are allowed, because Claude Code maps them onto Read
 * rules. Measured on Claude Code 2.1.312.
 *
 * `Read(//abs/path/**)` is Claude Code's absolute-path form (`/path` would be
 * relative to the settings file). A read through a symlink is allowed only
 * when both the written path and the resolved path are allowed, so a home
 * that is or sits under a symlink gets a second rule for its realpath. Both
 * rules name the same folder. The home, not the `docs` folder, is resolved.
 *
 * Returns `[]` (no rule; reads prompt as before #6321, and the settings file
 * is unchanged):
 * - when `<HAPI_HOME>/docs` is not Hapimatic's docs folder: missing, a symlink,
 *   or a real directory without the `.docs-version` stamp (a user's own
 *   `docs/` under a `HAPI_HOME` such as `$HOME` stays behind a prompt);
 * - on Windows, where the path form is unverified;
 * - when the path holds a character that would make the rule wider than the
 *   folder.
 * Never throws: the settings file is written at
 * session start (`runClaude.ts`), and a failed realpath drops only the second
 * rule. `HAPI_HOME` is resolved as #6219's docs pointer resolves it.
 *
 * The rule does not depend on `HAPI_DOCS_POINTER`: the stamped folder holds the
 * public user guide, so letting a session read it is harmless whether or not
 * its prompt names the folder.
 */
export function buildNodeDocsReadRules(
  deps: NodeDocsReadRuleDeps = {}
): string[] {
  if ((deps.platform ?? process.platform) === "win32") return [];
  const home = resolve(deps.homeDir ?? configuration.happyHomeDir);
  const docsDir = join(home, NODE_DOCS_DIR_NAME);
  if (!(deps.isNodeDocsDir ?? isNodeDocsDir)(docsDir)) return [];
  const dirs = [docsDir];
  try {
    const realHome = (deps.realpath ?? realpathSync)(home);
    if (realHome !== home) dirs.push(join(realHome, NODE_DOCS_DIR_NAME));
  } catch {
    // No realpath (the home does not exist yet, or cannot be read): the rule
    // for the resolved path alone.
  }
  if (dirs.some(dir => UNSAFE_RULE_PATH_CHARS.test(dir))) {
    logger.debug(
      "[generateHookSettings] Docs folder path holds a pattern character: no docs read rule"
    );
    return [];
  }
  return [...new Set(dirs.map(dir => `Read(/${dir}/**)`))];
}

/**
 * Generate a temporary settings file with SessionStart hook configuration.
 *
 * Issue #6321: when this node has its docs folder, the file also carries
 * `permissions.allow` with the read-only rule for it (`buildNodeDocsReadRules`).
 * Without one, the file is exactly as before #6321. Every launcher
 * receives this one file, so the rule reaches sdk, pty, tmux and local
 * sessions, and ACP editor sessions, which build their file here too.
 *
 * Issue #2155: `claudeMdExcludes` carries the resolved role profile's
 * `@`-include exclusions (ruling D3). This settings file is the SINGLE
 * `--settings` every launcher already delivers to the claude child (sdk via
 * `settingsPath`, pty/tmux/local via `--settings`), so merging the excludes
 * here scopes the instruction stack on EVERY launcher with no per-launcher
 * change. Empty array (no role / unknown role / missing profile / safe-mode) →
 * the key is omitted entirely → the child loads the FULL stack (fail-open, R3).
 * Verified live: `claudeMdExcludes` in a `--settings` file skips `@`-imported
 * memory files and MERGES with the user-level array (issue #2155 Task 1 spike).
 */
export interface HookSettingsOptions {
  /** Issue #2155: the role profile's `@`-include exclusions. */
  claudeMdExcludes?: string[];
  /** Issue #2626: the per-session output style. */
  outputStyle?: string;
  /** Issue #4568 (F1): an API-key session's helper binding. */
  apiKeyBinding?: ApiKeyHelperBinding;
  /** Issue #6171: the session's MCP set, as `resolveSessionMcpPolicy` built it. */
  mcpPolicy?: Pick<SessionMcpPolicy, "deny" | "connectorsOff"> | null;
}

export function generateHookSettingsFile(
  port: number,
  token: string,
  options: HookSettingsOptions = {}
): string {
  const {
    claudeMdExcludes = [],
    outputStyle,
    apiKeyBinding,
    mcpPolicy,
  } = options;
  const hooksDir = join(configuration.happyHomeDir, "tmp", "hooks");
  mkdirSync(hooksDir, { recursive: true });

  const filename = `session-hook-${process.pid}.json`;
  const filepath = join(hooksDir, filename);

  const { command, args } = getHappyCliCommand([
    "hook-forwarder",
    "--port",
    String(port),
    "--token",
    token,
  ]);
  const hookCommand = shellJoin([command, ...args]);

  // Every registered hook routes through the same hook-forwarder command; the
  // hook server disambiguates events by `hook_event_name`.
  const hookEntry = [
    {
      matcher: "*",
      hooks: [
        {
          type: "command",
          command: hookCommand,
        },
      ],
    },
  ];

  // Issue #1611: register UserPromptSubmit (→ thinking=true) and Stop
  // (→ thinking=false) alongside SessionStart so terminal-attached launchers
  // (pty/tmux), which have no SDK message stream, can drive the session status
  // dot via lifecycle hooks. SubagentStop is intentionally NOT registered — a
  // sub-agent finishing must not clear the whole session's thinking state
  // mid-turn (only the top-level Stop marks the session idle).
  //
  // Issue #1653: register Notification too. Under the tmux/pty launchers a
  // permission (or other TUI-blocking) prompt renders ONLY in the terminal and
  // is invisible to the web chat (the frozen-session signature). The
  // Notification hook fires when Claude is waiting on such a prompt, letting the
  // hook server surface a "waiting on terminal prompt" banner in the web chat.
  const settings: {
    hooks: Record<string, typeof hookEntry>;
    claudeMdExcludes?: string[];
    outputStyle?: string;
    apiKeyHelper?: string;
    promptCacheTtl?: string;
    permissions?: { allow: string[] };
    deniedMcpServers?: Array<{ serverName: string }>;
    disableClaudeAiConnectors?: boolean;
  } = {
    hooks: {
      SessionStart: hookEntry,
      UserPromptSubmit: hookEntry,
      Stop: hookEntry,
      Notification: hookEntry,
    },
  };

  // Issue #2155: merge the role profile's `@`-include exclusions (ruling D3).
  // Only add the key when non-empty — an empty exclude list omits the key, so
  // the child loads the full instruction stack (fail-open).
  if (claudeMdExcludes.length > 0) {
    settings.claudeMdExcludes = claudeMdExcludes;
  }

  // Issue #2626: inject the per-session output style. Only add the key when a
  // style is selected — an unset style omits the key (fail-open, R2), as the
  // claudeMdExcludes block above does. A `--settings` scalar `outputStyle`
  // wins over `~/.claude/settings.local.json` (Task 1 spike, verified on
  // Claude Code 2.1.x).
  if (outputStyle) {
    settings.outputStyle = outputStyle;
  }

  // Issue #6171: the session's MCP set. A deny entry stops that server from
  // starting in this process only (nothing shared is written); measured on
  // Claude Code 2.1.312, it matches the exact `claude mcp list` name for stdio,
  // plugin and connector servers. `disableClaudeAiConnectors` also covers a
  // connector added since the server's last poll. Both keys are omitted with no
  // set or a `mode: "all"` set, so such a file is exactly as before #6171.
  if (mcpPolicy && mcpPolicy.deny.length > 0) {
    settings.deniedMcpServers = mcpPolicy.deny.map(serverName => ({
      serverName,
    }));
  }
  if (mcpPolicy?.connectorsOff) {
    settings.disableClaudeAiConnectors = true;
  }

  // Issue #4568 (F1): an API-key session's credential. Claude Code reads the key
  // from the helper's stdout, so the key never enters a process environment;
  // measured on 2.1.280, the helper outranks `CLAUDE_CODE_OAUTH_TOKEN` and the
  // `/login` credentials, and a failing helper yields an empty credential (a
  // 401), never a login fallback. Only added for a key session — no other
  // session's file carries either key. Issue #5118: the same gate sets the
  // 1-hour cache TTL, so the two keys cannot drift apart (measured on 2.1.280: a
  // `--settings` `promptCacheTtl` is honoured in normal and `--safe-mode`).
  if (apiKeyBinding) {
    settings.apiKeyHelper = buildApiKeyHelperCommand(apiKeyBinding);
    settings.promptCacheTtl = API_KEY_SESSION_PROMPT_CACHE_TTL;
  }

  // Issue #6321: let the session read this node's docs folder without a
  // prompt. Read-only and scoped to exactly that folder; the key is omitted
  // when this node has no docs folder of its own, or no exact rule can be
  // written (fail closed: reads prompt as before, and the file is unchanged).
  // Safe mode drops this whole file (#1633), so a safe-mode session gets no
  // rule, and its prompt names no docs folder either.
  const docsReadRules = buildNodeDocsReadRules();
  if (docsReadRules.length > 0) {
    settings.permissions = { allow: docsReadRules };
  }

  writeFileSync(filepath, JSON.stringify(settings, null, 4));
  logger.debug(
    `[generateHookSettings] Created hook settings file: ${filepath} (${docsReadRules.length} docs read rule(s))`
  );

  return filepath;
}

/**
 * Issue #4568 (F1): the settings file a SAFE-MODE API-key session gets — the
 * `apiKeyHelper` alone. Safe mode suppresses Hapimatic's own injections (#1633),
 * so the hook settings file is dropped; but the helper is the session's ONLY
 * credential, and measured on Claude Code 2.1.280 `--safe-mode` still honours a
 * `--settings` `apiKeyHelper` while hooks stay disabled. Without this file a
 * safe-mode key session would have no key and fall through to the host login.
 * Issue #5118: it also carries the 1-hour cache TTL, which `--safe-mode` honours
 * from `--settings` too (measured on 2.1.280).
 */
export function generateApiKeyHelperSettingsFile(
  binding: ApiKeyHelperBinding
): string {
  const hooksDir = join(configuration.happyHomeDir, "tmp", "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const filepath = join(hooksDir, `api-key-helper-${process.pid}.json`);
  writeFileSync(
    filepath,
    JSON.stringify(
      {
        apiKeyHelper: buildApiKeyHelperCommand(binding),
        promptCacheTtl: API_KEY_SESSION_PROMPT_CACHE_TTL,
      },
      null,
      4
    )
  );
  logger.debug(
    `[generateHookSettings] Created API-key helper settings file: ${filepath}`
  );
  return filepath;
}

/**
 * Clean up the temporary hook settings file.
 */
export function cleanupHookSettingsFile(filepath: string): void {
  try {
    if (existsSync(filepath)) {
      unlinkSync(filepath);
      logger.debug(
        `[generateHookSettings] Cleaned up hook settings file: ${filepath}`
      );
    }
  } catch (error) {
    logger.debug(
      `[generateHookSettings] Failed to cleanup hook settings file: ${error}`
    );
  }
}
