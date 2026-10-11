// SPDX-License-Identifier: MIT
import type { RawJSONLines } from "../types";

/**
 * Suppresses the launcher's transcript-scan re-emit of a user message that
 * originated from the web client (issue #1719).
 *
 * Background: on the tmux and PTY launchers a web-originated user message is
 * persisted TWICE — once by the web's `POST /sessions/:id/messages` (Message A,
 * carries a `localId`, reconciles the optimistic bubble) and again by the
 * session scanner re-reading Claude's `.jsonl` transcript and re-emitting the
 * same `type:"user"` STRING-content line via `sendClaudeSessionMessage`
 * (Message B, no `localId`). The server's `store.messages.addMessage` only
 * de-dupes on `localId`, so both rows survive and render as two identical
 * bubbles with the same timestamp. The SDK launcher is immune because it never
 * uses the transcript scanner (it ingests the SDK message stream, which does not
 * re-emit the user's own prompt as a string-content user message).
 *
 * Fix: the launcher RECORDS every message it submits FROM THE WEB QUEUE (the
 * readiness-gate `submit` path), then the scanner's `onMessage` CONSUMES one
 * matching record when it sees the echoed user line and SKIPS re-emitting it.
 * Message A (the web POST copy) remains the single rendered bubble.
 *
 * Provenance certainty: in the tmux/PTY *remote* launchers, every message that
 * flows through `submit` came from `session.queue` (populated by the web POST).
 * A message typed directly into the TUI (`hapi launcher attach`, local mode)
 * never passes through `submit`, so it is never recorded and never suppressed —
 * its scanner echo is its ONLY bubble and MUST survive (Fallback Preservation
 * Rule). Message A and the scanner echo are coupled: a failed web POST never
 * reaches Claude, so there is no echo to suppress and no risk of dropping the
 * only copy.
 *
 * R5 (no over-suppression of a legitimately repeated message): records are held
 * as a FIFO multiset and consumed one-per-match, so sending the same text twice
 * records two entries and suppresses exactly two echoes; a third identical
 * scanner line with no remaining record is NOT suppressed.
 */
export interface WebEchoSuppressor {
  /** Record a message body submitted to Claude from the web queue. */
  record(text: string): void;
  /**
   * If a recorded body matches `text` (after whitespace-trim normalization),
   * consume ONE matching record and return true (caller skips the echo).
   * Returns false when there is no matching record (caller emits normally).
   */
  consumeMatch(text: string): boolean;
}

const DEFAULT_MAX_ENTRIES = 50;

/**
 * Normalize for matching. Claude's Ink TUI may trim a trailing newline between
 * the submitted body and the transcript line, so compare on the trimmed form.
 * Internal newlines (multi-line messages) are preserved — only leading/trailing
 * whitespace is stripped.
 */
function normalize(text: string): string {
  return text.trim();
}

export function createWebEchoSuppressor(opts?: {
  maxEntries?: number;
}): WebEchoSuppressor {
  const maxEntries = opts?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  // FIFO multiset of normalized submitted bodies awaiting their scanner echo.
  const pending: string[] = [];

  return {
    record(text: string): void {
      pending.push(normalize(text));
      // Bound the buffer: a submitted body whose echo never arrives (e.g. the
      // pane died before Claude wrote the transcript line) ages out instead of
      // leaking. Drop the OLDEST unmatched entries first.
      while (pending.length > maxEntries) {
        pending.shift();
      }
    },
    consumeMatch(text: string): boolean {
      const key = normalize(text);
      const idx = pending.indexOf(key);
      if (idx === -1) {
        return false;
      }
      pending.splice(idx, 1);
      return true;
    },
  };
}

/**
 * Decide whether a scanned transcript message is a web-originated user echo that
 * should be suppressed. Mirrors the EXACT user-bubble branch condition in
 * `ApiSessionClient.sendClaudeSessionMessage` (apiSession.ts): only a
 * non-sidechain, non-meta `type:"user"` message with STRING content becomes a
 * user bubble — those are the only messages that can duplicate Message A.
 * Tool-result user messages (array content), assistant, system, and summary
 * messages are never suppressed.
 *
 * Side effect: on a match this CONSUMES one record from `suppressor`.
 */
export function shouldSuppressUserEcho(
  message: RawJSONLines,
  suppressor: WebEchoSuppressor
): boolean {
  if (
    message.type === "user" &&
    message.isSidechain !== true &&
    message.isMeta !== true &&
    typeof message.message?.content === "string"
  ) {
    return suppressor.consumeMatch(message.message.content);
  }
  return false;
}
