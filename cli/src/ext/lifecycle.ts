// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Session lifecycle emitter for the CLI extension system (issue #1268).
 *
 * Deliberately a LEAF module: it depends only on `node:events` and the logger.
 * The emit sites (`@/agent/sessionBase`, `@/agent/runnerLifecycle`) are core
 * session code imported by nearly every session-touching module and test, so
 * they must NOT reach the heavy `@/ext/host` — that pulls in
 * `@/commands/registry`, which eagerly loads all 16 command modules and their
 * dependency trees (daemon control client, auth UI, tmux launchers, session
 * persistence, …). Routing the fire sites through this leaf keeps core session
 * code independent of the command dispatch table.
 *
 * `@/ext/host` re-exports this surface, so extension authors still see a single
 * `@/ext/host` entry point.
 *
 * Handler semantics:
 * - Invoked in subscription order; async handlers are NOT awaited (an extension
 *   owns its own async lifetime).
 * - A handler that throws — or returns a rejected promise — is contained and
 *   logged; it never aborts the emit loop or the session it was reporting on.
 */
import { EventEmitter } from "node:events";
import type { Session } from "@hapi/protocol";
import { logger } from "@/ui/logger";

/**
 * Handler shape for both lifecycle hooks, matching A's `CliExtensionHost`
 * exactly. The payload is the shared `Session` record — NOT a CLI-local event
 * type — because A shipped `(session: Session) => void | Promise<void>`.
 */
export type SessionLifecycleHandler = (
  session: Session
) => void | Promise<void>;

const EVT_SESSION_START = "session:start";
const EVT_SESSION_END = "session:end";

const emitter = new EventEmitter();
// Node warns at 10 listeners per event. Several extensions each subscribing to
// both hooks reaches that legitimately; 50 is generous headroom that still
// leaves a genuine listener leak detectable.
emitter.setMaxListeners(50);

/**
 * Trace then emit. The single source of truth for the trace format — mirrors
 * the private {@link subscribe} helper below, so the two directions of the
 * emitter stay symmetric.
 *
 * The debug line records the listener count so an extension author debugging a
 * handler that "never fires" can tell the two cases apart: the event was not
 * emitted at all, versus it was emitted with nobody subscribed (the usual cause
 * — registering after the seam has already run).
 */
function fire(event: string, session: Session): void {
  logger.debug(
    `[ext.lifecycle] emit ${event} sid=${session.id} listeners=${emitter.listenerCount(event)}`
  );
  emitter.emit(event, session);
}

/** Emit session-start to every subscriber. Called by `@/agent/sessionBase`. */
export function fireSessionStart(session: Session): void {
  fire(EVT_SESSION_START, session);
}

/** Emit session-end to every subscriber. Called by `@/agent/runnerLifecycle`. */
export function fireSessionEnd(session: Session): void {
  fire(EVT_SESSION_END, session);
}

/**
 * Wrap `handler` so neither a synchronous throw nor a rejected promise can
 * escape into the emit loop, subscribe it, and return an unsubscribe closure.
 * The closure captures `wrapped` (not `handler`), so unsubscribing removes the
 * exact listener that was added — subscribing the same handler twice yields two
 * independent subscriptions, each individually revocable.
 */
function subscribe(
  event: string,
  handler: SessionLifecycleHandler
): () => void {
  const wrapped = (session: Session): void => {
    try {
      const result = handler(session);
      if (result instanceof Promise) {
        result.catch((error: unknown) => {
          logger.warn(`[ext.lifecycle] ${event} handler rejected:`, error);
        });
      }
    } catch (error) {
      logger.warn(`[ext.lifecycle] ${event} handler threw:`, error);
    }
  };

  emitter.on(event, wrapped);
  return () => {
    emitter.off(event, wrapped);
  };
}

/** Subscribe to session-start. Returns an unsubscribe function. */
export function subscribeSessionStart(
  handler: SessionLifecycleHandler
): () => void {
  return subscribe(EVT_SESSION_START, handler);
}

/** Subscribe to session-end. Returns an unsubscribe function. */
export function subscribeSessionEnd(
  handler: SessionLifecycleHandler
): () => void {
  return subscribe(EVT_SESSION_END, handler);
}
