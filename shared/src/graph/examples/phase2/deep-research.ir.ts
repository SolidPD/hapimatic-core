// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Representative workflow #1 — DEEP RESEARCH, expressed as v0.1 Graph IR
 * (issue #2890, Graph Engineering Phase 2, Sub-Issue B, requirement R1).
 *
 * Real Hapimatic flow: the issue-researcher multi-hop pipeline — frame the
 * question, gather candidate sources, investigate each source, synthesize the
 * findings, emit the directive/report. It is an INVESTIGATION workflow: it reads
 * the codebase/corpus and rarely mutates, so every effect declares
 * `access: "read"` / `risk_tier: "readonly"` (no `mutating+` effect → no commit
 * node → no effect-ledger, by design).
 *
 * Construct coverage (coverage discipline — the four Phase-2 workflows must span
 * DISTINCT construct sets, not four near-identical sequences): this one exercises
 * `map` (fan-out over sources, keyed by a stable per-item identity) and `join`
 * (fan-in synthesis over the per-source investigations). Together with the other
 * three it makes the evaluation surface broad.
 *
 * Lint-clean by construction (V3): the single readonly effect never trips
 * `INV-ledgered-mutating-effects` (that rule fires only on `>= mutating`); the
 * `map` carries an `item_key` (`INV-stable-map-identity`); the `join` upstream
 * resolves; and `report` is `terminal: true` and reachable from the entry
 * (`INV-reachable-terminal`). Zero findings → `compileIR` accepts it (the compile
 * gate throws on ANY finding — there is no severity tier in v0.1).
 */
import type { GraphIR } from "../../ir";

/**
 * A multi-hop deep-research pipeline as a valid, lint-clean, compilable v0.1
 * `GraphIR`. `validateGraphIR(deepResearch).ok === true` (Task 1 Verify).
 */
export const deepResearch: GraphIR = {
  id: "hapimatic-deep-research",
  version: "0.1",
  nodes: [
    // Frame the research question (the issue-researcher's scoping step).
    { id: "frame_question", kind: "sequence" },
    // Gather candidate sources — a read over the corpus (no conflict: read-only).
    {
      id: "gather_sources",
      kind: "sequence",
      resources: [{ name: "research-corpus(hapimatic-private)", mode: "read" }],
      effects: [
        {
          access: "read",
          idempotency: "natural",
          reversibility: "reversible",
          authority: "none",
          reconciliation: "none",
          risk_tier: "readonly",
        },
      ],
    },
    // Fan out over each candidate source, keyed by a stable source identity.
    { id: "map_sources", kind: "map", item_key: "source-id" },
    // The per-source hop: read + extract the evidence from one source.
    {
      id: "investigate_source",
      kind: "sequence",
      resources: [{ name: "research-corpus(hapimatic-private)", mode: "read" }],
      effects: [
        {
          access: "read",
          idempotency: "natural",
          reversibility: "reversible",
          authority: "none",
          reconciliation: "none",
          risk_tier: "readonly",
        },
      ],
    },
    // Fan in: synthesize the findings across every investigated source.
    { id: "synthesize", kind: "join", upstreams: ["investigate_source"] },
    // Emit the research report/directive — the terminal stopping point.
    {
      id: "report",
      kind: "sequence",
      terminal: true,
      resources: [{ name: "research-corpus(hapimatic-private)", mode: "read" }],
      effects: [
        {
          access: "read",
          idempotency: "natural",
          reversibility: "reversible",
          authority: "none",
          reconciliation: "none",
          risk_tier: "readonly",
        },
      ],
    },
  ],
  edges: [
    { from: "frame_question", to: "gather_sources" },
    { from: "gather_sources", to: "map_sources" },
    // map → per-item body (v0.1: the map's subflow is carried by an edge).
    { from: "map_sources", to: "investigate_source" },
    // per-item body → the fan-in synthesis join.
    { from: "investigate_source", to: "synthesize" },
    // join → the terminal report (the join's continuation).
    { from: "synthesize", to: "report" },
  ],
};
