// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import type { ClaudeAccountInfo } from "@hapi/protocol/schemas";
import { computePlanLabel } from "@hapi/protocol/accounts";
import { logger } from "@/ui/logger";

/**
 * Structure of ~/.claude/.credentials.json
 */
interface ClaudeCredentialsFile {
  claudeAiOauth?: {
    subscriptionType?: string;
    rateLimitTier?: string;
    scopes?: string[];
  };
}

/**
 * Structure of ~/.claude.json (Claude Code config file)
 * Contains OAuth account info including email address
 */
interface ClaudeConfigFile {
  oauthAccount?: {
    accountUuid?: string;
    emailAddress?: string;
    displayName?: string;
    organizationName?: string;
  };
}

// `computePlanLabel` moved to `@hapi/protocol/accounts` (issue #1517) so the
// server can compute the same plan label during a mid-session account switch
// without importing from the cli package. Re-exported here so existing cli
// consumers (this file's internal use below + `accountTokenInjection.ts`) keep
// importing it from `@/utils/claudeCredentials` unchanged.
export { computePlanLabel };

/**
 * Reads email from ~/.claude.json config file
 * This file contains oauthAccount info populated by Claude Code during OAuth
 */
async function readEmailFromConfig(): Promise<string | undefined> {
  const configPath = join(os.homedir(), ".claude.json");

  try {
    const content = await readFile(configPath, "utf-8");
    const config: ClaudeConfigFile = JSON.parse(content);
    return config.oauthAccount?.emailAddress;
  } catch {
    // File doesn't exist or isn't readable - this is normal
    return undefined;
  }
}

/**
 * Read the host-default account's UUID from `~/.claude.json` `oauthAccount.accountUuid`
 * (issue #1520). This is the account whose OAuth refresh-token family is SHARED with
 * native Claude Code — Hapimatic must NOT rotate it (double-rotation produces the
 * `invalid_grant` lockout). The `TokenRefreshService` reads this on every refresh
 * decision (dynamic keying), so logging into a different host account automatically
 * re-targets which account Hapimatic defers.
 *
 * Identity ONLY — never reads or returns token values (the credential lives in
 * `~/.claude/.credentials.json`, which this function does not touch).
 *
 * @param configPath Override for `~/.claude.json` (test seam). Defaults to the real file.
 * @returns the host-default `accountUuid`, or `null` on any missing/corrupt/absent input.
 */
export async function readHostDefaultAccountUuid(
  configPath: string = join(os.homedir(), ".claude.json")
): Promise<string | null> {
  try {
    const content = await readFile(configPath, "utf-8");
    const config: ClaudeConfigFile = JSON.parse(content);
    return config.oauthAccount?.accountUuid ?? null;
  } catch {
    // Missing or unreadable ~/.claude.json — no host-default to key off. A missing
    // config also means native Claude Code has no active login, so the shared-family
    // contention this defends against is moot.
    return null;
  }
}

/**
 * Reads Claude account info from ~/.claude/.credentials.json and ~/.claude.json
 *
 * These files are created by Claude Code when the user authenticates.
 * - ~/.claude/.credentials.json: OAuth tokens, subscriptionType, rateLimitTier
 * - ~/.claude.json: User config including oauthAccount with email
 *
 * @returns ClaudeAccountInfo if credentials exist and are readable, undefined otherwise
 */
export async function readClaudeAccountInfo(): Promise<
  ClaudeAccountInfo | undefined
> {
  const credentialsPath = join(os.homedir(), ".claude", ".credentials.json");

  try {
    const content = await readFile(credentialsPath, "utf-8");
    const credentials: ClaudeCredentialsFile = JSON.parse(content);

    const oauth = credentials.claudeAiOauth;
    if (!oauth) {
      logger.debug("[CLAUDE_ACCOUNT] No claudeAiOauth in credentials file");
      return undefined;
    }

    // Also read email from config file (separate from credentials)
    const email = await readEmailFromConfig();

    const accountInfo: ClaudeAccountInfo = {
      subscriptionType: oauth.subscriptionType,
      rateLimitTier: oauth.rateLimitTier,
      planLabel: computePlanLabel(oauth.subscriptionType, oauth.rateLimitTier),
      email,
    };

    logger.debug(
      `[CLAUDE_ACCOUNT] Read account info: ${accountInfo.planLabel ?? "unknown"}, email: ${email ? "present" : "absent"}`
    );
    return accountInfo;
  } catch (error) {
    // File doesn't exist or isn't readable - this is normal for fresh installs
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      logger.debug("[CLAUDE_ACCOUNT] Credentials file not found");
    } else {
      logger.debug("[CLAUDE_ACCOUNT] Failed to read credentials:", error);
    }
    return undefined;
  }
}
