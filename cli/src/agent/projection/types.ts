// SPDX-License-Identifier: AGPL-3.0-only
/**
 * HAL skill-projection compiler — types (issue #3122, epic #3117 Sub-Issue G).
 *
 * The projection compiler takes a **contract envelope** (rp1-home#1689 — the
 * declarative half of a skill's contract: `required_capabilities`, `phases`,
 * `invariants`, `degradation`, SHA-pinned to the prose SKILL.md) and a
 * **harness manifest** (#3118, `@hapi/protocol` `HarnessManifest`) and produces
 * a per-skill projection PLAN, then materializes it as an **Agent Plugins 1.0.0**
 * folder in a foreign harness's per-session config home.
 *
 * These types mirror the companion-epic envelope schema STRUCTURALLY (the schema
 * is OWNED by rp1-home `.claude/skills/_shared/contract-envelope-schema.md`,
 * schema_version 1) — this file does NOT author the schema, it types the shape
 * the compiler consumes. The capability tokens align 1:1 with the #3118 manifest
 * axes (snake_case here to match the envelope's on-disk YAML; the compiler maps
 * them to the manifest's camelCase axis names — see `compiler.ts`).
 *
 * KD5 (provenance) and KD6 (the ordered `ProjectionStage` seam that #3123/#3125/
 * #3130 register against) both live here — see `ProjectionProvenance`,
 * `ProjectionContext`, and `ProjectionStage` below.
 */
import type {
  HarnessManifest,
  HarnessProvenance,
  TriState,
  AgentFlavor,
} from "@hapi/protocol";

/**
 * The envelope capability tokens (snake_case, matching the on-disk `envelope.yaml`).
 * Aligned 1:1 with the #3118 `HarnessManifest` axes; the compiler
 * (`manifestCapabilityState`) is the single place that maps each token to its
 * camelCase manifest axis. Widening this union means widening the envelope
 * schema (rp1-home#1689) in lockstep.
 */
export type CapabilityToken =
  | "skills"
  | "hooks"
  | "mcp"
  | "instruction_file"
  | "acp"
  | "headless_exec"
  | "subagents"
  | "session_persistence"
  | "session_roles"
  | "sandboxing";

/** The set of all valid capability tokens (runtime guard for parsing). */
export const CAPABILITY_TOKENS: readonly CapabilityToken[] = [
  "skills",
  "hooks",
  "mcp",
  "instruction_file",
  "acp",
  "headless_exec",
  "subagents",
  "session_persistence",
  "session_roles",
  "sandboxing",
];

/** A hand-authored semantic phase from the envelope. */
export interface EnvelopePhase {
  /** Stable kebab-case id, unique within the envelope. */
  id: string;
  /** Human-readable phase name. */
  name: string;
  /** Present ONLY on gate/stop seam phases — the compiler projects these as real gates. */
  gate?: "approval" | "hard-stop";
}

/** A namespaced invariant reference (`MH-<n>` / `INV-<n>`). */
export interface EnvelopeInvariant {
  /** MUST match `^(MH|INV)-[0-9]+$`. */
  id: string;
  /** Short "why this skill leans on it" note. */
  note?: string;
}

/**
 * The parsed contract envelope (schema_version 1). Structural mirror of the
 * rp1-home `contract-envelope-schema.md` — the declarative half of a skill's
 * contract that the compiler consumes.
 */
export interface ContractEnvelope {
  schemaVersion: number;
  /** MUST equal the enclosing skill directory name. */
  skill: string;
  /** Git blob SHA of the sibling canonical SKILL.md (the SHA-pin, KD4). */
  skillSha: string;
  /** Harness mechanisms the skill depends on. */
  requiredCapabilities: CapabilityToken[];
  /**
   * One entry per required capability — the tri-state fallback the skill
   * supports for that capability when a harness lacks native support
   * (`native` = no fallback → omit; `emulated` = deterministic-script form;
   * `absent` = non-essential → annotated omission).
   */
  degradation: Partial<Record<CapabilityToken, TriState>>;
  phases: EnvelopePhase[];
  invariants: EnvelopeInvariant[];
}

/**
 * A resolved skill: its envelope plus the canonical SKILL.md prose body the
 * projection carries (SHA-pinned; acquired by `envelopeSource.ts`).
 */
export interface ResolvedSkill {
  envelope: ContractEnvelope;
  /** The canonical SKILL.md content (prose + frontmatter), verbatim. */
  skillBody: string;
}

/** The projection outcome for a SINGLE capability of a skill. */
export type CapabilityOutcome = "native" | "emulated" | "omitted";

/** The per-capability decision (R2 — never silent; `reason` is always set). */
export interface CapabilityDecision {
  capability: CapabilityToken;
  /** What form of the capability the projection includes. */
  outcome: CapabilityOutcome;
  /** The harness's own native support for this axis (from the manifest). */
  harnessState: TriState;
  /** The envelope's declared fallback for this capability. */
  degradation: TriState;
  /** Human + machine readable annotation — the never-silent record. */
  reason: string;
}

/** The skill-level projection decision. */
export type SkillDecision = "native" | "emulated" | "omitted";

/** The compiled plan for projecting ONE skill onto ONE harness (pure — no I/O). */
export interface ProjectionPlan {
  skill: string;
  skillSha: string;
  agentId: AgentFlavor;
  /**
   * `omitted` when a required capability whose degradation is `native` (no
   * fallback) is unmet by the harness — the skill cannot run and is not
   * materialized. `emulated` when at least one capability is emulated.
   * `native` when every capability is natively supported.
   */
  decision: SkillDecision;
  /** Set when `decision === "omitted"` — why the whole skill was dropped. */
  omittedReason?: string;
  capabilities: CapabilityDecision[];
  phases: EnvelopePhase[];
  invariants: EnvelopeInvariant[];
}

/** A single skill's provenance entry (KD5). */
export interface ProjectionSkillProvenance {
  skill: string;
  skillSha: string;
  decision: SkillDecision;
  omittedReason?: string;
  degradations: Array<{
    capability: CapabilityToken;
    outcome: CapabilityOutcome;
    reason: string;
  }>;
}

/**
 * A per-hook coverage record (issue #3123, R7 / CG-2). Emitted by the hooks
 * projection stage for EVERY hook it projects (natively or via shim) or degrades
 * — the never-silent audit of what actually materialized. #3124 (message-layer
 * tier 2) consumes these via the session record and falls back to
 * manifest-derived coverage when they are absent; the `dedupKey` (KD6) is the
 * cross-issue contract artifact. #3130 later unifies this into the shared
 * `@hapi/protocol` provenance type — keep the field names stable.
 */
export interface HookCoverageRecord {
  event: string;
  matcher: string;
  /** KD6: `sha256(event + "\n" + matcher + "\n" + canonicalGuardId)`, lower hex. */
  dedupKey: string;
  /** `true` when registered in the CLI's OWN taxonomy; `false` for a plugin-shim
   * or a script-step degradation (KD6). */
  native: boolean;
  /** Set when the event could not be projected into the dialect and degraded to
   * the script-step tier — never silent (R3). */
  degraded?: boolean;
  /** Human + machine readable annotation for a degraded record (R3). */
  reason?: string;
}

/**
 * The projection provenance record (KD5) — the audit trail of every degradation
 * decision, written to disk LAST.
 *
 * #3130 UNIFIES this with the frozen cross-repo contract: `ProjectionProvenance`
 * COMPOSES `HarnessProvenance` (`@hapi/protocol`) — so the on-disk record
 * structurally CARRIES the frozen fields (`runtime.harness.{id,version}`,
 * `model`, `canonical_blob_shas`) that the rp1-home gate kit asserts, while
 * keeping the projection-specific degradation trail (`skills`, `agentId`, …)
 * cli-local. The contract fields live in exactly ONE shared place, so the two
 * shapes cannot drift and there is no lossy mapping (directive KD1). The
 * provenance stage (#3130 Task 3) populates the `HarnessProvenance` half; the
 * skills stage (#3122) owns the degradation trail.
 */
export type ProjectionProvenance = HarnessProvenance & {
  schemaVersion: number;
  /** Caller-injected ISO timestamp (deterministic tests pass a fixed value / omit). */
  generatedAt?: string;
  agentId: AgentFlavor;
  /** The manifest's `verifiedAgainst` (which CLI version the axes were verified against). */
  manifestVerifiedAgainst: string;
  skills: ProjectionSkillProvenance[];
  /**
   * Per-hook coverage records (issue #3123, R7). Present only when the hooks
   * projection stage ran and produced at least one record — a zero-hook spawn
   * leaves this undefined so the provenance stays byte-identical to the
   * skills-only baseline (golden-test stable).
   */
  hooks?: HookCoverageRecord[];
  /**
   * Set (never silently) when the SHA-pinned canonical envelope could not be
   * acquired (Task 5 failure policy) — the spawn proceeds WITHOUT projection and
   * this records why. Distinct from a per-skill omission.
   */
  unavailable?: { reason: string };
};

/**
 * The KD6 ordered-stage seam context (ruling D2a; epic CF-1). The registration
 * seam #3123 (hooks), #3125 (mcp), and #3130 (provenance emission) ADD a
 * `ProjectionStage` against this exact shape instead of editing materializer
 * internals.
 *
 * KD6 names the fields `{ envelope, manifest, configHomeDir, provenance }`; the
 * fleet form generalizes the singular `envelope` to `skills: ResolvedSkill[]`
 * (each carrying its envelope + canonical body) so the materializer projects the
 * whole skill fleet in one pass. `manifest`, `configHomeDir`, and `provenance`
 * are the KD6 fields verbatim. A stage may write into `configHomeDir` and append
 * to the shared mutable `provenance`; the provenance file is written LAST.
 */
export interface ProjectionContext {
  /** The skill fleet to project (KD6 `envelope`, fleet form). */
  skills: ResolvedSkill[];
  manifest: HarnessManifest;
  /** The per-session config home to materialize into (write-only, never a shared dir). */
  configHomeDir: string;
  /**
   * The spawn's selected model id (#3130) — set only for OpenRouter codex/opencode
   * spawns; a default spawn omits it (the provenance stage attributes it as
   * harness-default). Threaded here so the provenance stage can source it from
   * the KD6 context without reaching into spawn options.
   */
  model?: string;
  /** Shared mutable provenance the stages append to; written to disk last. */
  provenance: ProjectionProvenance;
}

/** A single ordered stage of the materializer pipeline (KD6). */
export interface ProjectionStage {
  id: string;
  run(ctx: ProjectionContext): Promise<void>;
}

/** Re-export the manifest tri-state for consumers of this module. */
export type { HarnessManifest, TriState, AgentFlavor };
