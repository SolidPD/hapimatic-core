// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Plan-side CLAUDE.md handling — split out of `importArchive.ts` (#4173, the
 * epic #4290 T2 move; #2077 max-lines), the same decomposition that produced
 * `./planHooks` (#3590) and `./planSections` (#4160). Homes the planner for the
 * CLAUDE.md member and its `@`-included siblings so the import core stays under
 * the 1,500-line `max-lines` guardrail. No behaviour change: the function body
 * is moved verbatim.
 */
import { basename, dirname, join } from "node:path";
import type { Omission, PorterManifest } from "@hapi/protocol/porter";
import { assertSafeEntry } from "./archiveContainment";
import {
  classifyClaudeMdInclude,
  includeKey,
  includeSkipOmission,
} from "./claudeMdIncludes";
import { hashContent } from "./conflictDetection";
import { findEntry } from "./planHooks";
import type { TarEntry } from "./tarArchive";
import type { PlannedFileItem } from "./importArchive";

export interface ClaudeMdPlanItem {
  file: PlannedFileItem;
  archivePath: string;
}

/**
 * Plan the CLAUDE.md member and its @-included siblings. An include is planned
 * only as a top-level `*.md` sibling (#4143, ./claudeMdIncludes); every other
 * include is returned in `skipped` as a plan omission.
 */
export function planClaudeMd(
  entries: TarEntry[],
  claudeMd: NonNullable<PorterManifest["claudeMd"]>,
  claudeDir: string,
  stagingDir: string
): { items: ClaudeMdPlanItem[]; skipped: Omission[] } {
  const out: ClaudeMdPlanItem[] = [];
  const skipped: Omission[] = [];
  const claimed = new Set<string>();
  const mdEntry = findEntry(entries, claudeMd.path);
  if (mdEntry) {
    const destPath = assertSafeEntry(claudeDir, {
      path: "CLAUDE.md",
      kind: "file",
    });
    out.push({
      archivePath: claudeMd.path,
      file: {
        kind: "claude-md",
        name: "CLAUDE.md",
        destPath,
        stagedPath: join(stagingDir, "tree", "CLAUDE.md"),
        incomingHash: hashContent(mdEntry.data),
        mode: mdEntry.mode,
      },
    });
  }
  const mdDir = dirname(claudeMd.path);
  // An exact-duplicate archive path collapses here, which keeps each skip's
  // `surface` unique. An absent member stays a silent skip — the exporter
  // already records it as an omission.
  for (const inc of new Set(claudeMd.includes)) {
    const entry = findEntry(entries, inc);
    if (!entry) continue;
    const rel =
      mdDir !== "." && inc.startsWith(mdDir + "/")
        ? inc.slice(mdDir.length + 1)
        : basename(inc);
    if (entry.kind !== "file") {
      skipped.push(includeSkipOmission(inc, rel, "not-regular-file"));
      continue;
    }
    // Containment first: `..` / absolute / NUL still refuse the archive (R7).
    const destPath = assertSafeEntry(claudeDir, { path: rel, kind: "file" });
    const verdict = classifyClaudeMdInclude(claudeDir, destPath, claimed);
    if (!verdict.ok) {
      skipped.push(includeSkipOmission(inc, verdict.destRel, verdict.reason));
      continue;
    }
    claimed.add(includeKey(verdict.destRel));
    // Name and stage by the NORMALIZED destination: a raw `rel` may carry a
    // trailing slash that `resolve()` dropped, which would stage to a directory.
    out.push({
      archivePath: inc,
      file: {
        kind: "claude-md-include",
        name: verdict.destRel,
        destPath,
        stagedPath: join(stagingDir, "tree", verdict.destRel),
        incomingHash: hashContent(entry.data),
        mode: entry.mode,
      },
    });
  }
  return { items: out, skipped };
}
