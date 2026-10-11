// SPDX-License-Identifier: MIT
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type McpConfigArg = {
  value: string;
  cleanup?: () => void;
};

export type McpConfigOptions = {
  useFile?: boolean;
  baseDir?: string;
};

export function resolveMcpConfigArg(
  mcpServers: Record<string, unknown>,
  options?: McpConfigOptions
): McpConfigArg {
  const configJson = JSON.stringify({ mcpServers });
  const useFile = options?.useFile ?? process.platform === "win32";
  if (!useFile) {
    return { value: configJson };
  }

  const dir = options?.baseDir ?? tmpdir();
  mkdirSync(dir, { recursive: true });

  const filePath = join(
    dir,
    `mcp-config-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );
  // #3125 R2: the JSON inlines per-server `env` values (secret-bearing), so the
  // temp file MUST be owner-only. Node's default mode would leave it 0644.
  writeFileSync(filePath, configJson, { encoding: "utf8", mode: 0o600 });

  return {
    value: filePath,
    cleanup: () => {
      try {
        unlinkSync(filePath);
      } catch {
        // Ignore cleanup errors; config file is optional and short-lived.
      }
    },
  };
}

export function appendMcpConfigArg(
  args: string[],
  mcpServers?: Record<string, unknown>,
  options?: McpConfigOptions
): (() => void) | null {
  if (!mcpServers || Object.keys(mcpServers).length === 0) {
    return null;
  }

  const { value, cleanup } = resolveMcpConfigArg(mcpServers, options);
  args.push("--mcp-config", value);
  return cleanup ?? null;
}
