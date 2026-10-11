// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Executor type contract + B–E extension seams — issue #3160 (Graph Runtime v1,
 * Graph Engineering Phase 3, Wave 1, Sub-Issue A).
 *
 * The public contract for the production graph executor (`executor.ts`): pluggable
 * node handlers, executor options, and the FOUR B–E extension-seam hooks. This is
 * the INT-4 cross-sub-issue interface consumed by:
 *   - B/#3161 (identity)   → `IdentityHook`
 *   - C/#3162 (ledger)     → `LedgerHook`
 *   - D/#3163 (retry/timeout) → `RetryPolicyHook`
 *   - E/#3164 (cancellation) → `CancellationHook`
 * A late signature change here ripples to all four sub-issues — architect-review
 * this seam BEFORE B begins (directive INT-4).
 *
 * 🔴 RUNTIME MODULE. The barrel that re-exports these types alongside `executor.ts`
 * transitively pulls the `node:crypto` compile runtime (via `recordLaunchHash`),
 * so the module is exposed via the `@hapi/protocol/graph/execute` subpath — NOT
 * the web-safe root barrel `shared/src/graph/index.ts` (KD2, mirroring
 * `@hapi/protocol/graph/compile`). `types.ts` itself imports only TYPES, but it
 * lives in the runtime module and is not re-exported web-side.
 */
import type { ConstructKind, GraphNode } from "../ir";
import type {
  CompiledNode,
  CompiledWorkflow,
  EffectLedgerRecord,
} from "../compile/types";
import type {
  EffectLifecycle,
  ExecutionOutcome,
  RunRecord,
  RunRecordNode,
  RunStoppedReason,
} from "../run-record";

// Re-export the run-record vocabulary for consumer convenience (directive Task 1).
export type {
  EffectLifecycle,
  ExecutionOutcome,
  RunRecord,
  RunRecordNode,
  RunStoppedReason,
} from "../run-record";

// ── Evidence class ────────────────────────────────────────────────────────────
/**
 * How a run's evidence was produced (synthesis I.4 self-exclusion). `simulated`
 * = deterministic test-double handlers (v0.1 CI); `artifact` = derived purely
 * from graph/compiled/lint artifacts; `real` = real agent-body handlers (reserved
 * for D/E). For `simulated`/`artifact` the run-record token columns are recorded
 * `null` (the measurement session is excluded from measurement).
 */
export type EvidenceClass = "simulated" | "artifact" | "real";

// ── Routing + gate surfaces (relocated from benchmark.ts) ────────────────────
/** One routing decision the executor took (for A2 branch/join explainability). */
export interface RoutingDecision {
  node_id: string;
  kind: ConstructKind;
  next: string[];
  rationale: string;
}

/** A pending operator requirement surfaced by a human-gate node (for A8). */
export interface GateSignal {
  node_id: string;
  gate_id: string;
  approver: string;
  requirement: string;
}

// ── Durable resume signal (OPEN kind-discriminated union) ────────────────────
/**
 * A human-gate resume signal: the run paused at a `human_gate` and needs an
 * external approval to proceed. Carries the four IR-derived fields (R4).
 */
export interface GateResumeSignal {
  kind: "gate";
  node_id: string;
  gate_id: string;
  approver: string;
  requirement: string;
}

/**
 * A durable signal that a cooperative cancellation happened (synthesis II.6 — a
 * cancellation is a durable append-only resume signal). E/#3164's additive arm on
 * the OPEN `ResumeSignal` union — a pre-authorized extension (sweep ruling R6),
 * NOT a new durable substrate: it rides the SAME channel A uses for `GateSignal`s.
 */
export interface CancellationResumeSignal {
  kind: "cancellation";
  /** The node instance that was cancelled. */
  node_id: string;
  /** The cancellation scope id (run / branch / node), when available. */
  scope_id?: string;
  /** Human-readable cancellation descriptor (mirrors the gate `requirement`). */
  requirement: string;
}

/**
 * A durable signal that an external actor must act on before the run can proceed.
 *
 * 🔓 OPEN UNION — E/#3164 appends `{ kind: "cancellation"; ... }`. Discriminated
 * on `kind`, so a consumer switch that omits a future arm fails the exhaustiveness
 * check rather than silently mis-handling it. The executor OWNS the durability of
 * these signals: it surfaces them in `ExecuteResult.gate_signals` and, when a
 * persistence sink is configured (`ExecutorOptions.runsRoot`), writes them into
 * the instance-unique `run_dir` alongside the run record (R4).
 */
export type ResumeSignal = GateResumeSignal | CancellationResumeSignal;

// ── run_dir convention (D2-A — pinned here, established by the executor) ──────
/**
 * The instance-unique run-directory convention. `run_id` is deterministic, but a
 * deterministic-only path COLLIDES across re-runs of the same artifact and would
 * cross-contaminate C's (#3162) crash-recovery ledger — so the per-instance
 * `<start-iso8601>-<uniq>` segment is MANDATORY.
 */
export const RUN_DIR_CONVENTION =
  "<runs-root>/<sanitized-run_id>/<start-iso8601>-<uniq>/" as const;

/**
 * Build the instance-unique `run_dir` path (D2-A). Pure path construction — the
 * caller supplies the wall-clock/uniqueness `instanceSegment` so the executor
 * stays deterministic (no wall-clock, no randomness) when NO persistence sink is
 * configured. C (#3162) writes its `ledger.jsonl` into this directory; it MUST
 * consume this path, not invent a second one (GAP-1).
 *
 * The `runId` and `instanceSegment` path SEGMENTS are sanitized before
 * interpolation (#3684): each NTFS-illegal character (`: < > " | ? *`) becomes
 * `__` and any trailing dot/space is stripped, so the on-disk directory is
 * Windows-checkout-safe even when a graph `id` contains a colon (e.g.
 * `hal-fault:timeout`). Only the filesystem PATH component is sanitized — the
 * `run_id` / `graph_id` FIELD values written into `run-record.json` keep their
 * colon, so evidence semantics are unchanged. `runsRoot` is NOT sanitized (it
 * legitimately carries `/` separators); only its trailing slash is trimmed.
 */
export function buildRunDir(
  runsRoot: string,
  runId: string,
  instanceSegment: string
): string {
  const root = runsRoot.replace(/\/+$/, "");
  // #3684: replace NTFS-illegal chars in a single path segment with `__` and
  // strip a trailing dot/space. Applied to `runId`/`instanceSegment` only — a
  // segment never contains `/`, so this cannot alter the directory nesting.
  const safeSegment = (s: string): string =>
    s.replace(/[:<>"|?*]/g, "__").replace(/[. ]+$/, "");
  return `${root}/${safeSegment(runId)}/${safeSegment(instanceSegment)}`;
}

// ── Node handler contract ─────────────────────────────────────────────────────
/**
 * The multiplicity context a node executes under. In v0.1 every field is absent
 * (one instance per node, node_instance_id = node id, II.6). B/#3161 reads these
 * to derive iteration/item-scoped identities for `map`/`loop` bodies.
 */
export interface NodeMultiplicity {
  /** Loop iteration ordinal (0-based), when the node is inside a `loop` body. */
  iterationIndex?: number;
  /** `map` item key, when the node is inside a keyed `map` body. */
  itemKey?: string;
  /** Which attempt this is (1-based); 2 when superseding a prior attempt. */
  attempt?: number;
}

/**
 * The context a `NodeHandler` receives for one node instance. Carries the IR node,
 * its lowered compiled node, the resolved logical identity, and the run's
 * deterministic identifiers.
 */
export interface NodeExecContext {
  /** The authored IR node being executed (gate semantics dispatch on `node.kind`). */
  node: GraphNode;
  /** The lowered compiled node (`step | commit | gate`), for effect/fencing info. */
  compiledNode: CompiledNode;
  /** The resolved logical identity for this node instance (R2; default = node.id). */
  nodeInstanceId: string;
  /** The run id (deterministic: `${graph_id}@${launchHash.slice(0,12)}`). */
  runId: string;
  /** The source graph id. */
  graphId: string;
  /** Monotonic execution ordinal (0-based) for this node instance. */
  executionEpoch: number;
  /** Which attempt this is (1-based). */
  attempt: number;
  /** How the run's evidence is classified. */
  evidenceClass: EvidenceClass;
  /** The instance-unique run directory (a value; persistence is opt-in). */
  runDir?: string;
  /**
   * F5 (architect-review #3159) — the ONE shared mid-flight-termination primitive.
   * The executor threads a fresh `AbortController.signal` here per handler
   * invocation; a cooperative handler MAY check/await it to stop mid-flight. It is
   * aborted by D's (#3163) per-node timeout/deadline path now, and by E's (#3164)
   * cancellation later — so INT-3's mid-flight-termination convention cannot diverge
   * into race-orphan vs cooperative-poll. Optional/additive: a handler that ignores
   * it behaves exactly as #3160 (the v0.1 deterministic doubles do).
   */
  signal?: AbortSignal;
  /**
   * E/#3164 — the cooperative cancellation poll the executor threads per node so a
   * handler can yield at a `handler-yield` checkpoint (`await
   * ctx.checkCancellation("handler-yield")` → `true` ⇒ the handler stops, e.g. via
   * `checkpoint(token)`). Optional/additive: a handler that ignores it behaves
   * exactly as #3160 (the v0.1 doubles never poll it).
   */
  checkCancellation?: (
    checkpoint: CancellationCheckpoint
  ) => boolean | Promise<boolean>;
}

/**
 * The result a node handler returns. `outcome` is the layer-1 lifecycle
 * classification (R3). `next` OPTIONALLY declares which successor arm(s) the
 * handler took — this is how branch/parallel/map routing enters v0.1, because the
 * compiled artifact does NOT lower routing predicates (Anchor 3 / KD1). When
 * omitted, the executor falls back to the IR-declared successors (`computeNext`).
 */
export interface NodeHandlerResult {
  outcome: ExecutionOutcome;
  next?: string[];
  /**
   * OPTIONAL layer-3 effect-lifecycle states this invocation produced, keyed by
   * `effect_id` (synthesis II.5 Layer 3, issue #3162). Set ONLY by C's ledger
   * interceptor (`execute/effect-ledger.ts#makeLedgerHook`) on commit-lowered
   * nodes; the executor lifts it onto `RunRecordNode.effects` when present. Plain
   * handlers and the B/D/E seams never set it — additive/backward-compatible, so
   * the pinned `LedgerHook`/`NodeHandler` SIGNATURES are unchanged (INT-4 safe).
   */
  effects?: Record<string, EffectLifecycle>;
  /**
   * OPTIONAL total attempt count for this node visit. Set ONLY by D's retry policy
   * (`execute/retry-policy.ts#makeRetryPolicyHook`, issue #3163) when it ran a
   * multi-attempt loop; the executor uses it to make the ONE canonical
   * `RunRecordNode` evidence the attempts via B's supersession
   * (`canonical_attempt == N`, `supersedes.length == N-1`) — attempts are NOT
   * stored as separate records (R5). Plain handlers and the B/C/E seams never set
   * it — additive/backward-compatible; unset ⇒ the executor's single-attempt
   * (or resume `priorRef`) numbering is byte-identical to #3160 (INT-4 safe).
   */
  retry_attempts?: number;
}

/** A pluggable node handler (async — real handlers do I/O). */
export type NodeHandler = (ctx: NodeExecContext) => Promise<NodeHandlerResult>;

/**
 * Node handlers keyed by node id. A `default` entry is the fallback for any node
 * without a specific handler — the deterministic test-double registers exactly one
 * `default` that succeeds every node (byte-reproducible CI).
 */
export type HandlerRegistry = Record<string, NodeHandler>;

// ── B–E extension seams (optional, no-op-defaulted hooks — R6) ───────────────
/**
 * The identity B/#3161 resolves per node instance (synthesis II.6): the logical
 * `node_instance_id` plus the reuse-decision `execution_signature`. Co-produced
 * from ONE encoder (architect-review F2) so C/#3162 (ledger keying) and D/#3163
 * (attempt-tracking) consume a single identity source — a separate signature hook
 * would invite the second encoder INT-1 forbids.
 */
export interface NodeIdentity {
  /** The logical identity, stable across retries/reorders (II.6). Default: `node.id`. */
  node_instance_id: string;
  /**
   * The reuse-decision digest (II.6). Default: `""` — A/#3160's no-op posture (A
   * carried no signature concept); B's encoder co-produces the real digest.
   */
  execution_signature: string;
}

/**
 * B/#3161 — resolve a node's identity. `ctx` carries the multiplicity so B can
 * derive iteration/item-scoped identities. **Synchronous** (architect-review F10:
 * the signature digest via `hashObject` is sync — do NOT make this async).
 * Default posture (A's no-op): `{ node_instance_id: node.id, execution_signature:
 * "" }`; B's default encoder (`execute/identity.ts#encodeNodeIdentity`) co-produces
 * the real id + signature.
 */
export type IdentityHook = (
  node: GraphNode,
  ctx: NodeMultiplicity
) => NodeIdentity;

/** The context C's ledger interceptor receives. */
export interface LedgerHookContext {
  /** The authored IR node. */
  node: GraphNode;
  /** The lowered compiled node (kind `commit` for a ledgered effect). */
  compiledNode: CompiledNode;
  /** The resolved logical identity for this node instance. */
  nodeInstanceId: string;
  /** The instance-unique run directory C writes its `ledger.jsonl` into (GAP-1). */
  runDir?: string;
  /** The commit node's deterministic fencing key (from the compiled node). */
  idempotencyKey?: string;
  /** The commit node's effect-ledger preamble (intent → perform → committed). */
  ledger?: EffectLedgerRecord[];
  /**
   * E/#3164 — the cooperative cancellation poll for the `after-effect-commit`
   * checkpoint. C consults it AROUND `perform()`: before performing (no NEW
   * `perform()` after a cancel is observed — R3(a)) and after `perform()` resolves
   * (no PERFORM-path `EffectCommitted` post-observation — R3(b)); on cancel the
   * effect is left `IN_DOUBT` for `reconcile`. Optional/additive: absent ⇒
   * byte-identical to #3162.
   */
  checkCancellation?: (
    checkpoint: CancellationCheckpoint
  ) => boolean | Promise<boolean>;
}

/**
 * C/#3162 — an AROUND/interceptor on a commit-node's effect. It RECEIVES the
 * `perform()` thunk and MUST invoke it (C wraps the effect, it does not merely
 * observe it). Default: invoke `perform()` directly. Nesting order is
 * `retry(ledger(handler))` — D wraps OUTSIDE C.
 */
export type LedgerHook = (
  ctx: LedgerHookContext,
  perform: () => Promise<NodeHandlerResult>
) => Promise<NodeHandlerResult>;

/** The context D's retry/timeout policy receives. */
export interface RetryPolicyHookContext {
  /** The authored IR node. */
  node: GraphNode;
  /** The resolved logical identity for this node instance. */
  nodeInstanceId: string;
  /** The node's declared retry budget from the IR, when present. */
  retry?: { max: number };
  /**
   * F5 (architect-review #3159) — abort the CURRENT in-flight attempt's
   * `NodeExecContext.signal`. The executor threads a fresh `AbortController` per
   * handler invocation; D calls this when its per-node timeout / deadline fires so
   * a cooperative handler can stop mid-flight. It is the SAME shared abort primitive
   * E/#3164 drives from its cancellation path — INT-3's termination convention lives
   * in one place. No-op-safe when absent (a bare hook still works).
   */
  abortInFlight?: () => void;
  /**
   * E/#3164 — the cooperative cancellation poll for the `policy-wait` checkpoint. D
   * polls it after its (cancellable, via `cancellableClock`) backoff sleep and
   * before each attempt; `true` ⇒ D stops the retry loop and returns node outcome
   * `cancelled` (a cancel arriving during backoff must not wait the backoff out —
   * INT-3). Optional/additive: absent ⇒ byte-identical to #3163.
   */
  checkCancellation?: (
    checkpoint: CancellationCheckpoint
  ) => boolean | Promise<boolean>;
}

/**
 * D/#3163 — per-node retry / timeout / deadline policy. It RECEIVES the
 * (ledger-wrapped) `attempt()` thunk and returns its result. Default: run once,
 * no timeout.
 */
export type RetryPolicyHook = (
  ctx: RetryPolicyHookContext,
  attempt: () => Promise<NodeHandlerResult>
) => Promise<NodeHandlerResult>;

/**
 * The cooperative-cancellation checkpoint classes E polls at. All FOUR are now
 * reachable (E/#3164 shipped the callback plumbing the pre-B architect review
 * (F7) sanctioned as additive):
 *   - `before-handler` — the executor polls `opts.cancellation` directly (run-level
 *     with `node` undefined, then node-level).
 *   - `handler-yield` — a cooperative handler polls `NodeExecContext.checkCancellation`.
 *   - `after-effect-commit` — C's ledger polls `LedgerHookContext.checkCancellation`
 *     around `perform()` (before → no NEW perform; after → no PERFORM-path commit).
 *   - `policy-wait` — D's retry loop polls `RetryPolicyHookContext.checkCancellation`
 *     around its (cancellable, via `cancellableClock`) backoff.
 * All three `checkCancellation?` fields are OPTIONAL/additive — absent ⇒ the seam is
 * byte-identical to #3160/#3162/#3163 (R6: no breaking change to A's contract). The
 * union stays OPEN (extend, never fork).
 */
export type CancellationCheckpoint =
  | "before-handler"
  | "handler-yield"
  | "after-effect-commit"
  | "policy-wait";

/** The context E's cancellation poll receives. */
export interface CancellationHookContext {
  /** The authored IR node (absent for run-level checkpoints). */
  node?: GraphNode;
  /** The resolved logical identity for this node instance (absent run-level). */
  nodeInstanceId?: string;
  /** Which checkpoint class is being polled. */
  checkpoint: CancellationCheckpoint;
}

/**
 * E/#3164 — a cooperative cancellation poll. Returns `true` to request
 * cancellation at this checkpoint. Default: never cancelled.
 */
export type CancellationHook = (
  ctx: CancellationHookContext
) => boolean | Promise<boolean>;

// ── Executor options + result ─────────────────────────────────────────────────
/**
 * Options for `executeWorkflow`. `handlers` is required; every other field is an
 * optional seam whose default reproduces the v0.1 deterministic simulator exactly.
 */
export interface ExecutorOptions {
  /** Pluggable node handlers keyed by node id; a `default` entry is the fallback. */
  handlers: HandlerRegistry;
  /** How to classify the run's evidence (default `"simulated"`). */
  evidenceClass?: EvidenceClass;
  /**
   * Resume seam: record this node `waiting` (a durable pending-operator signal,
   * II.6) and STOP the run with `stopped_reason:"interrupted"`; its successors do
   * NOT execute. Mirrors the v0.1 simulator's `ExecuteOptions.pauseAtNodeId`.
   */
  pauseAtNodeId?: string;
  /**
   * Resume seam: node id → the `canonical_result_ref` of a PRIOR attempt this
   * instance supersedes (II.8). The re-executed node becomes `canonical_attempt:2`
   * with a `supersedes` chain. Load-bearing for B's supersession (#3161).
   */
  supersede?: Record<string, string>;
  /** B/#3161 — identity resolution. Default: node id. */
  identity?: IdentityHook;
  /** C/#3162 — effect-ledger AROUND interceptor on commit nodes. Default: passthrough. */
  ledger?: LedgerHook;
  /** D/#3163 — per-node retry/timeout policy. Default: run once. */
  retry?: RetryPolicyHook;
  /** E/#3164 — cooperative cancellation poll. Default: never cancelled. */
  cancellation?: CancellationHook;
  /**
   * Opt-in durable-persistence root. When set, the executor establishes the
   * instance-unique `run_dir` under it and persists surfaced `ResumeSignal`s
   * there. When unset (v0.1 benchmark/fault-injection default), the executor
   * performs NO filesystem writes — preserving the no-wall-clock / no-randomness
   * reproducibility invariant (OR3).
   */
  runsRoot?: string;
  /**
   * Injected instance segment for `run_dir` (`<start-iso8601>-<uniq>`). Only used
   * when `runsRoot` is set; injected (not read from a clock inside the executor)
   * so the executor itself stays deterministic.
   */
  runInstanceSegment?: string;
}

/**
 * The result of one executor run. Its member NAMES are a pinned contract
 * (`answerBenchmarkMetrics` reads `.compiled`; the evidence writer consumes
 * `.routing`/`.gate_signals`). `compiled` is `null` ONLY on a refused run —
 * `compileIR` threw before any artifact existed (R5).
 */
export interface ExecuteResult {
  compiled: CompiledWorkflow | null;
  run_record: RunRecord;
  routing: RoutingDecision[];
  gate_signals: GateSignal[];
}
