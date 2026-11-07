// SPDX-License-Identifier: AGPL-3.0-only
import type { WaitClass } from "@hapi/protocol";
import {
  expectationOf,
  type FactsTurnRow,
  type ThroughputFactsStore,
} from "../store/throughput/factsStore";
import { alignSegments, type Alignment } from "./alignment";
import { classifyOpening, type ServerProvenance } from "./provenance";
import {
  isPricedCall,
  openingEvidenceOf,
  readSegmentAgents,
  type SkillCall,
  type TranscriptSegment,
} from "./transcriptCalls";
import {
  computeTurnFacts,
  factsFingerprint,
  isIssueSkill,
  resolveIssueRef,
} from "./turnFacts";

/**
 * Facts for one Claude session's turns from its parsed transcript (issue
 * #6164, A1 — R1, R2, R4). Pure of writes: the `throughput-facts` loop stores
 * the results; the report CLI's `--facts=compute` keeps them in memory.
 *
 * Every row of the session takes part in the alignment (so a turn's segment
 * is never claimed by another), and facts are computed for `targets`.
 */

/**
 * How far AFTER a prompt's transcript time the server may have stamped the
 * message that opened it (the newest user message at or before that point).
 */
export const OPENING_SLACK_MS = 5_000;
/** How far back the opening message is searched without a previous turn. */
const OPENING_LOOKBACK_MS = 6 * 3_600_000;

export interface BackgroundLaunch {
  toolUseId: string;
  turnId: string;
  hapiSessionId: string;
  agentId: string | null;
  launchedAtMs: number;
}

export type SessionFactsResult =
  | {
      id: string;
      status: "facts";
      fp: string;
      json: string;
      launches: BackgroundLaunch[];
      bgFp: string | null;
    }
  | { id: string; status: "unaligned"; fp: string };

export type SessionFactsStore = Pick<
  ThroughputFactsStore,
  "sessionLinkedIssue" | "findOpeningMessage"
>;

/** The server-stamped provenance of the message that opened `seg`. */
export function serverProvenanceOf(
  facts: SessionFactsStore,
  row: FactsTurnRow,
  seg: TranscriptSegment,
  prevTs: number | null
): ServerProvenance | null {
  const at = (seg.promptTs ?? row.startedAtMs) + OPENING_SLACK_MS;
  const after = prevTs ?? at - OPENING_LOOKBACK_MS;
  const m = facts.findOpeningMessage(row.hapiSessionId, after, at);
  return m
    ? { sentFrom: m.sentFrom, originSessionId: m.originSessionId }
    : null;
}

/**
 * The last real API call before segment `index`, which starts its opening idle
 * gap. A segment with no real call (only a `<synthetic>` usage-limit error, a
 * local command, an interrupted prompt) never touched the cache, so the walk
 * goes past it rather than letting it hide a post-idle rewrite.
 */
export function lastCallBefore(
  segments: readonly TranscriptSegment[],
  index: number
): number | null {
  for (let i = index - 1; i >= 0; i -= 1) {
    const ts = segments[i]!.lastAssistantTs;
    if (ts !== null) return ts;
  }
  return null;
}

/**
 * The rows that hold their Hapimatic session's first real model call (its
 * starting context). Known only when the session began in this transcript:
 * its rows run from seq 1 with no gap up to that row. An earlier row with no
 * real call, or with no segment of its own (a replaced turn, whose calls sit
 * in the row that replaced it), is passed over, so a session that opened with
 * a usage-limit error starts at its first real call instead of dropping out.
 */
export function sessionStartRows(
  rows: readonly FactsTurnRow[],
  alignment: ReadonlyMap<string, Alignment>,
  segments: readonly TranscriptSegment[]
): Set<string> {
  const bySession = new Map<string, FactsTurnRow[]>();
  for (const r of rows) {
    const list = bySession.get(r.hapiSessionId);
    if (list) list.push(r);
    else bySession.set(r.hapiSessionId, [r]);
  }
  const out = new Set<string>();
  for (const list of bySession.values()) {
    const sorted = [...list].sort((a, b) => a.seq - b.seq);
    for (let i = 0; i < sorted.length; i += 1) {
      const row = sorted[i]!;
      if (row.seq !== i + 1) break; // began in another transcript, or a gap
      const a = alignment.get(row.id);
      if (!a || a.status !== "aligned") continue;
      const seg = segments[a.segmentIndex];
      if (seg?.calls.some(c => !c.sidechain && isPricedCall(c))) {
        out.add(row.id);
        break;
      }
    }
  }
  return out;
}

/** The latest `issue-*` skill call at or before each segment. */
export function latestIssueSkills(
  segments: readonly TranscriptSegment[]
): Array<SkillCall | null> {
  const out: Array<SkillCall | null> = [];
  let last: SkillCall | null = null;
  for (const seg of segments) {
    for (const s of seg.skills) if (isIssueSkill(s)) last = s;
    out.push(last);
  }
  return out;
}

/** Fingerprint of the background agent files as read (status + token sums). */
export function bgFingerprint(
  files: ReadonlyArray<{
    status: string;
    in: number;
    out: number;
    cr: number;
    w1: number;
    w5: number;
  }>
): string | null {
  if (files.length === 0) return null;
  return files
    .map(f => `${f.status}:${f.in}:${f.out}:${f.cr}:${f.w1}:${f.w5}`)
    .join("|");
}

export async function computeSessionFacts(input: {
  facts: SessionFactsStore;
  /** Every turn row of the Claude session (alignment context). */
  sessionRows: readonly FactsTurnRow[];
  /** The finalized rows to compute facts for. */
  targets: readonly FactsTurnRow[];
  segments: readonly TranscriptSegment[];
  subagentsDir: string;
  literals: readonly string[];
}): Promise<SessionFactsResult[]> {
  const { facts, segments } = input;
  const alignment = alignSegments(
    input.sessionRows.map(r => ({
      id: r.id,
      promptMsgUuid: r.promptMsgUuid,
      startedAtMs: r.startedAtMs,
    })),
    segments.map(s => ({
      index: s.index,
      promptUuid: s.promptUuid,
      promptTs: s.promptTs,
    }))
  );
  const issueSkillAt = latestIssueSkills(segments);
  const starts = sessionStartRows(input.sessionRows, alignment, segments);
  const out: SessionFactsResult[] = [];
  for (const row of input.targets) {
    const fp = factsFingerprint(expectationOf(row));
    const a = alignment.get(row.id);
    if (!a || a.status !== "aligned") {
      out.push({ id: row.id, status: "unaligned", fp });
      continue;
    }
    const seg = segments[a.segmentIndex]!;
    const prevTs = lastCallBefore(segments, a.segmentIndex);
    const agents = await readSegmentAgents(seg, input.subagentsDir);
    const computed = computeTurnFacts({
      segment: seg,
      prevLastAssistantTs: prevTs,
      sessionStart: starts.has(row.id),
      fingerprint: fp,
      foreground: agents.foreground,
      background: agents.background,
      classifyOpening: (): WaitClass =>
        classifyOpening(
          openingEvidenceOf(seg),
          serverProvenanceOf(facts, row, seg, prevTs)
        ),
      issue: resolveIssueRef({
        rowRepo: row.repo,
        rowLinkedIssue: row.linkedIssue,
        sessionLinked: facts.sessionLinkedIssue(row.hapiSessionId),
        lastIssueSkill: issueSkillAt[a.segmentIndex] ?? null,
      }),
      literals: input.literals,
    });
    out.push({
      id: row.id,
      status: "facts",
      fp,
      json: computed.json,
      launches: agents.matched
        .filter(m => m.background)
        .map(m => ({
          toolUseId: m.toolUseId,
          turnId: row.id,
          hapiSessionId: row.hapiSessionId,
          agentId: m.agentId,
          launchedAtMs: seg.promptTs ?? row.startedAtMs,
        })),
      bgFp: bgFingerprint(agents.background),
    });
  }
  return out;
}
