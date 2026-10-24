// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Plan-side manifest-section handling — split out of `importArchive.ts` (#4160,
 * #2077 max-lines), the same decomposition that produced `planHooks.ts`
 * (#3590). Homes `planDimension`, the prefix-matcher every section
 * (`skills` … `outputStyles`, `hookSupport`) is planned through, together with
 * the #4160 rule that a section entry may only write inside its own folder
 * (./plannedDestinations).
 */
import { join, relative, resolve } from "node:path";
import {
  credentialPathPart,
  type ConfigEntry,
  type Omission,
} from "@hapi/protocol/porter";
import { assertSafeEntry } from "./archiveContainment";
import { hashContent } from "./conflictDetection";
import { ManifestValidationError } from "./importArchiveErrors";
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
 * entry that matches no FILE member is reported once in `unmatched`, a
 * separate array because it is not an import policy refusal. #5188: an entry
 * whose path is not a valid entry path (an empty, `.` or `..` part) matches
 * its members as written, as before #4185, and is reported as an invalid entry
 * path only when that match reaches no file.
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
  // The entry and member path that first planned each destination of an
  // entry. Two spellings of one entry (`skills/foo` and `skills/foo/`) now
  // reach the same members, so two spellings of one entry plan each file once;
  // a member can also be spelled two ways (`skills/foo/x`, `./skills/foo/x`).
  // Distinct entries that overlap (`skills` and `skills/foo`) each still plan
  // theirs; a member they match only once stripped adds no second byte source
  // (`destOwner` below). #5202 (U15): a member skipped that way is compared,
  // not dropped: the same bytes collapse, and different bytes refuse the
  // archive, as #4331 does for hooks.
  const plannedDest = new Map<
    string,
    { entry: ConfigEntry; path: string; hash: string }
  >();
  // #5188 (F2): the first member an entry matches as written for each
  // destination, across EVERY entry of this section, with its bytes' hash
  // (#5202 U15). Two plans of one destination stage to ONE file
  // (`stagedPath` below) and the commit writes that file for every plan of it,
  // so a second member there would replace the first's bytes. A member an
  // entry matches as written always plans (the pre-#4185 rule), so two
  // DIFFERENT as-written members of one destination still both plan and the
  // last staged lands, as before #4185; a member that matches only once
  // stripped plans a destination only when it is that destination's owner.
  // `resolve` gives the path `assertSafeEntry` returns for the same member.
  const destOwner = new Map<string, { path: string; hash: string }>();
  for (const ce of configEntries) {
    for (const e of entries) {
      if (e.kind !== "file" || !isAtOrUnder(e.path, ce.path)) continue;
      const d = resolve(claudeDir, e.path);
      if (!destOwner.has(d))
        destOwner.set(d, { path: e.path, hash: hashContent(e.data) });
    }
  }
  // A manifest that lists an entry path twice is planned and reported once.
  const seenEntries = new Set<string>();
  for (const ce of configEntries) {
    if (seenEntries.has(ce.path)) continue;
    seenEntries.add(ce.path);
    const prefix = normalizeEntryPath(ce.path);
    // FILE members this entry reached. A directory member never counts: a real
    // export carries `skills/foo/` as a directory member, which an entry
    // `skills/foo/` matched exactly before #4185 and then planned nothing.
    let fileMatches = 0;
    // #5188 (F4): an entry with an empty, "." or ".." part matches its members
    // as written, exactly as before #4185, so a plan it had is kept; it is
    // reported only when that matches no file. The tar reader refuses a `//`
    // member and containment a leading `/` (absolute) or a `..` one, so in
    // practice only a "." part plans.
    // A valid entry's as-written matches go first, so a member that matches
    // only once stripped never replaces one planned before.
    const candidates =
      prefix === null
        ? entries.filter(e => isAtOrUnder(e.path, ce.path))
        : entries
            .filter(e => isAtOrUnder(matchPath.get(e) ?? e.path, prefix))
            .sort(
              (a, b) =>
                Number(!isAtOrUnder(a.path, ce.path)) -
                Number(!isAtOrUnder(b.path, ce.path))
            );
    for (const entry of candidates) {
      // 🔴 #4185: an invalid entry leaves a claimed member, containment
      // included, to the hook-file loop (./planHooks `planHookFiles` checks
      // the member it stages), as before #4185.
      if (prefix === null && claimedOwners.has(entry.path)) {
        if (entry.kind === "file") fileMatches++;
        continue;
      }
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
      // member that matches only once stripped is skipped when another member
      // owns this destination, or when another spelling of this entry planned
      // it first, and only with the same bytes: different bytes refuse the
      // archive (#5202 U15).
      const planKey = `${prefix ?? ce.path}\0${destPath}`;
      const by = plannedDest.get(planKey);
      const hash = hashContent(entry.data);
      // 🔴 #5202 (U15): a skipped spelling with different bytes is never
      // dropped silently (zero bytes written: planImport removes the staging
      // dir on any throw).
      const differentContent = (other: string): ManifestValidationError =>
        new ManifestValidationError(
          "invalid",
          `${dimKey} members ${JSON.stringify(other)} and ` +
            `${JSON.stringify(entry.path)} both import to ` +
            `${JSON.stringify(v.destRel)} with different content`
        );
      if (!isAtOrUnder(entry.path, ce.path)) {
        // #5188 (F2): never a second byte source, from a member that matches
        // only once stripped, for a destination another member owns.
        const owner = destOwner.get(destPath);
        if (owner !== undefined && owner.path !== entry.path) {
          if (owner.hash === hash) continue;
          throw differentContent(owner.path);
        }
        destOwner.set(destPath, { path: entry.path, hash });
        if (by && (by.entry !== ce || by.path !== entry.path)) {
          if (by.hash === hash) continue;
          throw differentContent(by.path);
        }
      }
      if (!by) plannedDest.set(planKey, { entry: ce, path: entry.path, hash });
      plans.push({
        item: {
          kind,
          name: ce.name,
          destPath,
          // Stage by the NORMALIZED destination (#4143 precedent): a raw path
          // with a trailing slash would otherwise stage to a directory.
          stagedPath: join(stagingDir, "tree", v.destRel),
          incomingHash: hash,
          mode: entry.mode,
        },
        content: entry.data,
      });
    }
    // #4185: an entry that reached no file is reported, never dropped silently.
    // That includes an existing-but-empty `hooks/lib` or `hooks/_shared`
    // directory entry: nothing in it to import, so it is reported on purpose.
    if (fileMatches === 0)
      unmatched.push(
        sectionUnmatchedOmission(
          dimKey,
          ce.path,
          prefix === null ? "invalid-path" : "no-file"
        )
      );
  }
  const skipped = skippedEntries.map(path =>
    sectionEntryOmission(dimKey, path, {
      outside: outside.get(path),
      credential: credential.get(path),
    })
  );
  return { plans, skipped: [...skipped, ...spellingSkips], unmatched };
}
