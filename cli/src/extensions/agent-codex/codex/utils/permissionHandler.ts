// SPDX-License-Identifier: MIT
/**
 * Permission Handler for Codex tool approval integration
 *
 * Handles tool permission requests and responses for Codex sessions.
 * Simpler than Claude's permission handler since we get tool IDs directly.
 */

import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import {
  BasePermissionHandler,
  type PendingPermissionRequest,
  type PermissionCompletion,
} from "@/modules/common/permission/BasePermissionHandler";

interface PermissionResponse {
  id: string;
  approved: boolean;
  decision?: "approved" | "approved_for_session" | "denied" | "abort";
  reason?: string;
}

interface PermissionResult {
  decision: "approved" | "approved_for_session" | "denied" | "abort";
  reason?: string;
}

export class CodexPermissionHandler extends BasePermissionHandler<
  PermissionResponse,
  PermissionResult
> {
  constructor(session: ApiSessionClient) {
    super(session);
  }

  /**
   * Handle a tool permission request
   * @param toolCallId - The unique ID of the tool call
   * @param toolName - The name of the tool being called
   * @param input - The input parameters for the tool
   * @returns Promise resolving to permission result
   */
  async handleToolCall(
    toolCallId: string,
    toolName: string,
    input: unknown
  ): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve, reject) => {
      // Store the pending request
      this.addPendingRequest(toolCallId, toolName, input, { resolve, reject });

      // Send push notification
      // this.session.api.push().sendToAllDevices(
      //     'Permission Request',
      //     `Codex wants to use ${toolName}`,
      //     {
      //         sessionId: this.session.sessionId,
      //         requestId: toolCallId,
      //         tool: toolName,
      //         type: 'permission_request'
      //     }
      // );

      logger.debug(
        `[Codex] Permission request sent for tool: ${toolName} (${toolCallId})`
      );
    });
  }

  /**
   * Handle permission responses
   */
  protected handlePermissionResponse(
    response: PermissionResponse,
    pending: PendingPermissionRequest<PermissionResult>
  ): PermissionCompletion {
    const reason =
      typeof response.reason === "string" ? response.reason : undefined;
    const result: PermissionResult = response.approved
      ? {
          decision:
            response.decision === "approved_for_session"
              ? "approved_for_session"
              : "approved",
          reason,
        }
      : {
          decision: response.decision === "denied" ? "denied" : "abort",
          reason,
        };

    pending.resolve(result);
    logger.debug(
      `[Codex] Permission ${response.approved ? "approved" : "denied"} for ${pending.toolName}`
    );

    return {
      status: response.approved ? "approved" : "denied",
      decision: result.decision,
      reason: result.reason,
    };
  }

  protected handleMissingPendingResponse(_response: PermissionResponse): void {
    logger.debug("[Codex] Permission request not found or already resolved");
  }

  /**
   * Reset state for new sessions
   */
  reset(): void {
    this.cancelPendingRequests({
      completedReason: "Session reset",
      rejectMessage: "Session reset",
    });

    logger.debug("[Codex] Permission handler reset");
  }
}
