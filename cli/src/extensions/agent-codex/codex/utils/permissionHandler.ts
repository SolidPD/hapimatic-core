// SPDX-License-Identifier: MIT AND AGPL-3.0-only
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

export type PermissionAnswerCheck =
  | { ok: true }
  | { ok: false; reason: string };

/** Checks a request's answer set before the request is resolved (#6606 R13). */
export type PermissionAnswerValidator = (
  answers: unknown
) => PermissionAnswerCheck;

type PermissionDecision =
  | "approved"
  | "approved_for_session"
  | "denied"
  | "abort";

interface PermissionResponse {
  id: string;
  approved: boolean;
  decision?: PermissionDecision;
  reason?: string;
  /**
   * The answer set as the hub sent it (`Record<string, string[]>`), typed
   * unknown: only the request's validator and `copyAnswers` decide what it holds.
   */
  answers?: unknown;
  /** "session" when the hub knows a session approved (#6606 R18). */
  answeredBy?: unknown;
}

export interface PermissionResult {
  decision: PermissionDecision;
  reason?: string;
  /** Only an answer set the request's validator accepted (#6606 R17). */
  answers?: Record<string, string[]>;
  answeredBy?: "session";
}

/** A copy of an answer set, or null when it is not one (a record of string lists). */
function copyAnswers(answers: unknown): Record<string, string[]> | null {
  if (
    answers === null ||
    typeof answers !== "object" ||
    Array.isArray(answers)
  ) {
    return null;
  }
  const entries: Array<[string, string[]]> = [];
  for (const [key, values] of Object.entries(answers)) {
    if (!Array.isArray(values) || !values.every(v => typeof v === "string")) {
      return null;
    }
    entries.push([key, [...(values as string[])]]);
  }
  // fromEntries defines each key as an own property, `__proto__` included.
  return Object.fromEntries(entries);
}

/**
 * The decision a response carries. A deny with no decision is an abort
 * (Telegram's Deny), as before; an approval whose decision is `denied` or
 * `abort` is that decision (#6606 R3).
 */
function decisionOf(response: PermissionResponse): PermissionDecision {
  if (!response.approved) {
    return response.decision === "denied" ? "denied" : "abort";
  }
  switch (response.decision) {
    case "approved_for_session":
    case "denied":
    case "abort":
      return response.decision;
    default:
      return "approved";
  }
}

export class CodexPermissionHandler extends BasePermissionHandler<
  PermissionResponse,
  PermissionResult
> {
  /** The validator each pending request was registered with (#6606 R13). */
  private readonly validators = new Map<string, PermissionAnswerValidator>();

  constructor(session: ApiSessionClient) {
    super(session);
  }

  /**
   * Handle a tool permission request
   * @param toolCallId - The unique ID of the tool call
   * @param toolName - The name of the tool being called
   * @param input - The input parameters for the tool
   * @param validate - Checks an approval's answer set; an approval that fails
   *   it resolves as denied (an MCP form or link elicitation, #6606)
   * @returns Promise resolving to permission result
   */
  async handleToolCall(
    toolCallId: string,
    toolName: string,
    input: unknown,
    validate?: PermissionAnswerValidator
  ): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve, reject) => {
      if (validate) this.validators.set(toolCallId, validate);
      else this.validators.delete(toolCallId);
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
   * Handle permission responses. An approval of a request that carries a
   * validator is checked here, before the request is resolved or recorded, so
   * a set that fails is resolved denied and recorded once, as denied, with no
   * answers: the record is never approved first and denied second (#6606
   * R13). An approval whose decision is `denied` or `abort` is that decision.
   */
  protected handlePermissionResponse(
    response: PermissionResponse,
    pending: PendingPermissionRequest<PermissionResult>
  ): PermissionCompletion {
    const validate = this.validators.get(response.id);
    this.validators.delete(response.id);
    const reason =
      typeof response.reason === "string" ? response.reason : undefined;
    const answeredBy =
      response.answeredBy === "session" ? ("session" as const) : undefined;
    const decision = decisionOf(response);
    const settle = (
      status: "approved" | "denied",
      result: PermissionResult
    ): PermissionCompletion => {
      const full: PermissionResult = {
        ...result,
        ...(answeredBy ? { answeredBy } : {}),
      };
      pending.resolve(full);
      logger.debug(
        `[Codex] Permission ${full.decision} for ${pending.toolName}`
      );
      return {
        status,
        decision: full.decision,
        reason: full.reason,
        ...(full.answers ? { answers: full.answers } : {}),
        ...(full.answeredBy ? { answeredBy: full.answeredBy } : {}),
      };
    };
    const withReason = (value: string | undefined): { reason?: string } =>
      value === undefined ? {} : { reason: value };

    if (decision === "denied" || decision === "abort") {
      return settle("denied", { decision, ...withReason(reason) });
    }
    if (!validate) {
      return settle("approved", { decision, ...withReason(reason) });
    }

    let check: PermissionAnswerCheck;
    try {
      check = validate(response.answers);
    } catch (error) {
      logger.debug("[Codex] The answer check threw; denying", error);
      check = { ok: false, reason: "the answers could not be checked" };
    }
    const answers = check.ok ? copyAnswers(response.answers) : null;
    if (!check.ok || answers === null) {
      const refused = check.ok
        ? "the answers are not lists of text values"
        : check.reason;
      logger.debug(
        `[Codex] ${pending.toolName}: the answers failed the check; denying`
      );
      return {
        ...settle("denied", { decision: "denied", reason: refused }),
        answersDeclined: refused,
      };
    }
    return settle("approved", { decision, ...withReason(reason), answers });
  }

  protected handleMissingPendingResponse(_response: PermissionResponse): void {
    logger.debug("[Codex] Permission request not found or already resolved");
  }

  /**
   * Reset state for new sessions
   */
  reset(): void {
    this.validators.clear();
    this.cancelPendingRequests({
      completedReason: "Session reset",
      rejectMessage: "Session reset",
    });

    logger.debug("[Codex] Permission handler reset");
  }
}
