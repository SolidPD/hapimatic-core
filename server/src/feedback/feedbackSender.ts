// SPDX-License-Identifier: AGPL-3.0-only
import type {
  FeedbackAttachment,
  FeedbackEntryCategory,
  FeedbackMetadata,
} from "@hapi/protocol/types";
import { sendViaRelay } from "./relayTransport";

/**
 * Config seam for the feedback email transport (issue #2664, epic #2663).
 * `transport` discriminates the send path with NO code fork between issues:
 *
 *  - `"agentmail"` — this issue. Direct POST to the AgentMail send API from
 *    server config (RP1 / local dev, where the key can live in env).
 *  - `"relay"`     — Sub-Issue D (#2667). Cloud VMs POST to a relay so the raw
 *    AgentMail key never lands on a cloud host. That branch is added HERE later,
 *    keyed off `transport`.
 *  - `"off"`       — unconfigured. The send is skipped; the route still persists
 *    the row and returns success (R10).
 */
export interface FeedbackSenderConfig {
  transport: "agentmail" | "relay" | "off";
  /** Base URL of the transport. For "agentmail": `https://api.agentmail.to`. */
  endpoint: string;
  apiKey?: string;
  inboxId?: string;
  destination: string;
  /**
   * Relay transport (Sub-Issue D, #2667). When `transport === "relay"` the
   * structured feedback payload is POSTed to this Matt-controlled relay URL with
   * {@link relayToken} as the per-VM Bearer credential; the relay ALONE holds the
   * AgentMail key and sends the email. DEDICATED fields — never overload `apiKey`
   * (that is AgentMail-semantic) — so the "no `AGENTMAIL_API_KEY` on a customer VM"
   * invariant (R4) stays unambiguous. Both are resolved from env and NEVER written
   * back to settings.json (#2410 no-write-back). The relay's hosting + token-rail
   * are a deployment concern (`relayUrl` is the full endpoint URL); the client here
   * is transport-agnostic so #2658 can replace the relay with no client change (D3).
   */
  relayUrl?: string;
  relayToken?: string;
}

export type FeedbackSendResult =
  | { status: "sent"; messageId: string }
  | { status: "skipped"; reason: string }
  | { status: "error"; error: string };

export interface FeedbackEmailContent {
  subject: string;
  html: string;
  text: string;
  /**
   * Native email attachments (issue #2665). Each `data` is base64-encoded file
   * bytes, already MIME/size re-validated by the route. Absent/empty = the
   * plain #2664 email. Mapped to AgentMail's native `attachments` field in
   * {@link sendFeedbackEmail}.
   */
  attachments?: FeedbackAttachment[];
}

/**
 * HTML-escape a single value for safe interpolation into the email body (R6).
 * `scrubString` only redacts secrets — it does NOT neutralize markup — so every
 * interpolated value (free-text description AND metadata paths/user-agent) MUST
 * pass through here, because the email is structured to drop into a GitHub issue.
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const CATEGORY_LABEL: Record<FeedbackEntryCategory, string> = {
  bug: "Bug",
  feature: "Feature request",
  other: "Other",
  // Issue #4371: the in-app support "Contact a human" escalation.
  "support-escalation": "Support escalation",
};

/** Flatten the whitelisted metadata into RAW (label, value) rows. HTML escaping
 *  happens at render time (below); the text renderer uses the raw values. */
function metadataRows(metadata: FeedbackMetadata): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  const push = (label: string, v: unknown): void => {
    if (v === undefined || v === null || v === "") return;
    rows.push([label, String(v)]);
  };

  push("App version", metadata.appVersion);
  push("Route", metadata.route);
  push("User agent", metadata.userAgent);
  push("Viewport", metadata.viewport);

  if (metadata.about) {
    const a = metadata.about;
    const osParts = [a.osName, a.kernel, a.arch].filter(Boolean);
    if (osParts.length) push("OS", osParts.join(" / "));
    push("Device", a.deviceModel);
    push("CPU cores", a.cpuCores);
    if (a.totalRamBytes != null) {
      push("Total RAM", `${(a.totalRamBytes / 1e9).toFixed(1)} GB`);
    }
    push("Tailnet", a.tailnet);
  }

  if (metadata.stats === "unavailable") {
    push("VM stats", "unavailable");
  } else if (metadata.stats) {
    const s = metadata.stats;
    if (s.cpuUsagePercent != null)
      push("CPU usage", `${s.cpuUsagePercent.toFixed(0)}%`);
    if (s.cpuTemperatureF != null) push("CPU temp", `${s.cpuTemperatureF}°F`);
    if (s.memUsagePercent != null)
      push("Memory usage", `${s.memUsagePercent.toFixed(0)}%`);
    if (s.diskUsagePercent != null)
      push("Disk usage", `${s.diskUsagePercent.toFixed(0)}%`);
    push("Host", s.hostname);
    if (s.uptimeSec != null)
      push("Uptime", `${Math.floor(s.uptimeSec / 3600)}h`);
  }

  if (metadata.session === "no active session") {
    push("Session", "no active session");
  } else if (metadata.session) {
    const ss = metadata.session;
    push("Session id", ss.sessionId);
    push("Working dir", ss.workingDir);
    push("Launcher", ss.launcherKind);
    push("Account", ss.accountEmail);
    push("Model (active)", ss.activeModel ?? ss.modelMode);
    push("Effort", ss.effort);
    push("Flavor", ss.flavor);
    if (ss.safeMode != null) push("Safe mode", String(ss.safeMode));
  }

  return rows;
}

/**
 * The structured feedback input that {@link buildFeedbackEmail} renders into an
 * email. Extracted to a named type (Sub-Issue D, #2667) because it is ALSO the
 * relay transport's request payload: the relay receives these structured fields
 * and rebuilds the email server-side (`sendViaRelay` in `relayTransport.ts`),
 * rather than trusting a caller-rendered HTML body — a compromised customer VM
 * must not be able to make the relay send arbitrary markup as Matt's identity.
 */
export interface FeedbackEmailInput {
  category: FeedbackEntryCategory;
  description: string;
  submitterEmail: string | null;
  metadata: FeedbackMetadata;
  attachments?: FeedbackAttachment[];
}

/**
 * Build the feedback email (subject + formatted HTML + plain-text fallback).
 * The HTML is a `<table>` of context rows + the description block — NOT
 * hard-wrapped — structured to paste cleanly into a GitHub issue (R9). EVERY
 * interpolated value is `escapeHtml`-ed (R6).
 */
export function buildFeedbackEmail(
  input: FeedbackEmailInput
): FeedbackEmailContent {
  const categoryLabel = CATEGORY_LABEL[input.category];
  const subject = `Hapimatic feedback — ${categoryLabel}`;
  const rows = metadataRows(input.metadata);
  const attachments = input.attachments ?? [];

  const rowsHtml = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:4px 12px 4px 0;font-weight:600;color:#334155;vertical-align:top">${escapeHtml(
          k
        )}</td><td style="padding:4px 0;color:#0f172a">${escapeHtml(v)}</td></tr>`
    )
    .join("\n");

  const fromLine = input.submitterEmail
    ? ` — from ${escapeHtml(input.submitterEmail)}`
    : "";

  // Attachments are delivered as native email attachments (below), but list
  // their filenames in the body too so the reader sees WHAT is attached at a
  // glance (R3 — "appear in the email").
  const attachmentsHtml =
    attachments.length > 0
      ? [
          `<h3 style="margin:16px 0 8px">Attachments (${attachments.length})</h3>`,
          `<ul style="margin:0;padding-left:20px;font-size:14px;color:#0f172a">${attachments
            .map(a => `<li>${escapeHtml(a.filename)}</li>`)
            .join("")}</ul>`,
        ].join("\n")
      : "";

  const html = [
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;line-height:1.5">`,
    `<h2 style="margin:0 0 4px">Hapimatic feedback</h2>`,
    `<p style="margin:0 0 16px;color:#475569"><strong>${escapeHtml(categoryLabel)}</strong>${fromLine}</p>`,
    `<h3 style="margin:0 0 8px">Description</h3>`,
    `<p style="white-space:pre-wrap;margin:0 0 20px">${escapeHtml(input.description)}</p>`,
    `<h3 style="margin:0 0 8px">Context</h3>`,
    `<table style="border-collapse:collapse;font-size:14px">${rowsHtml}</table>`,
    attachmentsHtml,
    `</div>`,
  ]
    .filter(Boolean)
    .join("\n");

  const text = [
    `Hapimatic feedback — ${categoryLabel}`,
    ...(input.submitterEmail ? [`From: ${input.submitterEmail}`] : []),
    "",
    "Description:",
    input.description,
    "",
    "Context:",
    ...rows.map(([k, v]) => `- ${k}: ${v}`),
    ...(attachments.length > 0
      ? ["", "Attachments:", ...attachments.map(a => `- ${a.filename}`)]
      : []),
  ].join("\n");

  return {
    subject,
    html,
    text,
    attachments: attachments.length > 0 ? attachments : undefined,
  };
}

/**
 * Send the feedback email through the configured transport (R8/R10). NEVER
 * throws: an unconfigured transport returns `skipped`, and any network/HTTP
 * failure returns `error` — the caller persists the row regardless, so a failed
 * send can never lose feedback.
 */
export async function sendFeedbackEmail(
  config: FeedbackSenderConfig,
  content: FeedbackEmailContent,
  relayInput?: FeedbackEmailInput
): Promise<FeedbackSendResult> {
  if (config.transport === "off") {
    return {
      status: "skipped",
      reason: "feedback email transport is off (AgentMail not configured)",
    };
  }

  if (config.transport === "agentmail") {
    if (!config.apiKey || !config.inboxId) {
      return { status: "skipped", reason: "AgentMail apiKey/inboxId missing" };
    }
    const url = `${config.endpoint}/v0/inboxes/${encodeURIComponent(
      config.inboxId
    )}/messages/send`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          to: config.destination,
          subject: content.subject,
          html: content.html,
          text: content.text,
          // AgentMail native attachments (issue #2665). Per-object shape
          // verified against docs.agentmail.to: { filename, content_type,
          // content (base64), content_disposition }. Omitted entirely when
          // there are none so the #2664 plain-email body is byte-identical.
          ...(content.attachments && content.attachments.length > 0
            ? {
                attachments: content.attachments.map(a => ({
                  filename: a.filename,
                  content_type: a.mimeType,
                  content: a.data,
                  content_disposition: "attachment",
                })),
              }
            : {}),
        }),
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        return {
          status: "error",
          error: `AgentMail send failed: HTTP ${res.status}${
            bodyText ? ` — ${bodyText.slice(0, 300)}` : ""
          }`,
        };
      }
      const json = (await res.json().catch(() => ({}))) as {
        message_id?: string;
      };
      return { status: "sent", messageId: json.message_id ?? "" };
    } catch (err) {
      return {
        status: "error",
        error: `AgentMail send threw: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }

  if (config.transport === "relay") {
    // Sub-Issue D (#2667). Send the STRUCTURED payload to the Matt-controlled
    // relay so the raw AgentMail key never lives on a customer VM (R4). The relay
    // rebuilds + sends the email with the key it alone holds. `relayInput` carries
    // the structured fields (the same object `buildFeedbackEmail` rendered) — the
    // caller-rendered `content` is intentionally NOT forwarded (the relay must not
    // trust caller HTML). No structured input → skip (never lose the persisted row).
    if (!relayInput) {
      return {
        status: "skipped",
        reason:
          "relay transport selected but no structured feedback input was provided",
      };
    }
    return sendViaRelay(config, relayInput);
  }

  // Unreachable in practice (transport is "off" | "agentmail" | "relay", all
  // handled above) — skip rather than throw so an unforeseen transport can never
  // lose the persisted row (R10).
  return {
    status: "skipped",
    reason: `transport "${config.transport}" not implemented in this build`,
  };
}
