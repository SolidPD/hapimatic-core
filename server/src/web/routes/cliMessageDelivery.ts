// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";
import type { Store } from "../../store";
import type { SyncEngine } from "../../sync/syncEngine";
import { getCliConnectFloor } from "../../socket/handlers/cli/cliConnectFloors";

/**
 * #4682: how a session wrapper takes delivery of its user messages. The
 * contract is documented in docs/internal/architecture/sync.md, section
 * "Reconnect Message Backfill".
 */

/** Query of `GET /cli/sessions/:id/messages`, the wrapper's backfill read. */
export const getMessagesQuerySchema = z.object({
  afterSeq: z.coerce.number().int().min(0),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  // #4682 (R15): sent by a wrapper that keeps its own delivery floor, so the
  // server serves `afterSeq` exactly instead of applying the first-connect
  // floor below.
  exactCursor: z.coerce.number().int().min(0).max(1).optional(),
});

/**
 * The `POST /cli/sessions` body: the session plus the wrapper's delivery
 * floor. Every web or server send stored after this call gets a higher seq
 * (they append at `MAX(seq)+1`). Only a late CLI write (#952) is inserted
 * mid-stream: it can land at or below the floor, which is harmless because it
 * is wrapper-authored, or push a pre-attach row above it (residual KR1).
 * `getMaxSeq` is one index seek, read as its own statement and never inside a
 * transaction with `getOrCreateSession` (the deferred read-then-write #3631
 * pattern).
 */
export function sessionCreateResponse<S extends { id: string }>(
  engine: Pick<SyncEngine, "getMaxSeq">,
  session: S
): { session: S; deliveryFloorSeq: number } {
  return { session, deliveryFloorSeq: engine.getMaxSeq(session.id) };
}

/**
 * The seq a backfill read starts after. A wrapper that started before #4682
 * has no cursor until it receives a live message, and after a server restart
 * it asks for `afterSeq=0`, which would replay the session's whole user
 * history as new input. Such a request (no `exactCursor=1`; a current wrapper
 * that got no floor from an older server omits it too) is served from the
 * floor recorded at the session's first `/cli` connection or re-attach in this
 * server process. A non-zero cursor is always served as asked, so a
 * reconnecting wrapper still receives what it missed.
 */
export function backfillAfterSeq(
  store: Store | undefined,
  sessionId: string,
  query: z.infer<typeof getMessagesQuerySchema>
): number {
  if (query.afterSeq !== 0 || query.exactCursor === 1 || !store) {
    return query.afterSeq;
  }
  return getCliConnectFloor(store, sessionId) ?? 0;
}
