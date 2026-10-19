// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Plan-side handling of a `tenant` export (issue #4373, Task 4), split out of
 * `importArchive.ts` (#2077 max-lines), the decomposition that produced
 * `planHooks.ts` and `planSections.ts`. Two jobs:
 *
 *  - The premium refusal (defense in depth): a plugin descriptor whose
 *    marketplace is the licensed premium one is dropped from the plan and
 *    reported, in ANY archive, never installed and never offered as a
 *    remediation command. A premium pack installs only through its
 *    entitlement-checked channel after online activation (#3991, product map
 *    §8.6 T-ACT), and this codebase has no activation client an import could
 *    consult, so the refusal holds on every instance. The tenant exporter
 *    already drops these; this catches a hand-built or older archive.
 *  - The memory section: each `memory/<source project key>/…` member lands at
 *    `<config root>/projects/<destination key>/memory/…`, where the key is
 *    remapped from the source home to this one, and only when that project
 *    folder already exists here (Claude Code reads a project's memory only for
 *    that project). A missing project is a notice, not an error.
 *
 * `buildPluginRemediation` moved here from `importArchive.ts` beside the
 * refusal, so the remediation list is built from the already-filtered
 * descriptor.
 */
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  MEMORY_ARCHIVE_DIR,
  MEMORY_PROJECT_ABSENT_REASON,
  PREMIUM_REQUIRES_ACTIVATION_REASON,
  credentialPathPart,
  isPremiumMarketplace,
  projectKeyForPath,
  remapProjectKey,
  type Omission,
  type PorterManifest,
} from "@hapi/protocol/porter";
import { assertSafeEntry } from "./archiveContainment";
import { hashContent, type StagedFileItem } from "./conflictDetection";
import type { PlannedFileItem } from "./importArchive";
import type { TarEntry } from "./tarArchive";
import { trimTrailingChars } from "@hapi/protocol/trimChars";

/** The omission surface of one refused premium plugin or marketplace. */
function premiumSurface(what: string): string {
  return `plugins ${what}`;
}

const PREMIUM_REFUSAL_REASON = `not imported: a licensed premium plugin installs only through its entitlement channel after online activation, never by an import (${PREMIUM_REQUIRES_ACTIVATION_REASON})`;

/**
 * The manifest with every premium marketplace and plugin descriptor removed,
 * and one policy omission per removed item. A marketplace is premium by name
 * or by its source; a plugin is premium when its marketplace is a premium name
 * or a premium marketplace this archive lists. An emptied descriptor is
 * removed whole, so a plan with nothing left reports no plugin descriptor.
 */
export function stripPremiumPlugins(manifest: PorterManifest): {
  manifest: PorterManifest;
  skipped: Omission[];
} {
  const plugins = manifest.plugins;
  if (!plugins) return { manifest, skipped: [] };
  const premiumNames = new Set(
    plugins.marketplaces
      .filter(m => isPremiumMarketplace(m.name, m.source))
      .map(m => m.name)
  );
  const isPremium = (marketplace: string): boolean =>
    premiumNames.has(marketplace) || isPremiumMarketplace(marketplace);
  const skipped: Omission[] = [];
  const marketplaces = plugins.marketplaces.filter(m => {
    if (!premiumNames.has(m.name)) return true;
    skipped.push({
      surface: premiumSurface(`marketplace ${m.name}`),
      reason: PREMIUM_REFUSAL_REASON,
    });
    return false;
  });
  const kept = plugins.plugins.filter(p => {
    if (!isPremium(p.marketplace)) return true;
    skipped.push({
      surface: premiumSurface(`${p.name}@${p.marketplace}`),
      reason: PREMIUM_REFUSAL_REASON,
    });
    return false;
  });
  if (skipped.length === 0) return { manifest, skipped };
  const next: PorterManifest = { ...manifest };
  if (marketplaces.length + kept.length === 0) delete next.plugins;
  else next.plugins = { ...plugins, marketplaces, plugins: kept };
  return { manifest: next, skipped };
}

/** Shell-quote an interpolated field for the F12 remediation command list. */
function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) return value;
  return "'" + value.replace(/'/g, `'\\''`) + "'";
}

/** Build the deterministic F12 plugin-remediation command list (shell-quoted). */
export function buildPluginRemediation(manifest: PorterManifest): string[] {
  if (!manifest.plugins) return [];
  const cmds: string[] = [];
  for (const m of manifest.plugins.marketplaces) {
    cmds.push(`claude plugin marketplace add ${shellQuote(m.source)}`);
  }
  for (const p of manifest.plugins.plugins) {
    const ref = `${p.name}@${p.marketplace}`;
    cmds.push(`claude plugin install ${shellQuote(ref)}`);
  }
  return cmds;
}

/**
 * The import's one call (`importArchive.ts` planImport): the premium refusal
 * on the manifest, and the memory section staged into `files` / `stagedItems`.
 * Returns the filtered manifest (the plan's), the notices, and the policy
 * refusals.
 */
export async function planTenant(
  entries: readonly TarEntry[],
  manifest: PorterManifest,
  files: PlannedFileItem[],
  stagedItems: StagedFileItem[],
  dest: { claudeDir: string; stagingDir: string; homeDir: string }
): Promise<{
  manifest: PorterManifest;
  notices: Omission[];
  skipped: Omission[];
}> {
  const premium = stripPremiumPlugins(manifest);
  const memory = await planMemory(
    entries,
    premium.manifest,
    dest.claudeDir,
    dest.stagingDir,
    dest.homeDir
  );
  files.push(...memory.files);
  stagedItems.push(...memory.staged);
  return {
    manifest: premium.manifest,
    notices: memory.notices,
    skipped: [...premium.skipped, ...memory.skipped],
  };
}

/** The omission surface of one memory entry. */
export function memorySurface(projectKey: string): string {
  return `${MEMORY_ARCHIVE_DIR} ${projectKey}`;
}

/** A project key that names one folder: no separator, NUL, `.` or `..`. */
function validProjectKey(key: string): boolean {
  return (
    key !== "" &&
    key !== "." &&
    key !== ".." &&
    !key.includes("/") &&
    !key.includes("\\") &&
    !key.includes("\0")
  );
}

/** True when `p` is a real folder (never a link to one). */
async function isRealDir(p: string): Promise<boolean> {
  try {
    return (await lstat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Plan and stage the manifest's `memory` section. Returns the staged file
 * items, the notices (a project not present here), and the policy refusals (a
 * member outside its entry's folder, a credential-bearing name, an invalid
 * entry). A link member, or a `..` member that leaves the config root, still
 * refuses the whole archive through `assertSafeEntry`, as a section member
 * does.
 */
export async function planMemory(
  entries: readonly TarEntry[],
  manifest: PorterManifest,
  claudeDir: string,
  stagingDir: string,
  homeDir: string
): Promise<{
  files: PlannedFileItem[];
  staged: StagedFileItem[];
  notices: Omission[];
  skipped: Omission[];
}> {
  const files: PlannedFileItem[] = [];
  const staged: StagedFileItem[] = [];
  const notices: Omission[] = [];
  const skipped: Omission[] = [];
  const section = manifest.memory;
  if (!section) return { files, staged, notices, skipped };
  const destHomeKey = projectKeyForPath(resolve(homeDir));
  const seen = new Set<string>();
  for (const entry of section.entries) {
    const srcKey = entry.projectKey;
    if (seen.has(srcKey)) continue;
    seen.add(srcKey);
    const prefix = `${MEMORY_ARCHIVE_DIR}/${srcKey}`;
    // `entry.path` comes from the imported archive, so the trim must stay
    // linear — the `/\/+$/` form is quadratic on a long run of slashes.
    if (
      !validProjectKey(srcKey) ||
      trimTrailingChars(entry.path, "/") !== prefix
    ) {
      skipped.push({
        surface: memorySurface(srcKey),
        reason: `not imported: this is not a valid memory entry (it must be ${MEMORY_ARCHIVE_DIR}/<project key>)`,
      });
      continue;
    }
    const destKey = remapProjectKey(srcKey, section.sourceHomeKey, destHomeKey);
    const projectsDir = join(claudeDir, "projects");
    const projectDir = join(projectsDir, destKey);
    if (!(await isRealDir(projectsDir)) || !(await isRealDir(projectDir))) {
      notices.push({
        surface: memorySurface(srcKey),
        reason:
          destKey === srcKey
            ? MEMORY_PROJECT_ABSENT_REASON
            : `${MEMORY_PROJECT_ABSENT_REASON} (looked for projects/${destKey})`,
      });
      continue;
    }
    const entryRoot = join(claudeDir, MEMORY_ARCHIVE_DIR, srcKey);
    let refusal: string | null = null;
    for (const member of entries) {
      const path = member.path.replace(/^(\.\/)+/, "");
      if (path !== prefix && !path.startsWith(prefix + "/")) continue;
      // 🔴 Containment + link rejection on the RAW member path, as a section's.
      const asserted = assertSafeEntry(claudeDir, {
        path: member.path,
        kind: member.kind,
      });
      if (member.kind !== "file") continue;
      const rel = relative(entryRoot, asserted);
      if (rel === "" || isAbsolute(rel) || rel.split(sep)[0] === "..") {
        refusal ??= `not imported: a memory member may only write inside its own project's memory folder (${member.path})`;
        continue;
      }
      const part = credentialPathPart(rel);
      if (part !== null) {
        refusal ??= `not imported: ${member.path} has a credential-bearing path part (${part}); such files are never imported`;
        continue;
      }
      const destPath = join(projectDir, "memory", rel);
      const destRel = relative(claudeDir, destPath);
      const stagedPath = join(stagingDir, "tree", destRel);
      await mkdir(join(stagedPath, ".."), { recursive: true });
      await writeFile(stagedPath, member.data);
      files.push({
        kind: "memory",
        name: destKey,
        destPath,
        stagedPath,
        incomingHash: hashContent(member.data),
        mode: member.mode,
      });
      staged.push({ destPath, content: member.data });
    }
    if (refusal !== null)
      skipped.push({ surface: memorySurface(srcKey), reason: refusal });
  }
  return { files, staged, notices, skipped };
}
