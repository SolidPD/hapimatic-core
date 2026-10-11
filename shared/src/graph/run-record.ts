// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `RunRecord` — the canonical execution view over a graph run (issue #2891,
 * Graph Engineering Phase 2, Sub-Issue C, requirement R1).
 *
 * 🔴 CROSS-EPIC GAP realized here (directive Key Decision + synthesis II.8): the
 * canonical execution view is a synthesis concept that NO Phase-1 sub-issue built
 * explicitly. Phase-1 arguably could have owned it, but Phase-2 is where it is
 * first NEEDED — the benchmark (#2891) produces a `RunRecord` per workflow and
 * the evidence report (#2892) READS it by field. It is therefore defined in the
 * shared `@hapi/protocol/graph` surface, not in a script.
 *
 * 🔒 PINNED public contract (mirrors the `LintFinding` discipline, lint/types.ts):
 * `RunRecord` is a cross-epic contract consumed by #2892 (which reads it by
 * field), so its shape is locked by the type-snapshot test in `run-record.test.ts`.
 * Do NOT add / remove / rename a field without updating #2892 and bumping the
 * snapshot. Each field below carries a `// consumer:` annotation — the "no field
 * without a consumer" discipline inherited from `ir.ts` / the compile types.
 *
 * 🔴 WEB-SAFE MODULE. This module is re-exported from the root graph barrel
 * (`shared/src/graph/index.ts` → `shared/src/index.ts`), so — like the compile
 * TYPES — it MUST stay free of any `node:*` builtin. Its only import is `zod`
 * (already the barrel's single runtime dependency, pulled in via `lint/types.ts`).
 * The SHA-256 the run stores (`script_sha256`) is a *value* copied from
 * `recordLaunchHash` (which lives in the node:crypto `@hapi/protocol/graph/compile`
 * runtime) — this module never COMPUTES a hash, so it needs no crypto import.
 *
 * Modeled on the in-repo prior art `server/src/store/parityRuns.ts`
 * (`ParityRunRecord`) plus synthesis Part II — II.8 (canonical execution view)
 * and II.5 (the three-layer outcome model).
 */
import { z } from "zod";

// ── II.5 Layer 1 — execution lifecycle (the per-node `outcome`) ──────────────
/**
 * The execution-lifecycle outcome of a single node instance (synthesis II.5
 * Layer 1). `refused` is FIRST-CLASS (a refusal is neither a failure nor a
 * success). This is the vocabulary that makes metric A3 ("is it clear WHY
 * execution stopped?") answerable — a terminal state is always one of these
 * NAMED outcomes, never "unknown".
 */
export const EXECUTION_OUTCOMES = [
  "succeeded",
  "failed_retryable",
  "failed_terminal",
  "refused",
  "timed_out",
  "cancelled",
  "waiting",
  "skipped",
] as const;
export const ExecutionOutcomeSchema = z.enum(EXECUTION_OUTCOMES);
export type ExecutionOutcome = z.infer<typeof ExecutionOutcomeSchema>;

// ── II.5 Layer 3 — effect lifecycle (the runtime write-ahead ledger) ─────────
/**
 * The layer-3 effect-lifecycle state of a single `risk_tier >= mutating` effect
 * (synthesis II.5 Layer 3, issue #3162). ORTHOGONAL to the layer-1 `outcome`
 * above: `outcome` classifies whether the NODE ran; this classifies whether the
 * node's EFFECT durably landed (`JOURNALED RESULT != DURABLY SAFE EXTERNAL
 * EFFECT`, synthesis II.7). Vocabulary mirrors the II.1 state machine:
 *   - `n/a`         — a readonly / non-mutating effect (no ledger treatment).
 *   - `prepared`    — `EffectIntent` recorded, effect not yet performed (also the
 *                     re-armed state after a `safe_to_retry` reconcile).
 *   - `committed`   — `EffectCommitted` recorded; the effect durably landed.
 *   - `in_doubt`    — intent recorded, perform ambiguous (crash/cancel window);
 *                     blind retry is forbidden until reconciled (II.1).
 *   - `reconciled`  — a `queryable` probe PROVED a prior in-doubt effect had
 *                     already durably applied (post-doubt confirmation).
 *   - `compensated` — an in-doubt `{compensatable}` effect was rolled back.
 */
export const EFFECT_LIFECYCLE_STATES = [
  "n/a",
  "prepared",
  "committed",
  "in_doubt",
  "reconciled",
  "compensated",
] as const;
export const EffectLifecycleSchema = z.enum(EFFECT_LIFECYCLE_STATES);
export type EffectLifecycle = z.infer<typeof EffectLifecycleSchema>;

// ── Run-level stop reason (A3 — always NAMED, never "unknown") ───────────────
/**
 * Why the whole run stopped. A closed enum, so a run's stop reason is STRUCTURALLY
 * never "unknown" — that is precisely what metric A3 asserts. `completed_terminal`
 * = a `terminal: true` node succeeded; `interrupted` = the run was stopped
 * mid-flight (the fault-injection recovery scenario, R2/A5); the remainder mirror
 * the II.5 Layer-1 terminal outcomes for a run that ended abnormally.
 * // consumer: #2891 benchmark A3 answer + #2892 evidence report (per-run stop reason)
 */
export const RUN_STOPPED_REASONS = [
  "completed_terminal",
  "interrupted",
  "refused",
  "failed_terminal",
  "cancelled",
  "no_successor",
] as const;
export const RunStoppedReasonSchema = z.enum(RUN_STOPPED_REASONS);
export type RunStoppedReason = z.infer<typeof RunStoppedReasonSchema>;

// ── II.8 canonical per-node execution entry ──────────────────────────────────
/**
 * The canonical execution view of ONE `node_instance_id` (synthesis II.8). The
 * append-only journal retains superseded + duplicate entries across resumes
 * (right for audit, wrong for "current logical result"); this record materializes
 * the canonical view WITHOUT touching journal history.
 */
export const RunRecordNodeSchema = z
  .object({
    /**
     * Monotonic execution ordinal within the run (0-based). Recovers the order
     * in which node instances executed — the basis for explaining which branch
     * arm / join path was taken (A2: a successor's presence at a later epoch,
     * with the non-taken arm's target ABSENT, recovers the decision).
     * // consumer: #2891 A2 branch/join explainability + #2892 execution ordering
     */
    execution_epoch: z.number().int().nonnegative(),
    /**
     * Which attempt is canonical for this node (1-based). A resume that recomputes
     * a node (changed signature, II.6) increments this and lists the prior
     * attempt in `supersedes`.
     * // consumer: #2891 recovery scenario (A5) + #2892 canonical-attempt display
     */
    canonical_attempt: z.number().int().positive(),
    /**
     * `canonical_result_ref`s of prior attempts this instance supersedes (empty
     * on a first, un-resumed attempt). Materializes II.8's "mark old superseded"
     * without erasing the journal.
     * // consumer: #2891 recovery scenario (A5) + #2892 supersession chain
     */
    supersedes: z.array(z.string()),
    /**
     * A stable reference to THIS attempt's canonical result. Deterministic
     * (derived from run_id + node id + attempt), never a wall-clock/random token,
     * so a re-run of the same compiled artifact yields byte-identical refs.
     * // consumer: #2892 result-pointer + this record's own `supersedes` links
     */
    canonical_result_ref: z.string(),
    /**
     * The node instance's execution-lifecycle outcome (II.5 Layer 1).
     * // consumer: #2891 A1/A3/A7 answers + #2892 per-node outcome
     */
    outcome: ExecutionOutcomeSchema,
    /**
     * The II.6 reuse-decision digest for this attempt — `digest(node revision,
     * semantic inputs, declared env-dependency closure)`, computed by
     * `execute/identity.ts#computeExecutionSignature`. Materializes the runtime
     * identity B/#3161 tracks alongside the four supersession fields above. On a
     * resume, the SAME `node_instance_id` with a CHANGED signature — OR a
     * non-`succeeded` prior — recomputes and supersedes the prior attempt (II.6/
     * II.8, ruling R7 `decideReuse`); an equal signature over a `succeeded` prior
     * is the ONLY reuse case. DEFINITION-LEVEL in v0.1 (scopes to the declared IR
     * manifest, not runtime handler values).
     * // consumer: #3161 supersession decision (decideReuse) + #3162/#3163 keying
     */
    execution_signature: z.string(),
    /**
     * The synthesis II.5 Layer-3 effect-lifecycle state per `effect_id` for this
     * node instance (issue #3162). OPTIONAL and absent for non-mutating nodes and
     * the phase-2 workflows, so `.strict()` stays green without churn — a value
     * is present ONLY when a commit-lowered node ran through the runtime ledger.
     * Keyed by `effect_id` (`${node_instance_id}#${effectIndex}`), the ledger's
     * record correlator (NOT the target-facing `idempotency_key`). Kept ORTHOGONAL
     * to the layer-1 `outcome` above (II.7: a journaled result is not proof of a
     * durable external effect).
     * // consumer: #3162 runtime effect ledger (layer-3 surface) + #2892 effect-state display (additive optional read)
     */
    effects: z.record(z.string(), EffectLifecycleSchema).optional(),
  })
  .strict();
export type RunRecordNode = z.infer<typeof RunRecordNodeSchema>;

// ── The RunRecord (locked cross-epic shape — directive Task 1) ───────────────
/**
 * The canonical execution view of one graph run. Its shape is the directive's
 * locked contract, grounded in II.8 (per-`node_instance_id` canonical view +
 * run-level token columns) and II.5 (the `outcome` / `stopped_reason` vocabulary).
 */
export const RunRecordSchema = z
  .object({
    /**
     * Stable run identifier. Deterministic — derived from the graph id + the
     * launch hash — so re-running the same compiled artifact reproduces the same
     * run_id (the benchmark's reproducibility invariant).
     * // consumer: #2892 run identity + evidence-file naming
     */
    run_id: z.string(),
    /**
     * The source graph's id (`GraphIR.id` / `CompiledWorkflow.graph_id`).
     * // consumer: #2892 workflow → run correlation
     */
    graph_id: z.string(),
    /**
     * The launch-time SHA-256 of the compiled artifact — the STRICT_RESUME launch
     * hash from `recordLaunchHash` (#2886). Ties this run to the exact compiled
     * script it executed and is the value `checkResume` compares against on
     * recovery (A5).
     * // consumer: #2891 recovery scenario (A5, STRICT_RESUME) + #2892 script identity
     */
    script_sha256: z.string(),
    /**
     * The canonical per-node view, keyed by `node_instance_id` (the logical
     * identity encoded by `execute/identity.ts#encodeNodeInstanceId`, B/#3161). In
     * v0.1 there is one instance per graph node, so the key reduces to the bare
     * node id (II.6: `node_instance_id` is logical identity; a keyed `map` extends
     * the key to `(node, item_key)` and a `loop` to `(node, iteration)`).
     * // consumer: #2891 A1 (every executed node identifiable) + #2892 node table
     */
    nodes: z.record(z.string(), RunRecordNodeSchema),
    /**
     * Run-level token accounting: what the run actually spent (II.8
     * `actual_tokens_spent`). `null` here records DELIBERATE self-exclusion (R5,
     * synthesis I.4): this is a simulated deterministic executor with no real
     * agent tokens, and the measurement session is excluded from measurement.
     * Absent/`null` both mean "not measured".
     * // consumer: #2892 token-cost column (records "not measured — self-excluded")
     */
    actual_tokens_spent: z.number().int().nonnegative().nullable().optional(),
    /**
     * Run-level token accounting: the tokens attributable to the CANONICAL results
     * only (II.8 `canonical_result_tokens`, contrasted with `actual_tokens_spent`).
     * `null` for the same self-exclusion reason above.
     * // consumer: #2892 token-cost column (canonical vs actual)
     */
    canonical_result_tokens: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .optional(),
    /**
     * Why the run stopped — a NAMED reason, never "unknown" (this typed field IS
     * the structural guarantee metric A3 asserts).
     * // consumer: #2891 A3 answer + #2892 per-run stop reason
     */
    stopped_reason: RunStoppedReasonSchema,
  })
  .strict();
export type RunRecord = z.infer<typeof RunRecordSchema>;

/**
 * Parse + validate an unknown value (e.g. a re-read evidence JSON blob) as a
 * `RunRecord`. The runtime validator #2892 uses when reading stored run-records;
 * throws `ZodError` on a shape mismatch. (`.strict()` above means an extra key is
 * a hard error, so a silently-drifted producer cannot slip an unvalidated field
 * past #2892.)
 */
export function parseRunRecord(value: unknown): RunRecord {
  return RunRecordSchema.parse(value);
}
