// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The support "Contact a human" bundle (issue #4371 Task 4, R3/R4).
 *
 * `composeEscalationBundle` builds a small, redacted context bundle from a
 * support session — the Hapimatic version, the launcher, the harness, the most
 * recent errors recorded for that session, and the text of the support
 * conversation — and `serializeEscalationBundle` renders it to the exact text
 * the user previews AND the exact text that is sent. `escalationBundleHash` is
 * the sha256 of that text: `send` recomposes, and refuses when the hash differs
 * from the one the user previewed, so what is sent is exactly what was shown.
 *
 * DETERMINISM: the bundle carries no clock value of its own (error entries
 * carry their own recorded timestamps), so composing twice over unchanged state
 * yields the same bytes and the same hash.
 *
 * REDACTION (every string leaf, before serialization):
 *   1. `scrubTranscriptSecrets` — the known token shapes (GitHub, Anthropic,
 *      OpenAI-style `sk-`, AWS, Telegram, JWTs, age keys, `cliApiToken` in a
 *      key/assignment) AND the exact KNOWN LITERALS of this instance's own
 *      secrets, because a random instance token has no shape to match;
 *   2. Slack tokens (`xox[abposr]-…`), which no shared scrubber covers;
 *   3. `maskSecretText` — the provisioning-log masker (known literals again,
 *      `NAME=value` for the secret env names, Bearer/flag forms, and bare
 *      high-entropy runs).
 */
import { createHash } from "node:crypto";
import { scrubTranscriptSecrets } from "@hapi/protocol";
import { unwrapRoleWrappedRecordEnvelope } from "@hapi/protocol/messages";
import { maskSecretText } from "../provisioner/logMasking";

/** Bound on each transcript entry and on the number of entries kept. */
export const MAX_TRANSCRIPT_ENTRY_CHARS = 4000;
export const MAX_TRANSCRIPT_ENTRIES = 120;
export const MAX_RECENT_ERRORS = 3;

export interface EscalationTranscriptEntry {
  role: "user" | "assistant";
  text: string;
}

export interface EscalationError {
  at: string;
  category: string;
  message: string;
}

export interface EscalationBundle {
  kind: "hapimatic-support-escalation";
  hapimaticVersion: string;
  launcher: string;
  harness: string;
  sessionId: string;
  recentErrors: EscalationError[];
  transcript: EscalationTranscriptEntry[];
}

export interface EscalationInputs {
  version: string;
  launcher: string;
  harness: string;
  sessionId: string;
  /** Stored message rows, oldest first. */
  messages: ReadonlyArray<{ content: unknown }>;
  /** Error-log rows for the session, any order. */
  errors: ReadonlyArray<{
    timestamp: number;
    category: string;
    message: string;
  }>;
  /** Exact secret values this instance knows (its tokens, relay token, …). */
  secretLiterals: readonly string[];
}

const SLACK_TOKEN_RE = /\bxox[abposr]-[A-Za-z0-9-]{10,}/g;

/** Redact one string through every layer described in the module header. */
export function redactEscalationText(
  text: string,
  literals: readonly string[]
): string {
  const shaped = scrubTranscriptSecrets(text, literals).replace(
    SLACK_TOKEN_RE,
    "xox-[REDACTED]"
  );
  return maskSecretText(shaped, literals);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

/**
 * The visible text of one stored message, or null when it carries none (tool
 * calls, tool results, meta records, reasoning). Mirrors the traversal of
 * `server/src/sync/needsReviewContent.ts`.
 */
export function messageText(
  content: unknown
): EscalationTranscriptEntry | null {
  const record = unwrapRoleWrappedRecordEnvelope(content);
  if (!record || !isObject(record.content)) return null;
  const inner = record.content;

  if (record.role === "user") {
    if (inner.type === "text" && typeof inner.text === "string") {
      const text = inner.text.trim();
      return text ? { role: "user", text } : null;
    }
    return null;
  }

  if (record.role !== "agent" && record.role !== "assistant") return null;

  // Claude SDK output: data.message.content[] text blocks.
  if (inner.type === "output" && isObject(inner.data)) {
    const data = inner.data;
    if (
      data.isMeta === true ||
      data.isCompactSummary === true ||
      data.isSidechain === true ||
      data.type !== "assistant" ||
      !isObject(data.message)
    ) {
      return null;
    }
    const blocks = data.message.content;
    const parts: string[] = [];
    if (typeof blocks === "string") {
      parts.push(blocks);
    } else if (Array.isArray(blocks)) {
      for (const block of blocks) {
        if (
          isObject(block) &&
          block.type === "text" &&
          typeof block.text === "string"
        ) {
          parts.push(block.text);
        }
      }
    }
    const text = parts.join("\n").trim();
    return text ? { role: "assistant", text } : null;
  }

  // Codex / ACP: data.type === "message" with a string data.message.
  if (inner.type === "codex" && isObject(inner.data)) {
    const data = inner.data;
    if (
      data.isSidechain !== true &&
      data.type === "message" &&
      typeof data.message === "string" &&
      data.message.trim()
    ) {
      return { role: "assistant", text: data.message.trim() };
    }
  }
  return null;
}

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)} …[truncated]` : text;
}

export function composeEscalationBundle(
  inputs: EscalationInputs
): EscalationBundle {
  const literals = inputs.secretLiterals;
  const redact = (s: string): string => redactEscalationText(s, literals);

  const transcript: EscalationTranscriptEntry[] = [];
  for (const message of inputs.messages) {
    const entry = messageText(message.content);
    if (!entry) continue;
    // Redact BEFORE capping, so a secret straddling the cap is still whole
    // when it is matched.
    transcript.push({
      role: entry.role,
      text: cap(redact(entry.text), MAX_TRANSCRIPT_ENTRY_CHARS),
    });
  }

  const recentErrors = [...inputs.errors]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, MAX_RECENT_ERRORS)
    .map(e => ({
      at: new Date(e.timestamp).toISOString(),
      category: redact(e.category),
      message: cap(redact(e.message), 1000),
    }));

  return {
    kind: "hapimatic-support-escalation",
    hapimaticVersion: redact(inputs.version),
    launcher: redact(inputs.launcher),
    harness: redact(inputs.harness),
    sessionId: redact(inputs.sessionId),
    recentErrors,
    transcript: transcript.slice(-MAX_TRANSCRIPT_ENTRIES),
  };
}

/** The exact text previewed and sent. */
export function serializeEscalationBundle(bundle: EscalationBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

export function escalationBundleHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
