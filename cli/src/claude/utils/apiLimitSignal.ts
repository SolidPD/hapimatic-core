// SPDX-License-Identifier: MIT
/**
 * Launcher-agnostic extraction of an API-limit signal from one session message
 * (#4936). Feeds the single classification point
 * (`classifyApiLimitSignal`, `@hapi/protocol/apiErrorClasses`) from both
 * `ApiErrorDetector` and `RateLimitDetector`, on every launcher.
 *
 * The record shapes it reads:
 *   - **Transcript launchers** (tmux / pty / local): Claude Code's synthetic
 *     assistant entry — `isApiErrorMessage: true`, `apiErrorStatus`, and
 *     `apiErrorCode` (the API's `error.details.error_code`) when the API sent one.
 *   - **SDK launcher**: the converted assistant frame. `SDKToLogConverter` copies
 *     `api_error_code` → `apiErrorCode` but deliberately NOT the
 *     `is_api_error_message` flag, so the 400 user-limit frame (which carries no
 *     code) is recognized by its synthetic model + the `API Error:` text prefix.
 *   - **system / `api_error`** (Shape B): transcript retry records and
 *     `parseStderrApiError`'s synthetic (`cli/src/claude/sdk/query.ts`).
 *
 * The carrier gate is the false-positive guard: a real model turn (real model
 * id, no flag, no code) that merely quotes the cap text yields `null`.
 */

import type { RawJSONLines } from "../types";
import {
  statusFromApiErrorText,
  type ApiLimitSignal,
} from "@hapi/protocol/apiErrorClasses";

/** Claude Code's model id on the synthetic messages it writes itself. */
export const SYNTHETIC_MODEL = "<synthetic>";

/** Concatenate the text of an assistant message's content blocks. */
export function extractAssistantText(inner: unknown): string {
  if (!inner || typeof inner !== "object") return "";
  const content = (inner as Record<string, unknown>).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(block => {
      if (block && typeof block === "object") {
        const text = (block as Record<string, unknown>).text;
        if (typeof text === "string") return text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * The API-limit signal carried by `message`, or `null` when the message is not
 * an API-error record. Pure; reads passthrough fields defensively.
 */
export function extractApiLimitSignal(
  message: RawJSONLines
): ApiLimitSignal | null {
  const msg = message as Record<string, unknown>;

  if (msg.type === "assistant") {
    const inner = msg.message as Record<string, unknown> | undefined;
    const text = extractAssistantText(inner);
    const errorCode =
      typeof msg.apiErrorCode === "string" ? msg.apiErrorCode : undefined;
    const isCarrier =
      msg.isApiErrorMessage === true ||
      errorCode !== undefined ||
      (inner?.model === SYNTHETIC_MODEL &&
        text.trimStart().startsWith("API Error:"));
    if (!isCarrier) return null;
    const status =
      typeof msg.apiErrorStatus === "number"
        ? msg.apiErrorStatus
        : statusFromApiErrorText(text);
    return { status, errorCode, text };
  }

  if (msg.type === "system" && msg.subtype === "api_error") {
    const error = msg.error as Record<string, unknown> | undefined;
    if (!error) return null;
    const rawStatus = error.status ?? error.statusCode;
    const status = typeof rawStatus === "number" ? rawStatus : undefined;
    const body = error.body;
    // Same text source as RateLimitDetector's Shape B: `message`, else a string `body`.
    const text =
      typeof error.message === "string"
        ? error.message
        : typeof body === "string"
          ? body
          : "";
    let errorCode: string | undefined;
    if (body && typeof body === "object") {
      const details = (
        (body as Record<string, unknown>).error as
          | Record<string, unknown>
          | undefined
      )?.details as Record<string, unknown> | undefined;
      if (typeof details?.error_code === "string") {
        errorCode = details.error_code;
      }
    }
    return { status, errorCode, text };
  }

  return null;
}
