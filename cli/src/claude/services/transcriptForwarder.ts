// SPDX-License-Identifier: AGPL-3.0-only
/**
 * How the transcript launchers (pty, tmux and local) forward a scanned record to
 * the chat (#6088). Like `createSessionRateLimitDetector` (#6065) and the #1101
 * `mcpToggleService` factories, one factory is the symmetry contract: every
 * transcript launcher forwards the same way, and the rule is unit-tested here
 * once instead of per launcher. The launchers keep feeding every record to their
 * detectors; this only decides what reaches the chat.
 */

import type { RawJSONLines } from "../types";
import { isNoResponsePlaceholder } from "../utils/apiLimitSignal";
import {
  shouldSuppressUserEcho,
  type WebEchoSuppressor,
} from "../utils/webEchoSuppressor";

/** The session-client surface the forwarder sends through. */
export interface TranscriptMessageSink {
  sendClaudeSessionMessage(message: RawJSONLines): void;
}

export function createTranscriptForwarder(
  client: TranscriptMessageSink,
  opts: {
    /**
     * Issue #1719: the pty and tmux launchers record each web-queue submit, so
     * the scanner's echo of it is skipped (the web POST already persisted it).
     * The local launcher has no web submits and passes none.
     */
    webEchoSuppressor?: WebEchoSuppressor;
  } = {}
): (message: RawJSONLines) => void {
  return message => {
    // Issue #6088 (SINK-6): Claude Code's "No response requested." placeholder
    // never reaches the chat on the default SDK launcher; keep it out here too.
    if (isNoResponsePlaceholder(message)) {
      return;
    }
    if (
      opts.webEchoSuppressor &&
      shouldSuppressUserEcho(message, opts.webEchoSuppressor)
    ) {
      return;
    }
    client.sendClaudeSessionMessage(message);
  };
}
