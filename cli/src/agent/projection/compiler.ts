// SPDX-License-Identifier: AGPL-3.0-only
/**
 * HAL skill-projection compiler — the pure plan builder (issue #3122, Task 2).
 *
 * `buildProjectionPlan(envelope, manifest)` is PURE (no I/O): it compares the
 * envelope's `required_capabilities` against the harness manifest's axes and,
 * per capability, decides `native` / `emulated` / `omitted` — never a silent
 * drop (R2). The decision is a two-input table lookup:
 *
 *   harnessState (what the harness provides natively, from the manifest)
 *     × degradation (the fallback the skill supports, from the envelope)
 *     → per-capability outcome (+ a skill-level omission when a `native`-required
 *       capability is unmet).
 *
 * See rp1-home `contract-envelope-schema.md` § degradation for the authoritative
 * table this implements.
 */
import type { HarnessManifest, TriState } from "@hapi/protocol";
import type {
  CapabilityToken,
  CapabilityDecision,
  CapabilityOutcome,
  ContractEnvelope,
  ProjectionPlan,
  SkillDecision,
} from "./types";

/**
 * Map an envelope capability token to the harness's OWN native support level for
 * that axis, as a tri-state (`native` | `emulated` | `absent`). This is the
 * single place the snake_case envelope tokens meet the camelCase manifest axes.
 *
 * - `skills`: `native-dir` → native (a real discovery dir); `injected` →
 *   emulated (content reaches the CLI via instruction-file injection, not a
 *   native dir); `none` → absent.
 * - `hooks`: `native-taxonomy` → native; `plugin-shim` → emulated; `none` → absent.
 * - `mcp` / `instruction_file` / `headless_exec`: presence axes — a config
 *   format / instruction file / headless mode always exists on a real CLI, so
 *   these resolve to `native` when populated, `absent` otherwise.
 * - `acp`: the manifest's `acp.server` tri-state (server-side support is what a
 *   projected skill would drive).
 * - `subagents` / `session_roles` / `sandboxing`: bare manifest tri-states.
 * - `session_persistence`: `tmuxSafe` boolean → native / absent.
 */
export function manifestCapabilityState(
  manifest: HarnessManifest,
  capability: CapabilityToken
): TriState {
  switch (capability) {
    case "skills":
      return manifest.skills.mode === "native-dir"
        ? "native"
        : manifest.skills.mode === "injected"
          ? "emulated"
          : "absent";
    case "hooks":
      return manifest.hooks.mode === "native-taxonomy"
        ? "native"
        : manifest.hooks.mode === "plugin-shim"
          ? "emulated"
          : "absent";
    case "mcp":
      return manifest.mcp.configFormatId.length > 0 ? "native" : "absent";
    case "instruction_file":
      return manifest.instructionFile.name.length > 0 ? "native" : "absent";
    case "acp":
      return manifest.acp.server;
    case "headless_exec":
      return manifest.headlessExec.modes.length > 0 ? "native" : "absent";
    case "subagents":
      return manifest.subagents;
    case "session_persistence":
      return manifest.sessionPersistence.tmuxSafe ? "native" : "absent";
    case "session_roles":
      return manifest.sessionRoles;
    case "sandboxing":
      return manifest.sandboxing;
  }
}

/**
 * The per-capability decision table. `harnessState === "native"` always yields
 * the native form. When the harness lacks native support, the envelope's
 * declared `degradation` picks the outcome:
 *   - `native`   → the skill needs it natively; no fallback → OMIT the whole skill.
 *   - `emulated` → project the emulated (deterministic-script) form.
 *   - `absent`   → annotated omission of just this capability; the skill still projects.
 */
function decideCapability(
  capability: CapabilityToken,
  harnessState: TriState,
  degradation: TriState
): {
  outcome: CapabilityOutcome;
  forcesSkillOmission: boolean;
  reason: string;
} {
  if (harnessState === "native") {
    return {
      outcome: "native",
      forcesSkillOmission: false,
      reason: `${capability}: harness provides it natively`,
    };
  }
  // Harness lacks native support (its state is emulated or absent).
  switch (degradation) {
    case "native":
      return {
        outcome: "omitted",
        forcesSkillOmission: true,
        reason: `${capability}: required natively but harness support is "${harnessState}" and the skill declares no fallback — skill omitted`,
      };
    case "emulated":
      return {
        outcome: "emulated",
        forcesSkillOmission: false,
        reason: `${capability}: not native on this harness (harness="${harnessState}") — projecting the emulated deterministic-script form`,
      };
    case "absent":
      return {
        outcome: "omitted",
        forcesSkillOmission: false,
        reason: `${capability}: non-essential and not native (harness="${harnessState}") — annotated omission; the skill still projects`,
      };
  }
}

/**
 * Compile the projection PLAN for one skill onto one harness. Pure — directly
 * unit-testable. `decision === "omitted"` means a required-native capability is
 * unmet and the skill must NOT be materialized; otherwise every capability
 * carries a never-silent `reason` annotation (R2).
 *
 * A `required_capabilities` entry with no matching `degradation` key is treated
 * as the STRICTEST fallback (`native`) — the schema's coverage check enforces
 * that every required capability carries a degradation, so this only bites a
 * malformed envelope, and biting toward omission (fail-closed) is correct.
 */
export function buildProjectionPlan(
  envelope: ContractEnvelope,
  manifest: HarnessManifest
): ProjectionPlan {
  const capabilities: CapabilityDecision[] = [];
  let skillOmitted = false;
  const omitReasons: string[] = [];

  for (const capability of envelope.requiredCapabilities) {
    const harnessState = manifestCapabilityState(manifest, capability);
    const degradation: TriState = envelope.degradation[capability] ?? "native";
    const decision = decideCapability(capability, harnessState, degradation);
    capabilities.push({
      capability,
      outcome: decision.outcome,
      harnessState,
      degradation,
      reason: decision.reason,
    });
    if (decision.forcesSkillOmission) {
      skillOmitted = true;
      omitReasons.push(decision.reason);
    }
  }

  const decision: SkillDecision = skillOmitted
    ? "omitted"
    : capabilities.some(c => c.outcome === "emulated")
      ? "emulated"
      : "native";

  return {
    skill: envelope.skill,
    skillSha: envelope.skillSha,
    agentId: manifest.agentId,
    decision,
    omittedReason: skillOmitted ? omitReasons.join("; ") : undefined,
    capabilities,
    phases: envelope.phases,
    invariants: envelope.invariants,
  };
}
