// SPDX-License-Identifier: MIT AND AGPL-3.0-only
/**
 * Codex CLI version, executable and transport selection helpers (#6263).
 *
 * Hapimatic drives a remote Codex session over one of two transports:
 * - `mcp`: `codex mcp-server` (the MCP tools `codex` / `codex-reply`). Codex
 *   CLI 0.154.0 removed that subcommand.
 * - `app-server`: `codex app-server` (newline-delimited JSON-RPC over stdio).
 *
 * The selection is env (`HAPI_CODEX_TRANSPORT`), then `settings.json`
 * (`codexTransport`), then automatic by version. Mirrors
 * `shared/src/launcherResolver.ts` (env, then settings, then default, with the
 * rejected value recorded).
 */

import { execFileSync } from "node:child_process";
import { logger } from "@/ui/logger";

/**
 * Range of codex CLI versions whose `threadId` session-contract Hapimatic is
 * verified against. 0.144.6 is the first version carrying the verified `threadId`
 * contract.
 */
export const CODEX_MIN_SUPPORTED = "0.144.6";
/**
 * The newest Codex CLI a remote session was verified on (either transport): the
 * largest entry of CODEX_TRANSPORT_VERIFIED_VERSIONS (a test holds them equal).
 * The "above the tested maximum" warning uses each transport's own maximum
 * (codexTestedMaxFor), so a newer app-server stamp leaves the MCP warning intact.
 */
export const CODEX_TESTED_MAX = "0.167.0";
/** The Codex CLI release that removed `codex mcp-server` (2026-09-09). */
export const CODEX_MCP_SERVER_REMOVED_IN = "0.154.0";

/**
 * R13: the Codex CLI versions each transport was verified on. `mcp` is the
 * transport Hapimatic shipped with (threadId contract verified from 0.144.6,
 * live through 0.147.0). `app-server` is the #6263 port: live in a Hapimatic
 * session on 0.147.0, and verified headless on 0.166.0 and 0.167.0 (the real
 * CodexAppServerTransport, a scratch CODEX_HOME through OpenRouter: approvals,
 * abort, a permission-mode change, a child kill and resume, a fresh-process
 * resume; the `hapi` MCP tool by a stand-in MCP server). Matt's gate keeps a
 * newer Codex out of the shared account folders, which a live session uses.
 */
export const CODEX_TRANSPORT_VERIFIED_VERSIONS: Readonly<
  Record<CodexTransportKind, readonly string[]>
> = {
  mcp: ["0.144.6", "0.147.0"],
  "app-server": ["0.147.0", "0.166.0", "0.167.0"],
};

/** Wall-clock limit for `codex --version`, so a hung binary cannot block a start. */
export const CODEX_VERSION_PROBE_TIMEOUT_MS = 5_000;

export type CodexTransportKind = "mcp" | "app-server";
export type CodexTransportSetting = CodexTransportKind | "auto";
export type CodexTransportSource = "env" | "settings" | "auto";

export interface ResolvedCodexTransport {
  kind: CodexTransportKind;
  source: CodexTransportSource;
  /** An env or settings value that was not `auto`, `mcp` or `app-server`. */
  rejected?: string;
}

const VERSION_PATTERN =
  /codex-cli\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)/;

/**
 * Parse the output of `codex --version`, e.g. "codex-cli 0.147.0" or
 * "codex-cli 0.154.0-beta.2". Returns null when it holds no version.
 */
export function parseCodexVersionOutput(output: string): string | null {
  const match = output.match(VERSION_PATTERN);
  return match ? match[1] : null;
}

/**
 * Read the version of the Codex executable `bin`. Returns null when it is not
 * installed, exits non-zero, runs past the probe timeout, or prints no
 * version. Uses execFileSync (no shell): the argument list is static.
 */
export function readCodexVersion(bin: string = "codex"): string | null {
  try {
    const output = execFileSync(bin, ["--version"], {
      encoding: "utf8",
      timeout: CODEX_VERSION_PROBE_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return parseCodexVersionOutput(output.trim());
  } catch (error) {
    logger.debug("[codex] Error reading codex version:", error);
    return null;
  }
}

/** The newest Codex CLI `transport` was verified on. */
export function codexTestedMaxFor(transport: CodexTransportKind): string {
  return CODEX_TRANSPORT_VERIFIED_VERSIONS[transport].reduce((max, v) =>
    compareStableVersion(v, max) > 0 ? v : max
  );
}

/** Compare two X.Y.Z version strings, ignoring any prerelease suffix. Returns -1 / 0 / 1. */
export function compareStableVersion(a: string, b: string): number {
  const pa = a.split("-")[0].split(".").map(Number);
  const pb = b.split("-")[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

/** True for a prerelease build such as `0.148.0-alpha.3` or `0.154.0-rc.1`. */
export function isPrereleaseVersion(version: string): boolean {
  return version.includes("-");
}

/**
 * Warn (never throw) when the installed codex version is outside the range
 * Hapimatic is verified against. Silent for a null version (codex absent or
 * unparseable).
 *
 * Below CODEX_MIN_SUPPORTED the legacy sessionId/conversationId contract still
 * works on the MCP transport, so a throw would regress a working install. Above
 * the transport's tested maximum (or a prerelease) the contract MAY still hold,
 * so a hard fail would be its own regression.
 */
export function warnIfUnverifiedCodexVersion(
  version: string | null,
  transport: CodexTransportKind
): void {
  if (!version) return;

  const prerelease = isPrereleaseVersion(version);
  const testedMax = codexTestedMaxFor(transport);
  if (compareStableVersion(version, CODEX_MIN_SUPPORTED) < 0) {
    logger.warn(
      `[codex] Installed codex ${version} is BELOW the verified minimum ` +
        `${CODEX_MIN_SUPPORTED} (transport ${transport}). Hapimatic's Codex ` +
        `threadId contract is verified for >= ${CODEX_MIN_SUPPORTED} (tested ` +
        `through ${CODEX_TESTED_MAX}); on this older codex only the legacy ` +
        `sessionId contract applies and Codex sessions may fail.`
    );
  } else if (prerelease || compareStableVersion(version, testedMax) > 0) {
    logger.warn(
      `[codex] Installed codex ${version} is ABOVE the tested maximum ` +
        `${testedMax}${prerelease ? " (prerelease)" : ""} for the ` +
        `${transport} transport (verified on ` +
        `${CODEX_TRANSPORT_VERIFIED_VERSIONS[transport].join(", ")}); if Codex ` +
        `sessions misbehave, update Hapimatic.`
    );
  }
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * R14: the Codex executable to run — `HAPI_CODEX_BIN`, else `settings.json`
 * `codexBin`, else `codex` from PATH.
 */
export function resolveCodexBin(
  env: NodeJS.ProcessEnv,
  settings: { codexBin?: unknown }
): string {
  return nonEmpty(env.HAPI_CODEX_BIN) ?? nonEmpty(settings.codexBin) ?? "codex";
}

function normalizeSetting(value: unknown): string | undefined {
  return nonEmpty(value)?.toLowerCase();
}

function isTransportSetting(value: string): value is CodexTransportSetting {
  return value === "auto" || value === "mcp" || value === "app-server";
}

/**
 * The transport automatic selection picks for a Codex version: `app-server`
 * from CODEX_MCP_SERVER_REMOVED_IN (any prerelease of it included) and for an
 * unreadable version, else `mcp`.
 */
export function autoCodexTransportKind(
  version: string | null
): CodexTransportKind {
  if (!version) return "app-server";
  return compareStableVersion(version, CODEX_MCP_SERVER_REMOVED_IN) >= 0
    ? "app-server"
    : "mcp";
}

/**
 * R2/R3: pick the Codex transport. A valid env value wins; an invalid one is
 * recorded in `rejected` and settings are consulted; an absent, `auto` or
 * invalid value means automatic selection by version.
 */
export function resolveCodexTransportKind(args: {
  version: string | null;
  envValue: unknown;
  settingsValue: unknown;
}): ResolvedCodexTransport {
  const auto = (rejected?: string): ResolvedCodexTransport => {
    const resolved: ResolvedCodexTransport = {
      kind: autoCodexTransportKind(args.version),
      source: "auto",
    };
    if (rejected !== undefined) resolved.rejected = rejected;
    return resolved;
  };

  let rejected: string | undefined;
  const env = normalizeSetting(args.envValue);
  if (env !== undefined) {
    if (isTransportSetting(env)) {
      return env === "auto" ? auto() : { kind: env, source: "env" };
    }
    rejected = env;
  }

  const settings = normalizeSetting(args.settingsValue);
  if (settings !== undefined) {
    if (isTransportSetting(settings)) {
      if (settings === "auto") return auto(rejected);
      const resolved: ResolvedCodexTransport = {
        kind: settings,
        source: "settings",
      };
      if (rejected !== undefined) resolved.rejected = rejected;
      return resolved;
    }
    rejected = rejected ?? settings;
  }

  return auto(rejected);
}
