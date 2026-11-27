// SPDX-License-Identifier: AGPL-3.0-only
import { logger } from "@/ui/logger";

/**
 * Issue #1442: surface the silent multi-image data loss to the sender via the
 * proven #1078 tool-error toast path. The caller passes the SAME sessionId
 * source ToolErrorDetector uses (`session.sessionId`, which the server's
 * resolveSessionForNamespace resolves) — NOT the claudeRemote `sessionId` opt
 * (the Claude resume id, null for fresh sessions). The toast renders as
 * "Attached files: <msg>". Moved unchanged out of the SDK launcher's
 * `onMissingAttachments` closure by #6559, for room under the line cap.
 */
export function reportMissingAttachments(
  sessionId: string | null,
  missingPaths: string[]
): void {
  const names = missingPaths.map(p => p.split("/").pop() ?? p).join(", ");
  logger.reportError({
    message: `${missingPaths.length} attached file(s) missing from disk at parse time`,
    category: "tool-error",
    severity: "warn",
    sessionId,
    context: JSON.stringify({
      toolName: "Attached files",
      errorContent:
        `${missingPaths.length} of the attached files were not found on disk and ` +
        `could not be sent as images: ${names}. They were uploaded but their bytes ` +
        `never reached disk — please re-attach and resend.`,
    }),
  });
}
