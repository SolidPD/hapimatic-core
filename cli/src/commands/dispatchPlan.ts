// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What `hapi` will do with a command line, decided before anything runs
 * (hapimatic-private#5348).
 *
 * The normalizer no longer removes a `--` (it was always the user's marker in the
 * compiled binary, and consuming it turned `hapi -- --yolo` into a bypass session), so
 * every command can now see one. Only the commands that opt in (`acceptsEndOfOptions`:
 * the claude default and `companion`) take it; every other command, including every
 * extension command, is refused here. For the claude default the argument parser runs
 * here too, so its refusals (a value flag without a value, more than one prompt word, a
 * prompt with a remote start, …) come before runtime assets are unpacked.
 */
import { writeFileSync } from "node:fs";

import { parseClaudeCommandArgs } from "./claudeCommandArgs";
import type { ParsedClaudeCommandArgs } from "./claudeCommandArgs";
import { claudeCommand } from "./claude";
import { companionCommand, companionMarkerRefusal } from "./companion";
import { resolveCommand } from "./registry";
import type { CommandContext, CommandDefinition } from "./types";

export type DispatchPlan = {
  command: CommandDefinition;
  context: CommandContext;
  /** Set when the line is refused: the message to print before exiting 1. */
  refused?: string;
  /** The claude default command's parsed arguments (absent for other commands). */
  claude?: ParsedClaudeCommandArgs;
};

const MARKER = "--";

function displayName(command: CommandDefinition): string {
  return command === claudeCommand ? "claude" : command.name;
}

export function planDispatch(args: string[]): DispatchPlan {
  const { command, context } = resolveCommand(args);
  if (args.includes(MARKER) && command.acceptsEndOfOptions !== true) {
    return {
      command,
      context,
      refused: `hapi ${displayName(command)} does not take --. Only hapi [options] -- "<prompt>" and hapi companion ssh … -- <command> do.`,
    };
  }
  // Only these two commands' arguments are read here: a command's own context may
  // carry nothing else (a test double of resolveCommand returns `context: {}`).
  if (command === claudeCommand) {
    const parsed = parseClaudeCommandArgs(context.commandArgs);
    if ("error" in parsed) {
      return { command, context, refused: parsed.error };
    }
    return { command, context, claude: parsed };
  }
  if (command === companionCommand) {
    const refused = companionMarkerRefusal(context.commandArgs);
    if (refused) {
      return { command, context, refused };
    }
  }
  return { command, context };
}

/**
 * Report mode for `hapi selftest argv` (R12, R15). When this variable names a file,
 * `runCli` writes the dispatch decision there and exits with
 * {@link SELFTEST_ARGV_REPORT_EXIT} before anything runs. It is stripped from every
 * child environment the CLI builds (`AGENT_FORBIDDEN_ENV_VARS`).
 */
export const SELFTEST_ARGV_REPORT_ENV = "HAPI_SELFTEST_ARGV_REPORT";

/** Report mode always exits with this reserved code, never 0, whatever the decision. */
export const SELFTEST_ARGV_REPORT_EXIT = 86;

/** What a command line was decided to do, as `hapi selftest argv` compares it. */
export type ArgvDecision = {
  /** The command reached: its name, `claude` for the default command. */
  command: string;
  refused: boolean;
  /** The claude default command only: the starting mode, the marker prompt, the
   *  arguments forwarded to Claude. */
  permissionMode?: string;
  trailing?: string[];
  claudeArgs?: string[];
  /** Any other command that runs: the arguments it receives. */
  commandArgs?: string[];
};

export function argvDecision(plan: DispatchPlan): ArgvDecision {
  const decision: ArgvDecision = {
    command: displayName(plan.command),
    refused: plan.refused !== undefined,
  };
  if (plan.claude) {
    decision.permissionMode = plan.claude.options.permissionMode;
    decision.trailing = plan.claude.options.claudeTrailingArgs;
    decision.claudeArgs = plan.claude.options.claudeArgs;
  } else if (!decision.refused) {
    decision.commandArgs = plan.context.commandArgs;
  }
  return decision;
}

/**
 * Report mode: write `plan`'s decision (the object `runCli` acts on) to `reportPath`,
 * print one line to stderr and exit {@link SELFTEST_ARGV_REPORT_EXIT}. The file is
 * created exclusively, so the variable can never overwrite one; the exit is the same
 * whether or not the write worked, so report mode never continues into a real start and
 * never exits 0 (`hapi security audit` cannot read as passed).
 */
export function exitWithArgvReport(
  reportPath: string,
  plan: DispatchPlan
): never {
  try {
    writeFileSync(reportPath, `${JSON.stringify(argvDecision(plan))}\n`, {
      flag: "wx",
    });
  } catch {
    // The selftest reads a missing report as a failure; nothing else to do here.
  }
  console.error(
    `hapi: argv selftest report mode (${SELFTEST_ARGV_REPORT_ENV} is set); nothing was started.`
  );
  process.exit(SELFTEST_ARGV_REPORT_EXIT);
}

/** `argv` up to the first `--`, so prompt text after the marker is never logged. */
export function argsBeforeMarker(argv: readonly string[]): string[] {
  const at = argv.indexOf(MARKER);
  return at < 0 ? [...argv] : argv.slice(0, at);
}
