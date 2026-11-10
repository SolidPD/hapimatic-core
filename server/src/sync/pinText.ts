// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Text the server writes into its own pins (issue #6455): mirrored prompts and
 * Detected pins quote what an agent or a tool call said, so every such field
 * passes through the same scrub and the same length cap.
 */
import { neutralizeApprovalTokens, scrubSecretTokens } from "@hapi/protocol";

/** `text` cut to `max` characters, ending in an ellipsis when it was cut. */
export function capPinText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Secrets out first, then approval tokens, as Submit does (pinSubmission.ts). */
export function cleanPinText(text: string): string {
  return neutralizeApprovalTokens(scrubSecretTokens(text));
}
