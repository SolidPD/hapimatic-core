// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Runtime node identity + execution signature — issue #3161 (Graph Runtime v1,
 * Graph Engineering Phase 3, Wave 1, Sub-Issue B). The identity substrate C/D/E
 * attach to.
 *
 * Three exports, kept ORTHOGONAL (R5 — the id never feeds the signature and
 * vice-versa):
 *   - `encodeNodeInstanceId(node, ctx)` — the ONE canonical logical-identity
 *     encoder. C (#3162 ledger keying) and D (#3163 attempt-tracking) import THIS
 *     helper so every consumer produces the identical id string (KD4). For a
 *     non-multiplied node the id IS exactly `node.id` — no suffix ever (R1), which
 *     keeps runtime idempotency keys byte-identical to the compiler's
 *     `deriveNodeIdempotencyKey(node)` (INT-1 parity).
 *   - `computeExecutionSignature(node)` — the reuse-decision digest (R2).
 *   - `decideReuse(prior, currentSignature)` — the outcome-gated reuse policy (R3).
 *
 * 🔴 RUNTIME MODULE. Lives under `execute/` alongside `executor.ts`; it imports
 * `hashObject` (node:crypto via `../../deterministicJson`), so — like the executor
 * — it is reachable only through the `@hapi/protocol/graph/execute` subpath, never
 * the web-safe root barrel.
 *
 * Grounding: synthesis II.6 (identity/signature model) + II.8 (supersession);
 * expert-review ruling R7 (outcome-gated reuse, U+0000-escape hygiene, pinned
 * `node_revision` field list, definition-level signature honesty).
 */
import { hashObject } from "../../deterministicJson";
import type { GraphNode } from "../ir";
import type { ExecutionOutcome } from "../run-record";
import type { NodeIdentity, NodeMultiplicity } from "./types";

// ── Logical identity (R1, R5) ─────────────────────────────────────────────────

/**
 * The `node_instance_id` component separator. Written as the six-character escape
 * sequence `"\u0000"` (U+0000) — NEVER a raw NUL byte, which would make every
 * source file that carries it binary to grep/rg/diff (in-repo precedent:
 * `compile/strictResume.ts`). U+0000 cannot appear in a human-authored node id or
 * map key in practice, so `${node.id}${SEP}${disc}` splits unambiguously on the
 * FIRST separator — and a `node.id` that DOES contain U+0000 is rejected by
 * `encodeNodeInstanceId` so the invariant holds by construction.
 */
const INSTANCE_ID_SEPARATOR = "\u0000";

/**
 * Resolve a node instance's stable logical identity (`node_instance_id`, II.6).
 *
 * - **Non-multiplied (the v0.1 executor's every call — ctx carries no `itemKey` /
 *   `iterationIndex`)**: returns EXACTLY `node.id` — no suffix ever (R1). This is
 *   load-bearing: the compiler bakes `deriveNodeIdempotencyKey(node)` from
 *   `node.id`, so compiled↔runtime fencing-key parity requires the identical
 *   string (INT-1).
 * - **Resolved `itemKey` (a `map` item, `ir.ts` `map.item_key`, the
 *   `map_no_identity` lint R5)**: appends `item=<key>`.
 * - **Resolved `iterationIndex` (a `loop` iteration, `ir.ts`
 *   `loop.max_iterations`)**: appends `iter=<i>`.
 *
 * Gated on the resolved MULTIPLICITY (`ctx`), not on `node.kind`, so a body node
 * executing under map/loop multiplicity is disambiguated too. A nested case
 * (both keys present) appends both discriminators in a fixed order — decodable by
 * splitting on the separator.
 *
 * Stable across retries/reorders: the id is a pure function of `(node.id,
 * discriminator)` — `ctx.attempt` is deliberately NOT part of the identity (a
 * retry of the SAME instance keeps the SAME id; the attempt lives on the
 * `RunRecordNode`).
 *
 * Signature-assignable to `IdentityHook` (`(node, ctx: NodeMultiplicity) => string`).
 *
 * @throws if `node.id` contains U+0000 (ambiguous with the instance-id separator).
 *   `node.id` is unconstrained `z.string()` (`ir.ts`), so the encoder owns the guard.
 */
export function encodeNodeInstanceId(
  node: GraphNode,
  ctx: NodeMultiplicity
): string {
  if (node.id.includes(INSTANCE_ID_SEPARATOR)) {
    throw new Error(
      `encodeNodeInstanceId: node.id ${JSON.stringify(node.id)} contains U+0000, ` +
        `which is the reserved node_instance_id separator — ambiguous, refusing to encode.`
    );
  }
  const discriminators: string[] = [];
  if (ctx.itemKey !== undefined) discriminators.push(`item=${ctx.itemKey}`);
  if (ctx.iterationIndex !== undefined) {
    discriminators.push(`iter=${ctx.iterationIndex}`);
  }
  // Non-multiplied: bare node id — no suffix ever (R1 MUST; INT-1 parity).
  if (discriminators.length === 0) return node.id;
  return `${node.id}${INSTANCE_ID_SEPARATOR}${discriminators.join(INSTANCE_ID_SEPARATOR)}`;
}

// ── Execution signature (R2) ──────────────────────────────────────────────────

/**
 * Node fields that MUST NOT enter `node_revision`:
 *   - `id`: identity, orthogonal to the signature (R5 — the id never feeds the
 *     signature and vice-versa).
 *   - the declared manifest `contract`/`resources`/`effects`/`capabilities`: each
 *     is folded into the signature EXPLICITLY (`semantic_inputs` / `env_closure`),
 *     so re-including them in `node_revision` would double-count.
 *   - runtime policy `retry` (and #3163's incoming `timeout`/`deadline`): a policy
 *     tweak MUST NOT force a recompute (mirrors policy-field invisibility to the
 *     compiled launch hash). The reserved names are excluded pre-emptively so
 *     #3163 adding them cannot silently perturb every signature.
 */
const NODE_REVISION_EXCLUDED = new Set<string>([
  "id",
  "contract",
  "resources",
  "effects",
  "capabilities",
  "retry",
  "timeout",
  "deadline",
]);

/**
 * The node's DEFINITION digest input: `kind` + `terminal` + the kind-specific
 * SEMANTIC fields (branch arms + default, `parallel.targets`, `map.item_key`,
 * `join.upstreams`, `loop.max_iterations`/`on_exhaustion`, gate id/approver,
 * `subgraph.ref`), with identity / manifest / policy fields removed (see
 * `NODE_REVISION_EXCLUDED`). A NEW semantic field on a construct auto-enters the
 * signature (the safe over-recompute direction); a new policy field must be added
 * to the exclusion set.
 */
function nodeRevision(node: GraphNode): Record<string, unknown> {
  const revision: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (NODE_REVISION_EXCLUDED.has(key)) continue;
    revision[key] = value;
  }
  return revision;
}

/**
 * Compute a node's `execution_signature` — the digest that decides result reuse
 * (synthesis II.6). `digest(node revision, semantic inputs, declared env-dependency
 * closure)`:
 *   - `node_revision`   — the node's semantic definition (see `nodeRevision`).
 *   - `semantic_inputs` — the typed input contract `node.contract?.inputs` (a
 *     port-name→type-NAME map, `ir.ts`).
 *   - `env_closure`     — the declared dependency manifest `{ resources, effects,
 *     capabilities }`.
 *
 * 🔴 DEFINITION-LEVEL in v0.1 (ruling R7): `semantic_inputs` is a type map, NOT
 * runtime values. Reuse-on-same-signature is therefore SAFE only while no real
 * handler values exist — identical definitions with different runtime inputs would
 * collide. A value channel (#2890 / Wave-2 forward contract) is required before
 * reuse semantics may depend on inputs.
 *
 * 🔴 GUARDRAIL (R2): process args, an `args_hash`, and `repo_HEAD_at_start` NEVER
 * enter the signature — none exist in `shared/src/graph/`, so the exclusion holds
 * by construction; this function scopes strictly to the declared IR manifest.
 *
 * Uses `hashObject` (the SAME util `compile/effectLedger.ts` keys fencing with) at
 * its DEFAULT options — so runtime signatures and compiled fencing keys hash on the
 * identical serialization contract. NOTE: default `sortArrays:false` makes
 * declaration ARRAY ORDER signature-relevant, consistent with the effect-ledger keys.
 */
export function computeExecutionSignature(node: GraphNode): string {
  return hashObject({
    node_revision: nodeRevision(node),
    semantic_inputs: node.contract?.inputs,
    env_closure: {
      resources: node.resources,
      effects: node.effects,
      capabilities: node.capabilities,
    },
  });
}

/**
 * THE B-owned identity encoder (architect-review F2) — co-produces BOTH the
 * `node_instance_id` and the `execution_signature` for a node instance from a
 * single call, so C/#3162 and D/#3163 consume ONE identity source and the id and
 * signature cannot drift (a separate signature hook would be the second encoder
 * INT-1 forbids). This is the executor's default `IdentityHook` (it REPLACES
 * A/#3160's `{ node.id, "" }` no-op default, materializing the real signature).
 *
 * Synchronous (F10): both components are sync (`hashObject` is sync). `ctx.attempt`
 * does NOT affect the result (F1) — identity is stable across attempts, and the
 * signature is definition-level.
 */
export function encodeNodeIdentity(
  node: GraphNode,
  ctx: NodeMultiplicity
): NodeIdentity {
  return {
    node_instance_id: encodeNodeInstanceId(node, ctx),
    execution_signature: computeExecutionSignature(node),
  };
}

// ── Outcome-gated reuse policy (R3) ────────────────────────────────────────────

/** The prior-attempt facts `decideReuse` gates on. */
export interface PriorAttempt {
  /** The prior attempt's `execution_signature`. */
  execution_signature: string;
  /** The prior attempt's lifecycle outcome (II.5 Layer 1). */
  outcome: ExecutionOutcome;
}

/**
 * Decide whether a re-encountered node instance may REUSE its prior canonical
 * result or MUST RECOMPUTE it as a new attempt (synthesis II.6/II.8; ruling R7 /
 * finding 3161-1 HIGH, refutation-tested).
 *
 * Reuse ONLY when the signatures are EQUAL **and** the prior `outcome` is
 * `"succeeded"`. ANY non-succeeded prior (`waiting`, `failed_retryable`,
 * `failed_terminal`, `timed_out`, `cancelled`, `refused`, `skipped`) ⇒ recompute.
 *
 * The outcome gate is load-bearing: an UNCONDITIONAL "same signature ⇒ reuse"
 * would freeze a paused/failed attempt as canonical and regress the A5 recovery
 * invariant (a paused `waiting` gate must re-execute as `canonical_attempt: 2` →
 * `completed_terminal`). PURE — no I/O, no clock — so it is the stable policy C/D
 * and Wave-2's value channel consume.
 */
export function decideReuse(
  prior: PriorAttempt,
  currentSignature: string
): "reuse" | "recompute" {
  return prior.execution_signature === currentSignature &&
    prior.outcome === "succeeded"
    ? "reuse"
    : "recompute";
}
