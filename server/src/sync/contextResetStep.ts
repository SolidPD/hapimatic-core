// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The context-reset wiring (issue #6559, Task 10): the finalize step and the
 * small adapters `server/src/index.ts` uses to give the context-reset service
 * (`server/src/contextReset/service.ts`) its ports. Each adapter is pure or
 * takes its dependency as an argument, so it is tested here without a hub.
 *
 *   - `createContextResetStep`: a SYNCHRONOUS finalize step that only hands the
 *     RAW socket outcome and the turn's parsed label events to the service and
 *     returns `{}` (item 1). It runs after `parseStep` and
 *     `backgroundAgentSeedStep` (it reads the label events from their in-memory
 *     enrichment) and before `successorHandoffStep` (`turnLifecycle.ts`).
 *   - `contextResetTurnEvent`: the `context_reset` turn event Task 12 writes on
 *     the arming turn's row (item 6).
 *   - `adaptEngineSend`: the service's `sendMessage` port over the engine's, so
 *     the resume message goes `syncEngine.sendMessage → messageService.sendMessage`
 *     and never through the server-side queue (item 7; R13).
 *   - `listUserRoleMessages`: every stored user-role message of a session,
 *     oldest first, paged, for the carried messages (R10).
 *   - `activeClaimsOf`: a session's live file claims as `repo:path`.
 */

import type {
  ContextResetEvent,
  ContextResetLabelEvent,
  ContextResetSendPayload,
  ContextResetSendResult,
} from "../contextReset";
import type { StoredMessageLike } from "../contextReset/render";
import type { FinalizeTurnInput, TurnEventInput } from "../store/turns/types";
import type { StoredFileClaim, StoredMessage } from "../store/types";
import type { FinalizeStep } from "./turnLifecycle";
import type { SendMessageResult } from "./messageService";

/** What the step calls on the service. */
export interface ContextResetFinalizeTarget {
  onTurnFinalize(
    sessionId: string,
    seq: number,
    outcome: string,
    labelEvents: readonly ContextResetLabelEvent[] | null
  ): void;
}

/**
 * The turn's label events from the enrichment accumulated before the step, or
 * `null` when the turn was not parsed (no `events` at all): the service then
 * reads the lock as unknown and defers (ruling Q5a).
 */
export function labelEventsFromEnrichment(
  accumulated: Readonly<Partial<FinalizeTurnInput>> | undefined
): ContextResetLabelEvent[] | null {
  const events = accumulated?.events;
  if (!Array.isArray(events)) return null;
  const out: ContextResetLabelEvent[] = [];
  for (const ev of events) {
    if (ev.kind !== "label_added" && ev.kind !== "label_removed") continue;
    out.push({
      kind: ev.kind,
      name: ev.name ?? null,
      payload: ev.payload ?? null,
    });
  }
  return out;
}

/**
 * Item 1. Always the RAW `event.outcome` (`completed` / `interrupted`): the
 * finalize may upgrade `completed` to `errored` from the parse, which says
 * nothing about whether the operator stopped the turn. Returns `{}`.
 */
export function createContextResetStep(
  getTarget: () => ContextResetFinalizeTarget | null
): FinalizeStep {
  return (ctx, accumulated) => {
    const target = getTarget();
    if (!target) return {};
    target.onTurnFinalize(
      ctx.hapiSessionId,
      ctx.seq,
      ctx.event.outcome,
      labelEventsFromEnrichment(accumulated)
    );
    return {};
  };
}

/** Item 6 / Task 12: the turn event for one service event. */
export function contextResetTurnEvent(
  event: ContextResetEvent,
  tsMs: number
): TurnEventInput {
  return {
    tsMs,
    kind: "context_reset",
    name: event.outcome,
    payload: {
      armId: event.armId,
      trigger: event.trigger,
      outcome: event.outcome,
      reason: event.reason,
      fromStage: event.fromStage,
      toStage: event.toStage,
      issue: event.issue,
      contextBefore: event.contextBefore,
      newConversationId: event.newConversationId,
    },
  };
}

/** The engine's `sendMessage`, narrowed to what the adapter passes. */
export type EngineSend = (
  sessionId: string,
  payload: {
    text: string;
    localId: string;
    sentFrom: ContextResetSendPayload["sentFrom"];
    contextReset?: { armId: string };
    record: () => boolean;
  }
) => Promise<SendMessageResult>;

/**
 * Item 7. The service's send port over `syncEngine.sendMessage`, which calls
 * `messageService.sendMessage` directly: the message is persisted and emitted to
 * the wrapper at once, so the queue drain's hold on a `firing` row never holds
 * the service's own message (R13; build 3's reading, tested here). A hook
 * denial is `delivered: false` with its reason; a replayed delivery id is
 * `delivered: true, replayed: true`. A `RecordVetoError` propagates.
 */
export function adaptEngineSend(send: EngineSend) {
  return async (
    sessionId: string,
    payload: ContextResetSendPayload
  ): Promise<ContextResetSendResult> => {
    const result = await send(sessionId, {
      text: payload.text,
      localId: payload.localId,
      sentFrom: payload.sentFrom,
      ...(payload.contextReset
        ? { contextReset: { armId: payload.contextReset.armId } }
        : {}),
      record: payload.record,
    });
    if (result.delivered === false) {
      return { delivered: false, reason: result.reason };
    }
    return result.replayed
      ? { delivered: true, replayed: true }
      : { delivered: true };
  };
}

/**
 * The page size {@link listUserRoleMessages} asks for: the store's own
 * maximum, since `getMessagesAfter` answers at most 200 rows per call
 * (`server/src/store/messages.ts`).
 */
export const MESSAGE_PAGE_SIZE = 200;

/**
 * R10: the session's user-role messages, oldest first, read in pages so only
 * user-role rows are held (assistant and tool rows can be large). The renderer
 * filters them further by `sentFrom`. The read ends only on an empty page or a
 * cursor that stops advancing, never on a short page, because the store may
 * answer fewer rows than were asked for (#6559 PR 1 round 2, IR1).
 */
export function listUserRoleMessages(
  getMessagesAfter: (
    sessionId: string,
    afterSeq: number,
    limit: number
  ) => StoredMessage[],
  sessionId: string
): StoredMessageLike[] {
  const out: StoredMessageLike[] = [];
  let afterSeq = 0;
  for (;;) {
    const page = getMessagesAfter(sessionId, afterSeq, MESSAGE_PAGE_SIZE);
    const before = afterSeq;
    for (const msg of page) {
      const content = msg.content;
      if (
        content &&
        typeof content === "object" &&
        (content as Record<string, unknown>).role === "user"
      ) {
        out.push({ content });
      }
      if (msg.seq > afterSeq) afterSeq = msg.seq;
    }
    // A page that did not advance the cursor would loop forever.
    if (page.length === 0 || afterSeq === before) return out;
  }
}

/** The session's live claims as `repo:path`, in claim order. */
export function activeClaimsOf(claims: readonly StoredFileClaim[]): string[] {
  return claims
    .filter(c => c.releasedAt === null)
    .map(c => `${c.repo}:${c.path}`);
}
