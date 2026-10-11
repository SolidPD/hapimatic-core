// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Plan-side manifest-section handling — split out of `importArchive.ts` (#4160,
 * #2077 max-lines), the same decomposition that produced `planHooks.ts`
 * (#3590). Homes `planDimension`, the prefix-matcher every section
 * (`skills` … `outputStyles`, `hookSupport`) is planned through, together with
 * the #4160 rule that a section entry may only write inside its own folder
 * (./plannedDestinations).
 */
import { join } from "node:path";
import {
  credentialPathPart,
  type ConfigEntry,
  type Omission,
} from "@hapi/protocol/porter";
import { assertSafeEntry } from "./archiveContainment";
import { hashContent } from "./conflictDetection";
import {
  classifyPlannedDestination,
  sectionEntryOmission,
  type SectionField,
  type SkipTally,
} from "./plannedDestinations";
import type { PlannedFileItem, PlannedItemKind } from "./importArchive";
import type { TarEntry } from "./tarArchive";

export const DIM_DEST: Record<SectionField, PlannedItemKind> = {
  skills: "skill",
  agents: "agent",
  commands: "command",
  rules: "rule",
  outputStyles: "output-style",
  // #2639 (F9): hook-support subtrees (hooks/lib, hooks/_shared) ride the same
  // path-preserving prefix-matcher as the dimensions — see the `dims` loop in
  // `./importArchive` (planImport).
  hookSupport: "hook-lib",
};

/** A planned file item paired with its (transient) source bytes for staging. */
export interface StagedPlan {
  item: PlannedFileItem;
  content: Buffer;
}

/**
 * Build the flat list of file items for a dimension by matching every regular tar
 * member under each {@link ConfigEntry}'s archive path prefix. Containment is
 * asserted per item against the config root using the DEST-relative path — a
 * malicious `..`/absolute archive path is rejected here. (The manifest entry's
 * `name` is only a selection/grouping key — ./commitSelection — and never forms
 * a filesystem path, so it is not checked here.)
 * Directory and link members are still passed through {@link assertSafeEntry}
 * (which refuses links) but carry no content, so only regular files are staged.
 *
 * #4160: a member whose resolved destination is not strictly inside the
 * section's own folder is skipped — never staged, never written — and reported
 * once per entry in `skipped` (a plan `omissions[]` warning).
 *
 * #4172: a member inside its folder whose destination has a credential-bearing
 * path part (`.env`, `.npmrc`, `.ssh/…`, any case) is skipped the same way; the
 * rest of the archive still imports. Both causes share ONE omission per entry.
 * Containment escapes and link members still refuse the whole archive above.
 */
export function planDimension(
  entries: TarEntry[],
  configEntries: readonly ConfigEntry[],
  dimKey: SectionField,
  claudeDir: string,
  stagingDir: string,
  claimed?: ReadonlySet<string>
): { plans: StagedPlan[]; skipped: Omission[] } {
  const kind = DIM_DEST[dimKey];
  const plans: StagedPlan[] = [];
  const outside = new Map<string, SkipTally>();
  const credential = new Map<string, SkipTally & { part: string }>();
  const skippedEntries: string[] = [];
  const noteSkipped = (path: string): void => {
    if (!skippedEntries.includes(path)) skippedEntries.push(path);
  };
  for (const ce of configEntries) {
    const prefix = ce.path;
    for (const entry of entries) {
      const isExact = entry.path === prefix;
      const isUnder = entry.path.startsWith(prefix + "/");
      if (!isExact && !isUnder) continue;
      // #3590 (K3): a `hookSupport` tar entry whose archive path is already CLAIMED
      // by a registered `hooks[]` entry is planned by the hook-FILE loop, not here.
      // A conforming whole-tree archive never lists a registered path under
      // hookSupport (the exporter emits ≤1 reference per file), so this skip only
      // corrects a hand-built / extraction-prompt archive — planning it once
      // instead of double-planning the same destPath.
      if (claimed?.has(entry.path)) continue;
      // The archive path IS the config-root-relative destination path (the layout
      // mirrors `~/.claude`), so containment validates the actual archive path
      // rather than one reconstructed from name+rel.
      // 🔴 Containment + link rejection against the config root (R7).
      const destPath = assertSafeEntry(claudeDir, {
        path: entry.path,
        kind: entry.kind,
      });
      if (entry.kind !== "file") continue;
      // 🔴 #4160: only strictly inside this section's folder (after R7 above).
      const v = classifyPlannedDestination(claudeDir, kind, destPath);
      if (!v.ok) {
        const hit = outside.get(ce.path);
        if (hit) hit.count++;
        else outside.set(ce.path, { first: v.destRel, count: 1 });
        noteSkipped(ce.path);
        continue;
      }
      // 🔴 #4172: a credential-bearing path part is skipped for this member only.
      const part = credentialPathPart(v.destRel);
      if (part !== null) {
        const hit = credential.get(ce.path);
        if (hit) hit.count++;
        else credential.set(ce.path, { first: v.destRel, part, count: 1 });
        noteSkipped(ce.path);
        continue;
      }
      plans.push({
        item: {
          kind,
          name: ce.name,
          destPath,
          // Stage by the NORMALIZED destination (#4143 precedent): a raw path
          // with a trailing slash would otherwise stage to a directory.
          stagedPath: join(stagingDir, "tree", v.destRel),
          incomingHash: hashContent(entry.data),
          mode: entry.mode,
        },
        content: entry.data,
      });
    }
  }
  const skipped = skippedEntries.map(path =>
    sectionEntryOmission(dimKey, path, {
      outside: outside.get(path),
      credential: credential.get(path),
    })
  );
  return { plans, skipped };
}
