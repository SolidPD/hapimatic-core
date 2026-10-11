// SPDX-License-Identifier: AGPL-3.0-only
/**
 * HAL skill-projection compiler — public entry (issue #3122, epic #3117 Sub G).
 *
 * `projectSkills(opts)` is the single function the spawn path calls: resolve the
 * harness manifest → acquire the SHA-pinned canonical envelopes (fail-open) →
 * run the ordered KD6 stage pipeline (skills projection is the first built-in
 * stage; #3123/#3125/#3130 add more) → write the provenance record LAST → return
 * it. It NEVER throws on a missing manifest or unavailable envelope source — it
 * records an annotated `unavailable` provenance and returns, so the caller's
 * spawn proceeds without projection (Task 5 failure policy; R2's spirit).
 *
 * The R6 Claude-parity guarantee is enforced at the CALL SITE (the spawn path
 * gates on the normalized `agent !== "claude"`), keeping this entry
 * manifest-generic rather than re-hardcoding claude-specialness (the HAL goal).
 */
import { tryResolveHarnessManifest, type AgentFlavor } from "@hapi/protocol";
import { acquireEnvelopes } from "./envelopeSource";
import { createHooksProjectionStage } from "./hooks";
import {
  createProvenanceStage,
  createSkillsProjectionStage,
  runProjection,
  writeProvenanceRecord,
} from "./materializer";
import { createMcpProjectionStage } from "./mcp";
import type { McpProjectionInput } from "./mcp";
import type {
  ProjectionContext,
  ProjectionProvenance,
  ProjectionStage,
} from "./types";

/** The provenance schema version this compiler emits (KD5). */
export const PROJECTION_PROVENANCE_SCHEMA_VERSION = 1;

/**
 * Whether the spawn-path skill projection is enabled (issue #3122). Ships gated
 * OFF — with `HAPI_SKILL_PROJECTION` unset the spawn path is byte-identical to
 * today (R6-preserving for foreign spawns too), matching the OmniBox-sandbox
 * default-off posture for a novel hot-path subsystem. Truthy-enable with
 * `1` / `true` / `yes` / `on`. Read fresh (not cached) so a systemd env flip
 * takes effect on the next spawn.
 */
export function isSkillProjectionEnabled(): boolean {
  const raw = (process.env.HAPI_SKILL_PROJECTION ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/** Options for {@link projectSkills}. */
export interface ProjectSkillsOptions {
  /** The spawning harness's canonical stock-4 id (or any manifest id). */
  agentId: string;
  /** The per-session config home to materialize into (write-only, R5). */
  configHomeDir: string;
  /** The HAL canonical checkout (`settings.halCanonicalCheckoutPath`). */
  canonicalCheckoutPath?: string;
  /** Content-addressed cache dir (`<HAPI_HOME>/hal-projection-cache`). */
  cacheDir?: string;
  /** Restrict to these skill dir names (default: the whole owned fleet). */
  skills?: string[];
  /** Caller-injected ISO timestamp for the provenance (deterministic in tests). */
  generatedAt?: string;
  /**
   * The spawn's selected model id (#3130) — set only for OpenRouter codex/opencode
   * spawns; a default spawn omits it (the provenance attributes it harness-default).
   */
  model?: string;
  /**
   * Override the stage pipeline (default:
   * `[createSkillsProjectionStage(), createProvenanceStage()]`).
   */
  stages?: ProjectionStage[];
  /**
   * MCP projection input (issue #3125). When present, the DEFAULT pipeline
   * appends an `mcp` stage AFTER the hooks stage (KD6 ordering: skills → hooks →
   * mcp → provenance). Absent → no MCP stage, byte-identical to pre-#3125. Ignored
   * when an explicit `stages` override is supplied.
   */
  mcp?: McpProjectionInput;
}

/**
 * Compile + materialize the projected skill fleet for one foreign-harness spawn.
 * Returns the provenance record (also written under the config home). Fail-open:
 * an unknown manifest or an unavailable envelope source yields an annotated
 * `unavailable` provenance, not a throw.
 */
export async function projectSkills(
  opts: ProjectSkillsOptions
): Promise<ProjectionProvenance> {
  const manifest = tryResolveHarnessManifest(opts.agentId);
  const agentId = (manifest?.agentId ?? opts.agentId) as AgentFlavor;

  const provenance: ProjectionProvenance = {
    schemaVersion: PROJECTION_PROVENANCE_SCHEMA_VERSION,
    generatedAt: opts.generatedAt,
    agentId,
    manifestVerifiedAgainst:
      manifest?.verifiedAgainst ?? "unknown (no manifest)",
    skills: [],
  };

  if (!manifest) {
    provenance.unavailable = {
      reason: `no harness manifest registered for agent "${opts.agentId}" — projection skipped`,
    };
    await writeProvenanceRecord(opts.configHomeDir, provenance);
    return provenance;
  }

  const src = await acquireEnvelopes({
    canonicalCheckoutPath: opts.canonicalCheckoutPath,
    cacheDir: opts.cacheDir,
    skills: opts.skills,
  });
  if (!src.ok || !src.skills) {
    provenance.unavailable = {
      reason: src.unavailableReason ?? "envelope acquisition failed",
    };
    await writeProvenanceRecord(opts.configHomeDir, provenance);
    return provenance;
  }

  const ctx: ProjectionContext = {
    skills: src.skills,
    manifest,
    configHomeDir: opts.configHomeDir,
    model: opts.model,
    provenance,
  };
  // KD6 ordered stage pipeline: skills → hooks (#3123) → mcp (#3125) →
  // [provenance #3130]. The hooks stage ships with an empty canonical set, so it
  // is a safe no-op until the OR1 companion guard set is wired as its source. The
  // mcp stage is appended only when a projection input is supplied (byte-identical
  // to pre-#3125 otherwise). Provenance runs LAST — it reads the fleet's SHA-pinned
  // input and the record is written to disk after all stages regardless (KD6).
  const stages = opts.stages ?? [
    createSkillsProjectionStage(),
    createHooksProjectionStage(),
    ...(opts.mcp ? [createMcpProjectionStage(opts.mcp)] : []),
    createProvenanceStage(),
  ];
  return runProjection(ctx, stages);
}

export { buildProjectionPlan, manifestCapabilityState } from "./compiler";
export {
  toAgentPlugin,
  buildProjectedSkillMarkdown,
  buildHarnessAdaptationSection,
} from "./agentPlugins";
export {
  acquireEnvelopes,
  parseEnvelopeYaml,
  computeGitBlobSha,
} from "./envelopeSource";
export {
  createProvenanceStage,
  createSkillsProjectionStage,
  runProjection,
  resolvePluginRoot,
  PROVENANCE_RELATIVE_PATH,
  HAL_PLUGINS_DIRNAME,
} from "./materializer";
export {
  createHooksProjectionStage,
  transpile,
  computeHookDedupKey,
  buildClaudeTaxonomy,
  HAPIMATIC_CANONICAL_HOOKS,
  HAPI_LIFECYCLE_FORWARDER_CMD,
  HOOK_EVENTS,
  HOOK_DIALECT_IDS,
} from "./hooks";
export type {
  CanonicalHook,
  DialectFile,
  DialectOutput,
  HookDialect,
  HookEvent,
  HooksProjectionStageOptions,
} from "./hooks";
export {
  buildProvenance,
  isProjectionStale,
  probeHarnessVersion,
  resolveHarnessVersion,
} from "./provenance";
export type { BuildProvenanceInput } from "./provenance";
export type * from "./types";
