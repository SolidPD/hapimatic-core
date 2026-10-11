// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The production graph executor — issue #3160 (Graph Runtime v1, Graph Engineering
 * Phase 3, Wave 1, Sub-Issue A). The substrate #3161–#3164 attach to.
 *
 * `executeWorkflow(ir, opts)` runs a lint-clean graph node-by-node against
 * pluggable node handlers and emits a canonical `RunRecord` (synthesis II.8). It
 * REPLACES the inline v0.1 deterministic simulator that lived in
 * `scripts/graph-engineering/benchmark.ts` — this module is a relocation +
 * generalization of that code, adding a handler registry and the four B–E
 * extension seams (identity/ledger/retry/cancellation), all no-op-defaulted.
 *
 * 🔴 Verify-then-execute (R5): the executor compiles the IR ONCE up front
 * (`compileIR`, which gates on `runLinter`). A lint-failing artifact throws
 * `CompileError` → the run is REFUSED before any node executes (fail closed). It
 * never re-lints/re-compiles mid-run.
 *
 * 🔴 IR-first routing (KD1 / Anchor 3): the v0.1 compiled artifact does NOT lower
 * routing predicates (`CompiledEdge` is `{from,to}` only). Routing therefore comes
 * from the IR (branch arms, loop bounds, gate continuation) plus any
 * handler-declared `next` — never from the compiled edges alone.
 *
 * 🔴 Determinism: with the deterministic test-double handler and no persistence
 * sink, the executor uses NO wall-clock and NO randomness — `run_id`,
 * `canonical_result_ref`, and every traversal decision derive only from the graph
 * + its compiled launch hash, so a re-run yields a byte-identical `RunRecord`
 * (OR3). The instance-unique `run_dir` is only materialized when a caller opts
 * into persistence via `ExecutorOptions.runsRoot`.
 *
 * 🔴 RUNTIME MODULE (node:crypto via `recordLaunchHash`): exposed via the
 * `@hapi/protocol/graph/execute` subpath, NOT the web-safe root barrel (KD2).
 */
import { compileIR, CompileError, recordLaunchHash } from "../compile";
import type { CompiledNode, CompiledWorkflow } from "../compile/types";
import type { GraphIR, GraphNode } from "../ir";
import {
  RunRecordSchema,
  type EffectLifecycle,
  type ExecutionOutcome,
  type RunRecord,
  type RunRecordNode,
  type RunStoppedReason,
} from "../run-record";
import {
  buildRunDir,
  type ExecuteResult,
  type ExecutorOptions,
  type GateSignal,
  type NodeExecContext,
  type NodeHandler,
  type NodeHandlerResult,
  type ResumeSignal,
  type RoutingDecision,
} from "./types";
import { encodeNodeIdentity } from "./identity";
import { Cancelled, cancellationResumeSignal } from "./cancellation";

// ── Deterministic helpers (lifted verbatim from the v0.1 simulator) ──────────

/**
 * Deterministic canonical-result reference for a node attempt. Keyed on the
 * `node_instance_id` (architect-review F3) — NOT the raw node id — so under map/loop
 * multiplicity each instance's `canonical_result_ref` is unique and the II.8
 * `supersedes` chain cannot collide across items/iterations. In v0.1 (one instance
 * per node) the `node_instance_id` reduces to the node id, so refs stay byte-identical.
 */
export function resultRef(
  runId: string,
  nodeInstanceId: string,
  attempt: number
): string {
  return `${runId}#${nodeInstanceId}@${attempt}`;
}

/**
 * Compute the successor node ids of `node`, honoring construct-specific routing
 * (branch arms / parallel targets / loop forward-edge / gate continuation /
 * subgraph ref / map body) from the IR — NOT just the control-flow edges (v0.1
 * does not lower branch predicates or loop bounds into the compiled edges, so the
 * routing semantics live in the IR — KD1). The rationale string is the A2
 * explainability evidence. This is the fallback used when a handler does not
 * declare its own `next`.
 */
export function computeNext(
  node: GraphNode,
  edgesFrom: Map<string, string[]>
): { next: string[]; rationale: string } {
  const out = edgesFrom.get(node.id) ?? [];
  switch (node.kind) {
    case "branch": {
      const arms = node.branches.map(b => `${b.when}→${b.to}`).join(", ");
      return {
        next: [node.default],
        rationale: `branch: no live predicate eval (simulated) — took declared default arm '${node.default}'. Guarded arms: [${arms}].`,
      };
    }
    case "parallel":
      return {
        next: [...node.targets],
        rationale: `parallel fan-out: ${node.targets.length} concurrent target(s) [${node.targets.join(", ")}].`,
      };
    case "loop":
      return {
        next: [...out],
        rationale: `loop: resolved within max_iterations=${node.max_iterations}; on_exhaustion route '${node.on_exhaustion}' NOT taken.`,
      };
    case "human_gate":
      return {
        next: [...out],
        rationale: `human_gate '${node.gate_id}': operator '${node.approver}' required; simulated approval → continuation [${out.join(", ")}].`,
      };
    case "subgraph":
      return {
        next: [node.ref],
        rationale: `subgraph: inline entry '${node.ref}'.`,
      };
    case "map":
      return {
        next: [...out],
        rationale: `map (item_key='${node.item_key}'): per-item body (single simulated item) [${out.join(", ")}].`,
      };
    case "join":
      return {
        next: [...out],
        rationale: `join: fan-in over upstreams [${node.upstreams.join(", ")}] → continuation [${out.join(", ")}].`,
      };
    default:
      return {
        next: [...out],
        rationale: `sequence: control-flow edge(s) [${out.join(", ")}].`,
      };
  }
}

/** The single graph node with no incoming reference — the run's entry point. */
export function findEntry(ir: GraphIR): GraphNode {
  const incoming = new Set<string>();
  for (const e of ir.edges) incoming.add(e.to);
  for (const n of ir.nodes) {
    if (n.kind === "branch") {
      for (const b of n.branches) incoming.add(b.to);
      incoming.add(n.default);
    } else if (n.kind === "parallel") {
      for (const t of n.targets) incoming.add(t);
    } else if (n.kind === "loop") {
      incoming.add(n.on_exhaustion);
    } else if (n.kind === "subgraph") {
      incoming.add(n.ref);
    }
    // NOTE: join.upstreams are PREDECESSORS (the join declares who feeds it); the
    // upstream nodes are themselves reached via edges, so they must NOT count as
    // "incoming" here or the entry search would wrongly exclude them.
  }
  const entries = ir.nodes.filter(n => !incoming.has(n.id));
  if (entries.length !== 1) {
    throw new Error(
      `executeWorkflow(${ir.id}): expected exactly one entry node, found ${entries.length} [${entries.map(n => n.id).join(", ")}]`
    );
  }
  return entries[0];
}

// ── Default seams (reproduce the v0.1 simulator behavior exactly) ────────────

/**
 * Surface a human-gate's operator requirement as BOTH a `GateSignal` (A8
 * explainability) and a durable `ResumeSignal` (R4), appending to the run's
 * collectors. Centralizes the gate-signal shape + dual-push so the three
 * surfacing sites — pause-injected `waiting`, auto-approved `succeeded`, and a
 * handler-returned `waiting` — cannot drift apart.
 */
function surfaceGateSignal(
  node: Extract<GraphNode, { kind: "human_gate" }>,
  requirement: string,
  gateSignals: GateSignal[],
  resumeSignals: ResumeSignal[]
): void {
  const signal: GateSignal = {
    node_id: node.id,
    gate_id: node.gate_id,
    approver: node.approver,
    requirement,
  };
  gateSignals.push(signal);
  resumeSignals.push({ kind: "gate", ...signal });
}

// ── The refused-run sentinel (R5) ────────────────────────────────────────────
/**
 * Build the refused-run sentinel. `compileIR` threw BEFORE any compiled artifact
 * existed, so there is no launch hash: `run_id: "${ir.id}@refused"`,
 * `script_sha256: ""`, `graph_id: ir.id`, `nodes: {}`. STRICT_RESUME /
 * `checkResume` consumers MUST skip records with `stopped_reason:"refused"` — an
 * empty `script_sha256` is not a resumable hash.
 */
function refusedRun(ir: GraphIR): RunRecord {
  return {
    run_id: `${ir.id}@refused`,
    graph_id: ir.id,
    script_sha256: "",
    nodes: {},
    actual_tokens_spent: null,
    canonical_result_tokens: null,
    stopped_reason: "refused",
  };
}

/**
 * Run-stop-reason severity. The run's `stopped_reason` is a single scalar, but a
 * multi-branch traversal writes it once per terminating branch — so a later
 * clean-finishing branch must NOT mask an earlier abnormal termination (a failed
 * / cancelled / interrupted branch, review finding 4). `moreSevereStopReason`
 * keeps the MORE-severe reason, with one deliberate equal-rank pair:
 * `completed_terminal` and `no_successor` share rank 0, so between those two the
 * behavior is last-write-wins — exactly reproducing the v0.1 simulator, which
 * preserves the byte-identical phase-2 evidence (OR3). Every abnormal reason
 * outranks both, so it STICKS over a subsequent clean finish; a more-severe
 * abnormal reason still overwrites a less-severe one.
 */
const STOP_REASON_SEVERITY: Record<RunStoppedReason, number> = {
  no_successor: 0,
  completed_terminal: 0,
  interrupted: 2,
  cancelled: 3,
  failed_terminal: 4,
  refused: 5,
};
export function moreSevereStopReason(
  current: RunStoppedReason,
  candidate: RunStoppedReason
): RunStoppedReason {
  return STOP_REASON_SEVERITY[candidate] >= STOP_REASON_SEVERITY[current]
    ? candidate
    : current;
}

// ── The executor ──────────────────────────────────────────────────────────────

/**
 * Execute a verified graph node-by-node and materialize its `RunRecord`.
 *
 * Async because `NodeHandler` is async — `await` ripples to every call site.
 * Keeps the `executeWorkflow(ir, …)` name + IR-first signature so existing
 * consumers (the benchmark + fault-injection scripts) migrate cleanly.
 */
export async function executeWorkflow(
  ir: GraphIR,
  opts: ExecutorOptions
): Promise<ExecuteResult> {
  // ── Verify-then-execute (R5): a lint-failing artifact is refused up front. ──
  let compiled: CompiledWorkflow;
  try {
    compiled = compileIR(ir);
  } catch (e) {
    if (e instanceof CompileError) {
      const refused = refusedRun(ir);
      RunRecordSchema.parse(refused);
      return {
        compiled: null,
        run_record: refused,
        routing: [],
        gate_signals: [],
      };
    }
    throw e; // an unexpected error is a real failure — do not swallow it.
  }

  const scriptSha = recordLaunchHash(compiled);
  const runId = `${ir.id}@${scriptSha.slice(0, 12)}`;
  const evidenceClass = opts.evidenceClass ?? "simulated";
  const supersede = opts.supersede ?? {};
  // B/#3161 (architect-review F2): the default identity is the ONE co-producing
  // encoder `execute/identity.ts#encodeNodeIdentity` — it REPLACES A/#3160's
  // `{ node.id, "" }` no-op, materializing the real `execution_signature` alongside
  // the id. In the executor's single-pass traversal the multiplicity ctx carries no
  // itemKey/iterationIndex, so the id reduces to the bare `node.id` — keeping the
  // run-record keys (and compiled↔runtime idempotency parity) byte-identical to the
  // #3160 default (INT-1). C/#3162 threads real multiplicity through the same encoder.
  const identity = opts.identity ?? encodeNodeIdentity;

  // Instance-unique run_dir is materialized as a VALUE only when a persistence
  // sink is configured; v0.1 (no runsRoot) computes nothing → deterministic (OR3).
  const runDir =
    opts.runsRoot !== undefined
      ? buildRunDir(
          opts.runsRoot,
          runId,
          opts.runInstanceSegment ?? "0000-00000000T000000Z"
        )
      : undefined;

  const byId = new Map(ir.nodes.map(n => [n.id, n]));
  const compiledById = new Map<string, CompiledNode>(
    compiled.nodes.map(n => [n.id, n])
  );
  const edgesFrom = new Map<string, string[]>();
  for (const e of ir.edges) {
    const arr = edgesFrom.get(e.from) ?? [];
    arr.push(e.to);
    edgesFrom.set(e.from, arr);
  }

  const nodes: Record<string, RunRecordNode> = {};
  const routing: RoutingDecision[] = [];
  const gateSignals: GateSignal[] = [];
  const resumeSignals: ResumeSignal[] = [];
  let stoppedReason: RunStoppedReason = "no_successor";
  let epoch = 0;

  // FIFO traversal with visited-dedup (a parallel fan-out enqueues a join once).
  const entry = findEntry(ir);
  const queue: string[] = [entry.id];
  const enqueued = new Set<string>([entry.id]);

  // A run-level cancellation checkpoint helper (E/#3164; default: never cancelled).
  const pollCancellation = async (
    node: GraphNode | undefined,
    nodeInstanceId: string | undefined,
    checkpoint: Parameters<
      NonNullable<ExecutorOptions["cancellation"]>
    >[0]["checkpoint"]
  ): Promise<boolean> => {
    if (!opts.cancellation) return false;
    return await opts.cancellation({ node, nodeInstanceId, checkpoint });
  };

  outer: while (queue.length > 0) {
    const id = queue.shift() as string;
    const node = byId.get(id);
    if (!node) {
      throw new Error(`executeWorkflow(${ir.id}): dangling successor '${id}'`);
    }
    const compiledNode = compiledById.get(id);
    if (!compiledNode) {
      throw new Error(
        `executeWorkflow(${ir.id}): node '${id}' has no compiled counterpart`
      );
    }

    // B/#3161 supersession seam. When the caller declares a prior attempt for
    // this instance (`opts.supersede[id]`), v0.1 ALWAYS recomputes it as a new
    // attempt (canonical_attempt 2, prior ref → supersedes[]). This is the
    // conservative arm of the outcome-gated policy `identity.ts#decideReuse`: the
    // seam carries only the prior ref (not its outcome/signature), and the sole
    // live trigger — the fault-injection resume — always supersedes a `waiting`
    // gate, which `decideReuse` recomputes. The executor NEVER unconditionally
    // reuses (finding 3161-1 HIGH): definition-level signatures are not value-safe
    // (R7), so `decideReuse` is the exported policy a future value channel (C /
    // Wave-2) consumes once prior state is threaded through the seam.
    const priorRef = supersede[id];
    const attempt = priorRef ? 2 : 1;
    // F2: ONE hook call co-produces the id + signature (no drift). F1: `attempt`
    // is passed for ctx completeness but does NOT affect the resolved identity.
    const {
      node_instance_id: nodeInstanceId,
      execution_signature: executionSignature,
    } = identity(node, { attempt });

    // ── Resume seam: pause at this node → durable `waiting` signal, then stop. ─
    // Preserves the v0.1 simulator's pauseAt behavior byte-for-byte (the gate's
    // durable-resume requirement string is unchanged).
    if (opts.pauseAtNodeId === id) {
      nodes[nodeInstanceId] = {
        execution_epoch: epoch,
        canonical_attempt: 1,
        supersedes: [],
        canonical_result_ref: resultRef(runId, nodeInstanceId, 1),
        outcome: "waiting",
        execution_signature: executionSignature,
      };
      if (node.kind === "human_gate") {
        surfaceGateSignal(
          node,
          "operator approval (durable resume signal — II.6)",
          gateSignals,
          resumeSignals
        );
      }
      stoppedReason = moreSevereStopReason(stoppedReason, "interrupted");
      break;
    }

    // ── Cancellation checkpoints: before-handler (E/#3164). ───────────────────
    // Surface this node's durable cancellation resume signal (R4). Shared by the
    // two before-handler branches AND the mid-handler outcome path below.
    const emitCancellationSignal = (): void => {
      resumeSignals.push(
        cancellationResumeSignal({
          nodeId: nodeInstanceId,
          scopeId: nodeInstanceId,
        })
      );
    };
    // Record the current node `cancelled` + emit its resume signal — the shared body
    // of the two before-handler branches (they differ ONLY in the terminal action:
    // fold+break vs continue). Called at most once per node (the branches are
    // mutually exclusive), so `epoch++` fires exactly once, as in the inline form.
    const recordCancelledNode = (): void => {
      nodes[nodeInstanceId] = {
        execution_epoch: epoch++,
        canonical_attempt: attempt,
        supersedes: priorRef ? [priorRef] : [],
        canonical_result_ref: resultRef(runId, nodeInstanceId, attempt),
        outcome: "cancelled",
        execution_signature: executionSignature,
      };
      emitCancellationSignal();
    };
    // RUN-LEVEL FIRST (poll with node undefined): a WHOLE-RUN cancel is the ONLY
    // path that stops the run with `cancelled` — record the current node cancelled,
    // fold `cancelled`, and break (remaining queue does not run, like the pauseAt
    // seam). A hook that cancels unconditionally (e.g. A's placeholder
    // `ctx => ctx.checkpoint === "before-handler"`) returns true here → this branch.
    if (await pollCancellation(undefined, undefined, "before-handler")) {
      recordCancelledNode();
      stoppedReason = moreSevereStopReason(stoppedReason, "cancelled");
      break;
    }
    // NODE/BRANCH-LEVEL: this node's scope is cancelled but the whole run is not —
    // record it cancelled + surface the durable resume signal (R4), then drop ONLY
    // this node's frontier (`continue outer`) so sibling `parallel` arms run to
    // completion (R2). Deliberately does NOT fold `cancelled` into the run reason:
    // a branch-cancel that drains the frontier stops `no_successor`, not `cancelled`
    // (ruling R10 — only a whole-run cancel yields `cancelled`).
    if (await pollCancellation(node, nodeInstanceId, "before-handler")) {
      recordCancelledNode();
      continue outer;
    }

    // ── Invoke the handler through the extension seams: retry(ledger(handler)). ─
    const execCtx: NodeExecContext = {
      node,
      compiledNode,
      nodeInstanceId,
      runId,
      graphId: ir.id,
      executionEpoch: epoch,
      attempt,
      evidenceClass,
      runDir,
      // E/#3164 — a per-node cancellation poll so a cooperative handler can yield
      // at a `handler-yield` checkpoint. Maps to the same `opts.cancellation` hook.
      checkCancellation: checkpoint =>
        pollCancellation(node, nodeInstanceId, checkpoint),
    };
    const handler: NodeHandler | undefined =
      opts.handlers[id] ?? opts.handlers.default;
    if (!handler) {
      throw new Error(
        `executeWorkflow(${ir.id}): no handler for node '${id}' and no 'default' handler registered`
      );
    }
    // F5/#3159 — the ONE shared mid-flight-termination primitive. A FRESH
    // AbortController per handler invocation is threaded into `execCtx.signal` so a
    // cooperative handler can stop mid-flight; D's (#3163) timeout/deadline aborts it
    // via `abortInFlight` below, and E's (#3164) cancellation will drive the SAME
    // primitive later. Per-invocation (not per-node) means a retry gets a FRESH
    // un-aborted signal. Non-cooperative handlers (the v0.1 doubles) ignore it —
    // byte-identical to #3160 (the signal is never recorded in the RunRecord).
    let currentAttemptController: AbortController | undefined;
    const invokeHandler = () => {
      currentAttemptController = new AbortController();
      execCtx.signal = currentAttemptController.signal;
      return handler(execCtx);
    };
    // C/#3162 — ledger AROUND interceptor, but only on commit-lowered nodes.
    const withLedger =
      compiledNode.kind === "commit" && opts.ledger
        ? () =>
            opts.ledger!(
              {
                node,
                compiledNode,
                nodeInstanceId,
                runDir,
                idempotencyKey: compiledNode.idempotency_key,
                ledger: compiledNode.ledger,
                // E/#3164 — the ledger's cancel-during-effect poll (R3).
                checkCancellation: checkpoint =>
                  pollCancellation(node, nodeInstanceId, checkpoint),
              },
              invokeHandler
            )
        : invokeHandler;
    // D/#3163 — retry/timeout wraps OUTSIDE the ledger. `abortInFlight` lets D abort
    // the current attempt's `execCtx.signal` when its timeout/deadline fires (F5).
    const withRetry = opts.retry
      ? () =>
          opts.retry!(
            {
              node,
              nodeInstanceId,
              retry: node.retry,
              abortInFlight: () => currentAttemptController?.abort(),
              // E/#3164 — the retry policy's `policy-wait` cancel poll (Task 4g).
              checkCancellation: checkpoint =>
                pollCancellation(node, nodeInstanceId, checkpoint),
            },
            withLedger
          )
      : withLedger;

    let outcome: ExecutionOutcome;
    let handlerNext: string[] | undefined;
    // C/#3162 — the ledger interceptor surfaces per-effect layer-3 state via the
    // OPTIONAL NodeHandlerResult.effects map; the executor lifts it onto the
    // RunRecordNode. undefined for non-commit nodes and a disabled/absent ledger,
    // so those records stay byte-identical to #3160 (no `effects` field).
    let handlerEffects: Record<string, EffectLifecycle> | undefined;
    // D/#3163 — the retry policy reports its total attempt count (undefined unless
    // a multi-attempt loop ran); the record-builder below evidences it via B's
    // supersession on the ONE canonical record (R5).
    let handlerRetryAttempts: number | undefined;
    try {
      const result: NodeHandlerResult = await withRetry();
      outcome = result.outcome;
      handlerNext = result.next;
      handlerEffects = result.effects;
      handlerRetryAttempts = result.retry_attempts;
    } catch (e) {
      // E/#3164: a cooperative cancellation reaches this catch ONLY when a handler
      // THROWS `Cancelled` from a `handler-yield` checkpoint → record the node
      // `cancelled`, NOT `failed_terminal` (R1/R4). (The `policy-wait` and
      // cancel-during-effect paths do NOT throw — they RETURN `{outcome:"cancelled"}`
      // and flow through the normal outcome handling above.) Any OTHER throw is a
      // real failure → failed_terminal (v0.1 default — structured retryable failures
      // use NodeHandlerResult, not throws).
      outcome = e instanceof Cancelled ? "cancelled" : "failed_terminal";
    }

    // ── Record the node's canonical attempt (keyed by node_instance_id — R2). ──
    // D/#3163 (R5): when the retry policy ran a multi-attempt loop it reports N via
    // `retry_attempts`; the ONE canonical record then evidences the attempts —
    // `canonical_attempt == N` and `supersedes` = the N-1 prior in-run result refs
    // (preceded by a cross-run resume `priorRef`, if any). Attempts are NOT stored
    // as separate records. When `retry_attempts` is unset (no D policy, or a single
    // attempt), the record is byte-identical to #3160 (single attempt / resume).
    let canonicalAttempt = attempt;
    let supersedes = priorRef ? [priorRef] : [];
    if (handlerRetryAttempts !== undefined && handlerRetryAttempts > 1) {
      // COMPOSE the in-run retry count ON TOP of the resume generation `attempt`
      // (1 fresh, 2 on a cross-run resume) — do NOT overwrite it. This visit's
      // generations run `attempt … attempt+N-1`; the final is canonical and the
      // earlier in-run generations are superseded (preceded by the cross-run
      // `priorRef` when resuming). Composing (not overwriting) keeps
      // `canonical_result_ref` unique across a fresh-and-retried vs a
      // resumed-and-retried visit on the same deterministic runId (review finding 1).
      canonicalAttempt = attempt + handlerRetryAttempts - 1;
      const inRunPrior: string[] = [];
      for (let gen = attempt; gen < canonicalAttempt; gen++) {
        inRunPrior.push(resultRef(runId, nodeInstanceId, gen));
      }
      supersedes = priorRef ? [priorRef, ...inRunPrior] : inRunPrior;
    }
    nodes[nodeInstanceId] = {
      execution_epoch: epoch++,
      canonical_attempt: canonicalAttempt,
      supersedes,
      canonical_result_ref: resultRef(runId, nodeInstanceId, canonicalAttempt),
      outcome,
      execution_signature: executionSignature,
      // R6: surface the layer-3 effect lifecycle ONLY when the ledger produced it.
      ...(handlerEffects ? { effects: handlerEffects } : {}),
    };

    // A human_gate surfaces its operator requirement (A8). The requirement text
    // MUST reflect the ACTUAL outcome — a hardcoded "auto-approved" claim would
    // contradict a gate the handler recorded as `waiting`/failed (review finding
    // 1). Only a gate that actually succeeded is auto-approved; a handler that
    // returns `waiting` on its own initiative (i.e. NOT via the pauseAtNodeId
    // seam) surfaces a durable resume signal (R4); a failed/cancelled gate
    // surfaces no approval signal.
    if (node.kind === "human_gate" && outcome === "succeeded") {
      surfaceGateSignal(
        node,
        "operator approval (surfaced; auto-approved in benchmark run)",
        gateSignals,
        resumeSignals
      );
    } else if (node.kind === "human_gate" && outcome === "waiting") {
      surfaceGateSignal(
        node,
        "operator approval (durable resume signal — II.6)",
        gateSignals,
        resumeSignals
      );
    }

    // `skipped` is NOT a stop: it has no `RunStoppedReason` counterpart (a skip
    // means "this node didn't run", not "the run ended"), so it flows to normal
    // successor computation exactly like `succeeded` (review finding 2). Every
    // OTHER non-`succeeded` outcome stops enqueueing THIS node's successors
    // (other frontier branches still drain); its run-level reason is folded in
    // via `moreSevereStopReason` so a later clean branch cannot mask it (finding
    // 4).
    if (outcome !== "succeeded" && outcome !== "skipped") {
      if (
        outcome === "failed_terminal" ||
        outcome === "failed_retryable" ||
        outcome === "refused" ||
        outcome === "timed_out"
      ) {
        stoppedReason = moreSevereStopReason(stoppedReason, "failed_terminal");
      } else if (outcome === "cancelled") {
        // E/#3164 — a cancel surfaced MID-handler (a `handler-yield` checkpoint, a
        // `policy-wait` interrupt, or C's cancel-during-effect → node outcome
        // `cancelled` + effect `in_doubt`). Surface the durable resume signal (R4)
        // and drop THIS node's frontier only (siblings continue — R2).
        emitCancellationSignal();
        // F5/INT-3 — drive the ONE shared mid-flight primitive on cancel: abort the
        // current attempt's `execCtx.signal` (the SAME AbortSignal D aborts on
        // timeout), so any fire-and-forget abortable I/O the handler started is
        // cancelled too. E and D therefore share one termination convention.
        currentAttemptController?.abort();
        // Whole-run vs branch (ruling R10): the before-handler run-level poll folds
        // `cancelled` for a cancel observed BEFORE the handler. But a whole-run
        // cancel can first surface MID-handler (the run scope was cancelled while
        // this node ran) — in which case the before-handler poll already passed and
        // nothing folded `cancelled`. Re-poll the run scope here: if the WHOLE RUN
        // is cancelled, fold `cancelled` (else a branch-cancel drain correctly ends
        // `no_successor`). Without this, a whole-run cancel first seen on the LAST
        // queued node mis-reports `stopped_reason:"no_successor"` (review Finding 1).
        if (await pollCancellation(undefined, undefined, "before-handler")) {
          stoppedReason = moreSevereStopReason(stoppedReason, "cancelled");
        }
      } else if (outcome === "waiting") {
        stoppedReason = moreSevereStopReason(stoppedReason, "interrupted");
      }
      continue outer;
    }

    // A terminal node is a defined stopping point (A3).
    if (node.terminal === true) {
      routing.push({
        node_id: id,
        kind: node.kind,
        next: [],
        rationale: `terminal: true — defined stopping point.`,
      });
      stoppedReason = moreSevereStopReason(stoppedReason, "completed_terminal");
      continue outer;
    }

    // Successors: a handler MAY declare its taken arm(s); else fall back to the
    // IR-declared routing (computeNext), exactly as the v0.1 simulator did.
    let next: string[];
    let rationale: string;
    if (handlerNext !== undefined) {
      next = handlerNext;
      rationale = `handler-declared successors [${handlerNext.join(", ")}].`;
    } else {
      ({ next, rationale } = computeNext(node, edgesFrom));
    }
    routing.push({ node_id: id, kind: node.kind, next, rationale });
    if (next.length === 0) {
      stoppedReason = moreSevereStopReason(stoppedReason, "no_successor");
      continue outer;
    }
    for (const nx of [...next].sort()) {
      if (!enqueued.has(nx)) {
        enqueued.add(nx);
        queue.push(nx);
      }
    }
  }

  const runRecord: RunRecord = {
    run_id: runId,
    graph_id: ir.id,
    script_sha256: scriptSha,
    nodes,
    // Self-exclusion (synthesis I.4): a simulated/artifact run is not measured.
    actual_tokens_spent: evidenceClass === "real" ? undefined : null,
    canonical_result_tokens: evidenceClass === "real" ? undefined : null,
    stopped_reason: stoppedReason,
  };
  // Fail loud if the executor ever produced an off-contract record (.strict()).
  RunRecordSchema.parse(runRecord);

  // The executor owns durability: persist surfaced resume signals into run_dir
  // WHEN a sink is configured. v0.1 (no runsRoot) writes nothing (OR3).
  if (opts.runsRoot !== undefined && runDir && resumeSignals.length > 0) {
    await persistResumeSignals(runDir, runId, runRecord, resumeSignals);
  }

  return {
    compiled,
    run_record: runRecord,
    routing,
    gate_signals: gateSignals,
  };
}

/**
 * Persist the run record + surfaced resume signals into the instance-unique
 * `run_dir` (R4 durability). Dynamically imports `node:fs` so `types.ts`/this
 * module stay importable in contexts that never opt into persistence. Only
 * reached when `ExecutorOptions.runsRoot` is set.
 */
async function persistResumeSignals(
  runDir: string,
  runId: string,
  runRecord: RunRecord,
  resumeSignals: ResumeSignal[]
): Promise<void> {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    `${runDir}/run-record.json`,
    JSON.stringify(runRecord, null, 2) + "\n",
    "utf8"
  );
  writeFileSync(
    `${runDir}/resume-signals.json`,
    JSON.stringify({ run_id: runId, signals: resumeSignals }, null, 2) + "\n",
    "utf8"
  );
}
