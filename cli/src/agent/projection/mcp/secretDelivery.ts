// SPDX-License-Identifier: AGPL-3.0-only
/**
 * HAL MCP secret delivery — per-carrier NATIVE secret placement (issue #3125,
 * ruling D7b). No dialect has a verified env-FILE config key, so secrets ride
 * each carrier's own mechanism rather than a shared env-file scheme:
 *
 *   - codex     → env maps serialized INTO the composed `config.toml` (already
 *                 written mode 0600 in the 0700 session home — codexProviderConfig).
 *   - gemini    ┐ ACP `newSession` per-server `env` fields (in-protocol,
 *   - opencode  ┘ in-memory); the on-disk handoff artifact is mode 0600.
 *   - claude    → env inlined into the `--mcp-config` JSON temp file (0600).
 *
 * The one irrecoverable failure here is a leaked secret (OR1): a secret value
 * NEVER rides argv (it would land in the process list) and NEVER lands in a
 * group- or world-readable file. This module centralizes that policy and the
 * assertion helpers the emitters and tests reuse.
 */
import { statSync } from "node:fs";
import type { CanonicalMcpServer } from "./types";

/** The four verified carriers. */
export type McpCarrier = "codex" | "gemini" | "opencode" | "claude";

/** Owner-only file mode for any on-disk carrier holding env values. */
export const SECRET_FILE_MODE = 0o600 as const;

/** The per-carrier native secret-placement record (documentation + policy). */
export interface SecretPlacement {
  carrier: McpCarrier;
  /** Human-readable native mechanism. */
  mechanism: string;
  /** Whether env values land in an on-disk artifact for this carrier. */
  onDiskArtifact: boolean;
  /** Required file mode when `onDiskArtifact` (always 0600). */
  fileMode: number;
}

export const SECRET_PLACEMENT: Record<McpCarrier, SecretPlacement> = {
  codex: {
    carrier: "codex",
    mechanism:
      "env maps serialized into the composed config.toml (0600 in the 0700 session home)",
    onDiskArtifact: true,
    fileMode: SECRET_FILE_MODE,
  },
  gemini: {
    carrier: "gemini",
    mechanism:
      "ACP newSession per-server env fields (in-protocol); 0600 handoff artifact on disk",
    onDiskArtifact: true,
    fileMode: SECRET_FILE_MODE,
  },
  opencode: {
    carrier: "opencode",
    mechanism:
      "ACP newSession per-server env fields (in-protocol); 0600 handoff artifact on disk",
    onDiskArtifact: true,
    fileMode: SECRET_FILE_MODE,
  },
  claude: {
    carrier: "claude",
    mechanism: "env inlined into the --mcp-config JSON temp file (0600)",
    onDiskArtifact: true,
    fileMode: SECRET_FILE_MODE,
  },
};

/** Look up the native secret placement for a carrier. */
export function secretPlacement(carrier: McpCarrier): SecretPlacement {
  return SECRET_PLACEMENT[carrier];
}

/**
 * Collect every secret-bearing value (env values + http auth-header values)
 * from a canonical server set — the inputs the assertions guard against leaking.
 */
export function collectSecretValues(servers: CanonicalMcpServer[]): string[] {
  const values: string[] = [];
  for (const server of servers) {
    if (server.env) values.push(...Object.values(server.env));
    if (server.headers) values.push(...Object.values(server.headers));
  }
  return values.filter(value => value.length > 0);
}

/**
 * Assert no secret value appears anywhere in an argv array (R2 — argv leaks into
 * the process list). Throws on the first violation; a no-op when `secrets` is
 * empty. Emitters that build argv (never should carry secrets) and tests use it.
 */
export function assertNoSecretInArgv(
  argv: readonly string[],
  secrets: readonly string[]
): void {
  for (const secret of secrets) {
    if (!secret) continue;
    for (const arg of argv) {
      if (arg.includes(secret)) {
        throw new Error(
          "MCP secret-delivery violation: a secret value appears in argv " +
            "(secrets must ride the carrier's native env channel, never argv)"
        );
      }
    }
  }
}

/**
 * Assert a path is owner-only (mode 0600 / no group or other bits). Throws if
 * the file is group- or world-accessible (R2). Proves every on-disk carrier
 * holding env values is owner-only.
 */
export function assertOwnerOnly(path: string): void {
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `MCP secret-delivery violation: ${path} is mode 0${mode.toString(8)} — ` +
        "must be 0600 (owner-only); it holds env values"
    );
  }
}
