// SPDX-License-Identifier: MIT
/**
 * Generate temporary settings file with Claude hooks for session tracking.
 *
 * Creates a settings.json file that configures Claude's SessionStart hook
 * to notify our HTTP server when sessions change (new session, resume, compact, etc.).
 */

import { join } from "node:path";
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { configuration } from "@/configuration";
import { logger } from "@/ui/logger";
import { getHappyCliCommand } from "@/utils/spawnHappyCLI";

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
}

/**
 * Issue #4568 (F1): the `apiKeyHelper` command string for an API-key session.
 * Claude Code runs it through `/bin/sh` and reads the key from its stdout, so the
 * key is in no process environment. `HAPI_HOME` is pinned to THIS instance's
 * home so the helper reads the same vault the launcher checked, whatever the
 * child's environment holds. The string carries only the vault id and mask.
 */
export function buildApiKeyHelperCommand(
  binding: ApiKeyHelperBinding,
  deps: {
    happyHomeDir?: string;
    cli?: { command: string; args: string[] };
  } = {}
): string {
  const helperArgs = ["api-key-helper", "--id", binding.apiKeyId];
  if (binding.masked) helperArgs.push("--mask", binding.masked);
  const cli = deps.cli
    ? { command: deps.cli.command, args: [...deps.cli.args, ...helperArgs] }
    : getHappyCliCommand(helperArgs);
  const home = deps.happyHomeDir ?? configuration.happyHomeDir;
  // The assignment name must stay unquoted for sh to treat it as an assignment.
  return `HAPI_HOME=${shellQuote(home)} ${shellJoin([cli.command, ...cli.args])}`;
}

/**
 * Generate a temporary settings file with SessionStart hook configuration.
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
export function generateHookSettingsFile(
  port: number,
  token: string,
  claudeMdExcludes: string[] = [],
  outputStyle?: string,
  apiKeyBinding?: ApiKeyHelperBinding
): string {
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
  } = {
    hooks: {
      SessionStart: hookEntry,
      UserPromptSubmit: hookEntry,
      Stop: hookEntry,
      Notification: hookEntry,
    },
  };

  // Issue #2155: merge the role profile's `@`-include exclusions (ruling D3).
  // Only add the key when non-empty — an empty exclude list must produce a
  // settings file byte-identical to the pre-#2155 hooks-only file (fail-open).
  if (claudeMdExcludes.length > 0) {
    settings.claudeMdExcludes = claudeMdExcludes;
  }

  // Issue #2626: inject the per-session output style. Only add the key when a
  // style is selected — an unset style must produce a settings file
  // byte-identical to the pre-#2626 file (fail-open, R2), exactly like the
  // claudeMdExcludes block above. A `--settings` scalar `outputStyle` wins over
  // `~/.claude/settings.local.json` (Task 1 spike, verified on Claude Code 2.1.x).
  if (outputStyle) {
    settings.outputStyle = outputStyle;
  }

  // Issue #4568 (F1): an API-key session's credential. Claude Code reads the key
  // from the helper's stdout, so the key never enters a process environment;
  // measured on 2.1.280, the helper outranks `CLAUDE_CODE_OAUTH_TOKEN` and the
  // `/login` credentials, and a failing helper yields an empty credential (a
  // 401), never a login fallback. Only added for a key session — every other
  // session's file stays byte-identical.
  if (apiKeyBinding) {
    settings.apiKeyHelper = buildApiKeyHelperCommand(apiKeyBinding);
  }

  writeFileSync(filepath, JSON.stringify(settings, null, 4));
  logger.debug(
    `[generateHookSettings] Created hook settings file: ${filepath}`
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
 */
export function generateApiKeyHelperSettingsFile(
  binding: ApiKeyHelperBinding
): string {
  const hooksDir = join(configuration.happyHomeDir, "tmp", "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const filepath = join(hooksDir, `api-key-helper-${process.pid}.json`);
  writeFileSync(
    filepath,
    JSON.stringify({ apiKeyHelper: buildApiKeyHelperCommand(binding) }, null, 4)
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
