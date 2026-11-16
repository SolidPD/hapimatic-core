// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Callback Query Handlers for Telegram
 *
 * Handles InlineKeyboard button interactions for permission notifications.
 * Simplified to only support APPROVE and DENY actions.
 */

import { InlineKeyboard } from "grammy";
import type { Session, SyncEngine } from "../../sync/syncEngine";
import type { ErrorLogger } from "../../logging/errorLogger";
import { parseCallbackData, findSessionByPrefix } from "./renderer";

// Callback action types (simplified - only permission actions)
export const ACTIONS = {
  APPROVE: "ap",
  DENY: "dn",
} as const;

/**
 * How many characters of a request id a button carried before #6606 round 9,
 * and still carries for an id it cannot carry whole: one over the 64 bytes
 * of a button's data, or one that holds a ":" (round 9, D1).
 */
export const SHORT_REQUEST_ID = 8;

/**
 * Callback handler context
 */
export interface CallbackContext {
  syncEngine: SyncEngine;
  namespace: string;
  errorLogger?: ErrorLogger | null;
  answerCallback: (text?: string) => Promise<void>;
  editMessage: (text: string, keyboard?: InlineKeyboard) => Promise<void>;
}

async function getSessionOrAnswer(
  ctx: CallbackContext,
  syncEngine: SyncEngine,
  sessionPrefix: string,
  options?: { requireActive?: boolean }
): Promise<Session | null> {
  const session = findSessionByPrefix(
    syncEngine.getSessionsByNamespace(ctx.namespace),
    sessionPrefix
  );
  if (!session) {
    await ctx.answerCallback("Session not found");
    return null;
  }
  if (options?.requireActive && !session.active) {
    await ctx.answerCallback("Session is inactive");
    return null;
  }
  return session;
}

/**
 * Handle callback query
 */
export async function handleCallback(
  data: string,
  ctx: CallbackContext
): Promise<void> {
  const { action, sessionPrefix, extra } = parseCallbackData(data);
  const { syncEngine } = ctx;

  try {
    switch (action) {
      case ACTIONS.APPROVE: {
        const session = await getSessionOrAnswer(
          ctx,
          syncEngine,
          sessionPrefix,
          { requireActive: true }
        );
        if (!session) {
          return;
        }

        const requestId = findRequestByPrefix(session, extra || "");
        if (!requestId) {
          await ctx.answerCallback("Request not found or already processed");
          return;
        }

        await syncEngine.approvePermission(session.id, requestId);
        await ctx.answerCallback("Approved!");

        // Update the notification message
        await ctx.editMessage("Permission approved.", new InlineKeyboard());
        break;
      }

      case ACTIONS.DENY: {
        const session = await getSessionOrAnswer(
          ctx,
          syncEngine,
          sessionPrefix,
          { requireActive: true }
        );
        if (!session) {
          return;
        }

        const requestId = findRequestByPrefix(session, extra || "");
        if (!requestId) {
          await ctx.answerCallback("Request not found or already processed");
          return;
        }

        await syncEngine.denyPermission(session.id, requestId);
        await ctx.answerCallback("Denied");

        // Update the notification message
        await ctx.editMessage("Permission denied.", new InlineKeyboard());
        break;
      }

      default:
        await ctx.answerCallback("Unknown action");
    }
  } catch (error) {
    if (ctx.errorLogger) {
      ctx.errorLogger.warn("[Callback] Error processing callback", {
        category: "telegram-callback",
        stack: error instanceof Error ? error.stack : null,
        context: { data, namespace: ctx.namespace },
      });
    } else {
      console.error("[Callback] Error:", error);
    }
    await ctx.answerCallback("An error occurred");
  }
}

/**
 * The pending request a button names. A button carries the whole request id
 * (#6606 round 9, F3); a pending id it equals is that request. A button sent
 * before that, or for an id it cannot carry whole (D1), carries the id's
 * first `SHORT_REQUEST_ID` characters, which name the one pending id that
 * starts with them, or none when several do. A carried id that is not
 * pending is read by the same prefix rule when it has `SHORT_REQUEST_ID`
 * characters or fewer, so a stale whole id that short can still name another
 * pending id that starts with it, as before this round (D2); a longer one
 * names nothing. There is no fallback to another request, so a stale tap
 * otherwise answers "not found" and resolves nothing (#6606, PM ruling
 * P2-a).
 */
function findRequestByPrefix(
  session: Session,
  prefix: string
): string | undefined {
  const requests = session.agentState?.requests;
  if (!requests || prefix.length === 0) return undefined;
  if (Object.hasOwn(requests, prefix)) return prefix;
  if (prefix.length > SHORT_REQUEST_ID) return undefined;
  const matches = Object.keys(requests).filter(reqId =>
    reqId.startsWith(prefix)
  );
  return matches.length === 1 ? matches[0] : undefined;
}
