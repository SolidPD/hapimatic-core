// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Session Notification View for Telegram
 *
 * Provides notification formatting for permission requests.
 * All interactive session views are handled by the Telegram Mini App.
 */

import { InlineKeyboard } from "grammy";
import { isQuestionToolName } from "@hapi/protocol";
import type { Session } from "../../sync/syncEngine";
import { ACTIONS, SHORT_REQUEST_ID } from "./callbacks";
import { createCallbackData, truncate, getSessionName } from "./renderer";

const MAX_TOOL_ARGS_LENGTH = 150;

/**
 * The id of the first pending request that is not a question tool, or null.
 * A question (AskUserQuestion, an MCP server's form or link request) is
 * answered on its own card, so no Allow button is ever bound to it (#6606, PM
 * ruling P2-a).
 */
export function firstPermissionRequestId(session: Session): string | null {
  const requests = session.agentState?.requests ?? {};
  for (const [id, request] of Object.entries(requests)) {
    if (request && !isQuestionToolName(request.tool)) return id;
  }
  return null;
}

/**
 * Format a compact session notification for permission requests
 */
export function formatSessionNotification(session: Session): string {
  const name = getSessionName(session);
  const lines: string[] = ["Permission Request", "", `Session: ${name}`];

  const requests = session.agentState?.requests;
  const reqId = firstPermissionRequestId(session);
  if (requests && reqId !== null) {
    const req = requests[reqId];
    if (req) {
      lines.push(`Tool: ${req.tool}`);
      const args = formatToolArgumentsDetailed(
        req.tool,
        req.arguments as Record<string, unknown>
      );
      if (args) {
        lines.push(args);
      }
    }
  }

  return lines.join("\n");
}

/** Telegram's limit on a button's data, in bytes (not characters). */
const CALLBACK_DATA_MAX_BYTES = 64;

/**
 * A button's data, naming the request by its whole id, which a tap matches
 * exactly (#6606 round 9, F3: every Claude request id starts "toolu_01", so
 * a cut id named several). An id the data cannot carry whole is named by its
 * first `SHORT_REQUEST_ID` characters, as before (D1): one that does not fit
 * the 64 bytes, counted in bytes, or that holds a ":", which
 * `parseCallbackData` splits on.
 */
function requestButtonData(
  action: string,
  sessionId: string,
  requestId: string
): string {
  const data = createCallbackData(action, sessionId, requestId);
  const whole =
    !requestId.includes(":") &&
    data.endsWith(`:${requestId}`) &&
    new TextEncoder().encode(data).length <= CALLBACK_DATA_MAX_BYTES;
  return whole
    ? data
    : createCallbackData(
        action,
        sessionId,
        requestId.slice(0, SHORT_REQUEST_ID)
      );
}

/**
 * Create notification keyboard for quick actions
 */
export function createNotificationKeyboard(
  session: Session,
  miniAppUrl: string
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const requestId = firstPermissionRequestId(session);
  const canControl = session.active;

  if (canControl && requestId !== null) {
    keyboard
      .text("Allow", requestButtonData(ACTIONS.APPROVE, session.id, requestId))
      .text("Deny", requestButtonData(ACTIONS.DENY, session.id, requestId));
    keyboard.row();

    keyboard.webApp(
      "Details",
      buildMiniAppDeepLink(miniAppUrl, `session_${session.id}`)
    );
    return keyboard;
  }

  keyboard.webApp(
    "Open Session",
    buildMiniAppDeepLink(miniAppUrl, `session_${session.id}`)
  );
  return keyboard;
}

/**
 * Format detailed tool arguments for notification display
 */
function formatToolArgumentsDetailed(
  tool: string,
  args: Record<string, unknown>
): string {
  if (!args) return "";

  /** Safely coerce unknown value to string for display */
  const str = (val: unknown): string =>
    typeof val === "string" ? val : String(val ?? "");

  try {
    switch (tool) {
      case "Edit": {
        const file = str(args.file_path || args.path || "unknown");
        const oldStr = args.old_string
          ? truncate(str(args.old_string), 50)
          : "";
        const newStr = args.new_string
          ? truncate(str(args.new_string), 50)
          : "";
        let result = `File: ${truncate(file, MAX_TOOL_ARGS_LENGTH)}`;
        if (oldStr) result += `\nOld: "${oldStr}"`;
        if (newStr) result += `\nNew: "${newStr}"`;
        return result;
      }

      case "Write": {
        const file = str(args.file_path || args.path || "unknown");
        const content = args.content ? `${str(args.content).length} chars` : "";
        return `File: ${truncate(file, MAX_TOOL_ARGS_LENGTH)}${content ? ` (${content})` : ""}`;
      }

      case "Read": {
        const file = str(args.file_path || args.path || "unknown");
        return `File: ${truncate(file, MAX_TOOL_ARGS_LENGTH)}`;
      }

      case "Bash": {
        const cmd = str(args.command || "");
        return `Command: ${truncate(cmd, MAX_TOOL_ARGS_LENGTH)}`;
      }

      case "Task": {
        const desc = str(args.description || args.prompt || "");
        return `Task: ${truncate(desc, MAX_TOOL_ARGS_LENGTH)}`;
      }

      case "Grep":
      case "Glob": {
        const pattern = str(args.pattern || "");
        const path = str(args.path || "");
        let result = `Pattern: ${pattern}`;
        if (path) result += `\nPath: ${truncate(path, 80)}`;
        return result;
      }

      case "WebFetch": {
        const url = str(args.url || "");
        return `URL: ${truncate(url, MAX_TOOL_ARGS_LENGTH)}`;
      }

      case "TodoWrite": {
        const todos = args.todos;
        const count = Array.isArray(todos) ? todos.length : 0;
        return `Updating ${count} todo items`;
      }

      default: {
        // Generic args display for unknown tools
        const argStr = JSON.stringify(args);
        if (argStr.length > 10) {
          return `Args: ${truncate(argStr, MAX_TOOL_ARGS_LENGTH)}`;
        }
        return "";
      }
    }
  } catch {
    return "";
  }
}

function buildMiniAppDeepLink(baseUrl: string, startParam: string): string {
  try {
    const url = new URL(baseUrl);
    url.searchParams.set("startapp", startParam);
    return url.toString();
  } catch {
    const separator = baseUrl.includes("?") ? "&" : "?";
    return `${baseUrl}${separator}startapp=${encodeURIComponent(startParam)}`;
  }
}
