// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Plan-side hook handling — split out of `importArchive.ts` (#3590, #2077
 * max-lines). Homes the registered-hook-FILE staging loop and the denormalised
 * registration build so the import core stays under the 1,500-line `max-lines`
 * guardrail as the whole-tree hooks fix (#3590) accretes plan-time logic — the
 * same decomposition that produced `importPlanSummary.ts` (#2565) and
 * `commitSelection.ts` (#3247).
 *
 * The whole-tree hooks change (#3590) archives every `~/.claude/hooks/**` file,
 * so registry-referenced AND dynamically-loaded hooks travel with the archive.
 * The registered hook FILES land here (basename-flattened into `hooks/`); every
 * other hooks-tree file rides the manifest `hookSupport` dimension path-preserved
 * (planned by `planDimension` in `./planSections`).
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  credentialPathPart,
  denormalizeHookCommand,
  collectUnknownHookEvents,
  type PorterManifest,
  type HookEntry,
} from "@hapi/protocol/porter";
import {
  assertSafeEntry,
  lintHookCommandContainment,
} from "./archiveContainment";
import { hashContent, type StagedFileItem } from "./conflictDetection";
import { parseRegistryNames, hookNameOf } from "./hookRegistrationValidator";
import {
  classifyPlannedDestination,
  CredentialNameError,
  PlannedDestinationError,
} from "./plannedDestinations";
import type { TarEntry } from "./tarArchive";
import type { PlannedFileItem } from "./importArchive";

/** Hook-script extensions a registry name may resolve to. */
const HOOK_SCRIPT_EXTS = [".py", ".sh", ".js", ".ts", ".mjs"] as const;

/** A hooks-tree tar member that is a hook script (by extension). */
function isHookScriptMember(path: string): boolean {
  if (!path.startsWith("hooks/")) return false;
  return HOOK_SCRIPT_EXTS.some(ext => path.endsWith(ext));
}

/** Decode a tar entry's bytes to UTF-8, or `null` when the entry is absent. */
function decodeEntry(entry: TarEntry | undefined): string | null {
  return entry ? Buffer.from(entry.data).toString("utf-8") : null;
}

/** Find a tar entry by exact path. */
export function findEntry(
  entries: TarEntry[],
  path: string
): TarEntry | undefined {
  return entries.find(e => e.path === path);
}

/**
 * The set of archive paths carried by the manifest's registered `hooks[]`
 * entries (#3590 K3). The whole-tree exporter emits at most ONE manifest
 * reference per staged `hooks/**` file — registered scripts via `hooks[]`, every
 * other file via a `hookSupport` entry — so a conforming archive never lists a
 * registered path under `hookSupport`. This claimed set lets the import belt SKIP
 * any `hookSupport` tar entry whose archive path is already claimed by a
 * registration, so a hand-built or extraction-prompt archive that violates the
 * one-reference rule is corrected (planned once) instead of double-planned.
 */
export function claimedHookPaths(
  hooks: PorterManifest["hooks"]
): ReadonlySet<string> {
  return new Set(hooks.map(h => h.file.path));
}

/**
 * Plan + stage the registered hook FILES. Each registration's resolved script
 * file is basename-flattened into `hooks/<basename>` (registrations are merged
 * into `settings.json` separately). Mirrors the `dims` staging loop shape:
 * returns the planned items + their staged-content records for the caller to
 * concat, doing its own staging I/O so the import core stays a thin call site.
 *
 * #4160 (F3): a hook whose resolved destination is not a file under `hooks/`
 * (`file.path` "." → `hooks` itself, ".." → the config root) refuses the
 * archive with a typed `PlannedDestinationError` BEFORE staging — never an
 * untyped `EISDIR` from writing onto a staging directory.
 *
 * #4172: a hook whose flattened destination is credential-named
 * (`hooks/.npmrc`) likewise refuses with a typed `CredentialNameError` BEFORE
 * staging, so a secret from an archive is never written to disk here.
 */
export async function planHookFiles(
  entries: TarEntry[],
  hooks: PorterManifest["hooks"],
  claudeDir: string,
  stagingDir: string
): Promise<{ files: PlannedFileItem[]; staged: StagedFileItem[] }> {
  const files: PlannedFileItem[] = [];
  const staged: StagedFileItem[] = [];
  // #3590: a hook registered for MULTIPLE events (the dispatcher-form host
  // registers hook-dispatcher.py for 6 events) yields several manifest.hooks
  // entries that resolve to the SAME destPath — stage that file ONCE, so
  // filesWritten carries no duplicate (R4). The registrations themselves are
  // all preserved separately by buildHookEntries → the settings.json merge.
  const seen = new Set<string>();
  for (const hook of hooks) {
    const destRel = join("hooks", basename(hook.file.path));
    const destPath = assertSafeEntry(claudeDir, {
      path: destRel,
      kind: "file",
    });
    if (seen.has(destPath)) continue;
    const entry = findEntry(entries, hook.file.path);
    if (!entry || entry.kind !== "file") continue;
    // 🔴 #4160 (F3): typed refusal before any staging write (./plannedDestinations).
    const v = classifyPlannedDestination(claudeDir, "hook-file", destPath);
    if (!v.ok)
      throw new PlannedDestinationError(claudeDir, v.destRel, "hook-file");
    // 🔴 #4172: a credential-named hook file is refused before anything is
    // staged, so its bytes never reach disk; assertPlannedDestinations stays
    // the backstop over every producer.
    const part = credentialPathPart(v.destRel);
    if (part !== null)
      throw new CredentialNameError(claudeDir, v.destRel, part);
    seen.add(destPath);
    const stagedPath = join(stagingDir, "tree", destRel);
    await mkdir(dirname(stagedPath), { recursive: true });
    await writeFile(stagedPath, entry.data);
    const item: PlannedFileItem = {
      kind: "hook-file",
      name: basename(hook.file.path),
      destPath,
      stagedPath,
      incomingHash: hashContent(entry.data),
      mode: entry.mode,
    };
    files.push(item);
    staged.push({ destPath, content: entry.data });
  }
  return { files, staged };
}

/**
 * Build the denormalised hook registrations to merge into `settings.json`, plus
 * the advisory command-containment lint and the unknown-event list. Each
 * incoming registration command is expanded to the destination home so a
 * `$HOME`-form command resolves on this host.
 */
export function buildHookEntries(
  hooks: PorterManifest["hooks"],
  destHome: string,
  claudeDir: string
): {
  hookEntries: HookEntry[];
  hookCommandWarnings: string[];
  unknownHookEvents: string[];
} {
  const hookEntries: HookEntry[] = hooks.map(h => ({
    file: h.file,
    registration: {
      ...h.registration,
      command: denormalizeHookCommand(h.registration.command, destHome),
    },
  }));
  const hookCommandWarnings = hookEntries.flatMap(h =>
    lintHookCommandContainment(claudeDir, h.registration.command)
  );
  const unknownHookEvents = collectUnknownHookEvents(hookEntries);
  return { hookEntries, hookCommandWarnings, unknownHookEvents };
}

/**
 * #3590 (K4/D9): the plan-time fail-loud belt. Parse the archive's two
 * dynamic-loader registries (`hooks/lib/detector_registry.py` +
 * `hooks/lib/hook_registry.py`) and return every registry-referenced hook NAME
 * that resolves to NO hook script — neither a `hooks/**` member in the ARCHIVE
 * nor a `hooks/<name>.<ext>` file already at the DESTINATION. This is the drift a
 * whole-tree export should never produce, but a hand-built or extraction-prompt
 * archive can — so the commit refuses (typed 4xx) unless each missing name is
 * acknowledged.
 *
 * Must-not-block cases (return an empty list — NEVER a false refusal): an archive
 * with no registry (a Cursor / Claude Desktop source, or a pre-#2639 archive);
 * a registry name whose file is in the archive; a registry name whose file is
 * already present at the destination.
 */
export function planRegistryMissing(
  entries: TarEntry[],
  claudeDir: string
): string[] {
  const registryNames = parseRegistryNames(
    decodeEntry(findEntry(entries, "hooks/lib/detector_registry.py")),
    decodeEntry(findEntry(entries, "hooks/lib/hook_registry.py"))
  );
  if (registryNames.length === 0) return [];
  // Hook names carried by the archive (basename-keyed, any hooks/ depth).
  const archiveNames = new Set(
    entries
      .filter(e => e.kind === "file" && isHookScriptMember(e.path))
      .map(e => hookNameOf(e.path))
  );
  const destHooksDir = join(claudeDir, "hooks");
  const destHasHookNamed = (name: string): boolean =>
    HOOK_SCRIPT_EXTS.some(ext =>
      existsSync(join(destHooksDir, `${name}${ext}`))
    );
  const missing = registryNames.filter(
    name => !archiveNames.has(name) && !destHasHookNamed(name)
  );
  return missing.sort();
}
