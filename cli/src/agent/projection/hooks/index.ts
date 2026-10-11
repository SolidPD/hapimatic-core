// SPDX-License-Identifier: AGPL-3.0-only
/**
 * HAL hook-projection stage (issue #3123, Task 6 / KD5a) — public entry.
 *
 * `createHooksProjectionStage(opts)` returns a `ProjectionStage` registered into
 * #3122's KD6 ordered-stage seam (order: skills → hooks → mcp → provenance;
 * provenance written last). The stage reads `ctx.manifest.hooks` (mode +
 * dialectId), transpiles the canonical hook set into the harness's native
 * dialect (or the OpenCode plugin-shim), writes the registration wrapper(s) into
 * `ctx.configHomeDir`, and appends per-hook coverage records to
 * `ctx.provenance.hooks` (R7). When the manifest declares `hooks.mode === "none"`
 * (or an unknown dialect), every guard degrades to the script-step tier with an
 * annotated coverage record — NEVER silently dropped (R3). The server-side gate
 * remains the universal backstop by ladder design.
 *
 * The canonical hook set is INJECTED (`opts.canonicalHooks`) and defaults to
 * EMPTY: the real canonical guard set lands in the companion rp1-home epic (OR1,
 * SHA-pinned, cross-repo) and is wired as the source by a follow-up. Until then
 * the stage is a safe no-op in production (writes nothing, leaves provenance
 * byte-identical to the skills-only baseline) while the transpiler + emitters +
 * R7/KD6 contract are fully proven by tests. `HAPIMATIC_CANONICAL_HOOKS` is a
 * representative in-repo set (Hapimatic's own lifecycle hooks) exported for
 * those tests and the eventual wire-in.
 */
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type {
  HookCoverageRecord,
  ProjectionContext,
  ProjectionStage,
} from "../types";
import {
  baseCoverageRecord,
  transpile,
  HOOK_DIALECT_IDS,
  type CanonicalHook,
  type HookDialect,
} from "./transpiler";

export type {
  CanonicalHook,
  DialectFile,
  DialectOutput,
  HookDialect,
  HookEvent,
} from "./transpiler";
export {
  transpile,
  computeHookDedupKey,
  baseCoverageRecord,
  buildClaudeTaxonomy,
  HOOK_EVENTS,
  HOOK_DIALECT_IDS,
} from "./transpiler";

/** The shared CLI-neutral guard-script invocation referenced by every projected
 * lifecycle hook (R4 — one script, N wrappers). The runtime `--port`/`--token`
 * wiring is the driver follow-up; the projection carries the registration. */
export const HAPI_LIFECYCLE_FORWARDER_CMD = "hapi hook-forwarder";

/**
 * A representative canonical hook set — Hapimatic's OWN lifecycle events, the
 * exact four `generateHookSettings.ts` registers (SessionStart / UserPromptSubmit
 * / Stop / Notification, KD1's `Notification` included). All four reference the
 * SAME command (R4) under one `canonicalGuardId`, so their KD6 dedupKeys differ
 * only by event. Used by the dialect/stage tests and available for the OR1
 * follow-up to wire as the production source.
 */
export const HAPIMATIC_CANONICAL_HOOKS: readonly CanonicalHook[] = [
  {
    event: "SessionStart",
    matcher: "",
    command: HAPI_LIFECYCLE_FORWARDER_CMD,
    type: "command",
    timeout: 5000,
    canonicalGuardId: "hapi-lifecycle-forwarder",
  },
  {
    event: "UserPromptSubmit",
    matcher: "",
    command: HAPI_LIFECYCLE_FORWARDER_CMD,
    type: "command",
    timeout: 5000,
    canonicalGuardId: "hapi-lifecycle-forwarder",
  },
  {
    event: "Stop",
    matcher: "",
    command: HAPI_LIFECYCLE_FORWARDER_CMD,
    type: "command",
    timeout: 5000,
    canonicalGuardId: "hapi-lifecycle-forwarder",
  },
  {
    event: "Notification",
    matcher: "",
    command: HAPI_LIFECYCLE_FORWARDER_CMD,
    type: "command",
    timeout: 5000,
    canonicalGuardId: "hapi-lifecycle-forwarder",
  },
];

/** Options for {@link createHooksProjectionStage}. */
export interface HooksProjectionStageOptions {
  /**
   * The canonical hook set to project. Defaults to `[]` — a safe production
   * no-op until the OR1 companion guard set is wired. Pass
   * `HAPIMATIC_CANONICAL_HOOKS` (or a synthetic set) to project.
   */
  canonicalHooks?: readonly CanonicalHook[];
}

/** Narrow a manifest `dialectId` string to a known `HookDialect`, else undefined. */
function asHookDialect(dialectId: string | undefined): HookDialect | undefined {
  return dialectId !== undefined &&
    (HOOK_DIALECT_IDS as readonly string[]).includes(dialectId)
    ? (dialectId as HookDialect)
    : undefined;
}

/** Build a fully-degraded coverage set (R3 — never silent) for a canonical set
 * that could not be projected (mode `none` or an unknown dialect). */
function degradeAll(
  hooks: readonly CanonicalHook[],
  reason: string
): HookCoverageRecord[] {
  return hooks.map(h => ({
    ...baseCoverageRecord(h),
    native: false,
    degraded: true,
    reason,
  }));
}

/**
 * Create the hooks projection stage (KD5a; #3122's `ProjectionStage` contract).
 * Registered after the skills stage in the ordered pipeline.
 */
export function createHooksProjectionStage(
  opts: HooksProjectionStageOptions = {}
): ProjectionStage {
  const canonicalHooks = opts.canonicalHooks ?? [];
  return {
    id: "hooks",
    async run(ctx: ProjectionContext): Promise<void> {
      if (canonicalHooks.length === 0) {
        // No canonical source wired (OR1) — safe no-op, provenance untouched.
        return;
      }

      const { mode, dialectId } = ctx.manifest.hooks;
      let records: HookCoverageRecord[];

      if (mode === "none") {
        records = degradeAll(
          canonicalHooks,
          `manifest hooks.mode="none" — no native hook surface; degraded to the script-step tier (server-side gate is the backstop)`
        );
      } else {
        const dialect = asHookDialect(dialectId);
        if (!dialect) {
          records = degradeAll(
            canonicalHooks,
            `manifest hooks.mode="${mode}" but dialectId="${dialectId ?? "<unset>"}" is not a known hook dialect — degraded to the script-step tier`
          );
        } else {
          const output = transpile([...canonicalHooks], dialect);
          for (const file of output.files) {
            const target = join(ctx.configHomeDir, file.path);
            await fs.mkdir(dirname(target), { recursive: true });
            await fs.writeFile(target, file.content, "utf8");
          }
          records = output.coverage;
        }
      }

      if (records.length > 0) {
        ctx.provenance.hooks = [...(ctx.provenance.hooks ?? []), ...records];
      }
    },
  };
}
