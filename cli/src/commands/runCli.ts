// SPDX-License-Identifier: MIT
import { join } from "node:path";

import packageJson from "../../package.json";
import { ensureRuntimeAssets } from "@/runtime/assets";
import { isBunCompiled } from "@/projectPath";
import { logger } from "@/ui/logger";
import { getCliArgs } from "@/utils/cliArgs";
import { configuration } from "@/configuration";
import { CliExtensionHostImpl } from "@/ext/host";
import { loadCliExtensions } from "@/ext/loader";
import { scanFilesystemExtensions } from "@/ext/fsLoader";
import { extensions as builtinCliExtensions } from "@/extensions.generated";
import { resolveCommand } from "./registry";
import { apiKeyHelperCommand } from "./apiKeyHelper";
import { securityCommand } from "./security";

/**
 * Commands that dispatch BEFORE any CLI extension loads, so an extension's loader output
 * never lands on their stdout and no extension code runs in their process:
 * - `api-key-helper` (#4568 IR1): Claude Code uses its whole stdout as the API key.
 * - `security` (#4886 N2): the audit's `--json` report must parse, and an extension the
 *   audit may report as blocked must not have run inside the audit (or replaced the verb).
 * Both are built-in commands and need no extension.
 */
const PRE_EXTENSION_COMMANDS = new Set([
  apiKeyHelperCommand.name,
  securityCommand.name,
]);

export async function runCli(): Promise<void> {
  const args = getCliArgs();

  if (args.includes("-v") || args.includes("--version")) {
    console.log(`hapi version: ${packageJson.version}`);
    process.exit(0);
  }

  // A loader warning goes to stdout (logger.warn → console.log); see PRE_EXTENSION_COMMANDS.
  if (PRE_EXTENSION_COMMANDS.has(args[0])) {
    const { command, context } = resolveCommand(args);
    await command.run(context);
    return;
  }

  if (isBunCompiled()) {
    process.env.DEV = "false";
  }

  // Load CLI extensions BEFORE resolveCommand (issue #1270, Sub-Issue F) so
  // extensions can register additional commands via host.commands.add(). Runs
  // AFTER the -v/--version early-exit (so version output stays fast) and the
  // PRE_EXTENSION_COMMANDS early dispatch above. Empty registry → no-op.
  const cliHost = new CliExtensionHostImpl();
  // #1289: opt-in runtime filesystem extensions (ships gated OFF). When
  // HAPI_FS_EXTENSIONS is truthy, scan `${HAPI_HOME}/extensions/*/manifest.json`
  // for extensions declaring a `cli` entry point and concatenate them AFTER the
  // build-time builtins (R6). Default OFF → fsCliEntries is [] and this call is
  // byte-identical to before. ⚠️ This runs on every `hapi` invocation except
  // -v/--version and PRE_EXTENSION_COMMANDS, which return earlier (incl. the
  // short-lived per-hook-event `hook-forwarder` subprocess), so the scan cost is
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

  const { command, context } = resolveCommand(args);

  if (command.requiresRuntimeAssets) {
    await ensureRuntimeAssets();
    logger.debug("Starting hapi CLI with args: ", process.argv);
  }

  await command.run(context);
}
