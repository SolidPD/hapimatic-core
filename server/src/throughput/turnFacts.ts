// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";
import {
  CONTEXT_BIN_TOKENS,
  CONTEXT_COARSE_BIN_TOKENS,
  EFFORT_UNKNOWN,
  FACTS_MAX_BYTES,
  IDLE_GAP_MS,
  STAGE_NONE,
  STAGE_SUBAGENT,
  TURN_FACTS_VERSION,
  binIndexFor,
  canonicalJson,
  rebinHistogram,
  utf8ByteLength,
  type TurnFacts,
  type WaitClass,
} from "@hapi/protocol";
import { INTRA_TURN_CLASS } from "./provenance";
import { keepUnits } from "./testRuns";
import {
  SYNTHETIC_MODEL,
  isPricedCall,
  type AgentCallsSummary,
  type SkillCall,
  type TranscriptCall,
  type TranscriptSegment,
} from "./transcriptCalls";

/**
 * Pure per-turn facts (issue #6164, A1 — R2, R3, R15).
 *
 * `computeTurnFacts` folds ONE aligned transcript segment (plus the sub-agent
 * files it launched) into the facts v1 record of `shared/src/throughput.ts`:
 * tokens by category with the finalize parser's totals (segment usage once per
 * `message.id`, plus foreground sub-agent files), a stage × model breakdown,
 * effort, context histograms, post-idle rewrites with a wait class, agent test
 * runs, background agents and the issue reference. It returns canonical JSON
 * capped at {@link FACTS_MAX_BYTES}.
 *
 * No I/O: the collector reads the transcript and agent files, looks up the
 * opening message's server provenance (only when a post-idle gap needs it, via
 * the `classifyOpening` callback) and resolves the issue reference.
 */

/** The ledger columns the facts were computed from (the CAS expectation). */
export interface FingerprintColumns {
  status: string;
  promptMsgUuid: string | null;
  transcriptPath: string | null;
  tokIn: number | null;
  tokOut: number | null;
  tokCacheRead: number | null;
  tokCacheWrite: number | null;
  startedAtMs: number;
}

/**
 * Fingerprint of a row's ledger columns (16 hex). The rollup recomputes it from
 * a mirror row's `row_json` and ignores facts whose `fp` no longer matches, so
 * a ledger change made after collection (a repair, a late finalize) never
 * mixes with stale facts.
 */
export function factsFingerprint(c: FingerprintColumns): string {
  const s = (v: string | number | null): string =>
    v === null ? "" : String(v);
  return createHash("sha256")
    .update(
      [
        c.status,
        s(c.promptMsgUuid),
        s(c.transcriptPath),
        s(c.tokIn),
        s(c.tokOut),
        s(c.tokCacheRead),
        s(c.tokCacheWrite),
        String(c.startedAtMs),
      ].join("|")
    )
    .digest("hex")
    .slice(0, 16);
}

/** {@link factsFingerprint} over a `turns` row as JSON (local or mirrored). */
export function fingerprintOfRow(row: Record<string, unknown>): string {
  const n = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const s = (v: unknown): string | null =>
    typeof v === "string" && v !== "" ? v : null;
  return factsFingerprint({
    status: String(row.status ?? ""),
    promptMsgUuid: s(row.prompt_msg_uuid),
    transcriptPath: s(row.transcript_path),
    tokIn: n(row.tok_in),
    tokOut: n(row.tok_out),
    tokCacheRead: n(row.tok_cache_read),
    tokCacheWrite: n(row.tok_cache_write),
    startedAtMs: Number(row.started_at_ms ?? 0),
  });
}

export type IssueRef = [string, number, "session" | "linked" | "skill-args"];

const ISSUE_NUMBER = /#(\d{1,7})\b/;
const REPO_FLAG = /--repo[=\s]+([\w.-]+\/[\w.-]+)/;

/**
 * The turn's issue: the session's own link when its number matches the row's
 * (`session`), else the row's `repo` + `linked_issue` (`linked`), else the
 * latest `issue-*` skill call at or before the segment (`skill-args`, with its
 * `--repo`, else the row's repo).
 */
export function resolveIssueRef(input: {
  rowRepo: string | null;
  rowLinkedIssue: string | null;
  sessionLinked: { number: number; repo: string } | null;
  lastIssueSkill: SkillCall | null;
}): IssueRef | null {
  const linked = input.rowLinkedIssue?.match(ISSUE_NUMBER);
  const linkedNumber = linked ? Number(linked[1]) : null;
  if (
    linkedNumber !== null &&
    input.sessionLinked &&
    input.sessionLinked.number === linkedNumber
  ) {
    return [input.sessionLinked.repo, linkedNumber, "session"];
  }
  if (linkedNumber !== null && input.rowRepo) {
    return [input.rowRepo, linkedNumber, "linked"];
  }
  const skill = input.lastIssueSkill;
  const args = skill?.args ?? "";
  const n = args.match(ISSUE_NUMBER);
  if (skill && n) {
    const repo = args.match(REPO_FLAG)?.[1] ?? input.rowRepo;
    if (repo) return [repo, Number(n[1]), "skill-args"];
  }
  return null;
}

/** An `issue-*` workflow skill call (the census's issue attribution signal). */
export function isIssueSkill(skill: SkillCall): boolean {
  return skill.skill.startsWith("issue-");
}

export interface TurnFactsInput {
  segment: TranscriptSegment;
  /**
   * The last real main-chain call before this segment (`<synthetic>` entries
   * and call-less segments skipped): the start of the opening idle gap.
   */
  prevLastAssistantTs: number | null;
  /**
   * This turn holds its session's first real model call, so its first call is
   * the session's starting context (`ctx.st`). Sessions whose first turn made
   * no call (a usage-limit error, a local command) start at their first real
   * call instead of dropping out of the sample.
   */
  sessionStart?: boolean;
  fingerprint: string;
  /** Foreground sub-agent files this segment launched (rolled into `tok`). */
  foreground: readonly AgentCallsSummary[];
  /**
   * Background agents this segment launched: tokens in `bg` only (never
   * `tok`); their per-call context joins `ctx.s`.
   */
  background: readonly AgentCallsSummary[];
  /** Wait class of the opening post-idle gap; called only when one exists. */
  classifyOpening: () => WaitClass;
  issue: IssueRef | null;
  literals?: readonly string[];
}

export interface TurnFactsOutput {
  facts: TurnFacts;
  json: string;
  bytes: number;
}

type Six = [number, number, number, number, number, number];

function w5Of(c: TranscriptCall): number {
  return Math.max(0, c.cw - c.w1);
}

function addSix(
  sm: Record<string, Record<string, number[]>>,
  stage: string,
  model: string,
  v: Six
): void {
  const byModel = (sm[stage] ??= {});
  const cur = (byModel[model] ??= [0, 0, 0, 0, 0, 0]);
  for (let i = 0; i < 6; i += 1) cur[i] = (cur[i] ?? 0) + v[i]!;
}

function addBin(hist: Record<string, number>, tokens: number): void {
  const key = String(binIndexFor(tokens, CONTEXT_BIN_TOKENS));
  hist[key] = (hist[key] ?? 0) + 1;
}

export function computeTurnFacts(input: TurnFactsInput): TurnFactsOutput {
  const { segment } = input;
  const tok = { in: 0, out: 0, cr: 0, w1: 0, w5: 0 };
  const sm: Record<string, Record<string, number[]>> = {};
  const eff: Record<string, number> = {};
  const ctxMain: Record<string, number> = {};
  const ctxSub: Record<string, number> = {};
  let calls = 0;
  let first: number | null = null;
  let max: number | null = null;
  const mainCalls: TranscriptCall[] = [];

  for (const c of segment.calls) {
    const w5 = w5Of(c);
    tok.in += c.in;
    tok.out += c.out;
    tok.cr += c.cr;
    tok.w1 += c.w1;
    tok.w5 += w5;
    if (c.in + c.out + c.cr + c.cw === 0) continue;
    const priced = isPricedCall(c);
    const model = c.model && c.model !== SYNTHETIC_MODEL ? c.model : "unknown";
    if (c.sidechain) {
      addSix(sm, STAGE_SUBAGENT, model, [
        priced ? 1 : 0,
        c.in,
        c.out,
        c.cr,
        c.w1,
        w5,
      ]);
      if (priced) addBin(ctxSub, c.occupancy);
      continue;
    }
    addSix(sm, c.stage ?? STAGE_NONE, model, [
      priced ? 1 : 0,
      c.in,
      c.out,
      c.cr,
      c.w1,
      w5,
    ]);
    if (!priced) continue;
    calls += 1;
    mainCalls.push(c);
    const effort = c.effort ?? EFFORT_UNKNOWN;
    eff[effort] = (eff[effort] ?? 0) + 1;
    if (first === null) first = c.occupancy;
    max = max === null ? c.occupancy : Math.max(max, c.occupancy);
    addBin(ctxMain, c.occupancy);
  }

  for (const a of input.foreground) {
    tok.in += a.in;
    tok.out += a.out;
    tok.cr += a.cr;
    tok.w1 += a.w1;
    tok.w5 += a.w5;
    if (a.in + a.out + a.cr + a.w1 + a.w5 > 0) {
      addSix(sm, STAGE_SUBAGENT, a.model ?? "unknown", [
        a.calls,
        a.in,
        a.out,
        a.cr,
        a.w1,
        a.w5,
      ]);
    }
    for (const o of a.occupancies) addBin(ctxSub, o);
  }

  // Background agents: reported separately (`bg`), never in `tok`.
  const bg = backgroundFacts(input.background.length, input.background);
  for (const a of input.background) {
    for (const o of a.occupancies) addBin(ctxSub, o);
  }

  const idle = idleFacts(mainCalls, input);
  const tests = testFacts(segment, input.literals ?? []);

  const facts: TurnFacts = {
    v: TURN_FACTS_VERSION,
    fp: input.fingerprint,
    calls,
    tok,
    sm,
    eff,
    pte: segment.perTurnEffort,
    ep: segment.entrypoint,
    ctx: {
      f: first,
      x: max,
      m: ctxMain,
      ...(Object.keys(ctxSub).length > 0 ? { s: ctxSub } : {}),
      ...(input.sessionStart && first !== null ? { st: 1 } : {}),
    },
    ...(idle ? { idle } : {}),
    ...(tests ? { tests } : {}),
    bg,
    iss: input.issue,
  };
  return capFacts(facts);
}

/**
 * The `bg` section: `launched` background agents, with per-model
 * `[in, out, cr, w1, w5]` from the agent files read so far (a still-running
 * agent's file is partial until its completion refolds the turn). Null when
 * the turn launched none.
 */
export function backgroundFacts(
  launched: number,
  files: readonly AgentCallsSummary[]
): TurnFacts["bg"] {
  if (launched === 0) return null;
  const sm: Record<string, number[]> = {};
  for (const a of files) {
    if (a.status !== "done") continue;
    const cur = (sm[a.model ?? "unknown"] ??= [0, 0, 0, 0, 0]);
    cur[0] = (cur[0] ?? 0) + a.in;
    cur[1] = (cur[1] ?? 0) + a.out;
    cur[2] = (cur[2] ?? 0) + a.cr;
    cur[3] = (cur[3] ?? 0) + a.w1;
    cur[4] = (cur[4] ?? 0) + a.w5;
  }
  return { n: launched, sm };
}

/**
 * #6169: a post-idle reopening counts as "kept warm" when its opening call read
 * at least this share of its prefix from the cache (a keep-alive, or a wait
 * shorter than the cache TTL). Observed: cold cr 11,291 of 48,319 → not warm;
 * warm cr 48,076 of 48,365 → warm.
 */
export const WARM_READ_SHARE = 0.9;

function isWarmCall(c: TranscriptCall): boolean {
  return c.occupancy > 0 && c.cr >= WARM_READ_SHARE * c.occupancy;
}

function idleFacts(
  mainCalls: readonly TranscriptCall[],
  input: TurnFactsInput
): TurnFacts["idle"] | null {
  const gaps: Array<{
    at: number;
    gap: number;
    cls: WaitClass;
    w1: number;
    w5: number;
    model: string | null;
    warm: boolean;
    cr: number;
  }> = [];
  const opening = mainCalls[0];
  if (
    opening &&
    opening.ts > 0 &&
    input.prevLastAssistantTs !== null &&
    opening.ts - input.prevLastAssistantTs > IDLE_GAP_MS
  ) {
    gaps.push({
      at: opening.ts,
      gap: opening.ts - input.prevLastAssistantTs,
      cls: input.classifyOpening(),
      w1: opening.w1,
      w5: w5Of(opening),
      model: opening.model,
      warm: isWarmCall(opening),
      cr: opening.cr,
    });
  }
  for (let i = 1; i < mainCalls.length; i += 1) {
    const prev = mainCalls[i - 1]!;
    const cur = mainCalls[i]!;
    if (cur.ts > 0 && prev.ts > 0 && cur.ts - prev.ts > IDLE_GAP_MS) {
      gaps.push({
        at: cur.ts,
        gap: cur.ts - prev.ts,
        cls: INTRA_TURN_CLASS,
        w1: cur.w1,
        w5: w5Of(cur),
        model: cur.model,
        warm: isWarmCall(cur),
        cr: cur.cr,
      });
    }
  }
  if (gaps.length === 0) return null;
  const c: Record<string, number[]> = {};
  for (const g of gaps) {
    // [n, w1, w5] plus, only once a class has a kept-warm gap, [warmN, warmCr]
    // (#6169). Readers use `v[3] ?? 0`, so cold classes and facts written
    // before #6169 read as no kept-warm gaps, and cold facts are unchanged.
    const cur = (c[g.cls] ??= [0, 0, 0]);
    cur[0] = (cur[0] ?? 0) + 1;
    cur[1] = (cur[1] ?? 0) + g.w1;
    cur[2] = (cur[2] ?? 0) + g.w5;
    if (g.warm) {
      cur[3] = (cur[3] ?? 0) + 1;
      cur[4] = (cur[4] ?? 0) + g.cr;
    }
  }
  const top = [...gaps]
    .sort((a, b) => b.w1 + b.w5 - (a.w1 + a.w5) || a.at - b.at)
    .slice(0, 3)
    .map(g => [g.at, g.gap, g.cls, g.w1, g.w5, g.model]);
  return { n: gaps.length, c, top };
}

function testFacts(
  segment: TranscriptSegment,
  literals: readonly string[]
): TurnFacts["tests"] | null {
  if (segment.tests.length === 0) return null;
  const counts = new Map<string, number>();
  let fail = 0;
  for (const t of segment.tests) {
    if (t.failed) fail += 1;
    for (const u of t.units) counts.set(u, (counts.get(u) ?? 0) + 1);
  }
  return {
    runs: segment.tests.length,
    fail,
    units: keepUnits(counts, literals),
  };
}

/** Total tokens of a `[calls, in, out, cr, w1, w5]` entry. */
function sixTokens(v: readonly number[]): number {
  return (v[1] ?? 0) + (v[2] ?? 0) + (v[3] ?? 0) + (v[4] ?? 0) + (v[5] ?? 0);
}

/** Keep the `keep` largest stages; merge the rest into `other` per model. */
function collapseStages(
  sm: Record<string, Record<string, number[]>>,
  keep: number
): Record<string, Record<string, number[]>> {
  const ranked = Object.entries(sm)
    .map(([stage, byModel]) => ({
      stage,
      byModel,
      total: Object.values(byModel).reduce((s, v) => s + sixTokens(v), 0),
    }))
    .sort((a, b) => b.total - a.total || (a.stage < b.stage ? -1 : 1));
  const out: Record<string, Record<string, number[]>> = {};
  for (const [i, r] of ranked.entries()) {
    if (i < keep) {
      out[r.stage] = r.byModel;
      continue;
    }
    for (const [model, v] of Object.entries(r.byModel)) {
      addSix(out, "other", model, [
        v[0] ?? 0,
        v[1] ?? 0,
        v[2] ?? 0,
        v[3] ?? 0,
        v[4] ?? 0,
        v[5] ?? 0,
      ]);
    }
  }
  return out;
}

/**
 * Enforce {@link FACTS_MAX_BYTES}: drop `tests.units`, then `ctx.s`, then
 * `idle.top`, then coarsen `ctx.m` to 50K bins; as a last resort collapse the
 * smaller stages into `other`. `tok`, `sm`, `eff` and `fp` are never dropped.
 * Every step is recorded in `tr`.
 */
export function capFacts(facts: TurnFacts): TurnFactsOutput {
  let f: TurnFacts = facts;
  const measure = (): TurnFactsOutput => {
    const json = canonicalJson(f);
    return { facts: f, json, bytes: utf8ByteLength(json) };
  };
  let out = measure();
  const tr: string[] = [];
  const steps: Array<[string, () => TurnFacts | null]> = [
    [
      "tests.units",
      () =>
        f.tests?.units && f.tests.units.length > 0
          ? { ...f, tests: { ...f.tests, units: [] } }
          : null,
    ],
    [
      "ctx.s",
      () => {
        if (!f.ctx?.s) return null;
        const { s: _drop, ...ctx } = f.ctx;
        return { ...f, ctx };
      },
    ],
    [
      "idle.top",
      () => {
        if (!f.idle?.top) return null;
        const { top: _drop, ...idle } = f.idle;
        return { ...f, idle };
      },
    ],
    [
      "ctx.m",
      () =>
        f.ctx?.m && (f.ctx.b ?? CONTEXT_BIN_TOKENS) === CONTEXT_BIN_TOKENS
          ? {
              ...f,
              ctx: {
                ...f.ctx,
                b: CONTEXT_COARSE_BIN_TOKENS,
                m: rebinHistogram(
                  f.ctx.m,
                  CONTEXT_BIN_TOKENS,
                  CONTEXT_COARSE_BIN_TOKENS
                ),
              },
            }
          : null,
    ],
  ];
  for (const [name, step] of steps) {
    if (out.bytes <= FACTS_MAX_BYTES) break;
    const next = step();
    if (!next) continue;
    tr.push(name);
    f = { ...next, tr: [...tr] };
    out = measure();
  }
  for (let keep = 6; keep >= 1 && out.bytes > FACTS_MAX_BYTES; keep -= 1) {
    if (Object.keys(f.sm ?? {}).length <= keep) continue;
    if (!tr.includes("sm")) tr.push("sm");
    f = { ...f, sm: collapseStages(f.sm ?? {}, keep), tr: [...tr] };
    out = measure();
  }
  return out;
}
