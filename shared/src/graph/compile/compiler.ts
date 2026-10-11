// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Deterministic IR compiler — issue #2886 (Graph Engineering Phase 1, sub-issue
 * D), requirements R1 + R4.
 *
 * `compileIR(graph)` lowers a v0.1 `GraphIR` into a canonical, deterministically-
 * serializable `CompiledWorkflow`. Two load-bearing properties:
 *
 *  - **R1 (determinism)**: the SAME IR compiles to a byte-identical artifact.
 *    `compileIR` is PURE — no `Date.now()`, no `Math.random()`, no Map/Set
 *    iteration order, no `Object.keys` order assumptions. Every emitted array
 *    (nodes, edges, and each node's ledger) is placed in a canonical order by a
 *    stable key, so two IRs that differ ONLY in array order compile identically.
 *    (`deterministicStringify` defaults to `sortArrays:false`, so array order is
 *    hash-significant — the compiler owns that ordering.)
 *
 *  - **R4 (commit-nodes-not-agents)**: every `risk_tier >= mutating` effect lowers
 *    to a node with `kind === "commit"` carrying an `idempotency_key` — NEVER an
 *    agent body. The v0.1 authored IR has no `agent` construct at all (ir.ts:
 *    epic ruling D1-B), so "not an agent body" holds by construction; the
 *    compiled node vocabulary is the enumerated `{ step, commit, gate }`.
 *
 * **Gate first (lint → compile)**: `compileIR` runs #2884/#2885's `runLinter`
 * before lowering and throws `CompileError` on `!ok` — a lint-failing graph MUST
 * NOT compile (synthesis roadmap; V5).
 *
 * Strict layering (directive Architecture Guidance): this module imports only
 * `shared` (`../ir`, `../lint/*`, `../../deterministicJson`) — never `cli`/`server`.
 * The driver (cli) imports the compiler, not the reverse.
 */
import type { GraphIR, GraphNode } from "../ir";
import { runLinter } from "../lint/engine";
import { INCIDENT_DERIVED_RULES } from "../lint/incident-derived";
import { SEMANTIC_INVARIANT_RULES } from "../lint/semantic-invariant";
import type { LintFinding, LintRule } from "../lint/types";
import { deterministicStringify } from "../../deterministicJson";
import {
  buildEffectLedger,
  deriveNodeIdempotencyKey,
  hasMutatingEffect,
} from "./effectLedger";
import { COMPILED_ARTIFACT_VERSION } from "./types";
import type { CompiledEdge, CompiledNode, CompiledWorkflow } from "./types";

/**
 * Thrown by `compileIR` when the input graph fails the linter (lint → compile
 * gate, V5). Carries the linter findings so the caller can surface them.
 */
export class CompileError extends Error {
  readonly findings: LintFinding[];
  constructor(findings: LintFinding[]) {
    const ids = findings.map(f => f.invariant_id).join(", ");
    super(
      `compileIR: graph failed lint with ${findings.length} finding(s): ${ids}`
    );
    this.name = "CompileError";
    this.findings = findings;
  }
}

/**
 * The default rule set the compile gate runs — BOTH provenance classes
 * (#2884 INCIDENT_DERIVED + #2885 SEMANTIC_INVARIANT), matching the directive's
 * `runLinter(graph, [...INCIDENT_DERIVED_RULES, ...SEMANTIC_INVARIANT_RULES])`.
 */
export const DEFAULT_COMPILE_RULES: LintRule[] = [
  ...INCIDENT_DERIVED_RULES,
  ...SEMANTIC_INVARIANT_RULES,
];

/** Lexicographic (UTF-16 code-unit) string comparison — matches default JS sort. */
function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Lower one IR node to a compiled node. Precedence — commit > gate > step:
 *  1. any `mutating+` effect → `commit` (R4 is safety-critical and MUST hold
 *     regardless of the authored kind), carrying its idempotency key + ledger;
 *  2. else a `human_gate` → `gate`;
 *  3. else → `step`.
 */
function lowerNode(node: GraphNode): CompiledNode {
  if (hasMutatingEffect(node)) {
    return {
      id: node.id,
      kind: "commit",
      source_kind: node.kind,
      idempotency_key: deriveNodeIdempotencyKey(node),
      ledger: buildEffectLedger(node),
    };
  }
  if (node.kind === "human_gate") {
    return { id: node.id, kind: "gate", source_kind: node.kind };
  }
  return { id: node.id, kind: "step", source_kind: node.kind };
}

/**
 * Compile a v0.1 `GraphIR` into a deterministic `CompiledWorkflow`.
 *
 * @throws {CompileError} if the graph fails the linter (lint → compile gate).
 */
export function compileIR(
  graph: GraphIR,
  rules: LintRule[] = DEFAULT_COMPILE_RULES
): CompiledWorkflow {
  // Gate first: a lint-failing graph MUST NOT compile (V5).
  const lint = runLinter(graph, rules);
  if (!lint.ok) {
    throw new CompileError(lint.findings);
  }

  // Canonical ordering makes re-compilation byte-identical (R1) AND makes two
  // IRs that differ only in array order compile identically.
  const nodes = graph.nodes.map(lowerNode).sort((a, b) => byString(a.id, b.id));
  const edges: CompiledEdge[] = graph.edges
    .map(e => ({ from: e.from, to: e.to }))
    .sort((a, b) => byString(a.from, b.from) || byString(a.to, b.to));

  return {
    compiled_version: COMPILED_ARTIFACT_VERSION,
    graph_id: graph.id,
    nodes,
    edges,
  };
}

/**
 * Canonical serialization of a compiled artifact — the byte string whose
 * identity defines R1 determinism and whose SHA-256 is the STRICT_RESUME launch
 * hash (R2). Uses the DEFAULT `DeterministicJsonOptions` (must match
 * `recordLaunchHash` / `checkResume`).
 */
export function serializeCompiled(compiled: CompiledWorkflow): string {
  return deterministicStringify(compiled);
}
