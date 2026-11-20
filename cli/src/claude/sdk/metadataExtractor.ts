// SPDX-License-Identifier: MIT AND AGPL-3.0-only
/**
 * SDK Metadata Extractor
 * Captures available tools and slash commands from Claude SDK initialization
 */

import { query } from "./query";
import type { SDKSystemMessage } from "./types";
import { logger } from "@/ui/logger";
import {
  accountConfigDirFor,
  hasIsolatedConfigDir,
  readIsolatedCredentials,
} from "@/accounts/accountConfigDir";
import { sharesHostChain } from "@/accounts/hostChainQuarantine";

export interface SDKMetadata {
  tools?: string[];
  slashCommands?: string[];
}

export interface SDKMetadataProbeOptions {
  /** Issue #6171: inline `--settings` JSON carrying only the session's MCP keys,
   *  so a server the session denies does not start in the probe either. */
  settings?: string;
  /** Issue #6800: the session's bound account (`HAPI_ACCOUNT_UUID`), whose own
   *  folder the probe runs in. Absent → the probe does not run. */
  accountUuid?: string;
  /** Test seams; production uses the real readers and `query`. */
  deps?: ProbeConfigDirDeps & { query?: typeof query };
}

export interface ProbeConfigDirDeps {
  hasFolder?: (uuid: string) => Promise<boolean>;
  /** The folder login's refresh token and access-token expiry (epoch ms). */
  folderLogin?: (
    uuid: string
  ) => Promise<{ refreshToken: string; expiresAt: number } | null>;
  sharesHostChain?: (token: string) => Promise<boolean>;
  now?: () => number;
}

/**
 * Issue #6800 (round 2, R2-2): the probe does not run when the folder's access
 * token has less than this left. The probe is killed at `system/init`; a
 * `claude` renewing an expired token at that moment could spend the refresh
 * token without saving the new pair. The session's own `claude` renews it.
 */
export const PROBE_MIN_ACCESS_TOKEN_LIFETIME_MS = 10 * 60_000;

/**
 * Issue #6800 (R5, ruling P1): the folder the probe's `claude` runs in, or null
 * when it must not run. It runs only in the session's own account folder, and
 * only when the session is bound, the folder holds a login, that login is not
 * the `~/.claude` chain (invariant I1), and its access token has at least
 * {@link PROBE_MIN_ACCESS_TOKEN_LIFETIME_MS} left (round 2, R2-2), so the kill
 * at `system/init` can never land during a renewal. It then reads exactly the
 * config the session runs with (its user-scope links and its own `.claude.json`
 * MCP servers), so the tool and slash-command list is the session's own. With
 * no such folder (an unbound session, a folder not seeded yet, a shared chain,
 * a token due for renewal) the probe does not run, because without a
 * CLAUDE_CONFIG_DIR Claude Code falls back to `~/.claude`. Never throws.
 */
export async function resolveProbeConfigDir(
  accountUuid: string | undefined,
  deps: ProbeConfigDirDeps = {}
): Promise<string | null> {
  if (!accountUuid) return null;
  const hasFolder = deps.hasFolder ?? hasIsolatedConfigDir;
  const folderLogin =
    deps.folderLogin ??
    (async (uuid: string) => {
      const oauth = await readIsolatedCredentials(uuid);
      return oauth
        ? { refreshToken: oauth.refreshToken, expiresAt: oauth.expiresAt }
        : null;
    });
  const shares = deps.sharesHostChain ?? (t => sharesHostChain(t));
  const now = deps.now ?? Date.now;
  try {
    if (!(await hasFolder(accountUuid))) return null;
    const login = await folderLogin(accountUuid);
    if (!login?.refreshToken || (await shares(login.refreshToken))) {
      return null;
    }
    if (
      !Number.isFinite(login.expiresAt) ||
      login.expiresAt - now() < PROBE_MIN_ACCESS_TOKEN_LIFETIME_MS
    ) {
      logger.debug(
        "[metadataExtractor] the folder's access token is expired or due for renewal; the probe does not run (#6800 R2-2)"
      );
      return null;
    }
    return accountConfigDirFor(accountUuid);
  } catch (error) {
    logger.debug("[metadataExtractor] account folder check failed:", error);
    return null;
  }
}

/**
 * Extract SDK metadata by running a minimal query and capturing the init message
 * @returns SDK metadata containing tools and slash commands
 */
export async function extractSDKMetadata(
  probe: SDKMetadataProbeOptions = {}
): Promise<SDKMetadata> {
  const abortController = new AbortController();
  const runQuery = probe.deps?.query ?? query;
  const configDir = await resolveProbeConfigDir(probe.accountUuid, probe.deps);
  if (!configDir) {
    logger.debug(
      "[metadataExtractor] no account folder for this session; the metadata probe does not run (#6800)"
    );
    return {};
  }

  try {
    logger.debug(
      "[metadataExtractor] Starting SDK metadata extraction in the session's account folder"
    );

    // Run SDK with minimal tools allowed. `query()` strips every ambient binding
    // var (#3731), and the explicit set below is CLAUDE_CONFIG_DIR alone, never a
    // token: Claude Code emits `system/init` (tools + slash commands) before any
    // auth check, and we abort at init. Without a CLAUDE_CONFIG_DIR the child fell
    // back to ~/.claude and ~/.claude.json (#6800 R5, ruling P1).
    const sdkQuery = runQuery({
      prompt: "hello",
      options: {
        allowedTools: ["Bash(echo)"],
        maxTurns: 1,
        abort: abortController.signal,
        bindingEnvVars: { CLAUDE_CONFIG_DIR: configDir },
        // Claude Code reads `--settings` as a file path or a JSON string.
        ...(probe.settings ? { settingsPath: probe.settings } : {}),
      },
    });

    // Wait for the first system message which contains tools and slash commands
    for await (const message of sdkQuery) {
      if (message.type === "system" && message.subtype === "init") {
        const systemMessage = message as SDKSystemMessage;

        const metadata: SDKMetadata = {
          tools: systemMessage.tools,
          slashCommands: systemMessage.slash_commands,
        };

        logger.debug("[metadataExtractor] Captured SDK metadata:", metadata);

        // Abort the query since we got what we need
        abortController.abort();

        return metadata;
      }
    }

    logger.debug("[metadataExtractor] No init message received from SDK");
    return {};
  } catch (error) {
    // Check if it's an abort error (expected)
    if (error instanceof Error && error.name === "AbortError") {
      logger.debug(
        "[metadataExtractor] SDK query aborted after capturing metadata"
      );
      return {};
    }
    logger.debug("[metadataExtractor] Error extracting SDK metadata:", error);
    return {};
  }
}

/**
 * Extract SDK metadata asynchronously without blocking
 * Fires the extraction and updates metadata when complete
 */
export function extractSDKMetadataAsync(
  onComplete: (metadata: SDKMetadata) => void,
  probe: SDKMetadataProbeOptions = {}
): void {
  extractSDKMetadata(probe)
    .then(metadata => {
      if (metadata.tools || metadata.slashCommands) {
        onComplete(metadata);
      }
    })
    .catch(error => {
      logger.debug("[metadataExtractor] Async extraction failed:", error);
    });
}
