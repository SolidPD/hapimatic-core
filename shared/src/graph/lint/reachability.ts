// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shared graph-reachability predicates for the Graph Engineering linter — the
 * single home for the forward-successor / branch-region helpers used by BOTH
 * #2884's `INCIDENT_DERIVED` rules (`incident-derived.ts`) AND #2885's
 * `SEMANTIC_INVARIANT` rules (`semantic-invariant.ts`). Extracted (#3109) from
 * the duplicated copies that previously lived in each file, so there is exactly
 * one definition of each predicate — editing the traversal semantics here edits
 * them for both consumers by construction.
 *
 * All predicates are PURE and read only the v0.1 IR (#2883) graph structure (no
 * execution state), so both rule sets stay deterministic.
 */
import type { GraphNode } from "../ir";

/** True iff two sets share no element (used for the branch-head concurrency test). */
export function disjoint(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>
): boolean {
  for (const x of a) if (b.has(x)) return false;
  return true;
}

/**
 * Forward structural targets of a node (plain `edges` are added by the caller):
 * `parallel` fan-out, `branch` arms + default, `loop` exhaustion route.
 * `subgraph.ref` is deliberately NOT followed (v0.1 treats a subgraph as opaque)
 * and `join.upstreams` are fan-IN, not forward successors.
 */
function structuralTargets(node: GraphNode): string[] {
  switch (node.kind) {
    case "parallel":
      return [...node.targets];
    case "branch":
      return [...node.branches.map(b => b.to), node.default];
    case "loop":
      return [node.on_exhaustion];
    default:
      return [];
  }
}

/**
 * Forward control-flow successors of a node: its outgoing `edges` PLUS the
 * kind-specific structural targets (parallel fan-out, branch arms + default, loop
 * exhaustion route). Subgraph `ref` is deliberately NOT followed — v0.1 treats a
 * subgraph as OPAQUE (its own declared resources are the lint surface; its
 * interior is invisible to a single-document predicate). Join `upstreams` are
 * fan-IN, not forward edges, so they are never successors.
 */
export function successorsOf(
  node: GraphNode,
  edgeSucc: readonly string[]
): string[] {
  return [...edgeSucc, ...structuralTargets(node)];
}

/**
 * Nodes reachable from `startId` following successors, STOPPING at (and never
 * entering or crossing) any join node — a join is the fan-out's region boundary.
 * A post-join node is therefore excluded from every branch region, so a writer
 * that runs after the join is never treated as concurrent with an in-region
 * writer (negative case ii: in-region-vs-post-join → no conflict).
 */
export function branchRegion(
  startId: string,
  nodesById: ReadonlyMap<string, GraphNode>,
  edgeSuccById: ReadonlyMap<string, string[]>,
  joinIds: ReadonlySet<string>
): Set<string> {
  const visited = new Set<string>();
  const stack: string[] = [startId];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (visited.has(id)) continue;
    if (joinIds.has(id)) continue; // region boundary — exclude the join and everything past it
    visited.add(id);
    const node = nodesById.get(id);
    if (!node) continue; // dangling ref — validateGraphIR (#2883) owns that error class
    for (const s of successorsOf(node, edgeSuccById.get(id) ?? [])) {
      if (!visited.has(s)) stack.push(s);
    }
  }
  return visited;
}
