// SPDX-License-Identifier: MIT
import chalk from "chalk";
import { Writable } from "node:stream";
import { authAndSetupMachineIfNeeded } from "@/ui/auth";
import { initializeToken } from "@/ui/tokenInit";
import { maybeAutoStartServer } from "@/utils/autoStartServer";
import { logger } from "@/ui/logger";
import type { CommandDefinition } from "./types";

/**
 * Issue #1906 — `hapi acp` command. Exposes Hapimatic AS an ACP agent over
 * stdio so an editor (Zed/Neovim) can drive a governed Claude session. The
 * static command route is repo-sanctioned ("the ACP backend stays core",
 * `cli/CLAUDE.md`); an extension route is rejected.
 *
 * Modeled on `commands/opencode.ts` (the post-extension-migration static-command
 * pattern; `commands/codex.ts`/`gemini.ts` no longer exist). The critical
 * difference: ACP speaks JSON-RPC over stdout, so this command installs a
 * process-wide stdout guard BEFORE the bootstrap helpers run — otherwise
 * `maybeAutoStartServer()`'s console.log lines (and any stray
 * logger.info/warn/error) would corrupt the protocol stream, which fail-shuts on
 * the first unparseable line (R-RISK-3).
 */
export const acpCommand: CommandDefinition = {
  name: "acp",
  requiresRuntimeAssets: true,
  run: async ({ commandArgs }) => {
    let startedBy: "daemon" | "terminal" | undefined;
    for (let i = 0; i < commandArgs.length; i++) {
      if (commandArgs[i] === "--started-by") {
        startedBy = commandArgs[++i] as "daemon" | "terminal";
      }
    }

    // Capture the REAL stdout write for the ACP transport's dedicated channel,
    // then redirect every OTHER process.stdout write to stderr. Stray output is
    // still visible (in the editor's server log) but never on the JSON-RPC
    // channel. logger.debug is already file-based, so this only diverts
    // console.log / logger.{info,warn,error} and the maybeAutoStartServer prints.
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const acpOutput = new Writable({
      write(chunk, encoding, callback) {
        return originalStdoutWrite(
          chunk as string | Uint8Array,
          encoding as BufferEncoding,
          callback
        );
      },
    });
    // R3 (issue #3260): a real EPIPE on stdout (dead editor) emits `'error'` on
    // BOTH the `acpOutput` wrapper above AND the underlying `process.stdout`
    // Socket — the wrapper forwards the chunk and write callback straight to
    // the Socket, so one failed write produces two independent `'error'`
    // emissions on two different EventEmitters, and a listener on either one
    // ALONE still crashes the process (reproduced with a real broken pipe on
    // Node 22). This listener's only job is to keep the process alive; the
    // transport-level `AcpStdioTransport`'s own `this.output.on("error")`
    // listener is what actively rejects pending requests.
    process.stdout.on("error", err =>
      logger.debug("[ACP] stdout error (peer closed the JSON-RPC channel)", err)
    );
    const guardedWrite = ((chunk: unknown, ...args: unknown[]) =>
      (process.stderr.write as (...a: unknown[]) => boolean)(
        chunk,
        ...args
      )) as typeof process.stdout.write;
    process.stdout.write = guardedWrite;

    let stdoutRestored = false;
    const restoreStdout = (): void => {
      if (stdoutRestored) return;
      stdoutRestored = true;
      process.stdout.write = originalStdoutWrite as typeof process.stdout.write;
    };

    try {
      // initializeToken throws cleanly on a non-TTY pipe with no token
      // ("CLI_API_TOKEN is required ... run `hapi auth login`") — a clean
      // editor-side failure, never an interactive hang.
      await initializeToken();
      await maybeAutoStartServer();
      await authAndSetupMachineIfNeeded();

      const { AcpIngressServer } =
        await import("@/agent/backends/acp/AcpIngressServer");
      const server = new AcpIngressServer({
        input: process.stdin,
        output: acpOutput,
        startedBy,
      });
      logger.debug("[ACP] ingress server listening on stdio");

      // Block until the editor disconnects (input stream ends). shutdown() has
      // already torn down every session (servers + api sockets closed) by the
      // time this resolves, so exit cleanly — a disconnected stdio client means
      // the command is done.
      await server.whenClosed;
      restoreStdout();
      process.exit(0);
    } catch (error) {
      restoreStdout();
      logger.reportCaught(error, {
        category: "acp-ingress",
        severity: "error",
      });
      process.stderr.write(
        `${chalk.red("Error:")} ${
          error instanceof Error ? error.message : "Unknown error"
        }\n`
      );
      if (process.env.DEBUG) {
        process.stderr.write(`${String(error)}\n`);
      }
      process.exit(1);
    } finally {
      restoreStdout();
    }
  },
};
