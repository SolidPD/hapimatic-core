// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Server Settings Management
 *
 * Handles loading and persistence of server configuration.
 * Priority: environment variable > settings.json > default value
 *
 * When a NON-CREDENTIAL value (webappPort, webappUrl, corsOrigins) is loaded from an
 * environment variable and is not present in settings.json, it is saved to settings.json
 * for future use.
 *
 * CREDENTIALS ARE EXEMPT (issue #2410). `telegramBotToken` and `googleHandoffSecret` are
 * resolved from env but are NEVER written back, so a secret supplied via the environment
 * does not come to rest in settings.json — a file that is 0600 but is backed up, rsynced,
 * and carried inside the `hapimatic-private` backup set. The file remains a READ fallback
 * for instances configured before this policy.
 */

import { getSettingsFile, readSettings, writeSettings } from "./settings";
import type { FeedbackSenderConfig } from "../feedback/feedbackSender";

export interface ServerSettings {
  telegramBotToken: string | null;
  /** Issue #1003: shared HS256 secret the Google SSO gateway signs handoff
   *  tokens with and this instance verifies. null → Google OAuth route is
   *  disabled (returns 503). Priority: env HAPI_GOOGLE_HANDOFF_SECRET > file. */
  googleHandoffSecret: string | null;
  webappPort: number;
  webappUrl: string;
  corsOrigins: string[];
}

export interface ServerSettingsResult {
  settings: ServerSettings;
  sources: {
    telegramBotToken: "env" | "file" | "default";
    googleHandoffSecret: "env" | "file" | "default";
    webappPort: "env" | "file" | "default";
    webappUrl: "env" | "file" | "default";
    corsOrigins: "env" | "file" | "default";
  };
  savedToFile: boolean;
}

/**
 * Parse and normalize CORS origins
 */
function parseCorsOrigins(str: string): string[] {
  const entries = str
    .split(",")
    .map(origin => origin.trim())
    .filter(Boolean);

  if (entries.includes("*")) {
    return ["*"];
  }

  const normalized: string[] = [];
  for (const entry of entries) {
    try {
      normalized.push(new URL(entry).origin);
    } catch {
      // Keep raw value if it's already an origin-like string
      normalized.push(entry);
    }
  }
  return normalized;
}

/**
 * Derive CORS origins from webapp URL
 */
function deriveCorsOrigins(webappUrl: string): string[] {
  try {
    return [new URL(webappUrl).origin];
  } catch {
    return [];
  }
}

/**
 * Load server settings with priority: env > file > default
 * Saves new env values to file when not already present
 */
export async function loadServerSettings(
  dataDir: string
): Promise<ServerSettingsResult> {
  const settingsFile = getSettingsFile(dataDir);
  const settings = await readSettings(settingsFile);

  // If settings file exists but couldn't be parsed, fail fast
  if (settings === null) {
    throw new Error(
      `Cannot read ${settingsFile}. Please fix or remove the file and restart.`
    );
  }

  let needsSave = false;
  const sources: ServerSettingsResult["sources"] = {
    telegramBotToken: "default",
    googleHandoffSecret: "default",
    webappPort: "default",
    webappUrl: "default",
    corsOrigins: "default",
  };

  // telegramBotToken: env > file > null
  let telegramBotToken: string | null = null;
  if (process.env.TELEGRAM_BOT_TOKEN) {
    telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
    sources.telegramBotToken = "env";
    // #2410: credentials are NEVER written back to settings.json — same policy as
    // googleHandoffSecret below. A bot token supplied via env stays in env, so it cannot
    // linger at rest in a backed-up file after the env source is rotated. The `else if`
    // below is retained as a READ fallback for instances configured before this policy.
  } else if (settings.telegramBotToken !== undefined) {
    telegramBotToken = settings.telegramBotToken;
    sources.telegramBotToken = "file";
  }

  // googleHandoffSecret: env > file > null (issue #1003)
  let googleHandoffSecret: string | null = null;
  if (process.env.HAPI_GOOGLE_HANDOFF_SECRET) {
    googleHandoffSecret = process.env.HAPI_GOOGLE_HANDOFF_SECRET;
    sources.googleHandoffSecret = "env";
    // 🔴 #2410 / #2316 R10: credentials are NEVER written back to settings.json. The
    // handoff signing secret must exist ONLY in the 20-handoff.conf systemd drop-in, so
    // that rotating the drop-in fully rotates the secret and no copy lingers at rest.
    // Before this, provision.sh's R10 scrub was GUARANTEED to be undone by the #2381
    // post-scrub restart: the scrub made this key `undefined`, and the very next boot
    // re-persisted the env value (measured 2026-07-27 on two fleet VMs — settings.json mtime
    // ~2s AFTER the unit start). The invariant now holds by construction, not by ordering.
    // The `else if` below is retained as a READ fallback for pre-#2410 instances; removing
    // it would flip them to googleHandoffSecret=null -> ssoEnabled:false -> handoff 503.
  } else if (settings.googleHandoffSecret !== undefined) {
    googleHandoffSecret = settings.googleHandoffSecret;
    sources.googleHandoffSecret = "file";
  }

  // webappPort: env > file > 3006
  let webappPort = 3006;
  if (process.env.WEBAPP_PORT) {
    const parsed = parseInt(process.env.WEBAPP_PORT, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error("WEBAPP_PORT must be a valid port number");
    }
    webappPort = parsed;
    sources.webappPort = "env";
    if (settings.webappPort === undefined) {
      settings.webappPort = webappPort;
      needsSave = true;
    }
  } else if (settings.webappPort !== undefined) {
    webappPort = settings.webappPort;
    sources.webappPort = "file";
  }

  // webappUrl: env > file > http://localhost:{port}
  let webappUrl = `http://localhost:${webappPort}`;
  if (process.env.WEBAPP_URL) {
    webappUrl = process.env.WEBAPP_URL;
    sources.webappUrl = "env";
    if (settings.webappUrl === undefined) {
      settings.webappUrl = webappUrl;
      needsSave = true;
    }
  } else if (settings.webappUrl !== undefined) {
    webappUrl = settings.webappUrl;
    sources.webappUrl = "file";
  }

  // corsOrigins: env > file > derived from webappUrl
  let corsOrigins: string[];
  if (process.env.CORS_ORIGINS) {
    corsOrigins = parseCorsOrigins(process.env.CORS_ORIGINS);
    sources.corsOrigins = "env";
    if (settings.corsOrigins === undefined) {
      settings.corsOrigins = corsOrigins;
      needsSave = true;
    }
  } else if (settings.corsOrigins !== undefined) {
    corsOrigins = settings.corsOrigins;
    sources.corsOrigins = "file";
  } else {
    corsOrigins = deriveCorsOrigins(webappUrl);
  }

  // Save settings if any new values were added
  if (needsSave) {
    await writeSettings(settingsFile, settings);
  }

  return {
    settings: {
      telegramBotToken,
      googleHandoffSecret,
      webappPort,
      webappUrl,
      corsOrigins,
    },
    sources,
    savedToFile: needsSave,
  };
}

/**
 * Resolve the feedback email transport config (issue #2664, epic #2663) from
 * the process environment, following the env-first pattern of telegramBotToken
 * above. Credentials live ONLY in env (never written to settings.json — same
 * policy as #2410). When AgentMail is unconfigured, transport is "off": the
 * route still persists the row and returns success (R10). Sub-Issue D (#2667)
 * adds a "relay" branch here — no fork.
 */
export function resolveFeedbackSenderConfig(): FeedbackSenderConfig {
  const apiKey = process.env.AGENTMAIL_API_KEY || undefined;
  const inboxId = process.env.AGENTMAIL_INBOX_ID || undefined;
  const relayUrl = process.env.FEEDBACK_RELAY_URL || undefined;
  const relayToken = process.env.FEEDBACK_RELAY_TOKEN || undefined;
  const destination = process.env.FEEDBACK_DEST_EMAIL || "";

  // Sub-Issue D (#2667): the transport is a pure config choice — no code fork
  // (R3), and RP1 keeps sending direct-to-AgentMail (R5). Precedence: an explicit
  // FEEDBACK_TRANSPORT wins; otherwise infer from which credential set is present.
  // Relay is inferred FIRST so a customer VM holding only a relay URL+token can
  // NEVER fall through to a direct AgentMail send — the raw shared key must never
  // leave the relay (R4). RP1 (no relay config) keeps resolving to "agentmail"
  // exactly as in #2664. `relayToken` is a credential: like `apiKey` it lives ONLY
  // in env and is never written to settings.json (#2410 no-write-back).
  const explicit = process.env.FEEDBACK_TRANSPORT;
  let transport: FeedbackSenderConfig["transport"];
  if (explicit === "relay" || explicit === "agentmail" || explicit === "off") {
    transport = explicit;
  } else if (relayUrl && relayToken) {
    transport = "relay";
  } else if (apiKey && inboxId) {
    transport = "agentmail";
  } else {
    transport = "off";
  }

  // #4638 (ER 4371-5): core ships no built-in recipient. Direct AgentMail with
  // no FEEDBACK_DEST_EMAIL has nowhere to send, so report "off" (truthful for
  // every caller) and warn once at startup. Relay is untouched: the gateway
  // pins its own recipient.
  if (transport === "agentmail" && !destination) {
    console.warn(
      "[feedback] AgentMail is configured but FEEDBACK_DEST_EMAIL is not set; feedback email is off"
    );
    transport = "off";
  }

  return {
    transport,
    endpoint: process.env.AGENTMAIL_ENDPOINT || "https://api.agentmail.to",
    apiKey,
    inboxId,
    destination,
    relayUrl,
    relayToken,
  };
}
