// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Provenance-agnostic linter engine — issue #2885 (Graph Engineering Phase 1,
 * sub-issue C). `runLinter(graph, rules)` executes BOTH provenance classes —
 * #2884's `INCIDENT_DERIVED` rules and this issue's `SEMANTIC_INVARIANT` rules —
 * over one graph identically (provenance is metadata, never control flow, R1).
 *
 * The first pass REUSES #2883's `validateGraphIR` (CF-3 / V5): the parse-time
 * structural trio (duplicate-id, dangling-ref, unknown-construct) plus the two
 * distinct loop/map codes and the residual schema-class failures are mapped 1:1
 * into `SEMANTIC_INVARIANT` findings — ONE canonical definition (the validator),
 * surfaced through the lint layer. No duplicate-id / dangling-ref check is
 * re-implemented anywhere in the linter.
 *
 * `LintResult.ok` semantics (answers the epic #2888 cross-issue flag, 2026-08-16):
 * `ok === (findings.length === 0)` — "no findings", matching #2884's PINNED
 * `LintFinding` contract, whose docstring fixes the #2886 compile gate as `!ok`
 * with deliberately NO per-finding severity field in v0.1. The "advisory"
 * `mutating-effect-in-agent-body` rule therefore still counts toward `ok`; a
 * findings-tolerant run (#2890/#2891) reads `result.findings` directly or selects
 * a rule subset rather than relying on a per-finding severity. Consequences +
 * the compile-gate recommendation for #2886/#2891 are recorded in
 * `claudedocs/graph-engineering/lint-rule-seeding-audit.md` (Task 5).
 */
import type { GraphIR } from "../ir";
import { type IRErrorCode, validateGraphIR } from "../validate";
import type { LintFinding, LintRule } from "./types";

/** Aggregate linter verdict. See the `ok` semantics note in the module docstring. */
export interface LintResult {
  /** True iff the linter produced zero findings (no severity distinction in v0.1). */
  ok: boolean;
  /** All findings, de-duplicated by the compound key (invariant_id, where). */
  findings: LintFinding[];
}

/**
 * `IRError.code` → canonical `invariant_id` (directive 2885-5). This map IS the
 * validator-reuse catalog: the invariants below are enforced by #2883's
 * `validateGraphIR` and surfaced here — they are NOT re-authored as
 * `SEMANTIC_INVARIANT_RULES` predicates (V5). `loop_unbounded` and
 * `map_no_identity` are DISTINCT #2883 codes, never folded into `schema`.
 */
export const IRERROR_INVARIANT_ID: Record<IRErrorCode, string> = {
  duplicate_id: "INV-unique-node-ids",
  dangling_ref: "INV-no-dangling-refs",
  unknown_construct: "INV-known-constructs",
  loop_unbounded: "INV-bounded-loops",
  map_no_identity: "INV-stable-map-identity",
  schema: "INV-schema-valid",
};

/**
 * Map #2883's `validateGraphIR` `IRError[]` into `SEMANTIC_INVARIANT` findings
 * (CF-3). Each carries `rule_id:"validateGraphIR"`, `layers:["lint"]`, and the
 * canonical `invariant_id` for its code — so a validator-surfaced invariant
 * de-dups against a same-site rule-surfaced one (synthesis III.1).
 */
function validatorFindings(graph: GraphIR): LintFinding[] {
  const result = validateGraphIR(graph);
  if (result.ok) return [];
  return result.errors.map(
    (e): LintFinding => ({
      rule_id: "validateGraphIR",
      invariant_id: IRERROR_INVARIANT_ID[e.code],
      provenance_class: "SEMANTIC_INVARIANT",
      layers: ["lint"],
      where: e.where,
      message: e.message,
    })
  );
}

/**
 * De-duplicate by the COMPOUND key `(invariant_id, where)` — never bare
 * `invariant_id`, which would collapse two same-invariant findings at DIFFERENT
 * sites and discard their locations [2885-6]. When multiple enforcement layers
 * fire the same canonical invariant at the SAME site, the finding is reported
 * once and its `layers[]` is the union (synthesis III.1 — "report the invariant
 * once, list the layers", applied per site). Insertion order of first-seen keys
 * is preserved (`Map` iteration order).
 */
function dedupeByInvariantAndSite(findings: LintFinding[]): LintFinding[] {
  const bySite = new Map<string, LintFinding>();
  for (const f of findings) {
    const key = `${f.invariant_id}\u0000${f.where}`;
    const existing = bySite.get(key);
    if (!existing) {
      bySite.set(key, { ...f, layers: [...f.layers] });
      continue;
    }
    for (const layer of f.layers) {
      if (!existing.layers.includes(layer)) existing.layers.push(layer);
    }
  }
  return [...bySite.values()];
}

/**
 * Run the linter over one graph. Pass 1 reuses `validateGraphIR` (structural
 * trio + loop/map/schema); pass 2 runs every rule's pure `predicate`. Findings
 * are aggregated and de-duplicated by `(invariant_id, where)`. The engine is
 * provenance-agnostic — it runs `INCIDENT_DERIVED` and `SEMANTIC_INVARIANT`
 * rules identically (R1).
 */
export function runLinter(graph: GraphIR, rules: LintRule[]): LintResult {
  const findings: LintFinding[] = [
    ...validatorFindings(graph),
    ...rules.flatMap(rule => rule.predicate(graph)),
  ];
  const deduped = dedupeByInvariantAndSite(findings);
  return { ok: deduped.length === 0, findings: deduped };
}
