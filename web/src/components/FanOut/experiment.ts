// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Fan-out experiment model (#4469 Task 1). Pure helpers, no React.
 *
 * An experiment IS the parent session: no experiment record is stored (#3818
 * Slice 2 persists only the parent link). The peers are the parent's `spawn`
 * children. The spawn route defaults EVERY parent-linked spawn to "spawn"
 * (`server/src/web/routes/machines.ts`), so a PM session's lanes show up here
 * too — the view lists them. Disconnect others archives the ranked set, or
 * with no parsed ranking the current selection (by default every live child),
 * minus the winner (useExperimentActions).
 *
 * `peersOf` takes the LOCAL session list only; peers on another federation
 * node are #4497's (its Slice B widens this to the merged list).
 */
import type { SessionSummary } from "@/types/api";
import { getSessionTitle } from "@/lib/sessionHelpers";
import { FAN_OUT_MAX } from "./useFanOutSpawn";

export type PeerStatus =
  | "running"
  | "finished"
  | "needs input"
  | "rate-limited"
  | "disconnected"
  | "failed";

export type ExperimentPeer = {
  id: string;
  name: string;
  flavor: string;
  model: string | null;
  branch: string | null;
  worktreePath: string | null;
  /** The peer runs on the parent's machine, so its worktree is readable there. */
  sameMachine: boolean;
  status: PeerStatus;
  session: SessionSummary;
};

/**
 * A peer has finished its turn: live, not thinking, its prompt delivered, and
 * not waiting on anyone (#4469 R1).
 *
 * `messageCount` is the session's USER-message count
 * (`sessions.user_message_count`, server/src/store/messages.ts), not every
 * message: a fan-out peer receives exactly one user message — the queued
 * prompt — so it stays at 1 after the peer replies. `>= 1` means the prompt
 * was delivered; with `!thinking` the peer has processed it.
 */
export function isFinished(s: SessionSummary): boolean {
  return (
    s.active &&
    !s.thinking &&
    (s.messageCount ?? 0) >= 1 &&
    s.pendingRequestsCount === 0 &&
    !s.isWaitingForUserQuestion &&
    !s.blockedOnTuiPrompt &&
    !s.rateLimited &&
    s.lifecycleState !== "spawning" &&
    s.lifecycleState !== "failed"
  );
}

export function peerStatus(s: SessionSummary): PeerStatus {
  if (s.lifecycleState === "failed") return "failed";
  if (!s.active) return "disconnected";
  if (s.rateLimited) return "rate-limited";
  if (
    s.blockedOnTuiPrompt ||
    s.isWaitingForUserQuestion ||
    s.pendingRequestsCount > 0
  ) {
    return "needs input";
  }
  return isFinished(s) ? "finished" : "running";
}

function toPeer(
  s: SessionSummary,
  parentMachineId: string | undefined
): ExperimentPeer {
  const machineId = s.metadata?.machineId;
  return {
    id: s.id,
    name: getSessionTitle(s),
    flavor: s.metadata?.flavor ?? "claude",
    model: s.resolvedModel ?? s.modelMode ?? null,
    branch: s.metadata?.worktree?.branch ?? null,
    worktreePath: s.metadata?.path ?? null,
    sameMachine:
      machineId !== undefined &&
      parentMachineId !== undefined &&
      machineId === parentMachineId,
    status: peerStatus(s),
    session: s,
  };
}

/** `s` is one of `parentId`'s `spawn` children — the one rule for a peer. */
export function isSpawnChildOf(parentId: string, s: SessionSummary): boolean {
  return s.parentSessionId === parentId && s.parentRelationship === "spawn";
}

/**
 * The parent's `spawn` children, oldest first. `parent` may be absent from
 * `sessions` (the header passes its own session); its machine is read from it.
 */
export function peersOf(
  parent: Pick<SessionSummary, "id"> & {
    metadata?: { machineId?: string } | null;
  },
  sessions: readonly SessionSummary[]
): ExperimentPeer[] {
  const parentMachineId = parent.metadata?.machineId;
  return sessions
    .filter(s => isSpawnChildOf(parent.id, s))
    .slice()
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    .map(s => toPeer(s, parentMachineId));
}

/** The peers a review covers by default: every peer that can still answer. */
export function selectForReview(peers: readonly ExperimentPeer[]): string[] {
  return peers
    .filter(p => p.status !== "disconnected" && p.status !== "failed")
    .map(p => p.id);
}

/** True only for a non-empty list in which every peer is finished. */
export function allFinished(peers: readonly ExperimentPeer[]): boolean {
  return peers.length > 0 && peers.every(p => p.status === "finished");
}

export type ReviewReadiness =
  | { ok: true }
  | { ok: false; reason: "empty" | "too-many" | "unfinished"; text: string };

/**
 * Whether Review peers may run over `selected`. More than FAN_OUT_MAX peers
 * cannot fit one prompt (a parent can hold more `spawn` children than one
 * fan-out made).
 */
export function reviewReadiness(
  selected: readonly ExperimentPeer[]
): ReviewReadiness {
  if (selected.length === 0) {
    return { ok: false, reason: "empty", text: "select at least 1 peer" };
  }
  if (selected.length > FAN_OUT_MAX) {
    return {
      ok: false,
      reason: "too-many",
      text: `select at most ${FAN_OUT_MAX} peers`,
    };
  }
  if (!allFinished(selected)) {
    return {
      ok: false,
      reason: "unfinished",
      text: "waiting for every selected peer to finish",
    };
  }
  return { ok: true };
}
