// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import type { DecryptedMessage } from "@hapi/protocol/types";
import type { SpendLimitVariant } from "@hapi/protocol/apiErrorClasses";
import type {
  GateDenialOutcome,
  HookCoverageRecord,
  Metadata,
} from "@hapi/protocol";
import {
  resolveDenialOutcome,
  tryResolveHarnessManifest,
} from "@hapi/protocol";
import type { Server } from "socket.io";
import type { Store } from "../store";
import { EventPublisher } from "./eventPublisher";
import type { MessageOrigin, SentFrom } from "./sentFrom";
import {
  getRegisteredMessageHooks,
  messageHooksEnabled,
  runMessageHooks,
} from "./messageHooks";

/**
 * Result of {@link MessageService.sendMessage} (#3124). A gate-class message hook
 * can DENY delivery — surfaced as a TYPED result, NEVER a thrown error (a throw
 * is caught by the #1362 queue-drain send-failure paths and re-enqueued forever)
 * and NEVER a silent drop. With the hook stage OFF, delivery always returns
 * `{delivered: true}` and behavior is byte-identical to pre-#3124 (R6).
 */
export type SendMessageResult =
  | {
      delivered: true;
      // #2357: persisted-message metadata surfaced on the accepted arm so the
      // POST /sessions/:id/messages route can return {id,seq} to the caller.
      // Purely additive — the {delivered:false} arm and all four
      // `.delivered === false` narrowings (routes/messages.ts,
      // routes/federation/sessionData.ts, sync/queueDrainObserver.ts,
      // syncEngine.ts#drainQueueHead) are untouched.
      message: {
        id: string;
        seq: number;
        createdAt: number;
        localId: string | null;
      };
    }
  | {
      delivered: false;
      reason: string;
      hookId: string;
      // #3579: the server-resolved, ready-to-render outcome (Key Decision:
      // resolve server-side; the web stays thin, ISO→locale is the only
      // client-side formatting). Rides the {ok:false, denied} response body.
      outcome: GateDenialOutcome;
      // #3579: the copy-template params the hook attached (forwarded so a client
      // could re-render, though it consumes the pre-resolved `outcome`).
      params?: Record<string, string | number>;
    };

/**
 * Dependencies the #3124 message-hook stage needs from the engine. Injected
 * optionally so tests (and any construction that predates the stage) work
 * without it; when absent, the stage is skipped and delivery is unchanged.
 */
export interface MessageHookDeps {
  /** Resolve a session's metadata (for `flavor` → manifest + `hookCoverage`). */
  getSessionMetadata: (sessionId: string) => Metadata | undefined;
  /** Optional breadcrumb logger for the manifest-fallback path (KD4). */
  log?: (message: string, context?: Record<string, unknown>) => void;
}

export class MessageService {
  constructor(
    private readonly store: Store,
    private readonly io: Server,
    private readonly publisher: EventPublisher,
    private readonly hookDeps?: MessageHookDeps
  ) {}

  getMessagesPage(
    sessionId: string,
    options: { limit: number; beforeSeq: number | null }
  ): {
    messages: DecryptedMessage[];
    page: {
      limit: number;
      beforeSeq: number | null;
      nextBeforeSeq: number | null;
      hasMore: boolean;
    };
  } {
    const stored = this.store.messages.getMessages(
      sessionId,
      options.limit,
      options.beforeSeq ?? undefined
    );
    const messages: DecryptedMessage[] = stored.map(message => ({
      id: message.id,
      seq: message.seq,
      localId: message.localId,
      content: message.content,
      createdAt: message.createdAt,
    }));

    let oldestSeq: number | null = null;
    for (const message of messages) {
      if (typeof message.seq !== "number") continue;
      if (oldestSeq === null || message.seq < oldestSeq) {
        oldestSeq = message.seq;
      }
    }

    const nextBeforeSeq = oldestSeq;
    const hasMore =
      nextBeforeSeq !== null &&
      this.store.messages.getMessages(sessionId, 1, nextBeforeSeq).length > 0;

    return {
      messages,
      page: {
        limit: options.limit,
        beforeSeq: options.beforeSeq,
        nextBeforeSeq,
        hasMore,
      },
    };
  }

  getMessagesAfter(
    sessionId: string,
    options: { afterSeq: number; limit: number }
  ): DecryptedMessage[] {
    const stored = this.store.messages.getMessagesAfter(
      sessionId,
      options.afterSeq,
      options.limit
    );
    return stored.map(message => ({
      id: message.id,
      seq: message.seq,
      localId: message.localId,
      content: message.content,
      createdAt: message.createdAt,
    }));
  }

  async sendMessage(
    sessionId: string,
    payload: {
      text: string;
      localId?: string | null;
      // Programmatic-sender signal (#1234) using the canonical sentFrom
      // taxonomy (#2205, `./sentFrom`). Stamped into content.meta.sentFrom so
      // the AutoRecoveryService R3 predicate can exclude ALL programmatic
      // senders (auto-recovery / watchdog / heartbeat), not just its own prompt.
      sentFrom?: SentFrom;
      // #3331: origin-class provenance (R2, ruling D6(a)) — a companion to
      // sentFrom carrying the channel class + uid/sessionId. Stamped into
      // content.meta.origin and forwarded to the message-hook stage so the
      // token gate can verify provenance + self-send.
      origin?: MessageOrigin;
    }
  ): Promise<SendMessageResult> {
    const sentFrom = payload.sentFrom ?? "webapp";
    const origin = payload.origin;

    // #3124: message-layer hook stage (epic #3117 Sub I). Runs UserPromptSubmit-
    // class hooks BEFORE persist so their injected context reaches the model this
    // turn. Opt-in + default-OFF (KD5): with the flag off — or no hookDeps, or an
    // empty registry — this block is skipped and delivery is byte-identical to
    // pre-#3124 (R6). Every hook is `Promise.race`d against its timeout inside
    // runMessageHooks, so this adds NO unbounded await to the delivery path (the
    // #962 desync class — OR1).
    let text = payload.text;
    if (messageHooksEnabled() && this.hookDeps) {
      const hooks = getRegisteredMessageHooks();
      if (hooks.length > 0) {
        const metadata = this.hookDeps.getSessionMetadata(sessionId);
        const flavor =
          typeof metadata?.flavor === "string" ? metadata.flavor : undefined;
        const harnessManifest = flavor
          ? tryResolveHarnessManifest(flavor)
          : undefined;
        const coverage = metadata?.hookCoverage as
          | HookCoverageRecord[]
          | undefined;
        const stage = await runMessageHooks({
          text,
          sessionId,
          sentFrom,
          origin,
          harnessManifest,
          coverage,
          hooks,
          log: this.hookDeps.log,
        });
        if (stage.denied) {
          const at = new Date().toISOString();
          // The resolver keys on `code ?? reason` — a runner failure (timeout /
          // error) carries a code-shaped `code`; a hook's own reason is
          // code-shaped itself (`nonce-mismatch`, `state-indeterminate: …`).
          const resolveKey = stage.denied.code ?? stage.denied.reason;
          const outcome = resolveDenialOutcome(
            stage.denied.hookId,
            resolveKey,
            stage.denied.params ?? {}
          );
          // R3: persist a DURABLE in-thread notice (survives reload, fans out to
          // every client via the normal stream). The denied user TEXT is never
          // persisted or delivered (R8) — only this agent+event record.
          this.persistGateNotice(sessionId, {
            hookId: stage.denied.hookId,
            code: resolveKey,
            params: stage.denied.params,
            at,
          });
          // R4: keep the transient #1348 prompt-blocked toast — a message-layer
          // gate IS a UserPromptSubmit-class block. `blockedReason` stays
          // byte-identical (grep-able hookId + reason); the catalogue title +
          // ISO instant ride the new OPTIONAL fields (client formats `at`, R6).
          this.publisher.emit({
            type: "prompt-blocked",
            sessionId,
            data: {
              hookEvent: "UserPromptSubmit",
              blockedReason:
                `Message blocked by hook "${stage.denied.hookId}": ${stage.denied.reason}`.slice(
                  0,
                  2000
                ),
              originalPrompt: payload.text.slice(0, 500),
              title: outcome.title,
              at,
            },
          });
          return {
            delivered: false,
            reason: stage.denied.reason,
            hookId: stage.denied.hookId,
            outcome,
            ...(stage.denied.params ? { params: stage.denied.params } : {}),
          };
        }
        // #3579: a NON-blocking notice (#3559 already-granted, #3563
        // grant-orphaned) — persist beside delivery; delivery still proceeds.
        if (stage.notice) {
          this.persistGateNotice(sessionId, {
            hookId: stage.notice.hookId,
            code: stage.notice.code,
            params: stage.notice.params,
          });
        }
        text = stage.text;
      }
    }

    const content = {
      role: "user",
      content: {
        type: "text",
        text,
      },
      meta: {
        sentFrom,
        // #3331: origin-class provenance (R2). Stamped alongside sentFrom; absent
        // when the sender supplied none (programmatic / drained sends).
        ...(origin ? { origin } : {}),
      },
    };

    const msg = this.store.messages.addMessage(
      sessionId,
      content,
      payload.localId ?? undefined
    );

    this.emitNewMessage(sessionId, msg);

    // #2357: surface the persisted-message metadata so the send route can report
    // {id,seq} plus a delivered-vs-queued signal. The message is already
    // persisted (addMessage above) and emitted on the /cli socket (emitNewMessage
    // above); this return carries only facts known at response time.
    return {
      delivered: true,
      message: {
        id: msg.id,
        seq: msg.seq,
        createdAt: msg.createdAt,
        localId: msg.localId,
      },
    };
  }

  /**
   * #3579: persist a durable gate NOTICE into the session stream — the R3 half.
   * Publicly callable from a NON-send call site (#3563 posts `grant-orphaned`
   * from a turn-lifecycle step; #3559 posts `already-granted`). The record is
   * the EXISTING agent+event envelope (the only server-authored non-user shape
   * the web normalizer round-trips) with `data.type:"gate-denied"` — which keeps
   * it OUT of the CLI enqueue (role:"user" only), the R8 property.
   */
  persistGateNotice(
    sessionId: string,
    opts: {
      hookId: string;
      code: string;
      params?: Record<string, string | number>;
      at?: string;
    }
  ): void {
    // Millisecond precision (3579-1): `data.at` is the block's ONLY byte-distinct
    // field, and web `dedupeAgentEvents` keys agent-event blocks on
    // JSON.stringify(content.data) — three identical `replayed` refusals in a row
    // would otherwise collapse into ONE notice.
    const at = opts.at ?? new Date().toISOString();
    const outcome = resolveDenialOutcome(
      opts.hookId,
      opts.code,
      opts.params ?? {}
    );
    const content = {
      role: "agent",
      content: {
        id: randomUUID(),
        type: "event",
        data: {
          type: "gate-denied",
          hookId: opts.hookId,
          reason: opts.code,
          outcome,
          at,
        },
      },
    };
    // localId MUST be UNSET (3579-5): reusing the send's localId lets
    // mergeMessages drop the "blocked" bubble, and the store returns the existing
    // (sessionId, localId) row instead of inserting — a queued-drain/retry would
    // then return this notice row as if the message were delivered.
    const msg = this.store.messages.addMessage(sessionId, content);
    this.emitNewMessage(sessionId, msg);
  }

  /**
   * #4936: persist the durable in-thread STOP notice for an API spend cap / a
   * user-set spend limit. Same agent+event envelope as `persistGateNotice` —
   * never a `role:"user"` record, so it is never enqueued to Claude and never
   * wakes or re-prompts the session. `keyLabel` is display-safe (a vault label
   * or a masked key, resolved by the caller from session metadata); `resumesAt`
   * is the epoch ms the API reported, or null.
   */
  persistSpendLimitNotice(
    sessionId: string,
    opts: {
      variant: SpendLimitVariant;
      keyLabel: string | null;
      resumesAt: number | null;
      requestId?: string;
      at?: string;
    }
  ): void {
    // Millisecond precision keeps consecutive notices byte-distinct for the web
    // dedupe (the #3579-1 rule); `localId` stays UNSET (#3579-5).
    const at = opts.at ?? new Date().toISOString();
    const content = {
      role: "agent",
      content: {
        id: randomUUID(),
        type: "event",
        data: {
          type: "spend-limit-reached",
          variant: opts.variant,
          keyLabel: opts.keyLabel,
          resumesAt: opts.resumesAt,
          ...(opts.requestId !== undefined
            ? { requestId: opts.requestId }
            : {}),
          at,
        },
      },
    };
    const msg = this.store.messages.addMessage(sessionId, content);
    this.emitNewMessage(sessionId, msg);
  }

  /**
   * Fan a newly-persisted record out to the CLI (`/cli` io `update`) and every
   * web client (`message-received` SyncEvent → useSSE cache upsert). Reload comes
   * free via getMessagesPage. Shared by sendMessage and persistGateNotice so the
   * two fan-out paths cannot drift.
   */
  private emitNewMessage(
    sessionId: string,
    msg: ReturnType<Store["messages"]["addMessage"]>
  ): void {
    const update = {
      id: msg.id,
      seq: Date.now(),
      createdAt: msg.createdAt,
      body: {
        t: "new-message" as const,
        sid: sessionId,
        message: {
          id: msg.id,
          seq: msg.seq,
          createdAt: msg.createdAt,
          localId: msg.localId,
          content: msg.content,
        },
      },
    };
    this.io.of("/cli").to(`session:${sessionId}`).emit("update", update);

    this.publisher.emit({
      type: "message-received",
      sessionId,
      message: {
        id: msg.id,
        seq: msg.seq,
        localId: msg.localId,
        content: msg.content,
        createdAt: msg.createdAt,
      },
    });
  }
}
