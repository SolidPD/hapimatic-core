// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Module-level tracker for the highest-seen message sequence number per session.
 * Used by useSSE to record incoming message seqs, and by the SSE reconnect
 * handler to determine which messages need backfilling after a connection gap.
 */
const seqMap = new Map<string, number>();

export function getLastSeenSeq(sessionId: string): number | null {
  return seqMap.get(sessionId) ?? null;
}

export function updateLastSeenSeq(sessionId: string, seq: number): void {
  const current = seqMap.get(sessionId);
  if (current === undefined || seq > current) {
    seqMap.set(sessionId, seq);
  }
}

export function clearSeqTracker(): void {
  seqMap.clear();
}
