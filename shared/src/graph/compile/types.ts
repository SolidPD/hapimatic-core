// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Compiled-artifact TYPES — issue #2886 (Graph Engineering Phase 1, sub-issue D).
 *
 * 🔴 WEB-SAFE MODULE (no `node:crypto`, no `deterministicJson` import). This is the
 * ONLY compile module the root barrel (`shared/src/graph/index.ts` →
 * `shared/src/index.ts`) transitively exports, so it must stay free of any Node
 * builtin — web's tsconfig excludes `@types/node` (`types: ["vite/client"]`) and
 * would fail to resolve a `node:*` import pulled in through the barrel. The
 * node:crypto RUNTIME (`compiler.ts` / `effectLedger.ts` / `strictResume.ts`) is
 * exposed ONLY via the `@hapi/protocol/graph/compile` subpath, mirroring the
 * repo's `@hapi/protocol/gitRoot` (node:fs) subpath pattern.
 *
 * These types are the CF-8 cross-epic contract consumed by #2887 (the web
 * visualizer — hence the web-safety requirement above) and Phase-2 #2890/#2891;
 * a type-snapshot test (`compiler.test.ts`) locks the shape against drift.
 */
import type { ConstructKind } from "../ir";

/**
 * The compiled-artifact node vocabulary (epic ruling D1-B). Distinct from the 8
 * AUTHORED IR construct kinds — these are the LOWERED kinds the compiler emits:
 *  - `step`   — a deterministic lowered work unit
 *  - `commit` — an effect-commit node (carries a required `idempotency_key`)
 *  - `gate`   — a lowered `human_gate`
 * v0.1 compiled artifacts contain NO agent-body construct.
 */
export type CompiledNodeKind = "step" | "commit" | "gate";

/** The compiled-artifact format version (CF-8: locked by a type-snapshot test). */
export const COMPILED_ARTIFACT_VERSION = "0.1" as const;
export type CompiledArtifactVersion = typeof COMPILED_ARTIFACT_VERSION;

/** Phase of the intent → perform → committed effect-ledger sequence (synthesis II.4). */
export type LedgerPhase = "intent" | "perform" | "committed";

/**
 * Deterministic phase-ordering rank. Preserves causal order (intent before
 * perform before committed) when the ledger array is emitted — an alphabetical
 * sort would wrongly place "committed" first.
 */
export const LEDGER_PHASE_RANK: Record<LedgerPhase, number> = {
  intent: 0,
  perform: 1,
  committed: 2,
};

/**
 * One record of the compiled effect-ledger preamble (synthesis II.4 shapes).
 *
 * A discriminated union on `phase`: only the `intent` record carries the
 * compile-time-derivable descriptor fields (`target`/`witness`/`action`). The
 * `perform` record carries the fencing `idempotency_key` into the actual
 * operation; the `committed` record is a compile-time TEMPLATE — its runtime
 * `outcome`/`proof` (synthesis II.4 `EffectCommitted`) are filled by the driver
 * when the effect completes, so they are deliberately absent from the pure
 * compiled artifact.
 */
export type EffectLedgerRecord =
  | {
      phase: "intent";
      /** Stable per-(node, effect-index) identifier: `${nodeId}#${index}`. */
      effect_id: string;
      /** Deterministic fencing key derived from (node_instance_id, effect signature). */
      idempotency_key: string;
      /** What is mutated — the node's write/exclusive resource names, else the node id. */
      target: string;
      /** Authority witnesses required (from `effect.authority.witness`); `[]` when none. */
      witness: string[];
      /** Compile-time action descriptor: `${access}:${risk_tier}`. */
      action: string;
    }
  | { phase: "perform"; effect_id: string; idempotency_key: string }
  | { phase: "committed"; effect_id: string; idempotency_key: string };

/** A lowered node in the compiled artifact. */
export interface CompiledNode {
  /** Stable node id, carried through from the IR node. */
  id: string;
  /** Lowered vocabulary kind (see `CompiledNodeKind`). */
  kind: CompiledNodeKind;
  /** The authored IR construct kind this lowered from (traceability / viz #2887). */
  source_kind: ConstructKind;
  /** commit nodes ONLY: the deterministic node-level fencing key (R4). */
  idempotency_key?: string;
  /** commit nodes ONLY: the effect-ledger preamble (3 records per `mutating+` effect, R3). */
  ledger?: EffectLedgerRecord[];
}

/** A lowered control-flow edge. */
export interface CompiledEdge {
  from: string;
  to: string;
}

/**
 * The compiled workflow artifact — the v0.1 "smallest explicit execution model"
 * (charter III). It captures node CLASSIFICATION (step/commit/gate),
 * commit-node fencing + ledger, and control-flow topology (edges). Intra-node
 * routing predicates (branch arms, loop bounds) are NOT lowered in v0.1 — that
 * is a Phase-2 concern (#2890). This shape is a CROSS-EPIC CONTRACT (CF-8)
 * consumed by #2887 (visualizer) and Phase-2 #2890/#2891.
 */
export interface CompiledWorkflow {
  /** Compiled-artifact format version. */
  compiled_version: CompiledArtifactVersion;
  /** The source graph id. */
  graph_id: string;
  /** Lowered nodes, in canonical order (sorted by `id`). */
  nodes: CompiledNode[];
  /** Lowered edges, in canonical order (sorted by `from`, then `to`). */
  edges: CompiledEdge[];
}
