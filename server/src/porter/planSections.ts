// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Plan-side manifest-section handling — split out of `importArchive.ts` (#4160,
 * #2077 max-lines), the same decomposition that produced `planHooks.ts`
 * (#3590). Homes `planDimension`, the prefix-matcher every section
 * (`skills` … `outputStyles`, `hookSupport`) is planned through, together with
 * the #4160 rule that a section entry may only write inside its own folder
 * (./plannedDestinations).
 */
import { join, relative } from "node:path";
import {
  credentialPathPart,
  type ConfigEntry,
  type Omission,
} from "@hapi/protocol/porter";
import { assertSafeEntry } from "./archiveContainment";
import { hashContent } from "./conflictDetection";
import {
  classifyPlannedDestination,
  normalizeEntryPath,
  sectionEntryOmission,
  sectionUnmatchedOmission,
  stripEntrySpelling,
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

/** Is `path` exactly `prefix`, or a path under it? */
function isAtOrUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + "/");
}

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
 *
 * #4185: an entry path is compared by {@link normalizeEntryPath} and a member
 * path by {@link stripEntrySpelling}, so `skills/foo/`, `./skills/foo` and
 * `skills/foo` plan the same members, however the members are spelled. An
 * entry that matches no FILE member, or whose path is not a valid entry path,
 * is reported once in `unmatched`, a separate array because it is not an import
 * policy refusal.
 *
 * #4331: `claimed` maps each destination a registered hook stages to the
 * archive path it stages from (./planHooks `claimedHookPaths`). A `hookSupport`
 * member that writes a claimed destination is left to the hook-file loop,
 * however it is spelled (`./hooks/h.py` or `hooks/./a/run.py` beside the
 * registered path); a differently spelled one is also reported, once per
 * member, since the hook's bytes are the ones that land.
 */
export function planDimension(
  entries: TarEntry[],
  configEntries: readonly ConfigEntry[],
  dimKey: SectionField,
  claudeDir: string,
  stagingDir: string,
  claimed?: ReadonlyMap<string, string>
): { plans: StagedPlan[]; skipped: Omission[]; unmatched: Omission[] } {
  const kind = DIM_DEST[dimKey];
  const plans: StagedPlan[] = [];
  const outside = new Map<string, SkipTally>();
  const credential = new Map<string, SkipTally & { part: string }>();
  const skippedEntries: string[] = [];
  const noteSkipped = (path: string): void => {
    if (!skippedEntries.includes(path)) skippedEntries.push(path);
  };
  const unmatched: Omission[] = [];
  // 🔴 #4185: a member is matched with only its `./` / trailing `/` spelling
  // stripped, never rejected or skipped. Every member that matched before #4185
  // still matches, so a hostile `..` member still reaches `assertSafeEntry`
  // below (on its RAW path) and still refuses the whole archive.
  const matchPath = new Map<TarEntry, string>(
    entries.map(e => [e, stripEntrySpelling(e.path)])
  );
  // #4331: the raw archive paths the hook-FILE loop stages (the claim owners);
  // an invalid entry below leaves their containment to that loop.
  const claimedOwners = new Set(claimed?.values() ?? []);
  // #4331: per-MEMBER omissions, kept apart from the per-entry render below.
  const spellingSkips: Omission[] = [];
  // The entry and member path that first planned each destination of a
  // normalized entry. Two spellings of one entry (`skills/foo` and
  // `skills/foo/`) now reach the same members, and a member can be spelled two
  // ways (`skills/foo/x`, `./skills/foo/x`), so a member that matches only once
  // stripped is skipped when another spelling or entry already planned its
  // destination. Distinct entries that overlap (`skills` and `skills/foo`) each
  // still plan theirs.
  const plannedDest = new Map<string, { entry: ConfigEntry; path: string }>();
  // A manifest that lists an entry path twice is planned and reported once.
  const seenEntries = new Set<string>();
  for (const ce of configEntries) {
    if (seenEntries.has(ce.path)) continue;
    seenEntries.add(ce.path);
    const prefix = normalizeEntryPath(ce.path);
    if (prefix === null) {
      // 🔴 #4185: an invalid entry plans nothing and is reported, but every
      // member it matched before #4185 still passes containment, so a `..`
      // member still refuses the whole archive (#4160 R7).
      for (const entry of entries) {
        if (!isAtOrUnder(entry.path, ce.path) || claimedOwners.has(entry.path))
          continue;
        assertSafeEntry(claudeDir, { path: entry.path, kind: entry.kind });
      }
      unmatched.push(sectionUnmatchedOmission(dimKey, ce.path, "invalid-path"));
      continue;
    }
    // FILE members this entry reached. A directory member never counts: a real
    // export carries `skills/foo/` as a directory member, which an entry
    // `skills/foo/` matched exactly before #4185 and then planned nothing.
    let fileMatches = 0;
    // The members this entry matched before #4185 go first, so a member that
    // matches only once stripped never replaces one planned before.
    const candidates = entries
      .filter(e => isAtOrUnder(matchPath.get(e) ?? e.path, prefix))
      .sort(
        (a, b) =>
          Number(!isAtOrUnder(a.path, ce.path)) -
          Number(!isAtOrUnder(b.path, ce.path))
      );
    for (const entry of candidates) {
      // The archive path IS the config-root-relative destination path (the layout
      // mirrors `~/.claude`), so containment validates the actual archive path
      // rather than one reconstructed from name+rel.
      // 🔴 Containment + link rejection against the config root (R7).
      const destPath = assertSafeEntry(claudeDir, {
        path: entry.path,
        kind: entry.kind,
      });
      if (entry.kind !== "file") continue;
      // #3590 (K3): a `hookSupport` file whose DESTINATION a registered `hooks[]`
      // entry already stages is planned by the hook-FILE loop, not here. A
      // conforming whole-tree archive never lists a registered path under
      // hookSupport (the exporter emits ≤1 reference per file), so this skip only
      // corrects a hand-built / extraction-prompt archive — planning it once
      // instead of double-planning the same destPath. #4331: keyed on the
      // destination, after containment ran on the RAW path above (so a `..` copy
      // still refuses the archive), so every spelling of a claimed file is
      // caught, and a differently spelled one is reported.
      const owner = claimed?.get(destPath);
      if (owner !== undefined) {
        const surface = `hookSupport member ${entry.path}`;
        // Once per member, even when overlapping entries both reach it.
        if (
          owner !== entry.path &&
          !spellingSkips.some(o => o.surface === surface)
        ) {
          const destRel = relative(claudeDir, destPath);
          spellingSkips.push({
            surface,
            reason: `not imported: registered hook ${owner} writes the same destination (${destRel})`,
          });
        }
        // d2 (#4185): it counts as a match, because the hook-file loop plans it.
        fileMatches++;
        continue;
      }
      // #4185: every FILE member that reaches the #4160 check counts as a match,
      // including one skipped below for being outside the folder (#4160) or for
      // a credential-bearing name (#4172): its entry gets that omission instead.
      fileMatches++;
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
      // A member the raw entry path matched plans exactly as before #4185. A
      // member that matches only once stripped is skipped when another
      // spelling or entry planned this destination first. A repeat of the same
      // member path within one entry plans again, so a duplicated tar member
      // lands its last copy, as tar extraction does.
      const planKey = `${prefix}\0${destPath}`;
      const by = plannedDest.get(planKey);
      if (
        by &&
        !isAtOrUnder(entry.path, ce.path) &&
        (by.entry !== ce || by.path !== entry.path)
      )
        continue;
      if (!by) plannedDest.set(planKey, { entry: ce, path: entry.path });
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
    // #4185: an entry that reached no file is reported, never dropped silently.
    // That includes an existing-but-empty `hooks/lib` or `hooks/_shared`
    // directory entry: nothing in it to import, so it is reported on purpose.
    if (fileMatches === 0)
      unmatched.push(sectionUnmatchedOmission(dimKey, ce.path));
  }
  const skipped = skippedEntries.map(path =>
    sectionEntryOmission(dimKey, path, {
      outside: outside.get(path),
      credential: credential.get(path),
    })
  );
  return { plans, skipped: [...skipped, ...spellingSkips], unmatched };
}
