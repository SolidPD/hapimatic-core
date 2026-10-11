// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Harness install-recipe + update-registry PORT + supply-chain scan seam
 * (HAL catalog, epic #3117 Sub-D / issue #3120).
 *
 * A catalog CLI harness (Crush, Cursor CLI, Cline, Grok Build, Pi, Kimi Code —
 * ruling D4) is contributed to the extension host (`shared/src/ext/contributions.ts`
 * `HarnessContribution`) as `{ id, installRecipe, capabilityManifest, driverBinding }`.
 * This module owns the two shared shapes that contribution carries plus the
 * cross-package seams:
 *
 *   1. `HarnessInstallRecipe` — how to install / probe / uninstall the third-party
 *      binary, with a SCHEMA-LEVEL integrity contract (expert ruling 1B-17):
 *      `pinnedVersion` is REQUIRED and `sha256` is REQUIRED for `curl` recipes.
 *   2. `HarnessUpdateRegistry` — the thin consumer PORT the recipes call for version
 *      probe/pin/update (KD4 / R2). #1769/#1770's harness self-update registry
 *      (`shared/src/harness.ts` + `server/src/harness/registry.ts`) supplies the
 *      implementation semantics; this port REUSES its detection contract
 *      (`{cmd, versionRegex}` mirrors `HarnessDetectSchema`) rather than standing up a
 *      SECOND version store. There is deliberately NO parallel registry array here.
 *   3. `StagedInstall` / `ScanVerdict` — the PINNED #3131 (Sub Q) supply-chain scan
 *      seam. This issue is the CREATOR of the contract; #3131 supplies the scan
 *      implementation. An absent scan hook is a documented no-op pass.
 *
 * Kept zod-only (NO node/server/web imports) so it stays importable by every package —
 * cli, server, AND the browser web bundle — matching the `@hapi/protocol` /
 * `@hapi/protocol/ext` browser-safe contract.
 *
 * ── Two-tier harness identity (expert ruling D8b / KD5) ──
 * The stock 4 (`claude|codex|gemini|opencode`) are a CLOSED `AgentFlavor` union with a
 * total `Record<AgentFlavor, HarnessManifest>` registry (#3118). Catalog CLIs are the
 * OPEN third tier: their capability manifest is validated with an ID-OPEN derivative of
 * `harnessManifestSchema` ({@link catalogHarnessManifestSchema}) whose `agentId` is a
 * plain string, and they resolve via a SEPARATE resolver (`resolveCatalogManifest`,
 * `cli/src/ext/catalogHarnessRegistry.ts`) — NEVER through `resolveHarnessManifest`
 * (stock-only) and NEVER by widening `AgentFlavor`.
 */
import { z } from "zod";
import type { HarnessManifest } from "./harnessManifest";
import { harnessManifestSchema } from "./harnessManifest";

// ─── Catalog capability manifest — ID-OPEN derivative (KD5 / D8b) ───

/**
 * An ID-OPEN derivative of {@link harnessManifestSchema}: axis-identical to the stock-4
 * capability manifest, but `agentId` is a plain non-empty string (the OPEN catalog
 * harness id — `"crush"`, `"cursor"`, …) instead of the CLOSED `agentFlavorSchema` enum.
 * This is the validator for a catalog CLI's capability manifest (KD5) — it NEVER widens
 * `AgentFlavor` and its parse output is NEVER registered in #3118's stock record.
 *
 * `.strictObject().extend({...})` overrides the single `agentId` field while keeping the
 * strict, exhaustive axis set — a mistyped or stale axis still fails validation.
 */
export const catalogHarnessManifestSchema = harnessManifestSchema.extend({
  agentId: z.string().min(1),
});

/** Parsed shape of a catalog CLI's capability manifest (id-open `agentId`). */
export type CatalogHarnessManifest = z.infer<
  typeof catalogHarnessManifestSchema
>;

// ─── Install recipe — method + integrity (ruling 1B-17) ───

/** The three install channels a catalog recipe can use. */
export const harnessInstallMethodSchema = z.enum(["npm", "brew", "curl"]);
export type HarnessInstallMethod = z.infer<typeof harnessInstallMethodSchema>;

/** How a catalog harness binds to a HAL driver once installed (epic #3117). */
export const harnessDriverBindingSchema = z.enum([
  "native",
  "acp-generic",
  "headless-tmux-generic",
]);
export type HarnessDriverBinding = z.infer<typeof harnessDriverBindingSchema>;

/**
 * The DATA fields of an install recipe (the {@link HarnessInstallRecipe} closures live on
 * the interface, not the schema — `.parse()` strips them). Integrity is a SCHEMA-LEVEL
 * contract (expert ruling 1B-17), enforced by the `.superRefine` below so a pin-less or
 * pipe-to-bash recipe FAILS validation rather than shipping:
 *
 *   - `pinnedVersion` is always REQUIRED (an exact version, never `latest`).
 *   - an `npm` `spec` MUST carry the exact `pinnedVersion` (e.g. `pkg@1.2.3`).
 *   - a `curl` `spec` MUST be a pinned `https://` URL with no shell metacharacters
 *     (never pipe-to-bash), and `sha256` (the fetched-artifact checksum) is REQUIRED.
 *   - `sha256` is optional for `npm`/`brew` (the registry/formula integrity covers it).
 *
 * #3131's recipe-leg scan verifies against these fields — the schema must not let a
 * recipe land pin-less.
 */
export const harnessRecipeDataSchema = z
  .object({
    method: harnessInstallMethodSchema,
    /**
     * The install spec, interpreted per `method`: an `npm` package@version, a `brew`
     * formula (or tap/formula), or an exact pinned `https://` artifact URL for `curl`.
     */
    spec: z.string().min(1),
    /** The exact pinned version this recipe installs (never a range / `latest`). */
    pinnedVersion: z.string().min(1),
    /** SHA-256 of the fetched artifact — REQUIRED for `curl`, optional for `npm`/`brew`. */
    sha256: z.string().optional(),
    /**
     * Allow the package's install scripts to run (npm `postinstall`), OVERRIDING the default
     * `--ignore-scripts` (ruling 1B-17: "where the CLI tolerates it"). Set `true` ONLY for a CLI
     * whose npm package legitimately fetches its platform binary via `postinstall` (a Go/Rust CLI
     * wrapped in npm — Crush, Grok, Cline); `--ignore-scripts` would install a non-functional shell
     * for those. Leaving it unset keeps the secure default (scripts ignored) for pure-JS CLIs.
     * The compensating control for an allowed postinstall is the exact version pin + the #3131
     * supply-chain scan gate + the curated tier-1 list.
     */
    allowScripts: z.boolean().optional(),
    /** SPDX-ish license id surfaced in the catalog UI (e.g. `FSL-1.1-MIT`). */
    license: z.string().optional(),
  })
  .superRefine((r, ctx) => {
    if (r.method === "curl") {
      if (!r.sha256) {
        ctx.addIssue({
          code: "custom",
          message:
            "curl recipes require sha256 (fetched-artifact integrity, ruling 1B-17)",
          path: ["sha256"],
        });
      }
      if (!/^https:\/\//.test(r.spec)) {
        ctx.addIssue({
          code: "custom",
          message:
            "curl spec must be a pinned https:// URL (never http, never pipe-to-bash)",
          path: ["spec"],
        });
      }
      if (/[|;&$`\n<>]/.test(r.spec)) {
        ctx.addIssue({
          code: "custom",
          message: "curl spec must not contain shell metacharacters",
          path: ["spec"],
        });
      }
    }
    if (r.method === "npm" && !r.spec.endsWith(`@${r.pinnedVersion}`)) {
      ctx.addIssue({
        code: "custom",
        message: "npm spec must carry the exact pinnedVersion (e.g. pkg@1.2.3)",
        path: ["spec"],
      });
    }
  });

/** Parsed DATA shape of an install recipe (no closures). */
export type HarnessRecipeData = z.infer<typeof harnessRecipeDataSchema>;

/**
 * A version-probe target — a code-defined command + the regex that extracts the semver
 * from its stdout. Mirrors #1769's `HarnessDetectSchema` (`{cmd, version_regex}`), which
 * is the detection contract this port REUSES (R2 — no second version store).
 */
export interface HarnessProbeTarget {
  cmd: string;
  versionRegex: string;
}

/** Where the LATEST installable version of a harness comes from (mirrors #1769's `latest_source`). */
export interface HarnessLatestSource {
  method: HarnessInstallMethod;
  /** npm package name, brew formula, or a GitHub `owner/repo` — per `method`. */
  ref: string;
}

/**
 * The thin consumer PORT the recipes call for version probe / pin / update (KD4 / R2).
 * #1769/#1770's harness self-update registry supplies the implementation semantics; a
 * catalog recipe NEVER stands up a second version store — it consumes this port. The cli
 * adapter (`cli/src/ext/harnessUpdateRegistry.ts`) reuses #1769's detection contract.
 */
export interface HarnessUpdateRegistry {
  /** Probe the INSTALLED version of a harness binary. Returns `null` when it is absent. */
  probe(target: HarnessProbeTarget): Promise<string | null>;
  /** Record the pinned version a harness id resolved to (advisory; no parallel store). */
  pin(harnessId: string, version: string): Promise<void>;
  /** Resolve the LATEST installable version from a recipe's source. */
  update(source: HarnessLatestSource): Promise<string>;
}

/** Execution context handed to a recipe's closures — carries the update-registry port. */
export interface HarnessRecipeContext {
  registry: HarnessUpdateRegistry;
}

/**
 * A catalog CLI install recipe: the {@link HarnessRecipeData} fields plus the two
 * closures that execute against the machine. `versionProbe` MUST route through the
 * {@link HarnessUpdateRegistry} port (`ctx.registry.probe(...)`, R2/V2). A pin-less /
 * unpinned recipe fails {@link harnessRecipeDataSchema} (ruling 1B-17).
 *
 * (A `type` intersection, not an `interface extends`, because the data schema is a
 * refined effect — an interface cannot extend a refined/union type.)
 */
export type HarnessInstallRecipe = HarnessRecipeData & {
  /** Probe the installed version via the registry port; `null` when not installed. */
  versionProbe: (ctx: HarnessRecipeContext) => Promise<string | null>;
  /** Remove the installed binary (npm uninstall / brew uninstall / rm the fetched file). */
  uninstall: (ctx: HarnessRecipeContext) => Promise<void>;
};

/** Validate a recipe's DATA fields (the `.superRefine` enforces the integrity contract). */
export function validateHarnessRecipe(
  recipe: unknown
): { ok: true; data: HarnessRecipeData } | { ok: false; error: string } {
  const result = harnessRecipeDataSchema.safeParse(recipe);
  if (!result.success) return { ok: false, error: result.error.message };
  return { ok: true, data: result.data };
}

// ─── #3131 (Sub Q) supply-chain scan seam — PINNED contract (this issue creates it) ───

/** Severity of a supply-chain scan finding. #3131 may add fields; keep this minimal. */
export interface ScanFinding {
  severity: "info" | "low" | "medium" | "high" | "critical";
  message: string;
  /** Optional rule id the finding came from (e.g. a heuristic / advisory-db key). */
  rule?: string;
}

/**
 * The thing a scan runs against, discriminated on `kind`:
 *   - `extension` — a staged filesystem extension (its bytes live in `stagedDir`).
 *   - `harness-recipe` — a catalog CLI recipe (scanned before the recipe executes).
 */
export type StagedInstall =
  | { kind: "extension"; id: string; stagedDir?: string }
  | { kind: "harness-recipe"; id: string; recipe: HarnessInstallRecipe };

/** The verdict a supply-chain scan returns. `block` aborts the install before finalize. */
export interface ScanVerdict {
  verdict: "pass" | "block";
  findings: ScanFinding[];
}

/**
 * The scan hook signature. An ABSENT hook is a documented no-op PASS (the seam is inert
 * until #3131 fills it). #3131 supplies the implementation — it does NOT change this
 * contract.
 */
export type ScanBeforeInstall = (staged: StagedInstall) => Promise<ScanVerdict>;
