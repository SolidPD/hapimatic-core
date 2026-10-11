// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Commit-side hook validation + attribution — split out of `importArchive.ts`
 * (#3590, #2077 max-lines). Homes the post-commit hook-registration validator
 * call and its #2639 (F9) attribution so the import core stays under the
 * 1,500-line `max-lines` guardrail as the whole-tree hooks fix (#3590) accretes
 * commit-time logic — the same decomposition that produced `importPlanSummary.ts`
 * (#2565) and `commitSelection.ts` (#3247).
 */
import { basename, join } from "node:path";
import { HOOK_SUPPORT_DIRS } from "@hapi/protocol/porter";
import {
  validateHookRegistration,
  type HookRegistrationValidationResult,
} from "./hookRegistrationValidator";
import { RegistryDriftError } from "./importArchiveErrors";
import { sectionSkipSurface } from "./plannedDestinations";
import type { Conflict } from "./conflictDetection";
import type { ImportPlan, PlannedItemKind } from "./importArchive";
import type { CommitExclusions } from "./commitSelection";

/** Per-dimension parity: what the selected plan promised vs what the commit did. */
export interface DimensionParity {
  /** Selected planned items in this dimension. */
  expected: number;
  /** Items actually written (new content). */
  written: number;
  /** Selected items skipped as byte-identical no-ops (already present). */
  alreadyPresent: number;
  /** Selected items skipped because they differ and overwrite was not chosen. */
  skippedConflicts: number;
  /**
   * The non-tautological gap: for `hooks`, registry-referenced modules absent at
   * the destination post-commit (Task 4); for `hookSupport`, per-file entries
   * whose tar member was absent (a truncated/partial archive). Empty otherwise.
   */
  missing: string[];
}

/** #3590 (K6/D7): per-dimension parity report carried on `ImportResult`. */
export type ImportParity = Record<string, DimensionParity>;

/** The dimension a planned file item belongs to (for the parity report). */
const KIND_TO_DIM: Record<PlannedItemKind, string> = {
  skill: "skills",
  agent: "agents",
  command: "commands",
  rule: "rules",
  "output-style": "outputStyles",
  "claude-md": "claudeMd",
  "claude-md-include": "claudeMd",
  "hook-file": "hooks",
  "hook-lib": "hookSupport",
  "settings-script": "settingsScripts",
};

/**
 * #3590 (K6/D7): compute the per-dimension expected-vs-written parity for a
 * finalized commit. `runCommit` is all-or-nothing (rollback on any error), so for
 * file dimensions `written`/`alreadyPresent`/`skippedConflicts` are a function of
 * the selected plan — the two `missing` sources are the only non-tautological
 * signals (a registry that points at an absent hook; a truncated hookSupport
 * entry). Deselected items (#3247) are excluded from every count.
 */
export function computeParity(
  plan: ImportPlan,
  sel: CommitExclusions,
  filesWritten: readonly string[],
  skippedConflicts: readonly Conflict[],
  hookValidation: HookRegistrationValidationResult
): ImportParity {
  const written = new Set(filesWritten);
  const conflictByPath = new Map(plan.fileConflicts.map(c => [c.destPath, c]));
  const skippedByPath = new Set(skippedConflicts.map(c => c.destPath));
  const parity: ImportParity = {};
  const ensure = (dim: string): DimensionParity =>
    (parity[dim] ??= {
      expected: 0,
      written: 0,
      alreadyPresent: 0,
      skippedConflicts: 0,
      missing: [],
    });

  for (const item of plan.files) {
    if (sel.isItemExcluded(item)) continue;
    const p = ensure(KIND_TO_DIM[item.kind]);
    p.expected++;
    if (written.has(item.destPath)) p.written++;
    if (conflictByPath.get(item.destPath)?.kind === "exists")
      p.alreadyPresent++;
    if (skippedByPath.has(item.destPath)) p.skippedConflicts++;
  }

  // hooks: post-commit registry drift (Task 4) — a registry names an absent hook.
  if (hookValidation.registryMissing.length > 0) {
    ensure("hooks").missing = [...hookValidation.registryMissing];
  }

  // hookSupport: a per-file entry whose tar member was absent at plan time (a
  // truncated/partial archive) — the directory entries (lib/_shared) are excluded.
  const isDirEntry = (path: string): boolean =>
    HOOK_SUPPORT_DIRS.some(d => path === join("hooks", d));
  const plannedLibPaths = new Set(
    plan.files.filter(f => f.kind === "hook-lib").map(f => f.destPath)
  );
  // #4160: skip an entry only when the plan actually reports it as policy-skipped
  // (./planSections emits one omission per skipped entry). An entry with no such
  // omission — e.g. outside hooks/ and absent from the archive — is still missing.
  const policySkipped = new Set(plan.omissions.map(o => o.surface));
  const missingSupport = plan.manifest.hookSupport
    .filter(
      e =>
        !isDirEntry(e.path) &&
        !policySkipped.has(sectionSkipSurface("hookSupport", e.path)) &&
        !plannedLibPaths.has(join(plan.claudeDir, e.path))
    )
    .map(e => e.path);
  if (missingSupport.length > 0) {
    ensure("hookSupport").missing = missingSupport;
  }

  return parity;
}

/**
 * #3590 (K4/D9): enforce the plan-time fail-loud belt at commit. Throw
 * {@link RegistryDriftError} when the plan flagged missing registry hook modules
 * (`plan.registryMissing`), at least one hook survives the selection, and the
 * request did not acknowledge EVERY missing name. A commit that deselects every
 * hook, or acknowledges all missing names, proceeds. Runs BEFORE any write, so a
 * refusal leaves zero bytes and the plan staging intact for a re-commit.
 */
export function assertRegistryAcknowledged(
  plan: ImportPlan,
  sel: CommitExclusions,
  acknowledgeMissingHooks: readonly string[] = []
): void {
  if (plan.registryMissing.length === 0) return;
  if (sel.selectedHookEntries.length === 0) return; // every hook deselected
  const acked = new Set(acknowledgeMissingHooks);
  const unacked = plan.registryMissing.filter(n => !acked.has(n));
  if (unacked.length > 0) throw new RegistryDriftError(unacked);
}

/**
 * Run the post-commit hook validator and attribute unresolved imports to THIS
 * import's SELECTED hooks (#2639 F9, the third check). Reports drift; never rolls
 * back.
 *
 * The validator walks the ENTIRE destination `hooks/` tree — including
 * pre-existing native hooks that were never in this archive — so its findings are
 * intersected with this plan's SELECTED hook entries by BASENAME (the validator
 * returns dest file paths; `plan.hookEntries` carry archive paths) before
 * excluding from the count. A pre-existing hook's unresolved import stays LOUD (it
 * remains in `hookValidation.unresolvedImports`) but must NOT decrement the
 * imported count. A deselected hook (#3247) was neither written nor merged, so it
 * must not appear in the imported count either.
 */
export async function attributeHookValidation(
  plan: ImportPlan,
  sel: CommitExclusions
): Promise<{
  hookValidation: HookRegistrationValidationResult;
  hooks: { imported: number; excluded: { hook: string; module: string }[] };
}> {
  const hookValidation = await validateHookRegistration(plan.claudeDir);

  const importedHookBasenames = new Set(
    sel.selectedHookEntries.map(h => basename(h.file.path))
  );
  const hookExcluded: { hook: string; module: string }[] = [];
  const excludedHookNames = new Set<string>();
  for (const u of hookValidation.unresolvedImports) {
    const name = basename(u.hook);
    if (!importedHookBasenames.has(name)) continue; // pre-existing dest hook
    hookExcluded.push({ hook: name, module: u.module });
    excludedHookNames.add(name);
  }
  const hooksImported = sel.selectedHookEntries.length - excludedHookNames.size;

  return {
    hookValidation,
    hooks: { imported: hooksImported, excluded: hookExcluded },
  };
}
