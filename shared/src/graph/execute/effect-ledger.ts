// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The runtime effect-ledger driver — issue #3162 (Graph Runtime v1, Graph
 * Engineering Phase 3, Wave 1, Sub-Issue C). Promotes the write-ahead effect
 * ledger from a COMPILED CONVENTION (`compile/effectLedger.ts`, a pure data
 * template) into an ENFORCED RUNTIME PRIMITIVE.
 *
 * For every `risk_tier >= mutating` effect the runtime records an `EffectIntent`
 * BEFORE performing and an `EffectCommitted` AFTER (synthesis II.4), enforcing the
 * state machine `NOT_APPLICABLE → PREPARED → EXECUTING → COMMITTED | IN_DOUBT`
 * with `IN_DOUBT → reconcile → COMMITTED | SAFE_TO_RETRY | COMPENSATED` (II.1). A
 * blind retry from `IN_DOUBT` is REJECTED — reconcile must run first. This closes
 * the crash/cancel window the compiled convention only DOCUMENTED (II.7:
 * `JOURNALED RESULT != DURABLY SAFE EXTERNAL EFFECT`).
 *
 * 🔴 KEYING PARITY (KD1 / R3). The driver derives BOTH tokens via the SAME
 * `compile/effectLedger.ts` helpers, threading B's runtime `node_instance_id`
 * (#3161) as the `nodeId`: the `idempotency_key` (`deriveIdempotencyKey`, the
 * dedup token the TARGET receives) and the `effect_id`
 * (`deriveEffectId = ${nodeInstanceId}#${index}`, the LEDGER's record correlator,
 * NEVER target-facing). In v0.1 the `node_instance_id` reduces to `node.id`, so a
 * runtime key is byte-identical to the compiled artifact's (INT-1) — which is what
 * lets a re-performed effect across a crash window dedup at its target.
 *
 * 🔴 SCOPE (KD4 / II.3). This delivers idempotency (dedup by key) + the ledger.
 * True fencing beyond target-native CAS (distributed leases) is Wave-2 and is NOT
 * built here.
 *
 * 🔴 GRACEFUL DEGRADATION (R5 / KD3). `mode:"disabled"` (or simply not installing
 * the hook) performs the effect directly with NO live ledger — byte-identical to
 * pre-C behavior (the compiled preamble remains the fallback). This bounds the
 * blast radius: a ledger bug cannot block legitimate mutating work.
 *
 * 🔴 RUNTIME MODULE. Lives under `execute/` (imports the node:crypto compile
 * runtime via `../compile` helpers), reachable only through the
 * `@hapi/protocol/graph/execute` subpath — never the web-safe root barrel.
 */
import {
  deriveEffectId,
  deriveIdempotencyKey,
  mutatingEffectsWithIndex,
} from "../compile/effectLedger";
import type { EffectLedgerRecord } from "../compile/types";
import type { EffectDecl, GraphNode } from "../ir";
import type { EffectLifecycle } from "../run-record";
import type { LedgerHook, LedgerHookContext, NodeHandlerResult } from "./types";
import { Cancelled } from "./cancellation";
import { trimTrailingChars } from "../../trimChars";

// ── Runtime ledger records — an explicit SUPERSET of the compiled shapes ──────
/**
 * The runtime `EffectIntent`. A SUPERSET of the compiled intent record
 * (`compile/types.ts` `EffectLedgerRecord`): it additionally carries the effect's
 * `reconciliation` and `reversibility` specs, so recovery from `ledger.jsonl`
 * ALONE is self-contained — `reconcile()` never needs to reverse-map back into the
 * live IR. (This makes B's DECODABLE `node_instance_id` encoding a load-bearing
 * dependency: a ledger record must let recovery re-derive keys without the graph.)
 */
export interface EffectIntentRecord {
  phase: "intent";
  /** Ledger record correlator `${node_instance_id}#${index}` (NOT target-facing). */
  effect_id: string;
  /** Target-facing dedup token (`deriveIdempotencyKey` on the node_instance_id). */
  idempotency_key: string;
  /** What is mutated — the node's write/exclusive resources, else the node id. */
  target: string;
  /** Authority witnesses required (sorted); `[]` when `authority === "none"`. */
  witness: string[];
  /** Compile-time action descriptor `${access}:${risk_tier}`. */
  action: string;
  /** Superset: the effect's reconcile spec, for self-contained recovery. */
  reconciliation: EffectDecl["reconciliation"];
  /** Superset: the effect's reversibility, routing the compensation arm. */
  reversibility: EffectDecl["reversibility"];
}

/** The runtime `perform`-transition record (optional third record). */
export interface EffectPerformRecord {
  phase: "perform";
  effect_id: string;
  idempotency_key: string;
}

/**
 * The runtime `EffectCommitted`. A SUPERSET of the compiled committed template:
 * it carries the runtime `outcome` + `proof` (synthesis II.4 `EffectCommitted`),
 * which the pure compiled artifact deliberately omits. Writing this record CLOSES
 * the open intent for its `effect_id` (an effect is "open" iff it has an intent
 * and no committed record).
 */
export interface EffectCommittedRecord {
  phase: "committed";
  effect_id: string;
  idempotency_key: string;
  /** The effect's terminal disposition descriptor (II.4 `EffectCommitted.outcome`). */
  outcome: string;
  /** Evidence the effect durably landed (II.4 `EffectCommitted.proof`); may be null. */
  proof: string | null;
}

export type RuntimeLedgerRecord =
  | EffectIntentRecord
  | EffectPerformRecord
  | EffectCommittedRecord;

// ── The pluggable substrate (R4) ──────────────────────────────────────────────
/**
 * Where the ledger is hosted. `appendIntent` + `appendCommitted` + `readOpenIntents`
 * are the pinned MINIMUM; `appendPerform` (the `PREPARED → EXECUTING` transition)
 * is OPTIONAL — it is written for three-record audit fidelity (matching the
 * compiled template) and reserved for a future reconcile that distinguishes a
 * crash-before-perform from a crash-after-perform. `reconcile()` today does NOT
 * read it (it resolves purely from the open intent's declared reconcile spec), so
 * omitting it changes no current behavior. Pluggable so the run-scoped JSONL
 * default can later be swapped for an issue-scoped durable substrate without
 * touching the driver.
 */
export interface LedgerSubstrate {
  appendIntent(rec: EffectIntentRecord): void | Promise<void>;
  appendCommitted(rec: EffectCommittedRecord): void | Promise<void>;
  /** Open intents = every `effect_id` with an intent and NO committed record. */
  readOpenIntents(): EffectIntentRecord[] | Promise<EffectIntentRecord[]>;
  /** OPTIONAL `PREPARED → EXECUTING` marker (three-record fidelity). */
  appendPerform?(rec: EffectPerformRecord): void | Promise<void>;
}

/**
 * Order-aware open-intent resolution — the single source of truth both substrates
 * share so the pairing logic cannot drift between them. An `effect_id` is OPEN iff
 * its LATEST record in the append-only log is an `intent` with no `committed`
 * AFTER it: walk in order, an `intent` (re)opens the effect_id, a `committed`
 * closes it. This is correct across a same-`effect_id` RE-PERFORM (a prior
 * committed cycle does NOT mask a genuinely-open later intent — the exact hole a
 * flat `effect_id ∈ committedSet` membership test left) and across a
 * `safe_to_retry` re-arm (the re-perform's committed closes the entry). Returns
 * the latest open intent per open effect_id — all intents for one effect_id carry
 * the same reconcile/reversibility spec, so `reconcile()` reads the current one.
 */
function openIntentsFromLog(
  records: readonly RuntimeLedgerRecord[]
): EffectIntentRecord[] {
  const latestOpen = new Map<string, EffectIntentRecord>();
  for (const r of records) {
    if (r.phase === "intent") latestOpen.set(r.effect_id, r);
    else if (r.phase === "committed") latestOpen.delete(r.effect_id);
  }
  return [...latestOpen.values()];
}

/**
 * An in-memory substrate — the default for tests and a legitimate non-durable
 * fallback. `readOpenIntents` uses the order-aware `openIntentsFromLog` walk.
 */
export class InMemoryLedgerSubstrate implements LedgerSubstrate {
  readonly records: RuntimeLedgerRecord[] = [];

  appendIntent(rec: EffectIntentRecord): void {
    this.records.push(rec);
  }
  appendPerform(rec: EffectPerformRecord): void {
    this.records.push(rec);
  }
  appendCommitted(rec: EffectCommittedRecord): void {
    this.records.push(rec);
  }
  readOpenIntents(): EffectIntentRecord[] {
    return openIntentsFromLog(this.records);
  }
}

/**
 * The v0.1 default substrate: append-only JSONL at `${runDir}/ledger.jsonl` — the
 * instance-unique `run_dir` the executor (#3160) owns and threads into the
 * `LedgerHook` context (GAP-1: consume that path, never invent a second). Uses
 * `node:fs` via a dynamic import so this module stays importable in contexts that
 * never opt into durable persistence (mirrors `executor.ts#persistResumeSignals`).
 */
export class JsonlRunSubstrate implements LedgerSubstrate {
  private readonly path: string;

  constructor(runDir: string) {
    this.path = `${trimTrailingChars(runDir, "/")}/ledger.jsonl`;
  }

  private async append(rec: RuntimeLedgerRecord): Promise<void> {
    const { mkdirSync, appendFileSync } = await import("node:fs");
    const dir = this.path.slice(0, this.path.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    appendFileSync(this.path, JSON.stringify(rec) + "\n", "utf8");
  }

  async appendIntent(rec: EffectIntentRecord): Promise<void> {
    await this.append(rec);
  }
  async appendPerform(rec: EffectPerformRecord): Promise<void> {
    await this.append(rec);
  }
  async appendCommitted(rec: EffectCommittedRecord): Promise<void> {
    await this.append(rec);
  }

  async readOpenIntents(): Promise<EffectIntentRecord[]> {
    const { existsSync, readFileSync } = await import("node:fs");
    if (!existsSync(this.path)) return [];
    const records = readFileSync(this.path, "utf8")
      .split("\n")
      .filter(line => line.length > 0)
      .map(line => JSON.parse(line) as RuntimeLedgerRecord);
    return openIntentsFromLog(records);
  }
}

// ── Reconcile probes + compensators (the recovery seams) ──────────────────────
/** The result of a `queryable` reconcile probe against a target. */
export interface ProbeResult {
  /** Whether the probe could conclusively determine the target's state. */
  conclusive: boolean;
  /** Whether the effect was already durably applied at the target. */
  applied: boolean;
  /** Optional evidence for the committed record's `proof`. */
  proof?: string | null;
}
/** A `queryable` probe: interrogate the target to resolve an in-doubt effect. */
export type ReconcileProbe = (ctx: {
  effectId: string;
  idempotencyKey: string;
  intent: EffectIntentRecord;
}) => ProbeResult | Promise<ProbeResult>;
/** A compensation handler that rolls back an in-doubt `{compensatable}` effect. */
export type Compensator = (ctx: {
  effectId: string;
  intent: EffectIntentRecord;
}) => void | Promise<void>;

/** The `reconcile` verdict for an intent-without-commit (synthesis II.1). */
export type ReconcileStatus = "committed" | "safe_to_retry" | "compensated";

export type LedgerMode = "enabled" | "disabled";

export interface EffectLedgerConfig {
  substrate: LedgerSubstrate;
  /** `"disabled"` degrades to direct perform + no live ledger (R5). Default `"enabled"`. */
  mode?: LedgerMode;
  /** Probes for `{queryable}` reconcile, keyed by the reconciliation probe name. */
  probes?: Record<string, ReconcileProbe>;
  /** Compensators for `{compensatable}` reversibility, keyed by the handler name. */
  compensators?: Record<string, Compensator>;
}

/** Thrown when a retry is attempted on an IN_DOUBT effect before reconcile ran (R2). */
export class BlindRetryRejectedError extends Error {
  constructor(effectId: string) {
    super(
      `Blind retry from IN_DOUBT rejected for effect '${effectId}' — reconcile() must resolve it first (synthesis II.1).`
    );
    this.name = "BlindRetryRejectedError";
  }
}

/** True iff the effect gets ledger treatment (`risk_tier >= mutating`). */
function isMutating(effect: EffectDecl): boolean {
  return (
    mutatingEffectsWithIndex({ effects: [effect] } as GraphNode).length > 0
  );
}

// ── The runtime driver ────────────────────────────────────────────────────────
/**
 * The enforced runtime effect ledger. Holds the substrate + recovery seams and
 * tracks per-`effect_id` layer-3 state within the run. Recovery decisions read
 * from the SUBSTRATE (durable), so a fresh `EffectLedger` over a crashed run's
 * `ledger.jsonl` reconciles correctly (self-contained recovery).
 */
export class EffectLedger {
  private readonly substrate: LedgerSubstrate;
  readonly mode: LedgerMode;
  private readonly probes: Record<string, ReconcileProbe>;
  private readonly compensators: Record<string, Compensator>;
  /** Per-effect_id layer-3 state within THIS process (surfaced onto the run record). */
  private readonly states = new Map<string, EffectLifecycle>();
  /** effect_ids a reconcile resolved to `safe_to_retry` — re-perform is now allowed. */
  private readonly reArmed = new Set<string>();

  constructor(config: EffectLedgerConfig) {
    this.substrate = config.substrate;
    this.mode = config.mode ?? "enabled";
    this.probes = config.probes ?? {};
    this.compensators = config.compensators ?? {};
  }

  /** The layer-3 lifecycle state currently tracked for an effect_id. */
  getState(effectId: string): EffectLifecycle | undefined {
    return this.states.get(effectId);
  }

  /**
   * Run ONE `risk_tier >= mutating` effect through the write-ahead lifecycle:
   * `EffectIntent` (PREPARED) → `perform()` (EXECUTING) → `EffectCommitted`
   * (COMMITTED) on resolve, or IN_DOUBT on an ambiguous (thrown) failure.
   *
   * - A non-mutating effect bypasses the ledger entirely: `perform()` runs and the
   *   state is `n/a` (R1 gate).
   * - `mode:"disabled"`: `perform()` runs directly, NO ledger record is written,
   *   state `n/a` — graceful degradation to pre-C behavior (R5).
   * - A retry of an effect that is IN_DOUBT and has not been reconciled throws
   *   `BlindRetryRejectedError` (R2). `reconcile → safe_to_retry` re-arms it.
   *
   * On an ambiguous (thrown) `perform`, the intent is left OPEN (no committed
   * record), the state becomes `in_doubt`, and the original error is re-thrown —
   * the caller inspects `getState`/`reconcile`. The `idempotency_key` is the token
   * the caller MUST carry into the target where it supports dedup.
   *
   * @internal No PRODUCTION consumer as of #3191 — the executor path drives effects
   * through {@link EffectLedger.runNodeEffects} (via `makeLedgerHook`); benchmark /
   * fault-injection go through `executeWorkflow`. Kept PUBLIC (not `private`) so the
   * single-effect write-ahead lifecycle stays unit-testable: `effect-ledger.test.ts`
   * (`describe("EffectLedger.runEffect …")`) and `cancellation.test.ts` call
   * `ledger.runEffect(...)` on an instance. Barrel-exported wholesale via
   * `execute/index.ts` (`export * from "./effect-ledger"`).
   */
  async runEffect<T>(args: {
    nodeInstanceId: string;
    effect: EffectDecl;
    effectIndex: number;
    target: string;
    witness?: string[];
    perform: () => Promise<T>;
    /** Optional proof for the committed record (else the idempotency_key). */
    proof?: string | null;
    /**
     * E/#3164 — a cooperative cancel poll consulted AROUND `perform()`. On cancel
     * the intent is left OPEN, the state is `in_doubt`, and a `Cancelled` is thrown
     * (resolution flows through {@link reconcile}). See the cancel-during-effect
     * notes at the two call sites.
     */
    checkCancellation?: () => boolean | Promise<boolean>;
  }): Promise<{
    value: T;
    effectId: string;
    idempotencyKey: string;
    state: EffectLifecycle;
  }> {
    const { nodeInstanceId, effect, effectIndex, target, perform } = args;
    const checkCancellation = args.checkCancellation;
    const effectId = deriveEffectId(nodeInstanceId, effectIndex);
    const idempotencyKey = deriveIdempotencyKey(nodeInstanceId, effect);

    // R1 gate: a readonly / non-mutating effect never touches the ledger.
    if (!isMutating(effect)) {
      const value = await perform();
      this.states.set(effectId, "n/a");
      return { value, effectId, idempotencyKey, state: "n/a" };
    }

    // R5 degradation: disabled ⇒ perform directly, no ledger, byte-identical to pre-C.
    if (this.mode === "disabled") {
      const value = await perform();
      this.states.set(effectId, "n/a");
      return { value, effectId, idempotencyKey, state: "n/a" };
    }

    // R2 blind-retry rejection — the DURABLE in-doubt signal is an open intent in
    // the substrate (survives a crash), cleared only by a `safe_to_retry` reconcile.
    const openBefore = await this.substrate.readOpenIntents();
    this.blindRetryGuard(openBefore, effectId);

    // PREPARED (+ optional EXECUTING marker) — write the intent (superset record)
    // before performing, via the single-sourced PREPARED transition.
    const intent: EffectIntentRecord = {
      phase: "intent",
      effect_id: effectId,
      idempotency_key: idempotencyKey,
      target,
      witness: args.witness ?? [],
      action: `${effect.access}:${effect.risk_tier}`,
      reconciliation: effect.reconciliation,
      reversibility: effect.reversibility,
    };
    await this.writeIntentAndPrepare(intent);

    // E/#3164 (R3a) — a cancel observed AFTER the intent, BEFORE perform: do NOT
    // start a new perform (no NEW `perform()` after cancel observation). Leave the
    // intent OPEN, mark in_doubt, throw `Cancelled` — the caller reconciles.
    if (checkCancellation && (await checkCancellation())) {
      this.states.set(effectId, "in_doubt");
      throw new Cancelled();
    }

    // EXECUTING — run the effect carrying the idempotency_key as the dedup token.
    try {
      const value = await perform();
      // E/#3164 (R3b) — a cancel observed AFTER perform resolved, BEFORE commit: do
      // NOT write a PERFORM-path `EffectCommitted`. Leave the intent OPEN, mark
      // in_doubt, throw `Cancelled`; resolution flows exclusively through
      // `reconcile` (which may honestly report `committed` — the effect DID land at
      // the target, and that is the correct outcome, ruling R10 record-level).
      if (checkCancellation && (await checkCancellation())) {
        this.states.set(effectId, "in_doubt");
        throw new Cancelled();
      }
      // COMMITTED — the effect durably landed.
      await this.commitOne(
        effectId,
        idempotencyKey,
        "succeeded",
        args.proof ?? idempotencyKey,
        "committed"
      );
      return { value, effectId, idempotencyKey, state: "committed" };
    } catch (err) {
      // IN_DOUBT — no provable outcome (an ambiguous perform, or a cancel between
      // perform and commit above); leave the intent OPEN, block blind retry.
      this.states.set(effectId, "in_doubt");
      throw err;
    }
  }

  /**
   * Resolve an intent-without-commit (an IN_DOUBT effect) WITHOUT blind-retrying
   * a possibly-committed mutating effect (synthesis II.1, OR1 — the delicate core).
   * Driven by the intent's own `reconciliation` (+ `reversibility` for the
   * compensation arm), so it works purely from the durable substrate:
   *
   *   - `{queryable: p}` → run probe `p`: applied ⇒ `committed` (layer-3
   *     `reconciled`, probe-proven); not-applied ⇒ `safe_to_retry` (re-arm);
   *     inconclusive/failed ⇒ THROWS (never fabricates a status — the effect stays
   *     `in_doubt`, so a downstream retry stays blocked).
   *   - `keyed-dedup` → the idempotency key dedups at the target ⇒ `committed` (INT-2).
   *   - `none` + `reversibility:{compensatable:h}` → run compensator `h` ⇒
   *     `compensated`.
   *   - `none` + reversible/idempotent → `safe_to_retry` (the lint gate guarantees
   *     a `reconciliation:"none"` effect declares a non-"none" idempotency, so the
   *     re-perform dedups/no-ops — INT-2).
   */
  async reconcile(effectId: string): Promise<{ status: ReconcileStatus }> {
    const open = await this.substrate.readOpenIntents();
    const intent = open.find(i => i.effect_id === effectId);
    if (!intent) {
      throw new Error(
        `reconcile: no open intent for effect_id '${effectId}' — nothing to reconcile (it committed, was compensated, or never existed).`
      );
    }
    const { reconciliation, reversibility, idempotency_key } = intent;

    // 1. queryable → interrogate the target.
    if (typeof reconciliation === "object" && "queryable" in reconciliation) {
      const probe = this.probes[reconciliation.queryable];
      if (!probe) {
        throw new Error(
          `reconcile: no probe registered for queryable '${reconciliation.queryable}' (effect '${effectId}').`
        );
      }
      const result = await probe({
        effectId,
        idempotencyKey: idempotency_key,
        intent,
      });
      if (!result.conclusive) {
        // Never fabricate a status: the effect stays in_doubt, retry stays blocked.
        this.states.set(effectId, "in_doubt");
        throw new Error(
          `reconcile: probe '${reconciliation.queryable}' was inconclusive for effect '${effectId}' — it remains IN_DOUBT (retry stays blocked).`
        );
      }
      if (result.applied) {
        await this.closeCommitted(intent, "reconciled", result.proof ?? null);
        this.states.set(effectId, "reconciled");
        this.reArmed.delete(effectId);
        return { status: "committed" };
      }
      return this.markSafeToRetry(effectId);
    }

    // 2. keyed-dedup → the key dedups at the target ⇒ treat as committed (INT-2).
    if (reconciliation === "keyed-dedup") {
      await this.closeCommitted(intent, "committed-keyed-dedup", null);
      this.states.set(effectId, "committed");
      this.reArmed.delete(effectId);
      return { status: "committed" };
    }

    // 3. reconciliation === "none": the compensation arm (reversibility-routed)
    //    else safe_to_retry (declared idempotency, guaranteed by the lint gate).
    if (typeof reversibility === "object" && "compensatable" in reversibility) {
      const compensate = this.compensators[reversibility.compensatable];
      if (!compensate) {
        throw new Error(
          `reconcile: no compensator registered for '${reversibility.compensatable}' (effect '${effectId}').`
        );
      }
      await compensate({ effectId, intent });
      await this.closeCommitted(intent, "compensated", null);
      this.states.set(effectId, "compensated");
      this.reArmed.delete(effectId);
      return { status: "compensated" };
    }
    return this.markSafeToRetry(effectId);
  }

  /** Re-arm an in-doubt effect for a safe re-perform (layer-3 back to `prepared`). */
  private markSafeToRetry(effectId: string): { status: ReconcileStatus } {
    this.reArmed.add(effectId);
    this.states.set(effectId, "prepared");
    return { status: "safe_to_retry" };
  }

  /** Write the committed record that CLOSES an open intent during reconcile. */
  private async closeCommitted(
    intent: EffectIntentRecord,
    outcome: string,
    proof: string | null
  ): Promise<void> {
    await this.substrate.appendCommitted({
      phase: "committed",
      effect_id: intent.effect_id,
      idempotency_key: intent.idempotency_key,
      outcome,
      proof,
    });
  }

  /**
   * The PREPARED transition, single-sourced (issue #3162 reflection): persist the
   * write-ahead `intent`, mark the effect `prepared`, clear any prior
   * `safe_to_retry` re-arm, and write the optional `perform` marker. Shared by
   * `runEffect` and `runNodeEffects` so this state-machine step's side-effects
   * cannot drift between the two call sites.
   */
  private async writeIntentAndPrepare(
    intent: EffectIntentRecord
  ): Promise<void> {
    await this.substrate.appendIntent(intent);
    this.states.set(intent.effect_id, "prepared");
    this.reArmed.delete(intent.effect_id);
    await this.substrate.appendPerform?.({
      phase: "perform",
      effect_id: intent.effect_id,
      idempotency_key: intent.idempotency_key,
    });
  }

  /**
   * The blind-retry guard, single-sourced (#3191): an effect whose `effect_id` has
   * an OPEN intent in `openBefore` and has NOT been reconcile-re-armed cannot be
   * re-performed — reconcile must resolve it first (R2, synthesis II.1). Takes the
   * caller's PRE-READ `openBefore` array so neither call site re-reads the substrate
   * per effect (`runEffect` reads once for its one effect; `runNodeEffects` reads
   * ONCE per node before the prepare loop — #3191 finding 3191-2).
   */
  private blindRetryGuard(
    openBefore: EffectIntentRecord[],
    effectId: string
  ): void {
    if (
      openBefore.some(i => i.effect_id === effectId) &&
      !this.reArmed.has(effectId)
    ) {
      throw new BlindRetryRejectedError(effectId);
    }
  }

  /**
   * Write the forward-path (perform) `EffectCommitted` that CLOSES an open intent
   * AND set the effect's layer-3 `state`, single-sourced (#3191) — the block was
   * duplicated verbatim across `runEffect`'s success commit and `runNodeEffects`'
   * per-effect success + clean-`waiting`/`skipped` commits. MUST be awaited per
   * effect inside the existing commit `for` loop — NEVER batched (e.g. `Promise.all`)
   * — so `ledger.jsonl`'s append ORDER stays `[intent…, committed…]` in `prepared`
   * order, which crash-resume recovery depends on (#3191 finding 3191-1). Distinct
   * from {@link EffectLedger.closeCommitted}, which writes the RECONCILE-path
   * committed record from a recovered `intent` and leaves `states` to its caller.
   */
  private async commitOne(
    effectId: string,
    idempotencyKey: string,
    outcome: string,
    proof: string | null,
    state: EffectLifecycle
  ): Promise<void> {
    await this.substrate.appendCommitted({
      phase: "committed",
      effect_id: effectId,
      idempotency_key: idempotencyKey,
      outcome,
      proof,
    });
    this.states.set(effectId, state);
  }

  /**
   * Node-level lifecycle for a commit-lowered node (Task 3 — the `makeLedgerHook`
   * body). v0.1 gives ONE `perform` thunk per node (the handler runs ALL the
   * node's effects), so this writes an `EffectIntent` for every `mutating+` effect,
   * runs `perform()` ONCE, then commits every effect on `outcome:"succeeded"`.
   * Anything else — a resolved non-success outcome OR a thrown handler — is
   * conservatively IN_DOUBT: a mutating node that did not cleanly succeed may have
   * partially applied, so it must be reconciled, never blind-retried (II.1 / OR1).
   * Returns the handler's `NodeHandlerResult` augmented with the layer-3 `effects`
   * map the executor lifts onto `RunRecordNode.effects`.
   */
  async runNodeEffects(args: {
    nodeInstanceId: string;
    node: GraphNode;
    compiledLedger?: EffectLedgerRecord[];
    perform: () => Promise<NodeHandlerResult>;
    /**
     * E/#3164 — a cooperative cancel poll consulted AROUND `perform()`. On cancel,
     * every prepared effect is left OPEN (in_doubt) and the node returns outcome
     * `cancelled` (the executor records `cancelled` + surfaces the resume signal;
     * resolution flows through {@link reconcile}). Absent ⇒ byte-identical to #3162.
     */
    checkCancellation?: () => boolean | Promise<boolean>;
  }): Promise<NodeHandlerResult> {
    const { nodeInstanceId, node, compiledLedger, perform } = args;
    const checkCancellation = args.checkCancellation;
    const mutating = mutatingEffectsWithIndex(node);

    // Degradation / non-mutating node → passthrough (no ledger, no effects field).
    if (this.mode === "disabled" || mutating.length === 0) {
      return perform();
    }

    // Reuse the compiled preamble for target/witness/action (order-aligned: the
    // Nth mutating effect ↔ the Nth compiled intent record) while re-deriving
    // effect_id/idempotency_key with B's node_instance_id (R3 keying parity).
    const compiledIntents = (compiledLedger ?? []).filter(
      (r): r is Extract<EffectLedgerRecord, { phase: "intent" }> =>
        r.phase === "intent"
    );

    // R2 durable blind-retry rejection: an open intent from a PRIOR run (same
    // instance-unique run_dir) that was never reconciled blocks a re-perform.
    const openBefore = await this.substrate.readOpenIntents();
    const effects: Record<string, EffectLifecycle> = {};
    const prepared: { effectId: string; idempotencyKey: string }[] = [];

    for (let k = 0; k < mutating.length; k++) {
      const { effect, index } = mutating[k];
      const compiled = compiledIntents[k];
      const effectId = deriveEffectId(nodeInstanceId, index);
      const idempotencyKey = deriveIdempotencyKey(nodeInstanceId, effect);
      this.blindRetryGuard(openBefore, effectId);
      await this.writeIntentAndPrepare({
        phase: "intent",
        effect_id: effectId,
        idempotency_key: idempotencyKey,
        target: compiled?.target ?? node.id,
        witness: compiled?.witness ?? [],
        action: compiled?.action ?? `${effect.access}:${effect.risk_tier}`,
        reconciliation: effect.reconciliation,
        reversibility: effect.reversibility,
      });
      prepared.push({ effectId, idempotencyKey });
      effects[effectId] = "prepared";
    }

    // E/#3164 — leave every prepared effect OPEN (in_doubt) for a cancel, so the
    // node's terminal shape is `cancelled` + `effects[...] = "in_doubt"` (probe /
    // reconcile resolves durability). Shared by the before-perform (R3a) and
    // after-perform-pre-commit (R3b) cancel paths.
    const cancelledInDoubt = (): NodeHandlerResult => {
      for (const p of prepared) {
        this.states.set(p.effectId, "in_doubt");
        effects[p.effectId] = "in_doubt";
      }
      return { outcome: "cancelled", effects };
    };

    // E/#3164 (R3a) — a cancel observed BEFORE performing: do NOT start a new
    // perform. Every prepared effect stays OPEN (in_doubt); the node is `cancelled`.
    if (checkCancellation && (await checkCancellation())) {
      return cancelledInDoubt();
    }

    let result: NodeHandlerResult;
    try {
      result = await perform();
    } catch (err) {
      // E/#3164 (#3191) — preserve a cooperative `Cancelled` thrown through the
      // handler as `cancelled` (effects left in_doubt), reusing the SAME closure as
      // the polled-cancel checkpoints. The bare `catch {` discarded the error, so a
      // cancel was mis-recorded `failed_terminal` — the executor then saw no
      // `outcome:"cancelled"` and emitted no `CancellationResumeSignal`
      // (executor.ts:603). Mirrors `runEffect`'s re-throw catch and the executor's
      // sibling `instanceof Cancelled` fold (executor.ts:527); every other throw is
      // unchanged (`failed_terminal`, in_doubt).
      if (err instanceof Cancelled) return cancelledInDoubt();
      for (const p of prepared) {
        this.states.set(p.effectId, "in_doubt");
        effects[p.effectId] = "in_doubt";
      }
      return { outcome: "failed_terminal", effects };
    }

    // E/#3164 (R3b) — a cancel observed AFTER perform, BEFORE commit: do NOT write a
    // PERFORM-path `EffectCommitted`. Every effect stays OPEN (in_doubt) for
    // `reconcile`; the node is `cancelled` (reconcile may honestly report
    // `committed` — the effect landed; ruling R10 record-level invariant).
    if (checkCancellation && (await checkCancellation())) {
      return cancelledInDoubt();
    }

    for (const p of prepared) {
      if (result.outcome === "succeeded") {
        // The effect durably landed.
        await this.commitOne(
          p.effectId,
          p.idempotencyKey,
          "succeeded",
          p.idempotencyKey,
          "committed"
        );
        effects[p.effectId] = "committed";
      } else if (result.outcome === "waiting" || result.outcome === "skipped") {
        // A CLEAN "not performed" outcome — a pending human-gate (`waiting`) or a
        // deliberate `skipped`. The effect never ran, so it is NOT in_doubt. Close
        // the intent with its actual disposition so it is not left dangling-open,
        // which would otherwise falsely trip the blind-retry guard when the run
        // resumes and re-executes the same node instance. A `waiting` effect
        // re-runs on resume as a fresh cycle (layer-3 `prepared`, deferred); a
        // `skipped` effect has no effect at all (layer-3 `n/a`).
        const state: EffectLifecycle =
          result.outcome === "waiting" ? "prepared" : "n/a";
        await this.commitOne(
          p.effectId,
          p.idempotencyKey,
          result.outcome,
          null,
          state
        );
        effects[p.effectId] = state;
      } else {
        // A genuinely ambiguous failure (a resolved `failed_*`/`refused`/
        // `timed_out`/`cancelled`) — the mutating effect may have partially
        // applied, so leave the intent OPEN and mark in_doubt: recovery MUST
        // reconcile it, never blind-retry (II.1 / OR1).
        this.states.set(p.effectId, "in_doubt");
        effects[p.effectId] = "in_doubt";
      }
    }
    return { ...result, effects };
  }
}

// ── Executor integration — the LedgerHook factory (Task 3) ────────────────────
/**
 * Build the `LedgerHook` a caller passes as `ExecutorOptions.ledger` (#3160 seam).
 * On each commit-lowered node it wraps the handler's effect(s) in the ledger
 * lifecycle, keyed by B's `node_instance_id`, and surfaces each effect's layer-3
 * state via the OPTIONAL `NodeHandlerResult.effects` map (which the executor lifts
 * onto `RunRecordNode.effects`). A `mode:"disabled"` ledger degrades to a
 * passthrough — byte-identical to not installing the hook at all (R5).
 *
 * v0.1 has ONE `perform` thunk per node (the handler runs all the node's effects);
 * intents are written for every mutating effect, `perform()` runs ONCE, and each
 * effect commits on `outcome:"succeeded"` — anything else (a non-success outcome
 * or a thrown handler) is conservatively IN_DOUBT (a mutating node that did not
 * cleanly succeed may have partially applied — never blind-retry it, II.1/OR1).
 */
export function makeLedgerHook(ledger: EffectLedger): LedgerHook {
  return (
    ctx: LedgerHookContext,
    perform: () => Promise<NodeHandlerResult>
  ): Promise<NodeHandlerResult> =>
    ledger.runNodeEffects({
      nodeInstanceId: ctx.nodeInstanceId,
      node: ctx.node,
      compiledLedger: ctx.ledger,
      perform,
      // E/#3164 — bridge the LedgerHookContext checkpoint poll to the ledger's
      // zero-arg cancel poll (the ledger's cancel checkpoint is after-effect-commit).
      checkCancellation: ctx.checkCancellation
        ? () => ctx.checkCancellation!("after-effect-commit")
        : undefined,
    });
}
