// SPDX-License-Identifier: AGPL-3.0-only
import {
  parsePinUpsert,
  type PinContent,
  type SyncEvent,
} from "@hapi/protocol";

import { Store } from "../store";
import {
  RecordVetoError,
  type SendMessageResult,
} from "../sync/messageService";
import { PinService } from "../sync/pinService";
import { PinTurnCheck } from "../sync/pinTurnCheck";
import type { MessageOrigin } from "../sync/sentFrom";
import type { Session, SyncEngine } from "../sync/syncEngine";

/** A pin as a session posts it: the request body, with the key in the URL. */
export function pinBody(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    kind: "decision",
    title: "Go?",
    plainText: "Go? A yes, B no.",
    stakes: "reversible",
    risk: "low",
    blocking: false,
    options: [{ id: "A", label: "Yes" }],
    ...overrides,
  };
}

export function pinContent(
  key: string,
  overrides: Record<string, unknown> = {}
): PinContent {
  const parsed = parsePinUpsert(key, pinBody(overrides));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.content;
}

/**
 * The pin routes' view of a node: a real `Store` and `PinService` behind only the
 * engine lookups the routes make, so each route test exercises real SQL and the
 * real events. Sessions are added by namespace, because the cross-namespace rules
 * are what these tests prove.
 */
export function makePinWorld(dbPath = ":memory:") {
  const store = new Store(dbPath);
  const events: SyncEvent[] = [];
  const pins = new PinService(
    store.pins,
    { emit: event => events.push(event) },
    id => store.messages.getMaxSeq(id)
  );
  const sessions: Session[] = [];
  const addSession = (tag: string, namespace: string): Session => {
    const row = store.sessions.getOrCreateSession(
      tag,
      { path: "/tmp" },
      null,
      namespace
    );
    const session = {
      id: row.id,
      tag,
      namespace,
      metadata: null,
    } as unknown as Session;
    sessions.push(session);
    return session;
  };
  const engine = {
    pins,
    // #6455: the real turn check over this world's store.
    pinTurns: new PinTurnCheck({
      pins,
      getRecentMessages: (sid, options) =>
        store.messages.getRecentMessagesBounded(sid, options),
    }),
    getSession: (id: string) => sessions.find(s => s.id === id),
    getSessionByNamespace: (id: string, namespace: string) =>
      sessions.find(s => s.id === id && s.namespace === namespace),
    getSessionByTagAndNamespace: (tag: string, namespace: string) =>
      sessions.find(s => s.tag === tag && s.namespace === namespace),
    getSessionsByNamespace: (namespace: string) =>
      sessions.filter(s => s.namespace === namespace),
    // #6454: the engine's two turn-store readers, over this world's store.
    getSessionWorkflowBadge: (id: string) => {
      const issue = sessions.find(s => s.id === id)?.linkedIssue;
      return issue ? store.turns.getWorkflowBadge(id, issue.number) : null;
    },
    getSessionTotals: (id: string) => store.turns.getSessionTotals(id),
    hasMessageLocalId: (id: string, localId: string) =>
      store.messages.hasLocalId(id, localId),
  } as unknown as SyncEngine;
  return { store, events, pins, engine, addSession };
}

export type PinWorld = ReturnType<typeof makePinWorld>;

/** A Project Manager dashboard pin with these lanes (#6454). */
export function dashboardContent(
  key: string,
  lanes: unknown[],
  overrides: Record<string, unknown> = {}
): PinContent {
  return pinContent(key, {
    kind: "dashboard",
    options: undefined,
    lanes,
    ...overrides,
  });
}

/** Make `engine.pins` throw on `method`, for the error-mapping tests. */
export function breakPins(world: PinWorld, method: string, error: Error): void {
  (world.pins as unknown as Record<string, unknown>)[method] = () => {
    throw error;
  };
}

/** An error shaped like a lost SQLite write lock. */
export function sqliteBusy(): Error {
  return Object.assign(new Error("database is locked"), {
    code: "SQLITE_BUSY",
  });
}

export type SentMessage = {
  sessionId: string;
  text: string;
  localId?: string | null;
  origin?: MessageOrigin;
  /** #6452: `pin-deadline` for an automatic pick, else the operator's `webapp`. */
  sentFrom?: string;
};

/**
 * Give the world's engine a `sendMessage` that persists through the real message
 * store, so `localId` de-duplication is the store's own (#6450). `deny` makes the
 * next sends answer as a gate-class message hook would.
 */
export function attachSendMessage(world: PinWorld): {
  sent: SentMessage[];
  deny: (result: SendMessageResult | null) => void;
} {
  const sent: SentMessage[] = [];
  let denial: SendMessageResult | null = null;
  const sendMessage = async (
    sessionId: string,
    payload: Omit<SentMessage, "sessionId"> & { record?: () => boolean }
  ): Promise<SendMessageResult> => {
    const { record, ...shown } = payload;
    sent.push({ sessionId, ...shown });
    if (denial) return denial;
    const insert = () =>
      world.store.messages.addMessage(
        sessionId,
        {
          role: "user",
          content: { type: "text", text: payload.text },
          ...(payload.sentFrom ? { meta: { sentFrom: payload.sentFrom } } : {}),
        },
        payload.localId ?? undefined
      );
    // #6452: the record step and the insert in one transaction, as
    // MessageService.persistWithRecord does, including its #6453 replay rule:
    // a stored `localId` means the record step does not run again.
    let replayed = false;
    const msg = record
      ? world.store
          .getRawDb()
          .transaction(() => {
            const localId = payload.localId ?? undefined;
            replayed =
              localId !== undefined &&
              world.store.messages.hasLocalId(sessionId, localId);
            if (!replayed && !record()) throw new RecordVetoError();
            return insert();
          })
          .immediate()
      : insert();
    return {
      delivered: true,
      message: {
        id: msg.id,
        seq: msg.seq,
        createdAt: msg.createdAt,
        localId: msg.localId,
      },
      ...(replayed ? { replayed: true as const } : {}),
    };
  };
  (world.engine as unknown as { sendMessage: typeof sendMessage }).sendMessage =
    sendMessage;
  return { sent, deny: result => (denial = result) };
}

/** Mark a world's session live, as a Submit requires. */
export function activate(session: Session): Session {
  (session as { active: boolean }).active = true;
  return session;
}
