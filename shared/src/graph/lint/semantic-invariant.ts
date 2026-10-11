// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `SEMANTIC_INVARIANT` lint rules — issue #2885 (Graph Engineering Phase 1,
 * sub-issue C). Structural-correctness invariants that make a graph valid,
 * enforced BEFORE a real failure occurs (the complement to #2884's
 * incident-derived rules). Derived from the execution-semantics charter
 * (synthesis Parts II/IV), not from a specific incident — so these rules OMIT
 * `trigger_incident` (optional on `LintRule` for exactly this class) and carry
 * `provenance_class: "SEMANTIC_INVARIANT"` + a canonical `invariant_id` (R3).
 *
 * Predicates are PURE `(graph) => LintFinding[]` so the #2885 engine runs them
 * deterministically and #2886 can reuse them. `LintRule` / `LintFinding` are
 * IMPORTED from #2884's `types.ts` (CF-1 — never re-declared here).
 *
 * The parse-time structural invariants (duplicate-id, dangling-ref,
 * unknown-construct, loop-bound, loop-exhaustion-route, map-identity, residual
 * schema) are NOT re-authored as predicates here — they surface through the
 * engine's `validateGraphIR` reuse (see `engine.ts` `IRERROR_INVARIANT_ID`, the
 * validator-reuse catalog, V5). This file authors only the invariants that
 * `validateGraphIR` does NOT already cover.
 */
import {
  RISK_TIER_RANK,
  type GraphIR,
  type GraphNode,
  type ResourceDecl,
} from "../ir";
import type { EnforcementLayer, LintFinding, LintRule } from "./types";
import { disjoint, successorsOf, branchRegion } from "./reachability";

// ── Canonical invariant ids (one meaning, one id — synthesis III.1) ──────────
const INV_HUMAN_GATE_CONTINUATION = "INV-human-gate-has-continuation";
const INV_REACHABLE_BRANCH_ARMS = "INV-reachable-branch-arms";
const INV_LEGAL_RESOURCE_ACCESS = "INV-legal-resource-access";
const INV_NON_NEGATIVE_RETRY = "INV-non-negative-retry";
const INV_REACHABLE_TERMINAL = "INV-reachable-terminal";
const INV_LEDGERED_MUTATING_EFFECT = "INV-ledgered-mutating-effects";
/** CF-5: shared VERBATIM with #2886's commit-node lowering — one invariant, two layers. */
const INV_MUTATING_IS_COMMIT_NODE = "INV-mutating-is-commit-node";

const LINT_LAYER: EnforcementLayer[] = ["lint"];

/** Construct a `SEMANTIC_INVARIANT` finding (every authored rule runs at the lint layer). */
function finding(
  rule_id: string,
  invariant_id: string,
  where: string,
  message: string
): LintFinding {
  return {
    rule_id,
    invariant_id,
    provenance_class: "SEMANTIC_INVARIANT",
    layers: [...LINT_LAYER],
    where,
    message,
  };
}

interface GraphIndex {
  nodesById: Map<string, GraphNode>;
  edgeSuccById: Map<string, string[]>;
}

function indexGraph(graph: GraphIR): GraphIndex {
  const nodesById = new Map<string, GraphNode>();
  for (const n of graph.nodes) nodesById.set(n.id, n);
  const edgeSuccById = new Map<string, string[]>();
  for (const e of graph.edges) {
    const arr = edgeSuccById.get(e.from);
    if (arr) arr.push(e.to);
    else edgeSuccById.set(e.from, [e.to]);
  }
  return { nodesById, edgeSuccById };
}

// ── Rule: human_gate_without_continuation ────────────────────────────────────
const RID_HUMAN_GATE = "human-gate-without-continuation";
/**
 * A `human_gate` whose approval leads nowhere: no outgoing edge. A human_gate
 * has no structural targets, so its only continuation is an outgoing edge — with
 * none, the approval decision has no downstream effect and the gate is dead
 * structure.
 */
function detectHumanGateWithoutContinuation(graph: GraphIR): LintFinding[] {
  const hasOutgoing = new Set<string>();
  for (const e of graph.edges) hasOutgoing.add(e.from);
  const findings: LintFinding[] = [];
  for (const n of graph.nodes) {
    if (n.kind !== "human_gate") continue;
    if (!hasOutgoing.has(n.id)) {
      findings.push(
        finding(
          RID_HUMAN_GATE,
          INV_HUMAN_GATE_CONTINUATION,
          n.id,
          `human_gate "${n.id}" (gate_id: ${n.gate_id}) has no outgoing edge — an approval gate with no continuation gates nothing.`
        )
      );
    }
  }
  return findings;
}

// ── Rule: unreachable_branch_predicate (scoped: shadowed-identical arm) ───────
const RID_UNREACHABLE_BRANCH = "unreachable-branch-predicate";
/**
 * v0.1 (trivially-decidable, 2885-7): a `branch` arm whose `when` predicate is
 * IDENTICAL to an earlier arm's is unreachable — a deterministic branch takes
 * the first arm that holds, so the earlier arm always wins. Flags the later
 * (shadowed) arm. General predicate satisfiability is undecidable and explicitly
 * out of v0.1 scope.
 */
function detectUnreachableBranchArm(graph: GraphIR): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const n of graph.nodes) {
    if (n.kind !== "branch") continue;
    const firstSeenAt = new Map<string, number>();
    n.branches.forEach((arm, idx) => {
      const prior = firstSeenAt.get(arm.when);
      if (prior !== undefined) {
        findings.push(
          finding(
            RID_UNREACHABLE_BRANCH,
            INV_REACHABLE_BRANCH_ARMS,
            `${n.id}.branches[${idx}]`,
            `branch "${n.id}" arm ${idx} predicate ${JSON.stringify(
              arm.when
            )} is shadowed by the identical earlier arm ${prior} — the later arm is unreachable.`
          )
        );
      } else {
        firstSeenAt.set(arm.when, idx);
      }
    });
  }
  return findings;
}

// ── Rule: negative_retry ─────────────────────────────────────────────────────
const RID_NEGATIVE_RETRY = "negative-retry";
/**
 * `retry.max < 0`. #2883's schema deliberately permits a negative here so this
 * lint rule owns the check (the schema comment: "do not clean up with
 * .nonnegative()").
 */
function detectNegativeRetry(graph: GraphIR): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const n of graph.nodes) {
    if (n.retry && n.retry.max < 0) {
      findings.push(
        finding(
          RID_NEGATIVE_RETRY,
          INV_NON_NEGATIVE_RETRY,
          n.id,
          `node "${n.id}" declares retry.max = ${n.retry.max} — a retry count must be >= 0.`
        )
      );
    }
  }
  return findings;
}

// ── Rule: missing_terminal_condition (existential v0.1) ───────────────────────
const RID_MISSING_TERMINAL = "missing-terminal-condition";
/**
 * Existential v0.1 (D2-a): at least one node with `terminal: true` must be
 * reachable from an entry (entry = a node that is no other node's forward
 * successor). The universal "every path terminates" form is deferred. Uses the
 * forward-successor relation (edges + structural targets; subgraph opaque).
 */
function detectMissingTerminalCondition(graph: GraphIR): LintFinding[] {
  const index = indexGraph(graph);

  // Entries = nodes that are no other node's forward successor.
  const hasIncoming = new Set<string>();
  for (const n of graph.nodes) {
    for (const s of successorsOf(n, index.edgeSuccById.get(n.id) ?? [])) {
      hasIncoming.add(s);
    }
  }
  const entries = graph.nodes
    .filter(n => !hasIncoming.has(n.id))
    .map(n => n.id);

  // Reachable set from all entries.
  const reachable = new Set<string>();
  const stack = [...entries];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (reachable.has(id)) continue;
    reachable.add(id);
    const node = index.nodesById.get(id);
    if (!node) continue; // dangling — validateGraphIR owns that class
    for (const s of successorsOf(node, index.edgeSuccById.get(id) ?? [])) {
      if (!reachable.has(s)) stack.push(s);
    }
  }

  const hasReachableTerminal = graph.nodes.some(
    n => n.terminal === true && reachable.has(n.id)
  );
  if (hasReachableTerminal) return [];

  return [
    finding(
      RID_MISSING_TERMINAL,
      INV_REACHABLE_TERMINAL,
      graph.id,
      `graph "${graph.id}" has no node with terminal:true reachable from an entry — execution has no defined stopping point (existential v0.1 check).`
    ),
  ];
}

// ── Rule: unledgered_mutating_effect (R4) ─────────────────────────────────────
const RID_UNLEDGERED_MUTATING = "unledgered-mutating-effect";
/**
 * R4 (declaration-sufficiency, D1-B+S2): an effect with `risk_tier >= mutating`
 * (rank-compared via #2883's `RISK_TIER_RANK`) whose `idempotency == "none"` AND
 * `reconciliation == "none"` — nothing for the effect-ledger to key or reconcile
 * on. Only `>= mutating` effects get ledger treatment (synthesis II.1), and they
 * MUST get it. `destructive` is caught too (it out-ranks `mutating`).
 */
function detectUnledgeredMutatingEffect(graph: GraphIR): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const n of graph.nodes) {
    (n.effects ?? []).forEach((eff, i) => {
      if (RISK_TIER_RANK[eff.risk_tier] < RISK_TIER_RANK.mutating) return;
      if (eff.idempotency === "none" && eff.reconciliation === "none") {
        findings.push(
          finding(
            RID_UNLEDGERED_MUTATING,
            INV_LEDGERED_MUTATING_EFFECT,
            `${n.id}.effects[${i}]`,
            `node "${n.id}" effect[${i}] is ${eff.risk_tier} (>= mutating) but declares idempotency:"none" AND reconciliation:"none" — the effect-ledger has no key to dedup on and no query to reconcile (synthesis II.1).`
          )
        );
      }
    });
  }
  return findings;
}

// ── Rule: mutating_effect_in_agent_body (R5 — scoped ADVISORY) ────────────────
const RID_MUTATING_IN_AGENT_BODY = "mutating-effect-in-agent-body";
/**
 * R5 (advisory, D1-B). The canonical invariant `INV-mutating-is-commit-node`
 * (CF-5, shared VERBATIM with #2886) is ENFORCED at the compile layer — #2886
 * lowers every mutating effect to a dedicated commit node unconditionally.
 * #2883's 8-kind IR has no `agent`/`commit` kinds, so the ONE lint-decidable
 * proxy for "a mutating effect hidden in an opaque body" is a `subgraph` node
 * (its interior is invisible to a single-document linter). This rule emits a
 * scoped ADVISORY nudge for that case. `enforcement_layer` is `"lint"` (the layer
 * THIS finding fires at) — #2884's `EnforcementLayerSchema` has no `"compile"`
 * member, so the compile-layer primacy is conveyed in the message (the enum gap
 * is recorded in Task 5's field→consumer trace).
 */
function detectMutatingEffectInSubgraphBody(graph: GraphIR): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const n of graph.nodes) {
    if (n.kind !== "subgraph") continue;
    (n.effects ?? []).forEach((eff, i) => {
      if (RISK_TIER_RANK[eff.risk_tier] >= RISK_TIER_RANK.mutating) {
        findings.push(
          finding(
            RID_MUTATING_IN_AGENT_BODY,
            INV_MUTATING_IS_COMMIT_NODE,
            `${n.id}.effects[${i}]`,
            `ADVISORY: subgraph "${n.id}" declares a ${eff.risk_tier} (>= mutating) effect on its opaque body — a mutating effect should lower to a dedicated commit node, not hide inside a subgraph (INV-mutating-is-commit-node; enforced at the compile layer by #2886).`
          )
        );
      }
    });
  }
  return findings;
}

// ── Rule: illegal_resource_access (S6 split — same-node + cross-node) ──────────
const RID_ILLEGAL_RESOURCE_ACCESS = "illegal-resource-access";

const isRead = (mode: ResourceDecl["mode"]): boolean => mode === "read";
const isWriteLike = (mode: ResourceDecl["mode"]): boolean =>
  mode === "write" || mode === "exclusive";

interface RWConflict {
  name: string;
  modeA: ResourceDecl["mode"];
  modeB: ResourceDecl["mode"];
}

/**
 * Same-name resources where one side READS and the other WRITES/exclusive-locks.
 * Read/read (safe) and write/write (owned by #2884's write-conflict rule) are
 * deliberately excluded — this is the read-side complement.
 */
function readWriteConflicts(a: GraphNode, b: GraphNode): RWConflict[] {
  const out: RWConflict[] = [];
  const seen = new Set<string>();
  for (const ra of a.resources ?? []) {
    for (const rb of b.resources ?? []) {
      if (ra.name !== rb.name || seen.has(ra.name)) continue;
      const readVsWrite =
        (isRead(ra.mode) && isWriteLike(rb.mode)) ||
        (isWriteLike(ra.mode) && isRead(rb.mode));
      if (readVsWrite) {
        seen.add(ra.name);
        out.push({ name: ra.name, modeA: ra.mode, modeB: rb.mode });
      }
    }
  }
  return out;
}

/**
 * `illegal_resource_access` (S6 split). Two facets:
 *  (1) SAME-NODE inconsistency — an effect declaring `risk_tier:"readonly"` yet
 *      `access:"write"` (a writing effect cannot honestly be readonly-tier).
 *  (2) CROSS-NODE conflict — two concurrent-sibling nodes of one `parallel`
 *      fan-out declaring the SAME resource `name` where one reads and the other
 *      writes/exclusive-locks (a dirty-read/write race; the read-side complement
 *      to #2884's write/write rule). Same fan-out concurrency model as #2884: two
 *      region nodes are concurrent iff their branch-head sets are disjoint.
 * (The enum-mode facet — a `mode` not in {read,write,exclusive} — is PURE SHAPE
 * and surfaces via the engine's `validateGraphIR` reuse [S6a], not here.)
 */
function detectIllegalResourceAccess(graph: GraphIR): LintFinding[] {
  const findings: LintFinding[] = [];

  // Facet 1: same-node readonly-tier-but-writes.
  for (const n of graph.nodes) {
    (n.effects ?? []).forEach((eff, i) => {
      if (eff.risk_tier === "readonly" && eff.access === "write") {
        findings.push(
          finding(
            RID_ILLEGAL_RESOURCE_ACCESS,
            INV_LEGAL_RESOURCE_ACCESS,
            `${n.id}.effects[${i}]`,
            `node "${n.id}" effect[${i}] declares risk_tier:"readonly" but access:"write" — a writing effect cannot be readonly-tier.`
          )
        );
      }
    });
  }

  // Facet 2: cross-node concurrent read-vs-write on the same resource.
  const index = indexGraph(graph);
  const joinIds = new Set<string>();
  for (const n of graph.nodes) if (n.kind === "join") joinIds.add(n.id);

  const seen = new Set<string>();
  for (const p of graph.nodes) {
    if (p.kind !== "parallel") continue;

    const branchHeads = new Map<string, Set<string>>();
    for (const target of p.targets) {
      for (const nodeId of branchRegion(
        target,
        index.nodesById,
        index.edgeSuccById,
        joinIds
      )) {
        const set = branchHeads.get(nodeId);
        if (set) set.add(target);
        else branchHeads.set(nodeId, new Set([target]));
      }
    }

    const regionIds = [...branchHeads.keys()];
    for (let i = 0; i < regionIds.length; i++) {
      for (let j = i + 1; j < regionIds.length; j++) {
        const aId = regionIds[i];
        const bId = regionIds[j];
        if (aId === undefined || bId === undefined) continue;
        const headsA = branchHeads.get(aId);
        const headsB = branchHeads.get(bId);
        if (!headsA || !headsB || !disjoint(headsA, headsB)) continue;

        const [firstId, secondId] = aId < bId ? [aId, bId] : [bId, aId];
        const first = index.nodesById.get(firstId);
        const second = index.nodesById.get(secondId);
        if (!first || !second) continue;

        const pair = `${firstId},${secondId}`;
        for (const c of readWriteConflicts(first, second)) {
          const key = `${pair}|${c.name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          findings.push(
            finding(
              RID_ILLEGAL_RESOURCE_ACCESS,
              INV_LEGAL_RESOURCE_ACCESS,
              pair,
              `parallel siblings "${firstId}" and "${secondId}" declare ${c.modeA}/${c.modeB} access to the same resource "${c.name}" within the fan-out at "${p.id}" — a concurrent read alongside a write/exclusive is a dirty-read/write race.`
            )
          );
        }
      }
    }
  }
  return findings;
}

// ── The rule set ──────────────────────────────────────────────────────────────
/**
 * The `SEMANTIC_INVARIANT` rule set consumed by the #2885 linter engine
 * (`runLinter`). Structural-correctness invariants derived from the charter, not
 * from incidents (so `trigger_incident` is omitted). The parse-time structural
 * invariants (duplicate-id, dangling-ref, unknown-construct, loop-bound /
 * exhaustion, map-identity, schema) are surfaced via the engine's
 * `validateGraphIR` reuse, NOT re-authored here (V5).
 */
export const SEMANTIC_INVARIANT_RULES: LintRule[] = [
  {
    id: RID_HUMAN_GATE,
    provenance_class: "SEMANTIC_INVARIANT",
    mechanism:
      "A human_gate models 'pause for approval, then continue'. With no outgoing edge there is nothing to continue to — the approval decision has no downstream effect, so the gate is dead structure.",
    invariant_id: INV_HUMAN_GATE_CONTINUATION,
    enforcement_layer: "lint",
    predicate: detectHumanGateWithoutContinuation,
  },
  {
    id: RID_UNREACHABLE_BRANCH,
    provenance_class: "SEMANTIC_INVARIANT",
    mechanism:
      "A deterministic branch takes the first arm whose predicate holds. A later arm whose `when` is identical to an earlier arm can never be reached — the earlier arm always wins — so it is dead code masking author intent.",
    invariant_id: INV_REACHABLE_BRANCH_ARMS,
    enforcement_layer: "lint",
    predicate: detectUnreachableBranchArm,
  },
  {
    id: RID_ILLEGAL_RESOURCE_ACCESS,
    provenance_class: "SEMANTIC_INVARIANT",
    mechanism:
      "A concurrent read alongside a write/exclusive on the same resource is a dirty-read/write race; and an effect that writes cannot honestly declare risk_tier:readonly. Both are statically decidable from resource/effect declarations.",
    invariant_id: INV_LEGAL_RESOURCE_ACCESS,
    enforcement_layer: "lint",
    predicate: detectIllegalResourceAccess,
  },
  {
    id: RID_NEGATIVE_RETRY,
    provenance_class: "SEMANTIC_INVARIANT",
    mechanism:
      "A negative retry count is meaningless — a runtime cannot retry a step a negative number of times. #2883's schema deliberately permits the negative so this rule owns the check.",
    invariant_id: INV_NON_NEGATIVE_RETRY,
    enforcement_layer: "lint",
    predicate: detectNegativeRetry,
  },
  {
    id: RID_MISSING_TERMINAL,
    provenance_class: "SEMANTIC_INVARIANT",
    mechanism:
      "A workflow with no reachable terminal node has no defined stopping point — execution loops or halts undefined. v0.1 checks the existential form (>=1 terminal:true node reachable from an entry).",
    invariant_id: INV_REACHABLE_TERMINAL,
    enforcement_layer: "lint",
    predicate: detectMissingTerminalCondition,
  },
  {
    id: RID_UNLEDGERED_MUTATING,
    provenance_class: "SEMANTIC_INVARIANT",
    mechanism:
      "Only >= mutating effects get effect-ledger treatment (synthesis II.1), and they MUST get it. An effect declaring idempotency:none AND reconciliation:none gives the ledger no key to dedup on and no query to reconcile — an at-least-once mutation that cannot be made safe on resume.",
    invariant_id: INV_LEDGERED_MUTATING_EFFECT,
    enforcement_layer: "lint",
    predicate: detectUnledgeredMutatingEffect,
  },
  {
    id: RID_MUTATING_IN_AGENT_BODY,
    provenance_class: "SEMANTIC_INVARIANT",
    mechanism:
      "Mutating effects must be deterministic commit nodes, never hidden in an opaque body (synthesis I.3). The compile layer (#2886) enforces this by lowering; the lint layer contributes a scoped ADVISORY for the one lint-decidable proxy — a mutating effect declared on a subgraph node.",
    invariant_id: INV_MUTATING_IS_COMMIT_NODE,
    enforcement_layer: "lint",
    predicate: detectMutatingEffectInSubgraphBody,
  },
];
