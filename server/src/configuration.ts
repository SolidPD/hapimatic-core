// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Configuration for hapi-server (Direct Connect)
 *
 * Configuration is loaded with priority: environment variable > settings.json > default
 * When NON-CREDENTIAL values (webappPort, webappUrl, corsOrigins) are read from environment
 * variables and are not present in settings.json, they are automatically saved for future
 * use. Credentials (`telegramBotToken`, `googleHandoffSecret`) are EXEMPT and are never
 * written back — see `config/serverSettings.ts` and issue #2410.
 *
 * Optional environment variables:
 * - CLI_API_TOKEN: Shared secret for hapi CLI authentication (auto-generated if not set)
 * - TELEGRAM_BOT_TOKEN: Telegram Bot API token from @BotFather
 * - WEBAPP_PORT: Port for Mini App HTTP server (default: 3006)
 * - WEBAPP_URL: Public URL for Telegram Mini App
 * - CORS_ORIGINS: Comma-separated CORS origins
 * - VAPID_SUBJECT: Contact email or URL for Web Push (defaults to mailto:admin@hapi.run)
 * - HAPI_HOME: Data directory (default: ~/.hapi)
 * - DB_PATH: SQLite database path (default: {HAPI_HOME}/hapi.db)
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getOrCreateCliApiToken } from "./config/cliApiToken";
import { parseAllowlist, wildcardAllowlistWarning } from "./config/googleOAuth";
import { getSettingsFile } from "./config/settings";
import {
  loadServerSettings,
  type ServerSettings,
  type ServerSettingsResult,
} from "./config/serverSettings";
import * as extensionPrefsHelpers from "./config/extensionPrefs";

export type ConfigSource = "env" | "file" | "default";

export interface ConfigSources {
  telegramBotToken: ConfigSource;
  googleHandoffSecret: ConfigSource;
  webappPort: ConfigSource;
  webappUrl: ConfigSource;
  corsOrigins: ConfigSource;
  cliApiToken: "env" | "file" | "generated";
}

class Configuration {
  /** Telegram Bot API token */
  public readonly telegramBotToken: string | null;

  /** Telegram bot enabled status (token present) */
  public readonly telegramEnabled: boolean;

  /** Issue #1003: shared HS256 secret for verifying Google SSO handoff tokens */
  public readonly googleHandoffSecret: string | null;

  /** Issue #1003: Google OAuth handoff route enabled (secret present) */
  public readonly googleOAuthEnabled: boolean;

  /** Issue #1003: allowed emails for the Google SSO handoff (lowercased) */
  public readonly googleAllowlistEmails: string[];

  /** Issue #1003: allowed domains for the Google SSO handoff ("*" = any) */
  public readonly googleAllowlistDomains: string[];

  /**
   * Issue #2276: this instance's own identity (its subdomain) used as the expected
   * `aud` (audience) when verifying a Google SSO handoff token. Sourced env-only from
   * trusted config (`HAPI_GOOGLE_HANDOFF_AUD`) — NEVER from the request `Host` header,
   * which an attacker replaying a token against this instance controls (R3). `null` when
   * unset; the `/api/auth/google/handoff` exchange fails closed (503) rather than skip
   * the check, so an unprovisioned instance is loud, not silently replayable.
   */
  public readonly handoffAudience: string | null;

  /** CLI auth token (shared secret) */
  public cliApiToken: string;

  /** Source of CLI API token */
  public cliApiTokenSource: "env" | "file" | "generated" | "";

  /** Whether CLI API token was newly generated (for first-run display) */
  public cliApiTokenIsNew: boolean;

  /** Path to settings.json file */
  public readonly settingsFile: string;

  /** Data directory for credentials and state */
  public readonly dataDir: string;

  /** SQLite DB path */
  public readonly dbPath: string;

  /** Port for the Mini App HTTP server */
  public readonly webappPort: number;

  /** Public HTTPS URL for the Telegram Mini App (used in WebApp buttons) */
  public readonly miniAppUrl: string;

  /** Allowed CORS origins for Mini App + Socket.IO (comma-separated env override) */
  public readonly corsOrigins: string[];

  /** Sources of each configuration value */
  public readonly sources: ConfigSources;

  /**
   * Extension preferences helpers (Sub-Issue E of Epic #1264). A namespace
   * re-export of the pure functions in `config/extensionPrefs.ts`; the caller
   * passes `store.extensionPrefs` at call time, so Configuration does NOT hold a
   * Store reference (Configuration is created BEFORE Store at startup — a stored
   * reference would invert the load order). Static field initializer, not
   * constructor-assigned.
   */
  public readonly extensionPrefs: typeof extensionPrefsHelpers =
    extensionPrefsHelpers;

  /** Private constructor - use createConfiguration() instead */
  private constructor(
    dataDir: string,
    dbPath: string,
    serverSettings: ServerSettings,
    sources: ServerSettingsResult["sources"]
  ) {
    this.dataDir = dataDir;
    this.dbPath = dbPath;
    this.settingsFile = getSettingsFile(dataDir);

    // Apply server settings
    this.telegramBotToken = serverSettings.telegramBotToken;
    this.telegramEnabled = Boolean(this.telegramBotToken);

    // Issue #1003: Google SSO handoff secret + allowlist (env-only allowlist,
    // read directly here since it is not persisted to settings.json).
    this.googleHandoffSecret = serverSettings.googleHandoffSecret;
    this.googleOAuthEnabled = Boolean(this.googleHandoffSecret);
    const googleAllowlist = parseAllowlist({
      emails: process.env.HAPI_GOOGLE_ALLOWLIST_EMAILS,
      domains: process.env.HAPI_GOOGLE_ALLOWLIST_DOMAINS,
    });
    this.googleAllowlistEmails = googleAllowlist.emails;
    this.googleAllowlistDomains = googleAllowlist.domains;
    // #2280 R2: warn (not refuse — ruling D3-A) when a `*` any-domain allowlist is
    // set on a gateway-managed deployment (handoff secret present). Self-hosted
    // deployments without a handoff secret keep `*` unchanged (R3). The gateway
    // itself refuses `*` unconditionally (gateway/src/config.ts).
    const googleWildcardWarning = wildcardAllowlistWarning(
      googleAllowlist.domains,
      Boolean(this.googleHandoffSecret)
    );
    if (googleWildcardWarning) {
      console.warn(googleWildcardWarning);
    }

    // Issue #2276: this instance's expected handoff-token `aud`. Env-only and trusted
    // (modeled on the allowlist read above, NOT the credential loader — the audience is
    // an identity, not a secret, so it must not enter the #2410 never-persist path).
    // Empty/whitespace normalizes to null so the exchange endpoint fails closed.
    this.handoffAudience = process.env.HAPI_GOOGLE_HANDOFF_AUD?.trim() || null;

    this.webappPort = serverSettings.webappPort;
    this.miniAppUrl = serverSettings.webappUrl;
    this.corsOrigins = serverSettings.corsOrigins;

    // CLI API token - will be set by _setCliApiToken() before create() returns
    this.cliApiToken = "";
    this.cliApiTokenSource = "";
    this.cliApiTokenIsNew = false;

    // Store sources for logging (cliApiToken will be set by _setCliApiToken)
    this.sources = {
      ...sources,
    } as ConfigSources;

    // Ensure data directory exists
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }
  }

  /** Create configuration asynchronously */
  static async create(): Promise<Configuration> {
    // 1. Determine data directory (env only - not persisted)
    const dataDir = process.env.HAPI_HOME
      ? process.env.HAPI_HOME.replace(/^~/, homedir())
      : join(homedir(), ".hapi");

    // Ensure data directory exists before loading settings
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    // 2. Determine DB path (env only - not persisted)
    const dbPath = process.env.DB_PATH
      ? process.env.DB_PATH.replace(/^~/, homedir())
      : join(dataDir, "hapi.db");

    // 3. Load server settings (with persistence)
    const settingsResult = await loadServerSettings(dataDir);

    if (settingsResult.savedToFile) {
      console.log(
        `[Server] Configuration saved to ${getSettingsFile(dataDir)}`
      );
    }

    // 4. Create configuration instance
    const config = new Configuration(
      dataDir,
      dbPath,
      settingsResult.settings,
      settingsResult.sources
    );

    // 5. Load CLI API token
    const tokenResult = await getOrCreateCliApiToken(dataDir);
    config._setCliApiToken(
      tokenResult.token,
      tokenResult.source,
      tokenResult.isNew
    );

    return config;
  }

  /** Set CLI API token (called during async initialization) */
  _setCliApiToken(
    token: string,
    source: "env" | "file" | "generated",
    isNew: boolean
  ): void {
    this.cliApiToken = token;
    this.cliApiTokenSource = source;
    this.cliApiTokenIsNew = isNew;
    (this.sources as { cliApiToken: string }).cliApiToken = source;
  }
}

// Singleton instance (set by createConfiguration)
let _configuration: Configuration | null = null;

/**
 * Create and initialize configuration asynchronously.
 * Must be called once at startup before getConfiguration() can be used.
 */
export async function createConfiguration(): Promise<Configuration> {
  if (_configuration) {
    return _configuration;
  }
  _configuration = await Configuration.create();
  return _configuration;
}

/**
 * Get the initialized configuration.
 * Throws if createConfiguration() has not been called yet.
 */
export function getConfiguration(): Configuration {
  if (!_configuration) {
    throw new Error(
      "Configuration not initialized. Call createConfiguration() first."
    );
  }
  return _configuration;
}

// For compatibility - throws on access if not configured
export const configuration = new Proxy({} as Configuration, {
  get(_, prop) {
    return getConfiguration()[prop as keyof Configuration];
  },
});
