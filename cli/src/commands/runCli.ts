// SPDX-License-Identifier: AGPL-3.0-only
import { join } from "node:path";

import { CLI_VERSION } from "@/version";
import { addBundledGitLfsToPath, ensureRuntimeAssets } from "@/runtime/assets";
import { isBunCompiled } from "@/projectPath";
import { logger } from "@/ui/logger";
import { getCliArgs } from "@/utils/cliArgs";
import { configuration } from "@/configuration";
import { CliExtensionHostImpl } from "@/ext/host";
import { loadCliExtensions } from "@/ext/loader";
import { scanFilesystemExtensions } from "@/ext/fsLoader";
import { extensions as builtinCliExtensions } from "@/extensions.generated";
import {
  SELFTEST_ARGV_REPORT_ENV,
  argsBeforeMarker,
  exitWithArgvReport,
  planDispatch,
} from "./dispatchPlan";
import type { DispatchPlan } from "./dispatchPlan";
import { apiKeyHelperCommand } from "./apiKeyHelper";
import { securityCommand } from "./security";
import { hookForwarderCommand } from "./hookForwarder";

/**
 * Commands that dispatch BEFORE any CLI extension loads, so an extension's loader output
 * never lands on their stdout and no extension code runs in their process:
 * - `api-key-helper` (#4568 IR1): Claude Code uses its whole stdout as the API key.
 * - `security` (#4886 N2): the audit's `--json` report must parse, and an extension the
 *   audit may report as blocked must not have run inside the audit (or replaced the verb).
 * - `hook-forwarder` (#6455): Claude Code reads a Stop hook's stdout as its decision and
 *   adds a `UserPromptSubmit` or `SessionStart` hook's stdout to the agent's context.
 * All are built-in commands and need no extension.
 */
const PRE_EXTENSION_COMMANDS = new Set([
  apiKeyHelperCommand.name,
  securityCommand.name,
  hookForwarderCommand.name,
]);

/**
 * Issue #5348: a refused command line (an end-of-options marker for a command that does
 * not take it, or a claude argument the parser refuses) exits 1 here, before runtime
 * assets are unpacked and before the command runs. Report mode exits first.
 */
function exitIfRefused(plan: DispatchPlan): void {
  // Issue #5348 (R12, R15): `hapi selftest argv` report mode — the decision is written
  // from this same plan and the process exits 86 before the refusal exit, the runtime
  // assets and the command, on either dispatch path.
  const reportPath = process.env[SELFTEST_ARGV_REPORT_ENV];
  if (reportPath) {
    exitWithArgvReport(reportPath, plan);
  }
  if (plan.refused !== undefined) {
    console.error(plan.refused);
    process.exit(1);
  }
}

export async function runCli(): Promise<void> {
  const args = getCliArgs();

  // Issue #5348 (R5): the version flag is read from the FIRST argument only, so a `-v`
  // meant for a command (`hapi launcher status -v`) or after the marker reaches it.
  if (args[0] === "-v" || args[0] === "--version") {
    console.log(`hapi version: ${CLI_VERSION}`);
    process.exit(0);
  }

  // A loader warning goes to stdout (logger.warn → console.log); see PRE_EXTENSION_COMMANDS.
  if (PRE_EXTENSION_COMMANDS.has(args[0])) {
    const plan = planDispatch(args);
    exitIfRefused(plan);
    await plan.command.run(plan.context);
    return;
  }

  if (isBunCompiled()) {
    process.env.DEV = "false";
  }

  // Load CLI extensions BEFORE planDispatch (issue #1270, Sub-Issue F) so
  // extensions can register additional commands via host.commands.add(). Runs
  // AFTER the -v/--version early-exit (so version output stays fast) and the
  // PRE_EXTENSION_COMMANDS early dispatch above. Empty registry → no-op.
  const cliHost = new CliExtensionHostImpl();
  // #1289: opt-in runtime filesystem extensions (ships gated OFF). When
  // HAPI_FS_EXTENSIONS is truthy, scan `${HAPI_HOME}/extensions/*/manifest.json`
  // for extensions declaring a `cli` entry point and concatenate them AFTER the
  // build-time builtins (R6). Default OFF → fsCliEntries is [] and this call is
  // byte-identical to before. ⚠️ This runs on every `hapi` invocation except
  // -v/--version and PRE_EXTENSION_COMMANDS (which include the short-lived
  // per-hook-event `hook-forwarder` subprocess, #6455), so the scan cost is
  // paid per process — acceptable because it is opt-in and only fires when the
  // operator has enabled filesystem extensions.
  const fsExtensionsEnabled = ["true", "1", "yes"].includes(
    process.env.HAPI_FS_EXTENSIONS?.toLowerCase() || ""
  );
  const fsCliEntries = fsExtensionsEnabled
    ? await scanFilesystemExtensions(
        join(configuration.happyHomeDir, "extensions"),
        new Set(builtinCliExtensions.map(e => e.manifest.id))
      )
    : [];
  await loadCliExtensions(cliHost, [...builtinCliExtensions, ...fsCliEntries]);

  // After the extensions load, so an extension command resolves before it is refused.
  const plan = planDispatch(args);
  exitIfRefused(plan);
  const { command, context } = plan;

  if (command.requiresRuntimeAssets) {
    await ensureRuntimeAssets();
    addBundledGitLfsToPath();
    // Up to the marker only: the prompt after it is not written to the log.
    logger.debug(
      "Starting hapi CLI with args: ",
      argsBeforeMarker(process.argv)
    );
  }

  await command.run(context);
}
