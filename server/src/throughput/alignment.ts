// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Match transcript segments to `turns` rows (issue #6164, A1 — R1).
 *
 * One-to-one and in order:
 *
 *  1. Every row whose `prompt_msg_uuid` names a segment claims it FIRST, across
 *     the whole transcript. The finalize parser attributes the LAST segment to
 *     the finalizing turn (`parseTurn`, transcriptParser.ts), so a turn that
 *     replaced an open turn can own a segment that began long before its own
 *     start; claiming by uuid first keeps such a segment from also being
 *     handed to the replaced (orphaned) row — no double count.
 *  2. A row with no uuid claim takes the unclaimed segment whose prompt is
 *     nearest its start, within ±{@link TIME_WINDOW_MS}, and strictly before
 *     the next row's start minus {@link NEXT_ROW_GUARD_MS} (the #2248 bound:
 *     a later turn's prompt never goes to an earlier row). Measured on SL7
 *     (152 turns): the prompt is written p10 −1.3 s / p50 −0.4 s / p99 +2.2 s
 *     from `started_at_ms`.
 *  3. Two candidates whose distances differ by less than
 *     {@link AMBIGUITY_MS} make the row `unaligned`; so does any match that
 *     would break segment order.
 *
 * Never the REPAIR tool's positional `sorted[i] ↔ results[i]` pairing
 * (`backfillTurns.ts`), which misaligns as soon as one row lacks a segment.
 */

export const TIME_WINDOW_MS = 120_000;
export const NEXT_ROW_GUARD_MS = 3_000;
export const AMBIGUITY_MS = 1_000;
/** The prompt is typically written ~0.4 s before the turn opens. */
const PROMPT_LEAD_MS = 400;

export interface AlignRow {
  id: string;
  promptMsgUuid: string | null;
  startedAtMs: number;
}

export interface AlignSegment {
  index: number;
  promptUuid: string | null;
  promptTs: number | null;
}

export type Alignment =
  | { status: "aligned"; segmentIndex: number; how: "uuid" | "time" }
  | { status: "unaligned" };

export function alignSegments(
  rows: readonly AlignRow[],
  segments: readonly AlignSegment[]
): Map<string, Alignment> {
  const out = new Map<string, Alignment>();
  const claimed = new Set<number>();
  const byUuid = new Map<string, AlignSegment>();
  for (const s of segments) {
    if (s.promptUuid && !byUuid.has(s.promptUuid)) byUuid.set(s.promptUuid, s);
  }

  // 1. uuid claims, across the whole transcript.
  for (const r of rows) {
    if (!r.promptMsgUuid) continue;
    const seg = byUuid.get(r.promptMsgUuid);
    if (seg && !claimed.has(seg.index)) {
      claimed.add(seg.index);
      out.set(r.id, {
        status: "aligned",
        segmentIndex: seg.index,
        how: "uuid",
      });
    }
  }

  // 2. time claims, rows in start order.
  const ordered = [...rows].sort(
    (a, b) => a.startedAtMs - b.startedAtMs || (a.id < b.id ? -1 : 1)
  );
  for (let i = 0; i < ordered.length; i += 1) {
    const r = ordered[i]!;
    if (out.has(r.id)) continue;
    const next = ordered.slice(i + 1).find(x => x.startedAtMs > r.startedAtMs);
    const upper = next ? next.startedAtMs - NEXT_ROW_GUARD_MS : Infinity;
    const target = r.startedAtMs - PROMPT_LEAD_MS;
    const candidates = segments
      .filter(
        s =>
          !claimed.has(s.index) &&
          s.promptTs !== null &&
          Math.abs(s.promptTs - r.startedAtMs) <= TIME_WINDOW_MS &&
          s.promptTs < upper
      )
      .map(s => ({ s, d: Math.abs((s.promptTs as number) - target) }))
      .sort((a, b) => a.d - b.d);
    if (candidates.length === 0) {
      out.set(r.id, { status: "unaligned" });
      continue;
    }
    if (
      candidates.length > 1 &&
      candidates[1]!.d - candidates[0]!.d < AMBIGUITY_MS
    ) {
      out.set(r.id, { status: "unaligned" });
      continue;
    }
    const seg = candidates[0]!.s;
    claimed.add(seg.index);
    out.set(r.id, { status: "aligned", segmentIndex: seg.index, how: "time" });
  }

  // 3. order check: a time match that runs backwards against a neighbour
  //    is not trusted (uuid matches are authoritative and stay).
  let lastIndex = -1;
  for (const r of ordered) {
    const a = out.get(r.id);
    if (!a || a.status !== "aligned") continue;
    if (a.segmentIndex <= lastIndex && a.how === "time") {
      out.set(r.id, { status: "unaligned" });
      continue;
    }
    if (a.how === "time") lastIndex = a.segmentIndex;
  }
  for (const r of rows) {
    if (!out.has(r.id)) out.set(r.id, { status: "unaligned" });
  }
  return out;
}
