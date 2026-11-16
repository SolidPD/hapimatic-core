// SPDX-License-Identifier: AGPL-3.0-only
// Ported from tiann/hapi@34f931ef5 (cli/src/codex/utils/appServerPermissionAdapter.ts), AGPL-3.0-only, with changes.
// The item/permissions/requestApproval, item/tool/requestUserInput and
// mcpServer/elicitation/request handlers and the decision and grant mappings
// follow tiann/hapi main (appServerPermissionAdapter.ts:58-90, :391-482 at
// 2161a9ff; commits 56925f8b, 611c4eec, d97b270b), simplified.
/**
 * Answers every server-to-client request `codex app-server` can send
 * (#6263 R6). Command and file-change approvals go to the session's
 * CodexPermissionHandler; a request for a finished or aborted turn is
 * answered without prompting, in that request's own reply shape.
 */

import { randomUUID } from "node:crypto";
import { logger } from "@/ui/logger";
import {
  answerElicitation,
  type ElicitationAskResult,
  type ElicitationReply,
} from "../elicitation";
import type {
  CodexPermissionHandler,
  PermissionAnswerValidator,
} from "../utils/permissionHandler";
import type { AppServerRequestMethod } from "./appServerTypes";

type PermissionDecision =
  | "approved"
  | "approved_for_session"
  | "denied"
  | "abort";

type RequestHandler = (params: unknown) => Promise<unknown> | unknown;

export interface AppServerPermissionAdapterOptions {
  registerRequestHandler: (method: string, handler: RequestHandler) => void;
  getPermissionHandler: () => Pick<
    CodexPermissionHandler,
    "handleToolCall"
  > | null;
  /** False for a request whose turn has ended or was aborted. */
  isTurnLive: (turnId: string | null) => boolean;
  /** The change map cached from the file-change item's `item/started`. */
  getFileChanges: (itemId: string) => Record<string, unknown> | null;
  /** YOLO: approval policy `never` with `danger-full-access`. */
  isYolo: () => boolean;
  /** Post a chat notice (the transport's `hapi_notice`), #6606. */
  notice: (message: string) => void;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The same for command and file-change approvals, and independent of the
 * request's `availableDecisions`: `decline` lets the turn continue ("the agent
 * will continue the turn"), `cancel` interrupts it. Measured on 0.147.0 and
 * 0.167.0: an unlisted `decline` is accepted and the turn completes.
 */
export function mapApprovalDecision(decision: PermissionDecision): {
  decision: "accept" | "acceptForSession" | "decline" | "cancel";
} {
  switch (decision) {
    case "approved":
      return { decision: "accept" };
    case "approved_for_session":
      return { decision: "acceptForSession" };
    case "denied":
      return { decision: "decline" };
    case "abort":
      return { decision: "cancel" };
  }
}

function mapPermissionGrant(
  requested: unknown,
  decision: PermissionDecision
): { permissions: unknown; scope: "turn" | "session" } {
  if (decision === "approved" || decision === "approved_for_session") {
    return {
      permissions: requested,
      scope: decision === "approved_for_session" ? "session" : "turn",
    };
  }
  return { permissions: { network: null, fileSystem: null }, scope: "turn" };
}

/** The reply each method gets for a finished or aborted turn. */
export const STALE_TURN_REPLIES: Readonly<Record<string, unknown>> = {
  "item/commandExecution/requestApproval": { decision: "cancel" },
  "item/fileChange/requestApproval": { decision: "cancel" },
  "item/permissions/requestApproval": { permissions: {} },
  "item/tool/requestUserInput": { answers: {} },
  // Every elicitation reply has the three members (#6606 R2).
  "mcpServer/elicitation/request": {
    action: "cancel",
    content: null,
    _meta: null,
  },
};

const ELICITATION_FAILURE_DECLINE: Readonly<ElicitationReply> = {
  action: "decline",
  content: null,
  _meta: null,
};

export class AppServerPermissionAdapter {
  constructor(private readonly options: AppServerPermissionAdapterOptions) {}

  register(): void {
    const handlers: Record<AppServerRequestMethod, RequestHandler> = {
      "item/commandExecution/requestApproval": params =>
        this.commandApproval(params),
      "item/fileChange/requestApproval": params =>
        this.fileChangeApproval(params),
      "item/permissions/requestApproval": params =>
        this.permissionsApproval(params),
      "item/tool/requestUserInput": params => this.userInput(params),
      "mcpServer/elicitation/request": params => this.elicitation(params),
      // Legacy (v1) approvals: Hapimatic never opts into them; deny.
      execCommandApproval: () => ({ decision: "denied" }),
      applyPatchApproval: () => ({ decision: "denied" }),
      // No client-side implementation: a JSON-RPC error on purpose.
      "item/tool/call": () => {
        throw new Error("item/tool/call is not supported by Hapimatic");
      },
      "attestation/generate": () => {
        throw new Error("attestation/generate is not supported by Hapimatic");
      },
      "account/chatgptAuthTokens/refresh": () => {
        throw new Error(
          "account/chatgptAuthTokens/refresh is not supported by Hapimatic"
        );
      },
    };
    for (const [method, handler] of Object.entries(handlers)) {
      this.options.registerRequestHandler(method, handler);
    }
  }

  /** The stale-turn reply for `method`, or null when the turn is live. */
  private staleReply(method: string, params: unknown): unknown {
    const turnId = asString(asRecord(params).turnId) ?? null;
    if (this.options.isTurnLive(turnId)) return null;
    logger.debug(
      `[CodexAppServer] ${method} for a finished turn ${turnId ?? "?"}; answering without a prompt`
    );
    return STALE_TURN_REPLIES[method] ?? null;
  }

  /**
   * Ask the permission handler and return its whole result (the decision,
   * and for an elicitation the checked answers and who answered). A
   * rejection (the launcher's reset() on abort, mode change and turn end
   * rejects pending requests with "Session reset") becomes `abort`, so Codex
   * is never left without a reply.
   */
  private async ask(
    toolCallId: string,
    toolName: string,
    input: unknown,
    validate?: PermissionAnswerValidator
  ): Promise<ElicitationAskResult> {
    const handler = this.options.getPermissionHandler();
    if (!handler) {
      logger.debug("[CodexAppServer] No permission handler; declining");
      return { decision: "denied" };
    }
    try {
      return await handler.handleToolCall(
        toolCallId,
        toolName,
        input,
        validate
      );
    } catch (error) {
      logger.debug(
        `[CodexAppServer] Permission request ${toolCallId} ended without a decision`,
        error
      );
      return { decision: "abort" };
    }
  }

  private async decide(
    toolCallId: string,
    toolName: string,
    input: unknown
  ): Promise<PermissionDecision> {
    return (await this.ask(toolCallId, toolName, input)).decision;
  }

  private async commandApproval(params: unknown): Promise<unknown> {
    const stale = this.staleReply(
      "item/commandExecution/requestApproval",
      params
    );
    if (stale) return stale;
    const record = asRecord(params);
    const toolCallId = asString(record.itemId) ?? randomUUID();
    const input: Record<string, unknown> = {
      command: asString(record.command) ?? "",
      cwd: asString(record.cwd) ?? "",
    };
    const reason = asString(record.reason);
    if (reason) input.reason = reason;
    return mapApprovalDecision(
      await this.decide(toolCallId, "CodexBash", input)
    );
  }

  private async fileChangeApproval(params: unknown): Promise<unknown> {
    const stale = this.staleReply("item/fileChange/requestApproval", params);
    if (stale) return stale;
    const record = asRecord(params);
    const toolCallId = asString(record.itemId) ?? randomUUID();
    // The approval request carries no changes; they came with item/started.
    const input: Record<string, unknown> = {
      changes: this.options.getFileChanges(toolCallId) ?? {},
    };
    const reason = asString(record.reason);
    if (reason) input.reason = reason;
    const grantRoot = asString(record.grantRoot);
    if (grantRoot) input.grant_root = grantRoot;
    return mapApprovalDecision(
      await this.decide(toolCallId, "CodexPatch", input)
    );
  }

  private async permissionsApproval(params: unknown): Promise<unknown> {
    const stale = this.staleReply("item/permissions/requestApproval", params);
    if (stale) return stale;
    const record = asRecord(params);
    const permissions = record.permissions ?? {};
    const decision = await this.decide(
      asString(record.itemId) ?? randomUUID(),
      "CodexPermission",
      {
        message: asString(record.reason),
        cwd: asString(record.cwd),
        permissions,
      }
    );
    return mapPermissionGrant(permissions, decision);
  }

  /** Hapimatic has no Codex question UI: answer with no answers. */
  private userInput(params: unknown): unknown {
    const stale = this.staleReply("item/tool/requestUserInput", params);
    if (stale) return stale;
    logger.debug(
      "[CodexAppServer] item/tool/requestUserInput: no UI; empty answers"
    );
    return { answers: {} };
  }

  /**
   * An MCP server's request for input, which also carries Codex's own
   * approval of an MCP tool call (a field-less form whose `_meta` names
   * `mcp_tool_call`; the `hapi` server itself never elicits). A stalled reply
   * would stall that tool call, so every path answers. The routing module
   * (`../elicitation.ts`, #6606) decides: YOLO declines with a notice, a
   * field-less request keeps today's `mcp__<server>` card, a form or a link
   * gets its own card and is answered only from an answer set the handler
   * checked, and anything else is declined with a notice. Each request is
   * registered under a fresh UUID, never the server's `elicitationId`, so a
   * server cannot choose the key or make two requests share one (R11). A
   * throw anywhere becomes a decline with a notice, never a JSON-RPC error.
   */
  private async elicitation(params: unknown): Promise<ElicitationReply> {
    try {
      const stale = this.staleReply("mcpServer/elicitation/request", params);
      if (stale) return { ...(stale as ElicitationReply) };
      return await answerElicitation({
        params,
        yolo: this.options.isYolo(),
        ask: (toolName, input, validate) =>
          this.ask(randomUUID(), toolName, input, validate),
        notice: message => this.options.notice(message),
      });
    } catch (error) {
      logger.debug(
        "[CodexAppServer] mcpServer/elicitation/request could not be read; declining",
        error
      );
      try {
        this.options.notice(
          "MCP server (unnamed) asked for input and Hapimatic could not process it. Declined."
        );
      } catch {
        // The reply stands without the notice.
      }
      return { ...ELICITATION_FAILURE_DECLINE };
    }
  }
}
