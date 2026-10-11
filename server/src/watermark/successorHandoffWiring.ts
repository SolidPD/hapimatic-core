// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Wiring glue for the context-watermark successor handoff (issue #2158). Assembles
 * the injectable `SuccessorHandoffDeps` from the live `SyncEngine` + `Store` +
 * `ContextWatermarkService`, so `server/src/index.ts` wires the finalize step in a
 * single call (mirroring how `createPmReconcileStep(store.pmRoster, errorLogger)`
 * is a one-liner). The real handoff logic lives in `successorHandoffStep.ts`
 * (unit-tested with fakes); this file is thin, side-effect-free glue.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { HandoffPendingGate, Session } from "@hapi/protocol";
import { renderHandoffMessage } from "@hapi/protocol";

import type { SyncEngine } from "../sync/syncEngine";
import type { Store } from "../store";
import type { ErrorLogger } from "../logging/errorLogger";
import type { ContextWatermarkService } from "./contextWatermarkService";
import type { SuccessorHandoffDeps } from "../sync/successorHandoffStep";

export function buildSuccessorHandoffDeps(args: {
  syncEngine: SyncEngine;
  store: Store;
  service: ContextWatermarkService;
  /** Live spawn-cap for the capacity pre-check (the daemon owns the real clamp). */
  getMaxConcurrent: () => number;
  errorLogger?: ErrorLogger | null;
  now?: () => number;
}): SuccessorHandoffDeps {
  const { syncEngine, store, service, getMaxConcurrent } = args;
  const errorLogger = args.errorLogger ?? null;
  const now = args.now ?? Date.now;

  /**
   * Explicit open-transaction marker (never inferred): a non-`complete`
   * `pm_spawn_roster` row referencing this session — either as the PM
   * (`pm_session_id === session.tag`) or as the spawned peer
   * (`hapi_session_id === session.id`). On any lookup failure, FAIL SAFE by
   * reporting OPEN so the handoff defers rather than firing on uncertainty.
   */
  const hasOpenTransaction = (sessionId: string): boolean => {
    try {
      const session = syncEngine.getSession(sessionId);
      const tag = session?.tag ?? null;
      return store.pmRoster
        .getReconcilable()
        .some(
          r =>
            (tag != null && r.pmSessionId === tag) ||
            r.hapiSessionId === sessionId
        );
    } catch {
      return true;
    }
  };

  return {
    service,
    getSession: sessionId => syncEngine.getSession(sessionId),
    hasOpenTransaction,
    getActiveSessionCount: () => syncEngine.getActiveSessions().length,
    getMaxConcurrent,

    spawnSuccessor: async (predecessor: Session) => {
      const cwd = predecessor.metadata?.path;
      const machineId = predecessor.metadata?.machineId;
      if (!cwd || !machineId) {
        throw new Error(
          `predecessor ${predecessor.id} lacks metadata.path/machineId — cannot spawn successor`
        );
      }
      const baseName = predecessor.metadata?.name ?? "session";
      // Spawn as a SIMPLE session in the predecessor's own cwd (same machine,
      // same directory) — mirrors the sessionRespawn fork path, so the successor
      // sees the handoff packet on disk and shares the initiative worktree. The
      // successor inherits the predecessor's role (pm) and account binding.
      const result = await syncEngine.spawnSession({
        machineId,
        directory: cwd,
        sessionType: "simple",
        name: `${baseName}-successor`,
        parentSessionId: predecessor.id,
        accountUuid: predecessor.metadata?.accountUuid,
        // Issue #4568 (R6): a successor of an API-key session bills the same key.
        apiKeyId: predecessor.metadata?.apiKeyId,
        apiKeyMasked: predecessor.metadata?.apiKeyMasked,
        sessionRole: predecessor.metadata?.sessionRole,
        awaitWebhook: true, // "spawned" means "actually alive" — needed by confirm
      });
      if (result.type === "error") {
        throw new Error(`successor spawn failed: ${result.message}`);
      }
      return result.sessionId;
    },

    deliverPacket: async (successorId, packet) => {
      await syncEngine.sendMessage(successorId, {
        text: renderHandoffMessage(packet),
        // #3124: programmatic successor-handoff packet (was mislabeled "webapp").
        sentFrom: "handoff",
      });
    },

    confirmSuccessor: async successorId => {
      // Concrete server-side confirmation: the successor spawned (awaitWebhook)
      // and is present + active. The successor-SIDE packet-consumption ack is the
      // rp1-home `project-manager-role` companion's responsibility (Task 10).
      const s = syncEngine.getSession(successorId);
      return !!s && s.active;
    },

    roster: {
      resolveInitiative: sessionId => {
        const ids = store.initiatives.initiativesForSession(sessionId);
        if (ids.length === 0) return null;
        const id = ids[0];
        const init = store.initiatives.get(id);
        return { id, phase: init?.phase ?? null };
      },
      detachSession: (initiativeId, sessionId) =>
        store.initiatives.detachSession(initiativeId, sessionId),
      attachSession: (initiativeId, sessionId) =>
        store.initiatives.attachSession(initiativeId, sessionId),
      appendEvent: (initiativeId, kind, payload) =>
        store.initiatives.appendEvent(initiativeId, kind, payload),
    },

    reapPredecessor: async sessionId => {
      await syncEngine.archiveSession(sessionId);
    },
    reapSuccessor: async sessionId => {
      await syncEngine.deleteSession(sessionId);
    },
    reapBoundaryClear: sessionId => {
      const s = syncEngine.getSession(sessionId);
      // Re-check quiescence at reap time: predecessor present, not thinking (no
      // new turn opened since fire), and no open transaction.
      return !!s && !s.thinking && !hasOpenTransaction(sessionId);
    },

    persistPacket: (predecessor, packet) => {
      const dir = predecessor.metadata?.path;
      if (!dir) {
        throw new Error(
          `predecessor ${predecessor.id} lacks metadata.path — cannot persist packet`
        );
      }
      const claudedocs = join(dir, "claudedocs");
      mkdirSync(claudedocs, { recursive: true });
      const path = join(claudedocs, `.handoff-packet-${predecessor.id}.json`);
      writeFileSync(path, JSON.stringify(packet, null, 2), "utf-8");
      return path;
    },

    derivePendingGates: predecessor => {
      const li = predecessor.linkedIssue;
      if (!li) return [];
      const gate: HandoffPendingGate = {
        kind: "linked_issue",
        ref: `${li.repo}#${li.number}`,
      };
      if (li.state) gate.note = li.state;
      return [gate];
    },

    now,
    errorLogger,
  };
}
