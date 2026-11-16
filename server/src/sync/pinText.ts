// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Text the server writes into its own pins (issue #6455): mirrored prompts and
 * Detected pins quote what an agent or a tool call said, so every such field
 * passes through the same scrub and the same length cap.
 */
import {
  neutralizeApprovalTokens,
  scrubTranscriptSecrets,
} from "@hapi/protocol";

/** `text` cut to `max` characters, ending in an ellipsis when it was cut. */
export function capPinText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * The one scrubber for every pin field the server writes and for Submit's
 * record and message (`pinSubmission.ts`), #6458 Task 11c (#6530). It is built
 * on `scrubTranscriptSecrets`, because `scrubSecretTokens` alone has no rule
 * for GitHub tokens (`ghp_…`), AWS keys (`AKIA…`) or `CLI_API_TOKEN=` values,
 * which tool calls and prompts quote. Callers scrub before they cap
 * (`capPinText`), so a secret cut by the cap cannot slip past its pattern. The
 * generic `sk-` rule is the one both scrubbers already applied (#4512 tracks
 * its false positives).
 *
 * Approval tokens are neutralized first, because the transcript scrub masks
 * the same acceptor shape as `USER-APPROVAL-[REDACTED]`, which would keep the
 * prefix in the text and leave nothing for the pin wording
 * (`[approval token removed]`) to replace.
 */
export function cleanPinText(text: string): string {
  return scrubTranscriptSecrets(neutralizeApprovalTokens(text));
}
