// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";
import { parseMcpSetLaunchArg } from "@hapi/protocol";
import type { ClaudePermissionMode } from "@hapi/protocol/modes";
import { SessionRoleSchema } from "@hapi/protocol/schemas";
import type { StartOptions } from "@/claude/runClaude";
import {
  parseSpawnPermissionSeed,
  parseTerminalPermissionMode,
} from "@/claude/spawnPermissionSeed";
import { logger } from "@/ui/logger";

export type ParsedClaudeCommandArgs = {
  options: StartOptions;
  showHelp: boolean;
};

const END_OF_OPTIONS = "--";

const QUOTE_THE_PROMPT =
  'Put the text after -- in quotes as one argument: hapi -- "fix the bug"';

/**
 * Issue #5348 F-T2: the refusal for a forwarded flag left without a value before `--`.
 * Measured on Claude Code 2.1.321: a flag that needs a value takes `--` as it; one that
 * takes none (`--verbose`) does not, but hapi cannot tell the two apart. The text also
 * names the no-marker spelling, because a flag that is the only one has nothing to be
 * put ahead of (`hapi --continue "fix the bug"` works without the marker).
 */
function valuelessBeforeMarker(flag: string): { error: string } {
  return {
    error: `${flag} is directly before -- with no value. If it takes a value, Claude would take -- as that value, so give it one (${flag} <value> or ${flag}=<value>). If it takes none, such as --verbose, put it earlier, or leave out the -- (hapi --continue "fix the bug"): hapi cannot tell the two apart.`,
  };
}

/**
 * Issue #5348 (R6): the value of the Hapimatic flag at `args[at]`, or a refusal when it
 * is missing or starts with a dash. A dash-led value is never one the CLI writes, and
 * taking one let a flag swallow the end-of-options marker (`--started-by -- --yolo`
 * gave a bypass session).
 */
function flagValue(
  args: readonly string[],
  at: number,
  flag: string
): string | { error: string } {
  const value = args[at + 1];
  if (value === undefined || value.startsWith("-")) {
    return { error: `${flag} needs a value that does not start with a dash.` };
  }
  return value;
}

/**
 * The `hapi claude` (default command) argv parser, moved out of
 * `commands/claude.ts` unchanged so it is testable (#6400). Hapimatic's own
 * flags become `StartOptions`; every other flag (and a following non-dash
 * value) is forwarded to the claude child in `claudeArgs`.
 *
 * Issue #6400 P1: a terminal
 * `--permission-mode <m>` or `--permission-mode=<m>` is the session's starting
 * mode, at the same rank as `--yolo`, and is no longer forwarded, so every
 * launcher's child runs ONE mode, the session's live mode, which the UI shows
 * and can narrow. `bypassPermissions` is handled exactly as
 * `--dangerously-skip-permissions`. A value that is not a Claude mode, a
 * repeated `--permission-mode`, or a non-bypass mode beside `--yolo` /
 * `--dangerously-skip-permissions` is refused.
 *
 * Issue #5348: parsing stops at the end-of-options marker `--`. The ONE argument
 * after it is the prompt and travels in `claudeTrailingArgs` (never `claudeArgs`, which
 * the launchers search for a mode or a flag), so nothing after the marker sets a
 * posture. More than one argument after it, a prompt word before it, a prompt with a
 * remote or daemon start (the SDK launcher cannot deliver it), or a prompt on Windows
 * (`platform`) is refused. Every Hapimatic flag that takes a value refuses a missing
 * value and one that starts with a dash, so none can take the marker as its value, and
 * `--started-by` takes only `daemon` or `terminal`. A forwarded flag directly before the
 * marker that the catch-all left without a value is refused (F-T2: claude took `--` as its
 * value), judged on what claude sees: the last FORWARDED element, whatever hapi-only
 * flags stand between it and the marker. The catch-all cannot tell a value flag from one
 * that takes none, so this also
 * refuses `--verbose -- "x"`: the named narrowing.
 */
export function parseClaudeCommandArgs(
  commandArgs: readonly string[],
  platform: NodeJS.Platform = process.platform
): ParsedClaudeCommandArgs | { error: string } {
  const args = [...commandArgs];

  if (args.length > 0 && args[0] === "claude") {
    args.shift();
  }

  const options: StartOptions = {};
  let showHelp = false;
  const unknownArgs: string[] = [];
  let terminalMode: ClaudePermissionMode | undefined;
  // Issue #5348: a positional word reached the catch-all (a flag's value does not).
  let positionalWord = false;
  let endOfOptions = false;
  // Issue #5348 F-T2: a flag the catch-all forwarded without a value, and its index in
  // `unknownArgs`. It counts while it is still the LAST forwarded element: a flag hapi
  // consumes and never forwards (--started-by, a non-bypass --permission-mode, every
  // --hapi-*) does not clear it, because claude never sees that flag (fix round 2).
  let valueless: { flag: string; at: number } | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === END_OF_OPTIONS) {
      // Issue #5348 F-T2: claude would take the marker as that flag's value.
      if (valueless !== undefined && valueless.at === unknownArgs.length - 1)
        return valuelessBeforeMarker(valueless.flag);
      // Issue #5348 (R7): exactly one prompt argument after the marker; a bare
      // trailing marker forwards nothing.
      endOfOptions = true;
      const tail = args.slice(i + 1);
      if (tail.length > 1) return { error: QUOTE_THE_PROMPT };
      if (tail.length === 1) {
        options.claudeTrailingArgs = [END_OF_OPTIONS, tail[0]];
      }
      break;
    }

    if (arg === "-h" || arg === "--help") {
      showHelp = true;
      unknownArgs.push(arg);
    } else if (arg === "--hapi-starting-mode") {
      // Issue #6400 C2: refused through the result, like every other refusal
      // here, instead of a ZodError thrown out of `hapi`.
      const startingMode = z.enum(["local", "remote"]).safeParse(args[++i]);
      if (!startingMode.success) {
        return { error: "--hapi-starting-mode needs local or remote." };
      }
      options.startingMode = startingMode.data;
    } else if (arg === "--yolo") {
      options.permissionMode = "bypassPermissions";
      unknownArgs.push("--dangerously-skip-permissions");
    } else if (arg === "--dangerously-skip-permissions") {
      options.permissionMode = "bypassPermissions";
      unknownArgs.push(arg);
    } else if (
      arg === "--permission-mode" ||
      arg.startsWith("--permission-mode=")
    ) {
      // Issue #6400 P1: the session's starting mode, not forwarded. Consumes
      // the next token (space form) so the catch-all does not forward it.
      const value =
        arg === "--permission-mode"
          ? args[++i]
          : arg.slice("--permission-mode=".length);
      if (terminalMode !== undefined) {
        return { error: "--permission-mode was given more than once." };
      }
      const mode = parseTerminalPermissionMode(value);
      if (typeof mode !== "string") return mode;
      terminalMode = mode;
      if (mode === "bypassPermissions") {
        // Exactly the --dangerously-skip-permissions branch above, no wider.
        options.permissionMode = "bypassPermissions";
        unknownArgs.push("--dangerously-skip-permissions");
      }
    } else if (arg === "--hapi-permission-mode") {
      // Issue #6218: Hapimatic-internal (NOT forwarded to the claude child) —
      // the daemon's starting-mode seed. Only a non-bypass Claude mode is
      // accepted: bypass is `--yolo`'s job, and a saved posture outranks the
      // seed in runClaude. Consumes the next token like --hapi-effort.
      const seed = flagValue(args, i++, arg);
      if (typeof seed !== "string") return seed;
      options.spawnPermissionMode = parseSpawnPermissionSeed(seed);
    } else if (arg === "--safe-mode") {
      // Issue #1633: explicit branch — the catch-all below would slurp a
      // following non-dash token as this boolean flag's value. The flag is
      // forwarded to the claude child via claudeArgs; the launchers key
      // their hapi-injection suppression off its presence there.
      options.safeMode = true;
      unknownArgs.push(arg);
    } else if (arg === "--hapi-model-mode") {
      // Issue #1633: Hapimatic-internal (NOT forwarded to the claude child)
      // — seeds runClaude's model state so an explicit model selection
      // survives a model-switch respawn / daemon recovery.
      const modelMode = flagValue(args, i++, arg);
      if (typeof modelMode !== "string") return modelMode;
      options.modelMode = modelMode;
    } else if (arg === "--hapi-effort") {
      // Issue #2456: Hapimatic-internal (NOT forwarded as-is) — seeds
      // runClaude's effort state, which reaches the claude child as --effort
      // (via the launcher argv). Consumes the next token like --hapi-model-mode.
      const effort = flagValue(args, i++, arg);
      if (typeof effort !== "string") return effort;
      options.effort = effort;
    } else if (arg === "--hapi-node-default-effort") {
      // Issue #6070: Hapimatic-internal (NOT forwarded to the claude child) —
      // the node's pre-fit default effort when the spawn's effort was defaulted;
      // runClaude records it so a model switch can re-fit the effort.
      const nodeDefaultEffort = flagValue(args, i++, arg);
      if (typeof nodeDefaultEffort !== "string") return nodeDefaultEffort;
      options.nodeDefaultEffort = nodeDefaultEffort;
    } else if (arg === "--hapi-raw-model") {
      // Issue #2456: Hapimatic-internal — seeds runClaude's currentModel with a
      // specific pinned raw model id (precedence over --hapi-model-mode).
      const rawModel = flagValue(args, i++, arg);
      if (typeof rawModel !== "string") return rawModel;
      options.rawModel = rawModel;
    } else if (arg === "--hapi-session-role") {
      // Issue #2155: Hapimatic-internal (NOT forwarded to the claude child) —
      // seeds runClaude's role so the role profile's claudeMdExcludes are
      // merged into the hook-settings file and a respawn preserves the role.
      // An unrecognized value is dropped → runClaude sees no role → the
      // session loads the FULL stack (fail-open, R3). Consumes the next token
      // via `++i` (like --hapi-model-mode) so the catch-all does not slurp it.
      const role = flagValue(args, i++, arg);
      if (typeof role !== "string") return role;
      const parsedRole = SessionRoleSchema.safeParse(role);
      if (parsedRole.success) {
        options.sessionRole = parsedRole.data;
      }
    } else if (arg === "--hapi-output-style") {
      // Issue #2626 (D): Hapimatic-internal — seeds runClaude's outputStyle,
      // which is injected into the generated --settings file (the choke point
      // every launcher delivers). Free-form (built-in or custom name); no enum
      // validation — an unknown style is silently no-op'd by Claude Code
      // (Task 1 spike, fail-open). Consumes the next token via `++i` like
      // --hapi-effort so the catch-all does not slurp it.
      const outputStyle = flagValue(args, i++, arg);
      if (typeof outputStyle !== "string") return outputStyle;
      options.outputStyle = outputStyle;
    } else if (arg === "--hapi-mcp-set") {
      // Issue #6171: Hapimatic-internal — the MCP set and the known names,
      // which runClaude turns into `deniedMcpServers`. Consumed via `++i` so the
      // catch-all does not forward it to Claude. An unreadable value is dropped
      // and logged: the session then starts every server (today's behavior).
      const raw = flagValue(args, i++, arg);
      if (typeof raw !== "string") return raw;
      const payload = parseMcpSetLaunchArg(raw);
      if (payload) {
        options.mcpSet = payload;
      } else {
        logger.warn("[CLAUDE] ignoring an unreadable --hapi-mcp-set value");
      }
    } else if (arg === "--started-by") {
      // Issue #5348 (F4): only the two values the CLI itself writes.
      const startedBy = z
        .enum(["daemon", "terminal"])
        .safeParse(flagValue(args, i++, arg));
      if (!startedBy.success) {
        return { error: "--started-by needs daemon or terminal." };
      }
      options.startedBy = startedBy.data;
    } else {
      if (!arg.startsWith("-")) {
        positionalWord = true;
      }
      unknownArgs.push(arg);
      // Issue #5348 fix round 3: a `--flag=value` carries its own value, so the next word
      // is not taken with it; a word there is a positional word (a stray prompt word
      // before the marker is then refused below).
      const carriesValue = arg.startsWith("-") && arg.includes("=");
      if (
        !carriesValue &&
        i + 1 < args.length &&
        !args[i + 1].startsWith("-")
      ) {
        unknownArgs.push(args[++i]);
      } else if (arg.startsWith("-") && !arg.includes("=")) {
        // A dash-led next token is not taken as the value, so this flag goes forward
        // without one (`--flag=value` carries its own).
        valueless = { flag: arg, at: unknownArgs.length - 1 };
      }
    }
  }

  // Issue #5348 (R7, R8, R14): the marker prompt's own refusals.
  if (endOfOptions && positionalWord) {
    return { error: QUOTE_THE_PROMPT };
  }
  if (options.claudeTrailingArgs) {
    if (options.startingMode === "remote" || options.startedBy === "daemon") {
      return {
        error:
          "A prompt after -- needs a terminal start; it cannot be delivered to a remote or daemon-started session.",
      };
    }
    if (platform === "win32") {
      return {
        error: "A prompt after -- is not supported on Windows yet.",
      };
    }
  }

  // Issue #6400 P1: a non-bypass terminal mode becomes the HARD starting mode.
  // Beside --yolo / --dangerously-skip-permissions it would leave the child in
  // bypass while the session recorded the narrower mode, so that is refused.
  if (terminalMode !== undefined && terminalMode !== "bypassPermissions") {
    if (options.permissionMode === "bypassPermissions") {
      return {
        error: `--permission-mode ${terminalMode} cannot be combined with --yolo or --dangerously-skip-permissions.`,
      };
    }
    options.permissionMode = terminalMode;
    options.permissionModeFromFlag = true;
  }

  if (unknownArgs.length > 0) {
    options.claudeArgs = [...(options.claudeArgs || []), ...unknownArgs];
  }

  return { options, showHelp };
}
