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

import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { FEEDBACK_SINK_ORIGIN_ID_RE } from "@hapi/protocol/feedbackSink";
import { getSettingsFile, readSettings, writeSettings } from "./settings";
import type { FeedbackSenderConfig } from "../feedback/feedbackSender";
import type {
  FeedbackSinkConfig,
  FeedbackSinkOrigin,
} from "../feedback/sinkForward";
import { isEnvFlagTruthy } from "../provisioner/capability";
import { VERSION } from "../version.generated";

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

/** The operator-instance capability env flag (issue #2910, epic #2909 Sub A). */
export const OPERATOR_INSTANCE_ENV = "HAPI_OPERATOR_INSTANCE";

/**
 * Resolve the operator-instance capability (issue #2910, epic #2909 Sub A):
 * whether this instance shows the feedback READ surface (`GET /api/feedback`,
 * `GET /api/feedback/preflight`, the settings Feedback row and page). Default
 * OFF — fail-closed — and env-only, parsed with the house `isEnvFlagTruthy`
 * idiom (`1` / `true` / `yes`, case-insensitive, untrimmed), the same parse as
 * the sibling operator flag `HAPI_VM_ADMIN`. Customer-VM provisioning never
 * sets it, so a customer instance is closed by construction.
 *
 * `provisioner.enabled` is deliberately NOT reused: it is true only where the
 * operator's provisioning infra env exists (RP1), but the universal inbox must
 * be readable from any operator device (RP1, RP2, SL7, operator cloud VMs).
 *
 * Trust model: this is a VISIBILITY gate (non-advertisement, and the
 * precondition for #2912's inbox proxy routes), not an authorization boundary —
 * an instance owner controls the unit environment and can read the instance's
 * SQLite directly. The central inbox's real boundary is #2912's gateway
 * operator credential, which is never provisioned to customer VMs.
 */
export function resolveOperatorInstanceEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return isEnvFlagTruthy(env[OPERATOR_INSTANCE_ENV]);
}

/** Hosts a plain-`http://` gateway URL may name (#5858 D10): loopback only. */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "localhost",
  "[::1]",
]);

/**
 * Check `FEEDBACK_INBOX_URL` (already trimmed) and return the gateway origin with
 * trailing slashes dropped, or why it is refused. The one URL rule the sink
 * (#2911) and the inbox (#2912) share:
 *  - https, or plain http to a loopback host only (#5858 D10): both bearers
 *    travel to this URL, so neither may cross the network unencrypted;
 *  - the ORIGIN only — no path, query, fragment or credentials (#5858 PM
 *    ruling): the routes append `/api/...`, so `https://host/api` would call
 *    `/api/api/...` and get 404s.
 * The reason never quotes the value.
 */
function parseFeedbackGatewayUrl(
  raw: string
): { baseUrl: string } | { invalid: string } {
  let baseUrl = raw;
  while (baseUrl.endsWith("/")) baseUrl = baseUrl.slice(0, -1);
  if (!/^https?:\/\/[^/]/i.test(baseUrl) || !URL.canParse(baseUrl)) {
    return { invalid: "is not an http(s) URL" };
  }
  const url = new URL(baseUrl);
  if (
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    baseUrl.includes("?") ||
    baseUrl.includes("#") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return {
      invalid:
        "is not a bare gateway origin (it carries a path, query or credentials; set it to e.g. https://hapimatic.com)",
    };
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTNAMES.has(url.hostname)) {
    return {
      invalid:
        "uses plain http to a non-loopback host (use https, or http only to 127.0.0.1, localhost or [::1])",
    };
  }
  return { baseUrl };
}

/**
 * The operator node's SINK credential: `FEEDBACK_INBOX_URL` (the gateway origin,
 * see {@link parseFeedbackGatewayUrl}) + `FEEDBACK_INBOX_TOKEN` (the shared sink
 * bearer, ruling D12). Null when both are unset; `{ missing }` naming the unset
 * one when only one is set (issue #5798), so a typo in one env line is logged
 * instead of read as "not an operator node"; `{ invalid }` when the URL is
 * refused. A blank value counts as unset. The inbox does NOT use this pair
 * (#5858 R1): it needs `FEEDBACK_INBOX_NODE_TOKEN`, so a node that only forwards
 * feedback cannot read it.
 */
function readOperatorInboxEnv(
  env: Record<string, string | undefined>
):
  | { baseUrl: string; token: string }
  | { missing: "FEEDBACK_INBOX_URL" | "FEEDBACK_INBOX_TOKEN" }
  | { invalid: string }
  | null {
  const inboxUrl = env.FEEDBACK_INBOX_URL?.trim();
  const token = env.FEEDBACK_INBOX_TOKEN?.trim();
  if (!inboxUrl && !token) return null;
  if (!inboxUrl) return { missing: "FEEDBACK_INBOX_URL" };
  if (!token) return { missing: "FEEDBACK_INBOX_TOKEN" };
  const url = parseFeedbackGatewayUrl(inboxUrl);
  if ("invalid" in url) return url;
  return { baseUrl: url.baseUrl, token };
}

/** The half-set log text: names the unset variable and the set one, never a value. */
function halfSetInboxMessage(
  missing: "FEEDBACK_INBOX_URL" | "FEEDBACK_INBOX_TOKEN"
): string {
  const set =
    missing === "FEEDBACK_INBOX_URL"
      ? "FEEDBACK_INBOX_TOKEN"
      : "FEEDBACK_INBOX_URL";
  return `${missing} is not set but ${set} is — set both or neither`;
}

/** Where an operator instance reads the central inbox (issue #2912, epic #2909 Sub C). */
export interface FeedbackInboxConfig {
  /** The gateway origin, e.g. `https://hapimatic.com`. */
  baseUrl: string;
  /**
   * This node's OWN inbox token (`FEEDBACK_INBOX_NODE_TOKEN`: the `<token>` half
   * of its `<nodeId>:<token>` entry in the gateway's `GATEWAY_FEEDBACK_INBOX_TOKENS`,
   * #5858 R1) — never the sink bearer.
   * Env-only; never written to settings.json.
   */
  token: string;
}

/**
 * The operator node's credential for the gateway's central feedback inbox
 * (issue #2912): `FEEDBACK_INBOX_URL` + this node's own inbox token
 * `FEEDBACK_INBOX_NODE_TOKEN` (#5858 R1). The sink bearer `FEEDBACK_INBOX_TOKEN`
 * plays no part, so a node configured only to forward cannot read the inbox.
 * Null when unset, half-set, malformed, or when the node token equals the sink
 * token (the split would be void) — each but "unset" with one log line naming the
 * variable, never a value. Null keeps every inbox proxy route closed (404) even
 * where `HAPI_OPERATOR_INSTANCE` is set: the flag is a visibility gate, the
 * gateway's per-node token is the authorization boundary.
 */
export function resolveFeedbackInboxConfig(
  env: Record<string, string | undefined> = process.env
): FeedbackInboxConfig | null {
  const inboxUrl = env.FEEDBACK_INBOX_URL?.trim();
  const nodeToken = env.FEEDBACK_INBOX_NODE_TOKEN?.trim();
  if (!nodeToken) {
    // A URL alone is a forward-only node (the sink pair); say once why the inbox is closed.
    if (inboxUrl) {
      console.error(
        "[feedback-inbox] FEEDBACK_INBOX_NODE_TOKEN is not set — the inbox stays closed (FEEDBACK_INBOX_TOKEN only forwards feedback; it cannot read the inbox)"
      );
    }
    return null;
  }
  if (!inboxUrl) {
    console.error(
      "[feedback-inbox] FEEDBACK_INBOX_URL is not set but FEEDBACK_INBOX_NODE_TOKEN is — set both or neither; the inbox stays closed"
    );
    return null;
  }
  const url = parseFeedbackGatewayUrl(inboxUrl);
  if ("invalid" in url) {
    console.error(
      `[feedback-inbox] FEEDBACK_INBOX_URL ${url.invalid} — the inbox stays closed`
    );
    return null;
  }
  if (nodeToken === env.FEEDBACK_INBOX_TOKEN?.trim()) {
    console.error(
      "[feedback-inbox] FEEDBACK_INBOX_NODE_TOKEN equals FEEDBACK_INBOX_TOKEN — the inbox needs this node's own inbox token (the token half of its GATEWAY_FEEDBACK_INBOX_TOKENS entry, without the node id), not the sink token; the inbox stays closed"
    );
    return null;
  }
  return { baseUrl: url.baseUrl, token: nodeToken };
}

/** The repo Convert-to-issue files into when `FEEDBACK_ISSUE_REPO` is unset. */
export const DEFAULT_FEEDBACK_ISSUE_REPO = "MattStarfield/hapimatic-private";

/**
 * The repo the inbox's Convert-to-issue files into (`FEEDBACK_ISSUE_REPO`,
 * `owner/repo`), chosen by the server and never by the client. Unset ⇒ the
 * default; set but malformed ⇒ null, and Convert refuses rather than filing
 * into a repo nobody named.
 */
export function resolveFeedbackIssueRepo(
  env: Record<string, string | undefined> = process.env
): string | null {
  const raw = env.FEEDBACK_ISSUE_REPO?.trim();
  if (!raw) return DEFAULT_FEEDBACK_ISSUE_REPO;
  if (!/^[\w.-]+\/[\w.-]+$/.test(raw)) {
    console.error(
      "[feedback-inbox] FEEDBACK_ISSUE_REPO is not owner/repo — Convert to issue is off"
    );
    return null;
  }
  return raw;
}

const RELAY_URL_SUFFIX = "/feedback-relay";
const SINK_URL_SUFFIX = "/feedback-sink";

/**
 * Where this instance forwards its feedback rows: the gateway's central sink
 * (issue #2911, epic #2909 Sub B). A DEDICATED seam — never fields of
 * {@link FeedbackSenderConfig}, the email transport (the #2667 rule) — and
 * env-only: the credential is never written to settings.json (#2410).
 *
 *  - Operator node: `FEEDBACK_INBOX_URL` (the gateway origin) +
 *    `FEEDBACK_INBOX_TOKEN` (the shared sink bearer, ruling D12; it does not
 *    open the inbox, #5858). The node
 *    names itself with its federation node id (else the hostname). Wins when
 *    both branches are configured, so an operator cloud VM forwards as operator.
 *    Only one of the two set is logged and is null (#5798): the node never
 *    falls back to forwarding as a customer.
 *  - Customer VM: `FEEDBACK_RELAY_URL` ending in `/feedback-relay` +
 *    `FEEDBACK_RELAY_TOKEN`; the sink is the sibling `/feedback-sink` route and
 *    the gateway derives the origin from the token. With the token set, a
 *    missing URL or any other URL shape is logged and null (#6072): a token is
 *    never sent to a guessed origin. A URL with no token is silent, because the
 *    GitHub broker reads the same URL on a broker-only VM.
 *
 * Null means no forwarding. Rows stay pending, so a later fix forwards them.
 * Independent of `HAPI_OPERATOR_INSTANCE`, which only gates the read routes.
 */
export function resolveFeedbackSinkConfig(
  origin: FeedbackSinkOrigin = {},
  env: Record<string, string | undefined> = process.env
): FeedbackSinkConfig | null {
  const inbox = readOperatorInboxEnv(env);
  if (inbox !== null && "invalid" in inbox) {
    console.error(
      `[feedback-sink] FEEDBACK_INBOX_URL ${inbox.invalid} — feedback is not forwarded`
    );
    return null;
  }
  if (inbox !== null && "missing" in inbox) {
    // Issue #5798: a half-set operator pair is an operator node with a typo,
    // never a customer node — so no fall-through to the relay arm below.
    console.error(
      `[feedback-sink] ${halfSetInboxMessage(inbox.missing)}; feedback is not forwarded`
    );
    return null;
  }
  if (inbox !== null) {
    const base = inbox.baseUrl;
    const inboxToken = inbox.token;
    const originInstanceId = origin.nodeId ?? hostname();
    if (
      originInstanceId.length > 64 ||
      !FEEDBACK_SINK_ORIGIN_ID_RE.test(originInstanceId)
    ) {
      console.error(
        "[feedback-sink] this node's id is not a valid sink origin (letters, digits, '.', '_', '-'; up to 64) — feedback is not forwarded"
      );
      return null;
    }
    return {
      url: `${base}/api${SINK_URL_SUFFIX}`,
      token: inboxToken,
      originKind: "operator",
      originInstanceId,
      originLabel: (origin.nodeLabel?.trim() || originInstanceId).slice(0, 64),
      appVersion: VERSION,
    };
  }
  const relayUrl = env.FEEDBACK_RELAY_URL?.trim();
  const relayToken = env.FEEDBACK_RELAY_TOKEN?.trim();
  // Issue #6072: only a set token makes this a relay pair. A URL alone is a
  // valid broker-only VM (the GitHub broker reads it too), so it stays silent.
  if (!relayToken) return null;
  if (!relayUrl) {
    console.error(
      "[feedback-sink] FEEDBACK_RELAY_URL is not set but FEEDBACK_RELAY_TOKEN is — feedback is not forwarded"
    );
    return null;
  }
  if (!relayUrl.endsWith(RELAY_URL_SUFFIX)) {
    console.error(
      `[feedback-sink] FEEDBACK_RELAY_URL does not end in ${RELAY_URL_SUFFIX} (no trailing slash) — feedback is not forwarded`
    );
    return null;
  }
  return {
    url: relayUrl.slice(0, -RELAY_URL_SUFFIX.length) + SINK_URL_SUFFIX,
    token: relayToken,
    originKind: "customer",
    originInstanceId: null,
    originLabel: null,
    appVersion: VERSION,
  };
}

/**
 * The hosted tier's human-support reply-times text (issue #4371 R6; #4350
 * ruling D-4350-5, contract K15). Byte-equal with #4351 Task 1. The Core
 * (self-hosted) default is empty.
 */
export const HOSTED_SUPPORT_HOURS_TEXT =
  "Support replies within one business day, in business hours. This is a target, not an SLA.";

export type SupportChannelKind = "relay" | "agentmail" | "telegram" | "none";

export interface SupportChannelConfig {
  /** Where a "Contact a human" escalation is delivered. */
  kind: SupportChannelKind;
  /** The human-support reply-times text shown on the Help page. */
  hoursText: string;
  /**
   * An operator-configured "open an issue" URL. Empty = the client uses the
   * public Core repo's `/issues/new` (`shared/src/publicCoreSource.ts` holds
   * that URL — not duplicated here, because `test-public-source-gate.sh` pins
   * its copies to `scripts/lib/public-core-repo.txt`).
   */
  issueUrl: string;
  /** The operator's Telegram chat id, set only when `kind === "telegram"`. */
  telegramChatId: string | null;
}

/** settings.json `supportEscalation` block (non-credential values only). */
export interface SupportEscalationSettings {
  hoursText?: string;
  issueUrl?: string;
  telegramChatId?: string;
  channel?: string;
}

/**
 * Resolve where support escalations go (issue #4371 Task 5). Env-first, then
 * settings.json `supportEscalation`, then defaults.
 *
 * DECISION 2 (product map §8.4): platform credentials stay off customer VMs.
 * A hosted tenant (feedback transport `relay`) therefore resolves to `relay`
 * ONLY — never to an AgentMail or Telegram credential, even when one is also
 * present in its environment. Relay is checked FIRST for the same reason
 * `resolveFeedbackSenderConfig` infers it first.
 *
 * An operator or self-hosted install resolves to `agentmail` when the feedback
 * pipeline sends direct email (which already requires FEEDBACK_DEST_EMAIL,
 * #4638), else `telegram` when the Telegram bot is configured AND an operator
 * chat id is named, else `none` (the client shows the GitHub-issue link).
 *
 * `HAPI_SUPPORT_CHANNEL` / `supportEscalation.channel` can only NARROW: it
 * selects among the channels this install already has (or `none`), and an
 * unavailable value is ignored — it never adds a credential.
 */
export function resolveSupportChannel(opts: {
  feedback: FeedbackSenderConfig;
  telegramBotToken: string | null;
  settings?: SupportEscalationSettings;
  env?: Record<string, string | undefined>;
}): SupportChannelConfig {
  const env = opts.env ?? process.env;
  const settings = opts.settings ?? {};
  const pick = (envKey: string, fileValue: string | undefined): string =>
    (env[envKey] || fileValue || "").trim();

  const hosted = opts.feedback.transport === "relay";
  const telegramChatId =
    pick("HAPI_SUPPORT_TELEGRAM_CHAT_ID", settings.telegramChatId) || null;

  const available: SupportChannelKind[] = [];
  if (hosted) {
    available.push("relay");
  } else {
    if (opts.feedback.transport === "agentmail") available.push("agentmail");
    if (opts.telegramBotToken && telegramChatId) available.push("telegram");
  }

  let kind: SupportChannelKind = available[0] ?? "none";
  const override = pick("HAPI_SUPPORT_CHANNEL", settings.channel);
  if (override === "none") {
    kind = "none";
  } else if (available.includes(override as SupportChannelKind)) {
    kind = override as SupportChannelKind;
  }

  const hoursText =
    pick("HAPI_SUPPORT_HOURS_TEXT", settings.hoursText) ||
    (hosted ? HOSTED_SUPPORT_HOURS_TEXT : "");

  return {
    kind,
    hoursText,
    issueUrl: pick("HAPI_SUPPORT_ISSUE_URL", settings.issueUrl),
    telegramChatId: kind === "telegram" ? telegramChatId : null,
  };
}

/**
 * Read settings.json's `supportEscalation` block synchronously (issue #4371).
 * Tolerant: a missing or unreadable file, or a malformed block, yields `{}` and
 * the env/default layers of `resolveSupportChannel` apply. Only string values
 * are kept.
 */
export function readSupportEscalationSettings(
  dataDir: string
): SupportEscalationSettings {
  try {
    const raw = JSON.parse(readFileSync(getSettingsFile(dataDir), "utf8")) as {
      supportEscalation?: Record<string, unknown>;
    };
    const block = raw?.supportEscalation;
    if (!block || typeof block !== "object") return {};
    const out: SupportEscalationSettings = {};
    for (const key of [
      "hoursText",
      "issueUrl",
      "telegramChatId",
      "channel",
    ] as const) {
      const value = block[key];
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}
