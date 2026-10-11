// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Mermaid visualizer for the v0.1 Graph IR — issue #2887 (Graph Engineering
 * Phase 1, sub-issue E). `toMermaid(graph)` renders a `GraphIR` (#2883) as a
 * Mermaid `flowchart TD` string: one shape per construct kind, the control-flow
 * edges (explicit `edges[]` plus each construct's structural targets), and a
 * compact resource/effect annotation suffix on every labeled node.
 *
 * 🔴 WEB-SAFE MODULE — pure string output, no runtime dependency. It imports only
 * TYPES from `../ir` (erased at build), so it is safe to re-export from the root
 * barrel (`shared/src/graph/index.ts`) that web's `node:*`-free tsconfig consumes.
 * GitHub markdown renders ```` ```mermaid ```` fences natively, which alone
 * justifies the zero-runtime text-Mermaid choice (expert review 2887-7).
 *
 * Output discipline (expert review 2887-5) — the reason every label is
 * double-quoted and every id is sanitized:
 *  - ALL labels are wrapped in `"…"` in every shape form (`id["…"]`, `id{"…"}`,
 *    `id{{"…"}}`, `id[/"…"/]`, …) with any embedded `"` escaped as `#quot;`. The
 *    IR's own annotation strings carry parens (e.g. `git-object-db(<repo>)`),
 *    which break an UNQUOTED Mermaid label — quoting makes parens safe.
 *  - Every emitted node/subgraph id is sanitized to `[A-Za-z0-9_]` behind an
 *    `n_` / `sg_` prefix, so a raw IR id can never collide with a reserved
 *    Mermaid keyword. In particular a node whose IR id is the reserved flowchart
 *    keyword `end` becomes `n_end`, NEVER a bare `end` (the `end` token this file
 *    does emit is only a `subgraph … end` block terminator, which is legal).
 *  - A `loop` node emits a self-edge labeled `max <n>` AND a real edge to its
 *    `on_exhaustion` target, so neither bound field is silently dropped.
 *
 * Consumes (Epic-1 exit audit, #2887 Task 6): the visualizer is the ONE consumer
 * that touches every one of the 8 construct kinds — closing the "no kind without
 * a consumer" loop that the compiler (which lowers only id/kind/effects in v0.1)
 * leaves open for the routing constructs.
 */
import type { EffectDecl, GraphIR, GraphNode, ResourceDecl } from "../ir";

/** Sanitize a raw IR id to a Mermaid-safe token body (`[A-Za-z0-9_]`). */
function sanitize(rawId: string): string {
  return rawId.replace(/[^A-Za-z0-9_]/g, "_");
}

/**
 * Escape a label for a DOUBLE-QUOTED Mermaid label. Only `"` needs escaping
 * inside `"…"` (Mermaid's `#quot;` entity); parens/spaces/other punctuation are
 * safe once quoted. This is the load-bearing fix for the paren-label regression
 * (2887-5) — the caller ALWAYS wraps the result in `"…"`.
 */
function escapeLabel(label: string): string {
  return label.replace(/"/g, "#quot;");
}

/** Compact `key value` resource annotation, e.g. `write git-object-db(repo)`. */
function resourceAnnotation(resource: ResourceDecl): string {
  return `${resource.mode} ${resource.name}`;
}

/** Compact effect annotation, e.g. `effect write/mutating`. */
function effectAnnotation(effect: EffectDecl): string {
  return `effect ${effect.access}/${effect.risk_tier}`;
}

/**
 * The human-readable label for a node — id, kind, then a deterministic run of
 * resource/effect/gate/terminal/retry annotations, ` | `-joined. Deterministic
 * (IR declaration order, no Map/Set iteration) so the output is snapshot-stable.
 */
function nodeLabel(node: GraphNode): string {
  const parts: string[] = [node.id, node.kind];
  if (node.kind === "human_gate") {
    parts.push(`gate:${node.gate_id}`, `approver:${node.approver}`);
  }
  for (const resource of node.resources ?? []) {
    parts.push(resourceAnnotation(resource));
  }
  for (const effect of node.effects ?? []) {
    parts.push(effectAnnotation(effect));
  }
  if (node.retry) parts.push(`retry<=${node.retry.max}`);
  if (node.terminal) parts.push("terminal");
  return parts.join(" | ");
}

/**
 * Render one node as its kind-specific Mermaid shape (subgraph is handled
 * separately by the caller — it becomes a block, not an inline shape). Throws on
 * an unknown kind (defensive — the IR discriminated union should make this
 * unreachable, but a hand-built `GraphNode` cast could smuggle one through).
 */
function nodeShape(node: GraphNode, mid: string): string {
  const label = `"${escapeLabel(nodeLabel(node))}"`;
  switch (node.kind) {
    case "sequence":
      return `${mid}[${label}]`;
    case "branch":
      return `${mid}{${label}}`;
    case "human_gate":
      return `${mid}{{${label}}}`;
    case "parallel":
      return `${mid}[/${label}/]`;
    case "join":
      return `${mid}[\\${label}\\]`;
    case "map":
      return `${mid}[[${label}]]`;
    case "loop":
      return `${mid}((${label}))`;
    case "subgraph":
      // Handled as a block by toMermaid; nodeShape is never called for it.
      return `${mid}[${label}]`;
    default: {
      const unknown = node as { kind?: unknown };
      throw new Error(
        `toMermaid: unknown node kind ${JSON.stringify(unknown.kind)}`
      );
    }
  }
}

/** Render a `label`-carrying edge, or a plain edge when `label` is empty. */
function edgeLine(from: string, to: string, label?: string): string {
  return label
    ? `  ${from} -->|"${escapeLabel(label)}"| ${to}`
    : `  ${from} --> ${to}`;
}

/**
 * Render a `GraphIR` as a Mermaid `flowchart TD` string.
 *
 * Layout order (fully deterministic — IR array order, no re-sort):
 *  1. `flowchart TD` header
 *  2. one shape line per non-subgraph node (in `graph.nodes` order)
 *  3. explicit `edges[]` (in `graph.edges` order)
 *  4. structural edges per construct: branch arms + default, parallel fan-out,
 *     join fan-in, loop self-edge + exhaustion route
 *  5. `subgraph … end` blocks for every `subgraph` node
 */
export function toMermaid(graph: GraphIR): string {
  // Kind-aware id mapping: a subgraph node is referenced by an `sg_` id (its
  // block), every other node by an `n_` id. Refs/targets resolve through the
  // same map so an edge into a subgraph points at its block.
  const kindById = new Map<string, GraphNode["kind"]>();
  for (const node of graph.nodes) kindById.set(node.id, node.kind);
  const mid = (rawId: string): string =>
    `${kindById.get(rawId) === "subgraph" ? "sg_" : "n_"}${sanitize(rawId)}`;

  const lines: string[] = ["flowchart TD"];
  const subgraphBlocks: string[] = [];

  // (2) node shapes / subgraph blocks
  for (const node of graph.nodes) {
    if (node.kind === "subgraph") {
      const label = `"${escapeLabel(nodeLabel(node))}"`;
      subgraphBlocks.push(`  subgraph ${mid(node.id)}[${label}]`);
      subgraphBlocks.push(`    ${mid(node.ref)}`);
      subgraphBlocks.push("  end");
    } else {
      lines.push(`  ${nodeShape(node, mid(node.id))}`);
    }
  }

  // (3) explicit control-flow edges
  for (const edge of graph.edges) {
    lines.push(edgeLine(mid(edge.from), mid(edge.to)));
  }

  // (4) structural edges implied by each construct's kind-specific targets
  for (const node of graph.nodes) {
    switch (node.kind) {
      case "branch":
        for (const arm of node.branches) {
          lines.push(edgeLine(mid(node.id), mid(arm.to), arm.when));
        }
        lines.push(edgeLine(mid(node.id), mid(node.default), "default"));
        break;
      case "parallel":
        for (const target of node.targets) {
          lines.push(edgeLine(mid(node.id), mid(target)));
        }
        break;
      case "join":
        for (const upstream of node.upstreams) {
          lines.push(edgeLine(mid(upstream), mid(node.id)));
        }
        break;
      case "loop":
        lines.push(
          edgeLine(mid(node.id), mid(node.id), `max ${node.max_iterations}`)
        );
        lines.push(
          edgeLine(mid(node.id), mid(node.on_exhaustion), "on_exhaustion")
        );
        break;
      default:
        break;
    }
  }

  return [...lines, ...subgraphBlocks].join("\n");
}
