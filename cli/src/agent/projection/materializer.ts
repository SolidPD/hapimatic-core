// SPDX-License-Identifier: AGPL-3.0-only
/**
 * HAL skill-projection compiler — the materializer (issue #3122, Task 4 / KD6).
 *
 * The materializer owns the KD6 ordered-stage seam: a declared `ProjectionStage[]`
 * executed strictly in order, each stage writing into the per-session config home
 * and appending to the shared mutable `ctx.provenance`, with the provenance record
 * written to disk LAST — after every stage. #3122 ships the SKILLS projection as
 * the first built-in stage; #3123 (hooks), #3125 (mcp), and #3130 (provenance
 * emission) ADD stages against this exact signature instead of editing materializer
 * internals. That is the contract those three directives register against — do NOT
 * close the pipeline over skills-only assumptions.
 *
 * All writes go WRITE-ONLY into the per-session config home (never a shared dir —
 * R5), under a HAL-owned `hal-plugins/` root (or the manifest's native
 * `skills.discoveryPath` when the harness has one). Materialization is idempotent
 * against a pre-existing projection in a durable tmux home (KD1): each plugin dir
 * is cleared before it is rewritten, so a re-spawn over a populated home overwrites
 * cleanly and a now-omitted skill leaves no stale dir behind.
 */
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type { HarnessManifest } from "@hapi/protocol";
import { buildProjectionPlan } from "./compiler";
import { toAgentPlugin } from "./agentPlugins";
import { buildProvenance, resolveHarnessVersion } from "./provenance";
import type {
  ProjectionContext,
  ProjectionProvenance,
  ProjectionStage,
} from "./types";

/** The HAL-owned subdir name under which projected Agent Plugins are written. */
export const HAL_PLUGINS_DIRNAME = "hal-plugins";

/** Config-home-relative path of the provenance record (KD5), written last. */
export const PROVENANCE_RELATIVE_PATH = join(
  "hal-projection",
  "provenance.json"
);

/**
 * Write the KD5 provenance record under the config home in the canonical on-disk
 * shape (pretty JSON + trailing newline). The single source of truth for the
 * provenance format — a contract the golden test and #3130 consume, so both the
 * full-pipeline path ({@link runProjection}) and the fail-open early-return path
 * (`index.ts`) serialize it through here to prevent format drift.
 */
export async function writeProvenanceRecord(
  configHomeDir: string,
  provenance: ProjectionProvenance
): Promise<void> {
  const target = join(configHomeDir, PROVENANCE_RELATIVE_PATH);
  await fs.mkdir(dirname(target), { recursive: true });
  await fs.writeFile(
    target,
    `${JSON.stringify(provenance, null, 2)}\n`,
    "utf8"
  );
}

/**
 * Resolve the root dir (under the config home) where projected plugins land. A
 * native-dir skills harness uses its manifest `skills.discoveryPath` (the
 * harness's expected discovery location, R1), namespaced by a `hal-plugins/`
 * subdir so HAL never clobbers sibling non-HAL content there. Every other harness
 * (the injected-mode stock-4) lands at a HAL-owned `hal-plugins/` directly under
 * the config home — the concrete per-harness discovery/injection wiring is the
 * driver follow-up (#3123/#1692).
 */
export function resolvePluginRoot(
  configHomeDir: string,
  manifest: HarnessManifest
): string {
  if (manifest.skills.mode === "native-dir" && manifest.skills.discoveryPath) {
    return join(
      configHomeDir,
      manifest.skills.discoveryPath,
      HAL_PLUGINS_DIRNAME
    );
  }
  return join(configHomeDir, HAL_PLUGINS_DIRNAME);
}

/** Write every file of a packaged plugin under `pluginDir`, clearing it first. */
async function writePluginDir(
  pluginDir: string,
  files: { path: string; content: string }[]
): Promise<void> {
  // KD1 idempotency: clear the (HAL-created) plugin dir before rewriting so a
  // re-projection over a durable home overwrites cleanly with no stale files.
  await fs.rm(pluginDir, { recursive: true, force: true });
  for (const file of files) {
    const target = join(pluginDir, file.path);
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.writeFile(target, file.content, "utf8");
  }
}

/**
 * The FIRST built-in stage (#3122): compile each skill's plan, record its
 * per-capability degradation in provenance (never silent — R2), and materialize
 * every INCLUDED skill as an Agent Plugin. An omitted skill is recorded in
 * provenance but not written to disk.
 */
export function createSkillsProjectionStage(): ProjectionStage {
  return {
    id: "skills",
    async run(ctx: ProjectionContext): Promise<void> {
      const pluginRoot = resolvePluginRoot(ctx.configHomeDir, ctx.manifest);
      for (const { envelope, skillBody } of ctx.skills) {
        const plan = buildProjectionPlan(envelope, ctx.manifest);
        ctx.provenance.skills.push({
          skill: plan.skill,
          skillSha: plan.skillSha,
          decision: plan.decision,
          omittedReason: plan.omittedReason,
          degradations: plan.capabilities.map(c => ({
            capability: c.capability,
            outcome: c.outcome,
            reason: c.reason,
          })),
        });
        if (plan.decision === "omitted") {
          continue;
        }
        const plugin = toAgentPlugin(plan, skillBody);
        await writePluginDir(join(pluginRoot, plan.skill), plugin.files);
      }
    },
  };
}

/**
 * The provenance stage (#3130 Sub P): populate the shared mutable provenance with
 * the frozen cross-repo contract fields — `runtime.harness.{id,version}`, `model`,
 * `canonical_blob_shas` — from the projection's ACTUAL SHA-pinned input (the
 * skills' `envelope.skillSha`, not a re-derivation — OR3). Additive: it only sets
 * the `HarnessProvenance` half and never touches the `#3122` skills degradation
 * trail. The record itself is written to disk LAST by {@link runProjection} (KD6),
 * so registration order among the stages does not affect the on-disk result.
 *
 * `canonical_blob_shas` is the mechanical drift backbone (#3128 scorecard / #3129
 * conformance key on it via `isProjectionStale`). `version` is the exact probed
 * `<cli> --version` or a `range:`-prefixed manifest fallback; `model` is set only
 * when the spawn selected one (a default spawn omits it → harness-default).
 */
export function createProvenanceStage(): ProjectionStage {
  return {
    id: "provenance",
    async run(ctx: ProjectionContext): Promise<void> {
      const harnessId = ctx.manifest.agentId;
      const version = await resolveHarnessVersion(
        harnessId,
        ctx.manifest.verifiedAgainst
      );
      const blobShas = ctx.skills.map(skill => skill.envelope.skillSha);
      const contract = buildProvenance({
        harness: harnessId,
        version,
        model: ctx.model,
        blobShas,
      });
      ctx.provenance.runtime = contract.runtime;
      ctx.provenance.canonical_blob_shas = contract.canonical_blob_shas;
      if (contract.model !== undefined) {
        ctx.provenance.model = contract.model;
      }
    },
  };
}

/**
 * Run the ordered stage pipeline over the context, then write the accumulated
 * provenance record to disk LAST (KD6). Returns the provenance. A stage failure
 * propagates — the caller (`projectSkills`) is responsible for the fail-open
 * spawn policy, so the materializer itself surfaces real errors.
 */
export async function runProjection(
  ctx: ProjectionContext,
  stages: ProjectionStage[]
): Promise<ProjectionProvenance> {
  for (const stage of stages) {
    await stage.run(ctx);
  }
  await writeProvenanceRecord(ctx.configHomeDir, ctx.provenance);
  return ctx.provenance;
}
