// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Plan-side CLAUDE.md handling — split out of `importArchive.ts` (#4173, the
 * epic #4290 T2 move; #2077 max-lines), the same decomposition that produced
 * `./planHooks` (#3590) and `./planSections` (#4160). Homes the planner for the
 * CLAUDE.md member and its `@`-included siblings so the import core stays under
 * the 1,500-line `max-lines` guardrail. #4173 moved the function body verbatim;
 * #4285 then made a missing or non-regular CLAUDE.md member a plan refusal.
 */
import { dirname, join } from "node:path";
import type { Omission, PorterManifest } from "@hapi/protocol/porter";
import { assertSafeEntry } from "./archiveContainment";
import {
  CLAUDE_MD_REWRITE_MAX_BYTES,
  claudeMdTooLargeNotice,
  classifyClaudeMdInclude,
  includeDestination,
  includeKey,
  includeSkipOmission,
  includeUnreferencedNotice,
  includeUnrewrittenNotice,
  rewriteClaudeMd,
} from "./claudeMdIncludes";
import { hashContent } from "./conflictDetection";
import { ManifestValidationError } from "./importArchiveErrors";
import { findEntry } from "./planHooks";
import type { TarEntry } from "./tarArchive";
import type { PlannedFileItem } from "./importArchive";

export interface ClaudeMdPlanItem {
  file: PlannedFileItem;
  /** The archive member the bytes come from (a case alias's own spelling). */
  archivePath: string;
  /**
   * #4156: the bytes to stage instead of the archive member's — CLAUDE.md with
   * its nested include references rewritten. `file.incomingHash` hashes these.
   */
  content?: Buffer;
}

/**
 * #4156: how the staged CLAUDE.md was rewritten, so the commit can drop the
 * rewrite of an include the operator excluded ({@link claudeMdCommitBytes}).
 * `refs` pairs each rewritten reference with its include's planned item and
 * archive path.
 */
export interface ClaudeMdRewrite {
  destPath: string;
  original: Buffer;
  refs: Array<{
    ref: string;
    to: string;
    include: PlannedFileItem;
    archivePath: string;
  }>;
}

/**
 * Plan the CLAUDE.md member and its @-included siblings. An include is planned
 * as a top-level `*.md` sibling or, when CLAUDE.md names it below top level, as
 * a `*.md` under `claude-includes/` (#4143, #4156, ./claudeMdIncludes); every
 * other include is returned in `skipped` as a plan omission, except that a
 * listed include with no archive member under any case spelling refuses the
 * plan with `ManifestValidationError` (#5189). A nested include's
 * CLAUDE.md reference is rewritten to the path it lands at, so it resolves; one
 * the rewrite leaves as written is returned in `notices`, and `rewrite` lets the
 * commit drop the rewrite of an include the operator excludes.
 */
export function planClaudeMd(
  entries: TarEntry[],
  claudeMd: NonNullable<PorterManifest["claudeMd"]>,
  claudeDir: string,
  stagingDir: string
): {
  items: ClaudeMdPlanItem[];
  skipped: Omission[];
  notices: Omission[];
  rewrite?: ClaudeMdRewrite;
} {
  const out: ClaudeMdPlanItem[] = [];
  const skipped: Omission[] = [];
  const notices: Omission[] = [];
  const claimed = new Set<string>();
  const rewrites = new Map<string, string>();
  const refs: ClaudeMdRewrite["refs"] = [];
  const archivePathOf = new Map<string, string>();
  const mdEntry = findEntry(entries, claudeMd.path);
  // #4285 R7: the manifest asserts the member exists. A missing or non-regular
  // one is refused, not skipped — a silent skip is how a misnamed CLAUDE.md
  // (a header the local tar named differently) went unreported.
  if (!mdEntry || mdEntry.kind !== "file") {
    throw new ManifestValidationError(
      "invalid",
      `manifest.json names CLAUDE.md at ${JSON.stringify(claudeMd.path)}, but the archive ` +
        "has no regular-file member there"
    );
  }
  const mdItem: ClaudeMdPlanItem = {
    archivePath: claudeMd.path,
    file: {
      kind: "claude-md",
      name: "CLAUDE.md",
      destPath: assertSafeEntry(claudeDir, { path: "CLAUDE.md", kind: "file" }),
      stagedPath: join(stagingDir, "tree", "CLAUDE.md"),
      incomingHash: hashContent(mdEntry.data),
      mode: mdEntry.mode,
    },
  };
  out.push(mdItem);
  const mdDir = dirname(claudeMd.path);
  // An exact-duplicate archive path collapses here, which keeps each skip's
  // `surface` unique. Both exporters list an include only after copying it
  // (every omission path stops before the list), so a listed include is found
  // by exact name, or failing that as a case alias. The exporters dedupe
  // include lines case-sensitively, and on a case-insensitive disk (APFS,
  // NTFS) `@RULES.md` lands in the `rules.md` already copied and `@Docs/b.md`
  // in the existing `docs/` folder, so the member keeps the first spelling. A
  // case alias plans from that member through the normal path, where a repeated
  // file falls to the duplicate-destination skip. A listed include with no
  // member under any spelling is a manifest/archive mismatch, refused like a
  // missing CLAUDE.md (#4285 R7, #5189).
  for (const inc of new Set(claudeMd.includes)) {
    const entry =
      findEntry(entries, inc) ??
      entries.find(e => includeKey(e.path) === includeKey(inc));
    const { ref, rel } = includeDestination(inc, mdDir);
    if (!entry) {
      // Containment first, as for a present member (R7).
      assertSafeEntry(claudeDir, { path: rel, kind: "file" });
      throw new ManifestValidationError(
        "invalid",
        `manifest.json lists CLAUDE.md include ${JSON.stringify(inc)}, but the archive ` +
          "has no member there"
      );
    }
    if (entry.kind !== "file") {
      skipped.push(includeSkipOmission(inc, rel, "not-regular-file"));
      continue;
    }
    // Containment first: `..` / absolute / NUL still refuse the archive (R7).
    const destPath = assertSafeEntry(claudeDir, { path: rel, kind: "file" });
    // #5202 (U17): `@/…` and `@~/…` name files outside the config folder;
    // landing them under claude-includes/ and rewriting the reference would
    // point CLAUDE.md away from the file it meant.
    if (ref.startsWith("/") || ref.startsWith("~")) {
      skipped.push(includeSkipOmission(inc, rel, "absolute-or-home"));
      continue;
    }
    const verdict = classifyClaudeMdInclude(claudeDir, destPath, claimed);
    if (!verdict.ok) {
      skipped.push(includeSkipOmission(inc, verdict.destRel, verdict.reason));
      continue;
    }
    claimed.add(includeKey(verdict.destRel));
    // Name and stage by the NORMALIZED destination: a raw `rel` may carry a
    // trailing slash that `resolve()` dropped, which would stage to a directory.
    const file: PlannedFileItem = {
      kind: "claude-md-include",
      name: verdict.destRel,
      destPath,
      stagedPath: join(stagingDir, "tree", verdict.destRel),
      incomingHash: hashContent(entry.data),
      mode: entry.mode,
    };
    if (verdict.destRel !== ref) {
      rewrites.set(ref, verdict.destRel);
      refs.push({ ref, to: verdict.destRel, include: file, archivePath: inc });
      archivePathOf.set(ref, inc);
    }
    // The member's own path: staging reads the bytes back by it, and a case
    // alias's member is spelled differently from the listed include (#5189).
    out.push({ archivePath: entry.path, file });
  }
  // #5202 (U16): past the size cap the scan is skipped — one notice names
  // every edit, and the includes still land under claude-includes/.
  if (rewrites.size > 0 && mdEntry.data.length > CLAUDE_MD_REWRITE_MAX_BYTES) {
    notices.push(claudeMdTooLargeNotice(rewrites));
    return { items: out, skipped, notices };
  }
  // #4156: rewrite each accepted nested reference to where its file lands. The
  // conflict check sees the rewritten bytes; the commit re-renders them only
  // when the operator excludes a rewritten include.
  const hits = new Set<string>();
  const content = rewriteClaudeMd(mdEntry.data, rewrites, hits);
  for (const [ref, to] of rewrites) {
    if (hits.has(ref)) continue;
    notices.push(
      includeUnrewrittenNotice(archivePathOf.get(ref) ?? ref, ref, to)
    );
  }
  if (!content) return { items: out, skipped, notices };
  mdItem.content = content;
  mdItem.file.incomingHash = hashContent(content);
  const rewrite: ClaudeMdRewrite = {
    destPath: mdItem.file.destPath,
    original: mdEntry.data,
    refs: refs.filter(r => hits.has(r.ref)),
  };
  return { items: out, skipped, notices, rewrite };
}

/**
 * #4156: the bytes the commit writes for CLAUDE.md, or `undefined` to write the
 * staged file. When the operator excludes an include whose reference the plan
 * rewrote, that reference keeps its original spelling: the import never writes
 * the file the rewrite would point at, while the original reference may name a
 * file the destination already has.
 */
export function claudeMdCommitBytes(
  rewrite: ClaudeMdRewrite | undefined,
  item: PlannedFileItem,
  isExcluded: (item: PlannedFileItem) => boolean
): Buffer | undefined {
  if (!rewrite || item.destPath !== rewrite.destPath) return undefined;
  const kept = rewrite.refs.filter(r => !isExcluded(r.include));
  if (kept.length === rewrite.refs.length) return undefined;
  const map = new Map(kept.map(r => [r.ref, r.to]));
  return rewriteClaudeMd(rewrite.original, map) ?? rewrite.original;
}

/**
 * #5202 (U12): one notice per rewritten include the commit wrote while it did
 * not write the rewritten CLAUDE.md — the operator kept their own (a conflict
 * without overwrite) or left CLAUDE.md out — so nothing references the file
 * where it landed. Known only at commit: overwrite and the selection are the
 * operator's choices there. `written` tells whether the commit wrote an item;
 * `identical` whether the destination already held its staged bytes.
 */
export function claudeMdUnreferencedNotices(
  rewrite: ClaudeMdRewrite | undefined,
  written: (destPath: string) => boolean,
  identical: (destPath: string) => boolean
): Omission[] {
  if (!rewrite || written(rewrite.destPath) || identical(rewrite.destPath)) {
    return [];
  }
  return rewrite.refs
    .filter(r => written(r.include.destPath))
    .map(r => includeUnreferencedNotice(r.archivePath, r.ref, r.to));
}
