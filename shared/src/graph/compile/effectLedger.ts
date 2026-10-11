// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Effect-ledger preamble emitter — issue #2886 (Graph Engineering Phase 1,
 * sub-issue D), requirement R3.
 *
 * For every `risk_tier >= mutating` effect on a node (comparison via
 * `RISK_TIER_RANK` from #2883's `ir.ts` — a rank map, NEVER a string `>=`, which
 * would silently exempt `destructive`), the compiler emits the three-record
 * `EffectIntent` → perform → `EffectCommitted` ledger sequence (synthesis II.4).
 * The compiler is PURE: these are emitted as DATA (a template the driver writes
 * at runtime onto its chosen substrate — run-transcript JSONL is the v0.1
 * default), never as live writes.
 *
 * Design (R3/R4, double-apply hazard): the `idempotency_key` is derived
 * deterministically from `(node_instance_id, effect signature)` — in v0.1 the
 * compiled artifact is a static plan, so `node_instance_id === node.id` (there is
 * no runtime loop/map instance multiplicity to disambiguate yet). The same effect
 * on the same node therefore yields the SAME fencing token across a crash window,
 * which is exactly what lets a re-performed effect be deduped by its target.
 */
import type { EffectDecl, GraphNode } from "../ir";
import { RISK_TIER_RANK } from "../ir";
import { hashObject } from "../../deterministicJson";
import type { EffectLedgerRecord } from "./types";

/** An effect gets ledger + commit-node treatment iff its rank >= this. */
const MUTATING_RANK = RISK_TIER_RANK.mutating;

/** True iff this node carries at least one `risk_tier >= mutating` effect. */
export function hasMutatingEffect(node: GraphNode): boolean {
  return (node.effects ?? []).some(
    effect => RISK_TIER_RANK[effect.risk_tier] >= MUTATING_RANK
  );
}

/**
 * The node's `mutating+` effects paired with their original IR index (order
 * preserved). Exported (#3162) so C's RUNTIME driver (`execute/effect-ledger.ts`)
 * iterates the SAME rank-filtered effect set the compiler ledgers — single-sourcing
 * the `risk_tier >= mutating` gate so the compiled preamble and the live ledger
 * cannot disagree on WHICH effects are ledgered.
 */
export function mutatingEffectsWithIndex(
  node: GraphNode
): { effect: EffectDecl; index: number }[] {
  return (node.effects ?? [])
    .map((effect, index) => ({ effect, index }))
    .filter(({ effect }) => RISK_TIER_RANK[effect.risk_tier] >= MUTATING_RANK);
}

/**
 * Stable per-(node, effect-index) identifier: `${nodeId}#${index}`. Exported
 * (#3162, ruling R8) so C's runtime driver derives the LEDGER's record correlator
 * from B's runtime `node_instance_id` via the SAME helper — the compiled artifact
 * and the live ledger share one derivation (INT-1 parity). The `effect_id` is the
 * ledger's correlator, NEVER the target-facing dedup token (that is the
 * `idempotency_key` from `deriveIdempotencyKey`).
 */
export function deriveEffectId(nodeId: string, index: number): string {
  return `${nodeId}#${index}`;
}

/**
 * Per-effect fencing key — deterministic hash of `(node_instance_id, effect)`.
 * Uses the DEFAULT `DeterministicJsonOptions` (must match `recordLaunchHash` /
 * `checkResume`, which also use the defaults).
 */
export function deriveIdempotencyKey(
  nodeId: string,
  effect: EffectDecl
): string {
  return hashObject({ node_instance_id: nodeId, effect });
}

/**
 * Node-level commit-node fencing key — deterministic hash over the node id and
 * the ordered list of its `mutating+` effects. For the common single-mutating-
 * effect node this is a one-element list; it is the key V4 asserts a commit node
 * carries.
 */
export function deriveNodeIdempotencyKey(node: GraphNode): string {
  const effects = mutatingEffectsWithIndex(node).map(({ effect }) => effect);
  return hashObject({ node_instance_id: node.id, effects });
}

/** The node's write/exclusive resource names (sorted), used as the ledger `target`. */
function nodeWriteTargets(node: GraphNode): string[] {
  return (node.resources ?? [])
    .filter(r => r.mode === "write" || r.mode === "exclusive")
    .map(r => r.name)
    .sort();
}

/** Authority witnesses for an effect (sorted); `[]` when `authority === "none"`. */
function effectWitness(effect: EffectDecl): string[] {
  return typeof effect.authority === "object"
    ? [...effect.authority.witness].sort()
    : [];
}

/**
 * Build the effect-ledger preamble for a node: the concatenated three-record
 * intent → perform → committed sequence for each `mutating+` effect, in a
 * deterministic order (IR effect order, then phase order — both fixed, so the
 * emission order IS the canonical stable-key order; no re-sort can reorder it).
 * A node with no `mutating+` effect returns `[]` (a readonly node carries no
 * ledger — V3).
 */
export function buildEffectLedger(node: GraphNode): EffectLedgerRecord[] {
  const targets = nodeWriteTargets(node);
  const target = targets.length > 0 ? targets.join(",") : node.id;
  const records: EffectLedgerRecord[] = [];
  for (const { effect, index } of mutatingEffectsWithIndex(node)) {
    const effect_id = deriveEffectId(node.id, index);
    const idempotency_key = deriveIdempotencyKey(node.id, effect);
    records.push({
      phase: "intent",
      effect_id,
      idempotency_key,
      target,
      witness: effectWitness(effect),
      action: `${effect.access}:${effect.risk_tier}`,
    });
    records.push({ phase: "perform", effect_id, idempotency_key });
    records.push({ phase: "committed", effect_id, idempotency_key });
  }
  return records;
}
