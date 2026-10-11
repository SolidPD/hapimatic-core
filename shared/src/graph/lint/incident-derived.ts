// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `INCIDENT_DERIVED` lint rules — issue #2884 (Graph Engineering Phase 1,
 * sub-issue B). Rules grounded in real incidents from Hapimatic's failure/guard
 * corpus, ported into statically-decidable graph predicates over the v0.1 IR
 * (#2883). Provenance is mandatory: every rule cites its trigger incident,
 * mechanism, canonical invariant, and enforcement layer (R2/R3).
 *
 * v0.1 ports exactly the incidents that are decidable AT THE IR-LINT LAYER — i.e.
 * evaluable from the static graph structure + node resource/effect/kind
 * declarations alone, with no execution state. The full corpus audit
 * (`claudedocs/graph-engineering/lint-rule-seeding-audit.md`) records the
 * decidability verdict + disposition for EVERY corpus entry and explains why the
 * rest stay client-hook / server-gate / compile-layer / structural. Predicates
 * are PURE (`(graph) => findings`) so the #2885 engine runs them deterministically
 * and the #2886 compiler can reuse them.
 */
import type { GraphIR, GraphNode, ResourceDecl } from "../ir";
import type { EnforcementLayer, LintFinding, LintRule } from "./types";
import { disjoint, branchRegion } from "./reachability";

// ── Rule identity ────────────────────────────────────────────────────────────
const RULE_ID = "git-object-db-write-conflict";
/**
 * The canonical semantic invariant: no two concurrently-runnable nodes may both
 * hold write/exclusive access to the same shared exclusive resource. Enforced
 * STATICALLY here (`lint`) and DYNAMICALLY by `server/src/provisioner/fleetLock.ts`
 * at runtime (`server-gate`, "exactly one MUTATING provisioning job fleet-wide at
 * a time") — one invariant, two enforcement layers (synthesis III.1).
 */
const INVARIANT_ID = "INV-no-concurrent-exclusive-writes";
const LAYERS: EnforcementLayer[] = ["lint", "server-gate"];

// ── Predicate helpers (pure) ─────────────────────────────────────────────────
/** A resource mode that mutates shared state — the conflict-triggering side. */
const isWriteLike = (mode: ResourceDecl["mode"]): boolean =>
  mode === "write" || mode === "exclusive";

interface ResourceConflict {
  name: string;
  modeA: ResourceDecl["mode"];
  modeB: ResourceDecl["mode"];
}

/**
 * The shared write/exclusive resources two nodes conflict on: same resource
 * `name`, both sides write-like. A read on either side, or a different resource
 * name (e.g. a different repo), is NOT a conflict for this rule.
 */
function conflictingResources(a: GraphNode, b: GraphNode): ResourceConflict[] {
  const out: ResourceConflict[] = [];
  const seenNames = new Set<string>();
  const aWrites = (a.resources ?? []).filter(r => isWriteLike(r.mode));
  const bWrites = (b.resources ?? []).filter(r => isWriteLike(r.mode));
  for (const ra of aWrites) {
    if (seenNames.has(ra.name)) continue;
    const rb = bWrites.find(r => r.name === ra.name);
    if (rb) {
      seenNames.add(ra.name);
      out.push({ name: ra.name, modeA: ra.mode, modeB: rb.mode });
    }
  }
  return out;
}

/**
 * Detect concurrent conflicting writes to a shared exclusive resource. For each
 * `parallel` fan-out, compute each region node's branch-head set (which target
 * it descends from). Two nodes are CONCURRENT siblings iff their branch-head sets
 * are disjoint and non-empty — sharing a head means one is a sequential
 * descendant within the other's branch, not a concurrent sibling. Two concurrent
 * siblings that both declare write/exclusive on the same-named resource are a
 * violation.
 */
function detectConcurrentWriteConflicts(graph: GraphIR): LintFinding[] {
  const findings: LintFinding[] = [];

  const nodesById = new Map<string, GraphNode>();
  for (const n of graph.nodes) nodesById.set(n.id, n);

  const edgeSuccById = new Map<string, string[]>();
  for (const e of graph.edges) {
    const arr = edgeSuccById.get(e.from);
    if (arr) arr.push(e.to);
    else edgeSuccById.set(e.from, [e.to]);
  }

  const joinIds = new Set<string>();
  for (const n of graph.nodes) if (n.kind === "join") joinIds.add(n.id);

  // Dedup: a node pair can sit inside more than one fan-out region (nesting) and
  // conflict on the same resource — report each (pair, resource) at most once.
  const seen = new Set<string>();

  for (const p of graph.nodes) {
    if (p.kind !== "parallel") continue;

    // Branch-head membership for THIS fan-out: which target(s) each region node descends from.
    const branchHeads = new Map<string, Set<string>>();
    for (const target of p.targets) {
      const region = branchRegion(target, nodesById, edgeSuccById, joinIds);
      for (const nodeId of region) {
        const set = branchHeads.get(nodeId);
        if (set) set.add(target);
        else branchHeads.set(nodeId, new Set([target]));
      }
    }

    const regionNodeIds = [...branchHeads.keys()];
    for (let i = 0; i < regionNodeIds.length; i++) {
      for (let j = i + 1; j < regionNodeIds.length; j++) {
        const aId = regionNodeIds[i];
        const bId = regionNodeIds[j];
        if (aId === undefined || bId === undefined) continue;

        const headsA = branchHeads.get(aId);
        const headsB = branchHeads.get(bId);
        if (!headsA || !headsB) continue;
        // Concurrent iff branch-head sets are disjoint (no shared head).
        if (!disjoint(headsA, headsB)) continue;

        const a = nodesById.get(aId);
        const b = nodesById.get(bId);
        if (!a || !b) continue;

        const [firstId, secondId] = aId < bId ? [aId, bId] : [bId, aId];
        const pair = `${firstId},${secondId}`;
        for (const conflict of conflictingResources(a, b)) {
          const key = `${pair}|${conflict.name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          findings.push({
            rule_id: RULE_ID,
            invariant_id: INVARIANT_ID,
            provenance_class: "INCIDENT_DERIVED",
            layers: [...LAYERS],
            where: pair,
            message:
              `Parallel siblings "${firstId}" and "${secondId}" both declare ` +
              `${conflict.modeA}/${conflict.modeB} access to shared resource ` +
              `"${conflict.name}" within the fan-out at "${p.id}" — concurrent ` +
              `conflicting writes to a shared exclusive resource corrupt it ` +
              `(2026-05-17 shared-.git/ subagent shallow-fetch incident).`,
          });
        }
      }
    }
  }
  return findings;
}

// ── The rule ─────────────────────────────────────────────────────────────────
/**
 * MANDATORY seed rule (R4). The worked example: the 2026-05-17 shared-`.git/`
 * corruption → `parallel nodes declare conflicting write to git-object-db(<repo>)`
 * → lint-time rejection. The predicate generalizes beyond git-object-db to ANY
 * shared write/exclusive resource (keyed on `ResourceDecl.name`, the #2883 IR's
 * designated conflict-key for `resource-conflict lint (#2884)`); git-object-db is
 * the incident that grounds it.
 *
 * v0.1 limitation (recorded in the audit doc): a `subgraph` node's INTERIOR
 * resource writes are invisible to this single-document predicate — only a
 * subgraph's own declared `resources` are the lint surface.
 */
export const gitObjectDbWriteConflictRule: LintRule = {
  id: RULE_ID,
  provenance_class: "INCIDENT_DERIVED",
  trigger_incident:
    "2026-05-17 subagent shallow-fetch incident — a worktree-spawned subagent's " +
    "improvised `git fetch --depth=1` wrote the SHARED `.git/shallow`, corrupting " +
    "every worktree of the clone (memory: feedback_subagents_corrupted_shallow_git; " +
    "MUST_HOLD invariant #6 is the incident-adjacent but DISTINCT no-shallow-fetch " +
    "invariant, enforced at the client-hook layer by git-shallow-fetch-guard.py).",
  mechanism:
    "Parallel branches of a fan-out share one exclusive resource — the repo's " +
    "git-object-db (`.git/`), shared across all worktrees of a clone. Two concurrent " +
    "writers race, and a conflicting write corrupts state fleet-wide. Statically " +
    "decidable: two nodes on distinct sibling branches of one `parallel` fan-out " +
    "both declaring write/exclusive access to the same-named resource.",
  invariant_id: INVARIANT_ID,
  enforcement_layer: "lint",
  predicate: detectConcurrentWriteConflicts,
};

/**
 * The `INCIDENT_DERIVED` rule set consumed by the #2885 linter engine. Each rule
 * is grounded in a real corpus incident (provenance mandatory). v0.1 ports the
 * one incident that is decidable at the IR-lint layer and unowned elsewhere; the
 * audit doc records why the remainder of the corpus is NOT ported here.
 */
export const INCIDENT_DERIVED_RULES: LintRule[] = [
  gitObjectDbWriteConflictRule,
];
