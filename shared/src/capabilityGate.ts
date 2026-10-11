// SPDX-License-Identifier: AGPL-3.0-only
/**
 * HAL capability gate — the pure predicate half of capability-aware spawn
 * suggestions (issue #3132, epic #3117 Sub R). Expert rulings D5a / 1B-16.
 *
 * `checkCapabilities(required, manifest)` compares a skill's envelope
 * `required_capabilities` (#3122 `ContractEnvelope`) against a harness capability
 * manifest (#3118 `HarnessManifest`) and reports which required capabilities the
 * harness cannot provide. It is a PURE predicate — no I/O, no registry lookups —
 * so both the cli-side gate (`cli/src/modules/common/capabilityMissHandler.ts`)
 * and any future server-side enforcement rung consume ONE implementation
 * (expert ruling D1 / KD1: shared placement).
 *
 * The gate is COARSE: "missing" means the harness cannot provide the capability
 * in ANY form (its manifest axis resolves to `absent`). A capability the harness
 * supports only in EMULATED form is NOT a miss here — that is the degrade path,
 * which the offer surfaces via the envelope's own `degradation` annotation (KD5).
 */
import type { HarnessManifest, TriState } from "./harnessManifest";

/**
 * The capability-id → predicate(manifest) map (expert ruling 1B-16 / KD1). Keys
 * are the envelope's snake_case capability tokens (owned by rp1-home
 * `contract-envelope-schema.md`; mirrored as `CapabilityToken` in
 * `cli/src/agent/projection/types.ts`). Each predicate returns TRUE when the
 * harness provides the capability in SOME form (native or emulated) — i.e. the
 * axis is NOT `absent`. A required id NOT in this map is treated as MISSING
 * (fail-safe — mirrors #3126's Fallback Preservation posture: an unrecognized
 * requirement is assumed unmet rather than silently satisfied).
 *
 * NOTE (DRY): these predicates are `manifestCapabilityState(m, cap) !== "absent"`
 * for the same 10 tokens `cli/src/agent/projection/compiler.ts` already maps.
 * That function returns the full tri-state for the projection decision table;
 * the gate only needs the boolean "can this harness do it at all?". The mapping
 * is intentionally duplicated across the package boundary — `shared/` cannot
 * import from `cli/`, and relocating `manifestCapabilityState` into `shared/`
 * would edit the merged, expert-reviewed #3122 compiler (outside this issue's
 * scope). Converging the two behind one shared source is a tracked follow-up.
 */
const CAPABILITY_PREDICATES: Record<string, (m: HarnessManifest) => boolean> = {
  skills: m => m.skills.mode !== "none",
  hooks: m => m.hooks.mode !== "none",
  mcp: m => m.mcp.configFormatId.length > 0,
  instruction_file: m => m.instructionFile.name.length > 0,
  acp: m => m.acp.server !== "absent",
  headless_exec: m => m.headlessExec.modes.length > 0,
  subagents: m => m.subagents !== "absent",
  session_persistence: m => m.sessionPersistence.tmuxSafe,
  session_roles: m => m.sessionRoles !== "absent",
  sandboxing: m => m.sandboxing !== "absent",
};

/** The outcome of a capability check against one harness manifest. */
export interface CapabilityCheckResult {
  /** True when EVERY required capability is provided (native or emulated). */
  ok: boolean;
  /**
   * The subset of `required` the harness cannot provide (axis is `absent`, or the
   * capability id is unknown). Preserves the input order; deduplication is the
   * caller's concern (envelopes list each capability once).
   */
  missing: string[];
}

/**
 * Compare a skill's required capabilities against a harness manifest. Pure.
 *
 * @param required the envelope's `required_capabilities` (snake_case tokens).
 * @param manifest the session harness's capability manifest (#3118).
 */
export function checkCapabilities(
  required: string[],
  manifest: HarnessManifest
): CapabilityCheckResult {
  const missing = required.filter(cap => {
    const predicate = CAPABILITY_PREDICATES[cap];
    // Unknown capability id → MISSING (fail-safe, KD1 / expert ruling 1B-16).
    return predicate ? !predicate(manifest) : true;
  });
  return { ok: missing.length === 0, missing };
}

/**
 * Enumerate which of the supplied harness manifests can run a skill — every
 * candidate whose manifest satisfies ALL `required` capabilities. Pure; the
 * caller supplies the manifest set (the cli gate passes the stock-4
 * `HARNESS_MANIFESTS` registry). Order follows the input map's key order.
 *
 * @param required the skill's `required_capabilities`.
 * @param manifests candidate harness id → manifest (e.g. the stock-4 registry).
 */
export function findCapableHarnesses(
  required: string[],
  manifests: Record<string, HarnessManifest>
): string[] {
  return Object.keys(manifests).filter(
    id => checkCapabilities(required, manifests[id]).ok
  );
}

/**
 * The COMPLETED capability-miss payload the cli gate delivers to the web (KD2).
 * The web renders this VERBATIM — it computes nothing from manifests, so the
 * web needs no manifest source. Shared so the cli producer and web consumer
 * agree on one shape.
 */
export interface CapabilityMissPayload {
  /** The skill whose required capabilities are unmet on this session's harness. */
  skill: string;
  /** The session harness's canonical id (the harness that lacks the capabilities). */
  sessionHarness: string;
  /** The subset of required capabilities the session's harness cannot provide. */
  missing: string[];
  /**
   * For each MISSING capability, the envelope's declared degradation fallback —
   * the annotation the "degrade" path follows (KD5). A capability absent from
   * this map declared no fallback (strictest: native-only, no degrade form).
   */
  degradation: Partial<Record<string, TriState>>;
  /**
   * Canonical harness ids whose manifests satisfy ALL of the skill's required
   * capabilities — the "respawn under a capable harness" candidates (KD2/KD3).
   * Excludes the session's own harness. Empty when no candidate can run the skill.
   */
  capableHarnesses: string[];
}

/** The user's (or a policy's) answer to a capability-miss offer (KD2 round-trip). */
export type CapabilityOfferDecision = "degrade" | "respawn";

/**
 * The `tool` name a capability-miss request carries in `AgentState.requests`
 * (KD2 — the cli publishes it via the permission-flow-style channel; the web
 * matches on it to render the offer). Shared so producer and consumer agree.
 */
export const CAPABILITY_OFFER_TOOL = "capability-offer";

/**
 * The RPC method the web calls to return a {@link CapabilityOfferDecision} to
 * the cli gate (distinct from the permission flow's `"permission"` method).
 */
export const CAPABILITY_OFFER_RPC_METHOD = "capabilityOffer";
