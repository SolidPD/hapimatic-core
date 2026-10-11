// SPDX-License-Identifier: AGPL-3.0-only
/**
 * v0.1 Graph Intermediate Representation (IR) schema — issue #2883 (Graph
 * Engineering Phase 1, sub-issue A). The foundational contract every other
 * Phase-1 sub-issue consumes: the linter (#2884/#2885), compiler (#2886), and
 * visualizer (#2887) all read the schema defined here.
 *
 * Ratified semantic source: `docs/internal/architecture/graph-engineering/
 * execution-semantics-charter.md` (Accepted 2026-08-15, epic #2875 CLOSED).
 * Claude-facing field-derivation source: `claudedocs/graph-engineering/
 * synthesis-v2.1-and-governance.md` Part II (semantic model) + Part IV (Epic 1).
 *
 * Design invariant — "no field without a consumer" (synthesis III.1): every
 * field below carries a `// consumer:` annotation naming the specific v0.1
 * reader. A field with no named consumer must not exist. The construct set is
 * frozen at 8 kinds (epic ruling D2-a); `agent`/`commit` are compiled-artifact
 * constructs emitted by #2886, never authored (epic ruling D1-B), so they are
 * absent here by design.
 */
import { z } from "zod";
import { RiskTierSchema, type RiskTier } from "../riskTier";

// ── Capability enforcement posture ───────────────────────────────────────────
/**
 * A capability's enforcement posture. v0.1 capabilities are DECLARED + LINTED,
 * not ENFORCED (synthesis I.5) — so a v0.1 entry is `declared` or `linted`. The
 * `enforced(<mech>)` form is reserved for a later phase and REQUIRES a non-empty
 * mechanism (`z.string().min(1)`): bare `enforced` and `enforced()` are rejected
 * (V4 — "no entry claims bare enforced without a <mech>"). The template-literal
 * form (zod 4.2.1) gives runtime validation AND the precise static type
 * `` `enforced(${string})` ``; the `z.string().regex(/^enforced\(.+\)$/)` union
 * is the documented fallback (it erases the literal type to `string`).
 */
export const EnforcementSchema = z.union([
  z.literal("declared"),
  z.literal("linted"),
  z.templateLiteral(["enforced(", z.string().min(1), ")"]),
]);
export type Enforcement = z.infer<typeof EnforcementSchema>;

// ── Risk tier + rank ─────────────────────────────────────────────────────────
// The canonical risk-tier vocabulary lives in `shared/src/riskTier.ts` (issue
// #3741, ER 2026-09-16 D9 — exactly ONE declaration repo-wide). It is imported
// above for local use (`RiskTierSchema` in EffectDeclSchema, `RiskTier` in
// RISK_TIER_RANK) and alias-re-exported here to preserve this module's public
// surface for existing importers. An alias re-export of the single declaration is
// TS2308-safe (landed precedents: `types.ts:63`→`effort.ts:16`,
// `conflictSeverity.ts:240`→`fileClaims.ts:15`); what must never exist is a second
// *declaration*.
export { RISK_TIERS, RiskTierSchema, type RiskTier } from "../riskTier";

/**
 * Ordinal rank for risk-tier comparisons. Every "risk_tier >= mutating"
 * comparison MUST use this map, never string comparison.
 * // consumer: #2885 unledgered-mutating rule + #2886 commit-node lowering
 * House idiom: `server/src/federation/healthAggregator.ts` SEVERITY_RANK.
 */
export const RISK_TIER_RANK: Record<RiskTier, number> = {
  readonly: 0,
  mutating: 1,
  destructive: 2,
};

// ── Resource declaration ─────────────────────────────────────────────────────
/** A resource a node reads/writes. // consumer: resource-conflict lint (#2884) */
export const ResourceDeclSchema = z.object({
  name: z.string(), // consumer: resource-conflict lint (#2884) — conflict-key
  mode: z.enum(["read", "write", "exclusive"]), // consumer: resource-conflict lint (#2884) — read/write/exclusive conflict matrix
});
export type ResourceDecl = z.infer<typeof ResourceDeclSchema>;

// ── Effect declaration (synthesis II.2 consumer-derived candidate set) ────────
/**
 * A side-effect a node performs. Each field is derived from a named v0.1
 * consumer (synthesis II.2); this is a STARTING set — any field the linter /
 * compiler sub-issues do not read is deleted before Epic-1 exit.
 */
export const EffectDeclSchema = z.object({
  access: z.enum(["pure", "read", "write"]), // consumer: resource-conflict lint (write/read conflict detection)
  idempotency: z.enum(["natural", "none"]).or(z.object({ keyed: z.string() })), // consumer: effect-ledger dedup + STRICT_RESUME
  reversibility: z
    .enum(["reversible", "irreversible"])
    .or(z.object({ compensatable: z.string() })), // consumer: effect-ledger recovery routing
  authority: z.enum(["none"]).or(z.object({ witness: z.array(z.string()) })), // consumer: capability validation + witness preamble
  reconciliation: z
    .enum(["keyed-dedup", "none"])
    .or(z.object({ queryable: z.string() })), // consumer: effect-ledger IN_DOUBT reconcile
  risk_tier: RiskTierSchema, // consumer: effect-ledger gate (only >= mutating gets ledger treatment, synthesis II.1) + capability lint
});
export type EffectDecl = z.infer<typeof EffectDeclSchema>;

// ── Capability entry ─────────────────────────────────────────────────────────
/** A capability a node declares it exercises. // consumer: capability validation (#2884) */
export const GraphCapabilitySchema = z.object({
  name: z.string(), // consumer: capability validation (#2884) — capability identity
  enforcement: EnforcementSchema, // consumer: capability validation (#2884) — v0.1 posture is declared|linted; enforced(<mech>) reserved
});
export type GraphCapability = z.infer<typeof GraphCapabilitySchema>;

// ── Typed node contract ──────────────────────────────────────────────────────
/** Port→type-name maps for a node's typed I/O contract. */
export const NodeContractSchema = z.object({
  inputs: z.record(z.string(), z.string()).optional(), // consumer: #2886 compiler node-contract type check (input port types)
  outputs: z.record(z.string(), z.string()).optional(), // consumer: #2886 compiler node-contract type check (output port types)
});
export type NodeContract = z.infer<typeof NodeContractSchema>;

// ── Shared node base ─────────────────────────────────────────────────────────
/**
 * Fields common to every node kind. Each construct schema below `.extend()`s
 * this base with a `kind` literal discriminator plus its kind-specific fields.
 */
const NodeBaseSchema = z.object({
  id: z.string(), // consumer: validateGraphIR (duplicate_id + dangling_ref resolution) — every consumer references nodes by id
  contract: NodeContractSchema.optional(), // consumer: #2886 compiler node-contract type check
  resources: z.array(ResourceDeclSchema).optional(), // consumer: resource-conflict lint (#2884)
  effects: z.array(EffectDeclSchema).optional(), // consumer: effect-ledger (#2886)
  capabilities: z.array(GraphCapabilitySchema).optional(), // consumer: capability validation (#2884)
  terminal: z.boolean().optional(), // consumer: #2885 missing_terminal_condition (>=1 node with terminal:true reachable from entry; entry = nodes with no incoming edges; existential form for v0.1)
  retry: z
    .object({
      max: z.number().int(), // consumer: #2885 negative_retry — schema deliberately permits negatives so the lint rule owns negativity; do not "clean up" with .nonnegative()
      // consumer: #3163 runtime retry/timeout/deadline — inter-attempt delay (base `ms`, optional exponential `factor`, default constant)
      backoff: z
        .object({
          ms: z.number().int().nonnegative(),
          factor: z.number().positive().optional(),
        })
        .optional(),
    })
    .optional(),
  // consumer: #3163 runtime retry/timeout/deadline — per-node timeout; exceeding it marks the node `timed_out`
  // (run-record `ExecutionOutcome`). A large per-node override protects a slow-but-healthy node from a false timeout.
  timeout: z.object({ ms: z.number().int().positive() }).optional(),
  // consumer: #3163 runtime retry/timeout/deadline — a RUN-RELATIVE retry budget (a logical/duration budget,
  // NEVER an absolute wall-clock timestamp in authored IR: graphs are single-use but must replay reproducibly under
  // simulation, and the production clock's now() is monotonic).
  deadline: z.object({ ms: z.number().int().positive() }).optional(),
  // NOTE (#3163): retry/timeout/deadline are runtime-read policy fields — the executor reads them from the IR at run
  // time (no compiler lowering; `CompiledWorkflow` is untouched; `validate.ts` accepts them for free as optional base
  // fields). They are INVISIBLE to the launch hash: `recordLaunchHash` covers the `CompiledWorkflow` only, so a policy
  // edit does not change `script_sha256` and STRICT_RESUME treats it as the same workflow — intentional, mirroring B's
  // `node_revision` exclusion of policy fields. Do NOT add `.default()` to these (a default would inject the key into
  // every parsed IR for ALL consumers).
});

// ── The 8 minimal constructs (epic ruling D2-a — frozen at 8 kinds) ───────────
/** Linear step; ordering is carried by graph edges. */
export const SequenceNodeSchema = NodeBaseSchema.extend({
  kind: z.literal("sequence"), // consumer: validateGraphIR unknown_construct + #2886 compiler lowering
});

/** Deterministic switch: ordered guarded arms + a required default. */
export const BranchNodeSchema = NodeBaseSchema.extend({
  kind: z.literal("branch"), // consumer: validateGraphIR unknown_construct + #2886 compiler lowering
  // consumer: #2886 compiler branch lowering (the ordered guarded arms); inner when/to annotated below
  branches: z.array(
    z.object({
      when: z.string(), // consumer: #2886 compiler branch lowering (predicate ref)
      to: z.string(), // consumer: validateGraphIR dangling_ref + #2886 branch lowering (target node id)
    })
  ),
  default: z.string(), // consumer: validateGraphIR dangling_ref + #2886 branch lowering (fallthrough node id)
});

/** Fan-out: run every target node concurrently. */
export const ParallelNodeSchema = NodeBaseSchema.extend({
  kind: z.literal("parallel"), // consumer: validateGraphIR unknown_construct + #2886 compiler lowering
  targets: z.array(z.string()), // consumer: validateGraphIR dangling_ref + resource-conflict lint (#2884, concurrent branches) + #2886 fan-out lowering
});

/** Keyed map: apply a per-item subflow with a stable item identity. */
export const MapNodeSchema = NodeBaseSchema.extend({
  kind: z.literal("map"), // consumer: validateGraphIR unknown_construct + #2886 compiler lowering
  item_key: z.string(), // consumer: #2885 map_no_identity (stable per-item identity, R5) + #2886 map lowering
});

/** Fan-in: synchronize over named upstream nodes. */
export const JoinNodeSchema = NodeBaseSchema.extend({
  kind: z.literal("join"), // consumer: validateGraphIR unknown_construct + #2886 compiler lowering
  upstreams: z.array(z.string()), // consumer: validateGraphIR dangling_ref + #2886 fan-in lowering
});

/** Bounded loop: a finite iteration count + an exhaustion route. */
export const LoopNodeSchema = NodeBaseSchema.extend({
  kind: z.literal("loop"), // consumer: validateGraphIR unknown_construct + #2886 compiler lowering
  max_iterations: z.number().int().positive(), // consumer: #2885 loop_unbounded (bound presence, R5) + #2886 loop lowering
  on_exhaustion: z.string(), // consumer: validateGraphIR dangling_ref + #2885 loop_unbounded (exhaustion route, R5) + #2886 loop lowering
});

/** Human approval gate. */
export const HumanGateNodeSchema = NodeBaseSchema.extend({
  kind: z.literal("human_gate"), // consumer: validateGraphIR unknown_construct + #2886 compiler lowering
  gate_id: z.string(), // consumer: #2886 human-gate lowering (STRICT_RESUME checkpoint id)
  approver: z.string(), // consumer: capability validation (#2884) — who may satisfy the gate
});

/** Reference to a subgraph's entry node (resolved within this document in v0.1). */
export const SubgraphNodeSchema = NodeBaseSchema.extend({
  kind: z.literal("subgraph"), // consumer: validateGraphIR unknown_construct + #2886 compiler lowering
  ref: z.string(), // consumer: validateGraphIR dangling_ref (v0.1: resolves to a node id in this document) + #2886 subgraph inlining
});

/**
 * The discriminated union over `kind` — an unknown `kind` value is rejected here
 * for free (satisfies half of R4; the structural half lives in `validateGraphIR`).
 */
export const NodeSchema = z.discriminatedUnion("kind", [
  SequenceNodeSchema,
  BranchNodeSchema,
  ParallelNodeSchema,
  MapNodeSchema,
  JoinNodeSchema,
  LoopNodeSchema,
  HumanGateNodeSchema,
  SubgraphNodeSchema,
]);
export type GraphNode = z.infer<typeof NodeSchema>;

/** The complete, exhaustive set of v0.1 construct kinds (frozen — epic ruling D2-a). */
export const CONSTRUCT_KINDS = [
  "sequence",
  "branch",
  "parallel",
  "map",
  "join",
  "loop",
  "human_gate",
  "subgraph",
] as const;
export type ConstructKind = (typeof CONSTRUCT_KINDS)[number];

// ── Edges ────────────────────────────────────────────────────────────────────
/** A directed control-flow edge between two node ids. */
export const EdgeSchema = z.object({
  from: z.string(), // consumer: validateGraphIR dangling_ref + #2886 control-flow lowering
  to: z.string(), // consumer: validateGraphIR dangling_ref + #2886 control-flow lowering
});
export type Edge = z.infer<typeof EdgeSchema>;

// ── Top-level document ───────────────────────────────────────────────────────
/** The canonical v0.1 IR document. */
export const GraphIRSchema = z.object({
  id: z.string(), // consumer: #2887 visualizer graph identity + subgraph ref target
  version: z.literal("0.1"), // consumer: schema-version gate (all v0.1 consumers pin "0.1")
  nodes: z.array(NodeSchema), // consumer: every consumer (the node set)
  edges: z.array(EdgeSchema), // consumer: validateGraphIR dangling_ref + #2886 control-flow lowering + #2887 visualizer
});
export type GraphIR = z.infer<typeof GraphIRSchema>;
