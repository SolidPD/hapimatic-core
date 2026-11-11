// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The remote Codex transport seam (#6263).
 *
 * The remote launcher drives Codex through the ten methods of
 * {@link CodexTransport}. Two implementations exist: `CodexMcpClient`
 * (`codex mcp-server`, removed in Codex CLI 0.154.0) and
 * `CodexAppServerTransport` (`codex app-server`). {@link createCodexTransport}
 * picks one from the version, env and settings it is handed; it never reads
 * `settings.json` or runs `codex --version` itself.
 */

import { logger } from "@/ui/logger";
import { createAppServerTransport } from "./codexAppServerTransport";
import { CodexMcpClient } from "./codexMcpClient";
import {
  CODEX_MCP_SERVER_REMOVED_IN,
  compareStableVersion,
  resolveCodexBin,
  resolveCodexTransportKind,
  type CodexTransportKind,
  type ResolvedCodexTransport,
} from "./codexVersion";
import {
  CodexStartError,
  type CodexEvent,
  type CodexSessionConfig,
} from "./types";
import type { CodexPermissionHandler } from "./utils/permissionHandler";

export { CodexStartError };

/**
 * Start options. `nativeResume` asks the app-server transport to resume a
 * prior thread by id (R10); the MCP transport ignores it and uses the
 * transcript summary in `config` as today.
 */
export interface CodexStartOptions {
  signal?: AbortSignal;
  nativeResume?: {
    threadId: string;
    /** The system prompt without the transcript summary. */
    developerInstructions: string;
  };
}

export interface CodexTurnOptions {
  signal?: AbortSignal;
}

/**
 * What the remote launcher needs from a Codex transport. `startSession` and
 * `continueSession` resolve when the turn ends and reject with an error named
 * `AbortError` on abort.
 */
export interface CodexTransport {
  readonly kind: CodexTransportKind;
  setPermissionHandler(handler: CodexPermissionHandler): void;
  setHandler(handler: ((event: CodexEvent) => void) | null): void;
  connect(): Promise<void>;
  startSession(
    config: CodexSessionConfig,
    options?: CodexStartOptions
  ): Promise<unknown>;
  continueSession(prompt: string, options?: CodexTurnOptions): Promise<unknown>;
  getSessionId(): string | null;
  hasActiveSession(): boolean;
  storeSessionForResume(): string | null;
  clearSession(): void;
  disconnect(): Promise<void>;
  /**
   * Stop the running turn again (app-server, #6263): the launcher's abort
   * signal reaches a turn only once, so a second stop after Codex did not
   * confirm the first one comes through here. `leaving` (exit or switch to
   * local) settles the turn at once. Optional: the MCP transport stops
   * through the abort signal alone.
   */
  stopActiveTurn?(options?: { leaving?: boolean }): void;
}

export interface CodexTransportSelection {
  transport: CodexTransport;
  resolved: ResolvedCodexTransport;
  version: string | null;
  bin: string;
  /**
   * Set only under automatic selection with an unreadable version: builds the
   * MCP transport to try when the app-server start fails (the path that
   * existed before #6263 for an unreadable version — Fallback Preservation).
   */
  mcpFallback?: () => CodexTransport;
}

/** Builds the app-server transport (injectable for tests). */
export type AppServerTransportFactory = (args: {
  bin: string;
  version: string | null;
}) => CodexTransport;

export function createCodexTransport(args: {
  version: string | null;
  settings: { codexTransport?: unknown; codexBin?: unknown };
  env: NodeJS.ProcessEnv;
  createAppServer?: AppServerTransportFactory;
}): CodexTransportSelection {
  const resolved = resolveCodexTransportKind({
    version: args.version,
    envValue: args.env.HAPI_CODEX_TRANSPORT,
    settingsValue: args.settings.codexTransport,
  });
  const bin = resolveCodexBin(args.env, args.settings);
  logger.debug(
    `[codex] transport=${resolved.kind} source=${resolved.source} ` +
      `codex=${args.version ?? "unknown"} bin=${bin}` +
      (resolved.rejected !== undefined
        ? ` rejected=${JSON.stringify(resolved.rejected)}`
        : "")
  );
  if (resolved.rejected !== undefined) {
    logger.warn(
      `[codex] Ignoring the invalid Codex transport ` +
        `${JSON.stringify(resolved.rejected)} (expected auto, mcp or app-server); ` +
        `using ${resolved.kind} (${resolved.source})`
    );
  }

  const buildMcp = (): CodexTransport =>
    new CodexMcpClient({ bin, version: args.version });
  const createAppServer = args.createAppServer ?? createAppServerTransport;
  const transport =
    resolved.kind === "app-server"
      ? createAppServer({ bin, version: args.version })
      : buildMcp();

  const selection: CodexTransportSelection = {
    transport,
    resolved,
    version: args.version,
    bin,
  };
  if (
    resolved.source === "auto" &&
    args.version === null &&
    transport.kind === "app-server"
  ) {
    selection.mcpFallback = buildMcp;
  }
  return selection;
}

function versionLabel(version: string | null): string {
  return version ? `Codex CLI ${version}` : "Codex CLI (version unknown)";
}

/** One attempt's cause, without the "Codex could not start:" prefix. */
export function describeCodexStartFailure(
  error: CodexStartError,
  host: string
): string {
  if (error.kind === "not-installed") {
    const where = error.codexBin === "codex" ? "" : ` at ${error.codexBin}`;
    return `the Codex CLI${where} is not installed on ${host}`;
  }
  if (
    error.transport === "mcp" &&
    error.codexVersion !== null &&
    compareStableVersion(error.codexVersion, CODEX_MCP_SERVER_REMOVED_IN) >= 0
  ) {
    return (
      `${versionLabel(error.codexVersion)} has no \`mcp-server\` command ` +
      `(removed in ${CODEX_MCP_SERVER_REMOVED_IN}). Set the Codex transport ` +
      `to auto or app-server`
    );
  }
  if (error.kind === "exited-at-startup") {
    return `${versionLabel(error.codexVersion)} exited at startup (${error.detail})`;
  }
  return `${versionLabel(error.codexVersion)} did not complete the ${error.transport} handshake (${error.detail})`;
}

/**
 * The cause of a failed start, without prefix or full stop (the archive
 * reason's text). With a fallback attempt (`error.previous`), names both.
 */
export function summarizeCodexStartFailure(
  error: CodexStartError,
  host: string
): string {
  if (error.previous) {
    return (
      `${error.previous.transport}: ` +
      `${describeCodexStartFailure(error.previous, host)}; ` +
      `${error.transport} fallback: ${describeCodexStartFailure(error, host)}`
    );
  }
  return describeCodexStartFailure(error, host);
}

/** R4: the chat sentence for a failed start. */
export function formatCodexStartFailure(
  error: CodexStartError,
  host: string
): string {
  return `Codex could not start: ${summarizeCodexStartFailure(error, host)}.`;
}

/** Any connect failure as a CodexStartError (unknown errors: handshake failed). */
export function toCodexStartError(
  error: unknown,
  context: {
    transport: CodexTransportKind;
    version: string | null;
    bin: string;
  }
): CodexStartError {
  if (error instanceof CodexStartError) return error;
  return new CodexStartError({
    kind: "initialize-failed",
    transport: context.transport,
    codexVersion: context.version,
    codexBin: context.bin,
    detail: error instanceof Error ? error.message : String(error),
    cause: error,
  });
}

/**
 * R3/R4: connect the selected transport. When the selection carries an
 * `mcpFallback` and the first start failed for a reason other than
 * `not-installed` (the MCP transport spawns the same executable), disconnect
 * the failed transport and try MCP. Resolves with the connected transport;
 * rejects with a CodexStartError whose `previous` names the first attempt
 * when the fallback also failed. `attach` sets the launcher's handlers on the
 * fallback before it connects.
 */
export async function connectCodexTransport(args: {
  selection: CodexTransportSelection;
  attach: (transport: CodexTransport) => void;
}): Promise<CodexTransport> {
  const { selection } = args;
  const context = (transport: CodexTransport) => ({
    transport: transport.kind,
    version: selection.version,
    bin: selection.bin,
  });

  const primary = selection.transport;
  let first: CodexStartError;
  try {
    await primary.connect();
    return primary;
  } catch (error) {
    first = toCodexStartError(error, context(primary));
  }
  if (!selection.mcpFallback || first.kind === "not-installed") {
    throw first;
  }

  try {
    await primary.disconnect();
  } catch (error) {
    logger.debug("[codex] Error disconnecting the failed transport", error);
  }
  logger.warn(
    `[codex] ${primary.kind} start failed (${first.kind}: ${first.detail}); trying mcp`
  );
  const fallback = selection.mcpFallback();
  args.attach(fallback);
  try {
    await fallback.connect();
    return fallback;
  } catch (error) {
    const second = toCodexStartError(error, context(fallback));
    second.previous = first;
    throw second;
  }
}
