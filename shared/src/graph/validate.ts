// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Structural validator for the v0.1 Graph IR — issue #2883 (Graph Engineering
 * Phase 1, sub-issue A). `GraphIRSchema.safeParse` covers shape + unknown-kind
 * rejection, but three invariants are graph-GLOBAL and cannot be expressed in a
 * per-node schema: duplicate node ids, dangling references, and (surfaced
 * uniformly) unknown constructs. This module aggregates all of them into one
 * coded, id-naming error list (R4).
 *
 * Reused by #2885 (linter): its engine maps each `IRError.code` to a canonical
 * invariant_id, so the codes are a stable contract — `loop_unbounded` and
 * `map_no_identity` are DISTINCT codes, never folded into the catch-all `schema`.
 */
import { CONSTRUCT_KINDS, GraphIRSchema, type GraphIR } from "./ir";

/** Distinct, contract-stable structural error codes (consumed by #2885). */
export type IRErrorCode =
  | "unknown_construct"
  | "dangling_ref"
  | "duplicate_id"
  | "loop_unbounded"
  | "map_no_identity"
  | "schema";

/** A single structural finding. `where` names the offending id/path (R4). */
export interface IRError {
  code: IRErrorCode;
  where: string;
  message: string;
}

/** Discriminated result — `graph` is only present on success. */
export type GraphValidateResult =
  | { ok: true; graph: GraphIR }
  | { ok: false; errors: IRError[] };

// ── Defensive raw-input accessors (input is `unknown` until proven valid) ─────
type RawRecord = Record<string, unknown>;
const asRecord = (v: unknown): RawRecord | undefined =>
  typeof v === "object" && v !== null ? (v as RawRecord) : undefined;
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asString = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

/** Render a Zod issue path as `nodes[0].kind`-style locator. */
function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${seg}]`;
    else out += out ? `.${String(seg)}` : String(seg);
  }
  return out || "<root>";
}

const KNOWN_KINDS = new Set<string>(CONSTRUCT_KINDS);

/**
 * Validate a candidate graph. Returns the parsed `GraphIR` on success, or an
 * aggregated list of coded errors on failure. Never throws — malformed input
 * yields errors, not exceptions.
 */
export function validateGraphIR(input: unknown): GraphValidateResult {
  const errors: IRError[] = [];

  const parsed = GraphIRSchema.safeParse(input);

  const root = asRecord(input);
  const rawNodes = asArray(root?.nodes);
  const rawEdges = asArray(root?.edges);

  // ── Step 1: map schema (shape / unknown-kind / missing-field) issues ────────
  if (!parsed.success) {
    const unknownReported = new Set<number>();
    for (const issue of parsed.error.issues) {
      const path = issue.path;
      const nodeIndex =
        path[0] === "nodes" && typeof path[1] === "number" ? path[1] : -1;

      if (nodeIndex < 0) {
        errors.push({
          code: "schema",
          where: formatPath(path),
          message: issue.message,
        });
        continue;
      }

      const node = asRecord(rawNodes[nodeIndex]);
      const kind = asString(node?.kind);
      const nodeId = asString(node?.id) ?? `nodes[${nodeIndex}]`;
      const field = path[2];

      // Unknown / missing construct kind: the discriminatedUnion could not match
      // a member. Index the raw input to name the offending kind (R4).
      if (kind === undefined || !KNOWN_KINDS.has(kind)) {
        if (!unknownReported.has(nodeIndex)) {
          unknownReported.add(nodeIndex);
          errors.push({
            code: "unknown_construct",
            where: `nodes[${nodeIndex}]`,
            message: `Unknown construct kind ${JSON.stringify(
              node?.kind
            )} at nodes[${nodeIndex}] (id: ${nodeId}); valid kinds: ${CONSTRUCT_KINDS.join(
              ", "
            )}`,
          });
        }
        continue;
      }

      // A matched kind with a missing/invalid required field maps to the DISTINCT
      // code #2885 expects (never the catch-all `schema`).
      if (
        kind === "loop" &&
        (field === "max_iterations" || field === "on_exhaustion")
      ) {
        errors.push({
          code: "loop_unbounded",
          where: nodeId,
          message: `Loop node "${nodeId}" has a missing or invalid "${String(
            field
          )}" — a bounded loop requires both max_iterations (positive int) and on_exhaustion (R5)`,
        });
        continue;
      }
      if (kind === "map" && field === "item_key") {
        errors.push({
          code: "map_no_identity",
          where: nodeId,
          message: `Map node "${nodeId}" is missing "item_key" — a keyed map requires a stable item-identity key (R5)`,
        });
        continue;
      }

      errors.push({
        code: "schema",
        where: formatPath(path),
        message: issue.message,
      });
    }
  }

  // ── Step 2: duplicate node ids (graph-global; safeParse cannot see this) ────
  const idCounts = new Map<string, number>();
  for (const raw of rawNodes) {
    const id = asString(asRecord(raw)?.id);
    if (id !== undefined) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  }
  for (const [id, count] of idCounts) {
    if (count > 1) {
      errors.push({
        code: "duplicate_id",
        where: id,
        message: `Duplicate node id "${id}" appears ${count} times — node ids must be unique`,
      });
    }
  }

  // ── Step 3: dangling references (every ref must resolve to a node id) ────────
  const idSet = new Set<string>(idCounts.keys());
  type Ref = { where: string; target: string };
  const refs: Ref[] = [];

  rawEdges.forEach((raw, i) => {
    const edge = asRecord(raw);
    const from = asString(edge?.from);
    const to = asString(edge?.to);
    if (from !== undefined)
      refs.push({ where: `edges[${i}].from`, target: from });
    if (to !== undefined) refs.push({ where: `edges[${i}].to`, target: to });
  });

  for (const raw of rawNodes) {
    const node = asRecord(raw);
    if (!node) continue;
    const nid = asString(node.id) ?? "<node>";
    switch (asString(node.kind)) {
      case "branch": {
        asArray(node.branches).forEach((b, j) => {
          const to = asString(asRecord(b)?.to);
          if (to !== undefined)
            refs.push({ where: `${nid}.branches[${j}].to`, target: to });
        });
        const def = asString(node.default);
        if (def !== undefined)
          refs.push({ where: `${nid}.default`, target: def });
        break;
      }
      case "parallel":
        asArray(node.targets).forEach((t, j) => {
          const target = asString(t);
          if (target !== undefined)
            refs.push({ where: `${nid}.targets[${j}]`, target });
        });
        break;
      case "join":
        asArray(node.upstreams).forEach((u, j) => {
          const target = asString(u);
          if (target !== undefined)
            refs.push({ where: `${nid}.upstreams[${j}]`, target });
        });
        break;
      case "loop": {
        const route = asString(node.on_exhaustion);
        if (route !== undefined)
          refs.push({ where: `${nid}.on_exhaustion`, target: route });
        break;
      }
      case "subgraph": {
        const ref = asString(node.ref);
        if (ref !== undefined) refs.push({ where: `${nid}.ref`, target: ref });
        break;
      }
      default:
        break;
    }
  }

  for (const ref of refs) {
    if (!idSet.has(ref.target)) {
      errors.push({
        code: "dangling_ref",
        where: ref.where,
        message: `Reference "${ref.target}" (${ref.where}) does not resolve to any node id`,
      });
    }
  }

  // ── Verdict ─────────────────────────────────────────────────────────────────
  if (parsed.success && errors.length === 0) {
    return { ok: true, graph: parsed.data };
  }
  return { ok: false, errors };
}
