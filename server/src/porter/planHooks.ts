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
 * The registered hook FILES land here, each at its archive path under `hooks/`
 * (folders kept, #4331); every other hooks-tree file rides the manifest
 * `hookSupport` dimension, also path-preserved (planned by `planDimension` in
 * `./planSections`).
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  credentialPathPart,
  denormalizeHookCommand,
  collectUnknownHookEvents,
  type PorterManifest,
  type HookEntry,
  type Omission,
} from "@hapi/protocol/porter";
import {
  assertSafeEntry,
  lintHookCommandContainment,
} from "./archiveContainment";
import { hashContent, type StagedFileItem } from "./conflictDetection";
import {
  parseRegistryNames,
  hookNameOf,
  referencedPaths,
} from "./hookRegistrationValidator";
import { ManifestValidationError } from "./importArchiveErrors";
import {
  classifyPlannedDestination,
  CredentialNameError,
  PlannedDestinationError,
  stripEntrySpelling,
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
 * #5188 (S1): the tar member a `hooks[]` file path names. The exact path
 * wins, as before; otherwise the first FILE member whose path matches once
 * a leading `./` and a trailing `/` are stripped from both
 * (./plannedDestinations `stripEntrySpelling`), the spelling a hand-built
 * `./hooks/h.py` member has. {@link planHookFiles} checks containment on
 * the member it stages as well as on the manifest path.
 */
export function findHookMember(
  entries: TarEntry[],
  path: string
): TarEntry | undefined {
  const exact = findEntry(entries, path);
  if (exact) return exact;
  const want = stripEntrySpelling(path);
  return entries.find(
    e => e.kind === "file" && stripEntrySpelling(e.path) === want
  );
}

/**
 * Where a registered hook's script lands: `<claudeDir>/<archive path>`, the
 * path-preserved destination (#4331). The ONE definition planning, selection
 * (./commitSelection) and commit attribution (./commitHooks) key a hook on, so
 * two same-named hooks in different folders never share a key.
 *
 * A comparison key only: every write still goes through `assertSafeEntry`,
 * whose `resolve(resolve(root), path)` this matches, so a key equals the
 * planned hook-file item's `destPath`.
 */
export function hookFileDest(claudeDir: string, archivePath: string): string {
  return resolve(claudeDir, archivePath);
}

/**
 * The destinations the registered `hooks[]` entries stage, each mapped to the
 * archive path whose bytes it stages (#3590 K3, keyed on the destination by
 * #4331). The whole-tree exporter emits at most ONE manifest reference per
 * staged `hooks/**` file — registered scripts via `hooks[]`, every other file
 * via a `hookSupport` entry — so a conforming archive never lists a registered
 * path under `hookSupport`. This map lets the import belt SKIP any `hookSupport`
 * member that writes a destination a registration already stages, however that
 * member is spelled, so a hand-built or extraction-prompt archive that violates
 * the one-reference rule is corrected (planned once) instead of double-planned.
 *
 * Each destination maps to the archive path whose bytes it stages: the path of
 * the member {@link findHookMember} finds (#5188), which is what
 * `planDimension` compares members to. The owner is the first registration
 * whose member {@link findHookMember} finds is a regular file, the same one
 * {@link planHookFiles} stages; a registration with no such member claims
 * nothing, so its destination is left to `hookSupport`.
 */
export function claimedHookPaths(
  entries: TarEntry[],
  hooks: PorterManifest["hooks"],
  claudeDir: string
): ReadonlyMap<string, string> {
  const claimed = new Map<string, string>();
  for (const h of hooks) {
    const member = findHookMember(entries, h.file.path);
    if (member?.kind !== "file") continue;
    const dest = hookFileDest(claudeDir, h.file.path);
    // #5188 (S1): the member's own path, which planDimension compares members to.
    if (!claimed.has(dest)) claimed.set(dest, member.path);
  }
  return claimed;
}

/**
 * Plan + stage the registered hook FILES. Each registration's script is staged
 * at its archive path, which must lie under `hooks/` (folders kept, #4331), so
 * a merged registration names a file that lands; registrations are merged into
 * `settings.json` separately. Mirrors the `dims` staging loop shape: returns the
 * planned items + their staged-content records for the caller to concat, doing
 * its own staging I/O so the import core stays a thin call site.
 *
 * #4160 (F3): a hook whose resolved destination is not a file under `hooks/`
 * (`file.path` "." → `hooks` itself; since #4331 also any path outside
 * `hooks/`, such as `skills/fmt/check.py`, which was once flattened onto a real
 * `hooks/check.py`) refuses the archive with a typed `PlannedDestinationError`
 * BEFORE staging. A `..` part is refused by containment first, as the base
 * `PathEscapeError`.
 *
 * #4172: a hook whose destination has a credential-named part (`hooks/.npmrc`,
 * `hooks/.ssh/x.py`) likewise refuses with a typed `CredentialNameError` BEFORE
 * staging, so a secret from an archive is never written to disk here.
 *
 * #4331: two registrations whose archive paths resolve to ONE destination
 * (`hooks/a/run.py`, `hooks/./a/run.py`) with different bytes refuse the
 * archive with a `ManifestValidationError`, so a merged registration never runs
 * a script other than the one it names and no script is silently dropped.
 *
 * #5188 (S1): a `file.path` with no exactly spelled member stages the member
 * {@link findHookMember} finds (`./hooks/h.py` for `hooks/h.py`), and that
 * member passes containment too, so an absolute `/hooks/h.py` found for
 * `.//hooks/h.py` refuses the archive.
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
  // #4331: keyed on the resolved destination, with the bytes it was staged from.
  const seen = new Map<string, { archivePath: string; hash: string }>();
  for (const hook of hooks) {
    // 🔴 #4331: the archive path IS the destination (folders kept), so
    // containment checks the manifest path as written: `..`, absolute and NUL
    // refuse here. The member staged below gets its own check (#5188).
    const destPath = assertSafeEntry(claudeDir, {
      path: hook.file.path,
      kind: "file",
    });
    const entry = findHookMember(entries, hook.file.path);
    if (!entry || entry.kind !== "file") continue;
    // 🔴 #5188 (S1): the member whose bytes are staged passes containment too,
    // so a `/hooks/h.py` member found for `.//hooks/h.py` refuses the archive
    // (an invalid `hookSupport` entry leaves a claimed member's containment to
    // this loop, and no valid entry reaches an absolute member).
    if (entry.path !== hook.file.path)
      assertSafeEntry(claudeDir, { path: entry.path, kind: entry.kind });
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
    const hash = hashContent(entry.data);
    const first = seen.get(destPath);
    if (first) {
      if (first.archivePath === hook.file.path || first.hash === hash) continue;
      // 🔴 #4331: never keep the first script silently (zero bytes written:
      // planImport removes the staging dir on any throw).
      throw new ManifestValidationError(
        "invalid",
        `hooks[] entries ${JSON.stringify(first.archivePath)} and ` +
          `${JSON.stringify(hook.file.path)} both import to ` +
          `${JSON.stringify(v.destRel)} with different content`
      );
    }
    seen.set(destPath, { archivePath: hook.file.path, hash });
    // Stage by the NORMALIZED destination (#4143 precedent in ./planSections).
    const stagedPath = join(stagingDir, "tree", v.destRel);
    await mkdir(dirname(stagedPath), { recursive: true });
    await writeFile(stagedPath, entry.data);
    const item: PlannedFileItem = {
      kind: "hook-file",
      name: basename(hook.file.path),
      destPath,
      stagedPath,
      incomingHash: hash,
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
 *
 * #4331 (PM scope addition, 2026-10-15): a registration whose hook file this
 * plan does not write — its tar member is missing or not a regular file, and no
 * other producer plans its destination — is HELD: it leaves `hookEntries`, so
 * it is neither merged nor offered for selection, and `hookHolds` carries one
 * omission naming the registration and its missing file. Merged, it would run
 * whatever the destination already holds at that path. The hold keys on what
 * the plan writes (`plannedDests`, every producer's destination), the shape of
 * #5178's settings hold. Honest exporters never emit such a registration.
 *
 * #4331 (R5): a merged registration whose command names scripts of which none
 * is planned by this import and none exists at the destination is reported
 * once per distinct command. It would land as a dangling command: for example
 * an exported script from outside `hooks/` (carried as `hooks/<name>` with its
 * command unchanged). The token rule is the post-commit validator's
 * `referencedPaths`, so plan time and commit time agree. Advisory, never a
 * refusal; it proves only that some named script exists, not that it holds the
 * imported bytes.
 */
export function buildHookEntries(
  hooks: PorterManifest["hooks"],
  destHome: string,
  claudeDir: string,
  plannedDests: ReadonlySet<string>
): {
  hookEntries: HookEntry[];
  hookHolds: Omission[];
  hookCommandWarnings: string[];
  unknownHookEvents: string[];
} {
  const hookHolds: Omission[] = [];
  const hookEntries: HookEntry[] = [];
  for (const h of hooks) {
    const entry: HookEntry = {
      file: h.file,
      registration: {
        ...h.registration,
        command: denormalizeHookCommand(h.registration.command, destHome),
      },
    };
    const dest = hookFileDest(claudeDir, h.file.path);
    if (plannedDests.has(dest)) {
      hookEntries.push(entry);
      continue;
    }
    const surface = heldHookSurface(entry);
    if (!hookHolds.some(o => o.surface === surface)) {
      hookHolds.push({
        surface,
        reason:
          `not merged: its hook file ${h.file.path} is not a file in this ` +
          `archive and this import writes nothing at ` +
          `${relative(claudeDir, dest)}, so it would run whatever the ` +
          `destination holds there`,
      });
    }
  }
  const hookCommandWarnings = hookEntries.flatMap(h =>
    lintHookCommandContainment(claudeDir, h.registration.command)
  );
  for (const cmd of new Set(hookEntries.map(h => h.registration.command))) {
    const paths = referencedPaths(cmd, claudeDir);
    const resolves = paths.some(
      p => plannedDests.has(resolve(p)) || existsSync(p)
    );
    if (paths.length > 0 && !resolves) {
      hookCommandWarnings.push(
        `hook command runs a script this import does not write and the destination lacks: ${cmd}`
      );
    }
  }
  const unknownHookEvents = collectUnknownHookEvents(hookEntries);
  return { hookEntries, hookHolds, hookCommandWarnings, unknownHookEvents };
}

/**
 * The omission surface of a held hook registration (#4331): its events and its
 * command, so two held registrations never share a key in the review's
 * surface-keyed "Deliberately omitted" list.
 */
export function heldHookSurface(h: HookEntry): string {
  return `hook registration ${h.registration.events.join(",")} runs ${h.registration.command}`;
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
  // #5188: a `./hooks/…` member counts too (spelling stripped for this test
  // only; it can only remove a false refusal).
  const archiveNames = new Set(
    entries
      .map(e => ({ kind: e.kind, path: stripEntrySpelling(e.path) }))
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
