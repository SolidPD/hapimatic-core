// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Plan-side handling of the top-level script an executable setting runs
 * (issue #4173) — split out of `importArchive.ts` like `./planSections` and
 * `./planHooks` (#2077 max-lines).
 *
 * The archive's `settings-scripts/<name>` members are written ONLY at
 * `<config root>/<name>` and only when ALL of these hold: an IMPORTED
 * `statusLine.command` / `apiKeyHelper` value names `$HOME/.claude/<name>`
 * (and `<name>` passes the shared rule: top-level, a script extension, not
 * credential-bearing); the manifest lists the member; the member is a regular
 * file; and the config root is `<destination $HOME>/.claude`, the path the
 * value runs. Nothing is ever resolved from a `settingsScripts[]` path itself.
 * The combined-list backstop (`./plannedDestinations`) recomputes the
 * referenced set from the plan's settings, independently of this planner.
 *
 * D4: a carried script is written only when at least one setting that runs it
 * lands; one whose every referencing key is a kept `differs` conflict is held
 * (not written, not mode-reconciled) and reported, so it can never become the
 * file a kept setting runs.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  SETTINGS_SCRIPTS_DIR,
  SETTINGS_SCRIPT_SKIP_REASONS,
  collectSettingsScriptRefs,
  settingsScriptGateHolds,
  type ExecutableSettingsKey,
  type Omission,
  type PorterManifest,
  type SettingsScriptNameVerdict,
} from "@hapi/protocol/porter";
import { assertSafeEntry } from "./archiveContainment";
import { includeKey } from "./claudeMdIncludes";
import {
  hashContent,
  type Conflict,
  type StagedFileItem,
} from "./conflictDetection";
import { findEntry } from "./planHooks";
import type { StagedPlan } from "./planSections";
import type { TarEntry } from "./tarArchive";
import type { PlannedFileItem, PlannedItemKind } from "./importArchive";

/** The archive-path prefix of a carried script. */
const PREFIX = `${SETTINGS_SCRIPTS_DIR}/`;

/** The review preview cap (D5): the first 16 KiB, text only. */
export const SETTINGS_SCRIPT_PREVIEW_BYTES = 16 * 1024;

/** Why the importer did not plan a `settingsScripts` entry. */
export const SETTINGS_SCRIPT_IMPORT_REASONS = {
  notUnderDir:
    "not imported: a settingsScripts entry must name a file directly under settings-scripts/",
  unreferenced:
    "not imported: no apiKeyHelper or statusLine command in this archive runs this file",
  notHomeConfigRoot:
    "not imported: the command runs this script from $HOME/.claude, which is not this import's config root",
  missing: "not imported: the archive has no such member",
  notRegularFile: "not imported: the archive member is not a regular file",
  duplicate: (destRel: string) =>
    `not imported: another script already writes ${destRel}`,
} as const;

/** The omission surface for a skipped `settingsScripts` entry (#4160's spelling). */
export function settingsScriptEntrySurface(path: string): string {
  return `settingsScripts entry ${path}`;
}

/** Is the config root the `.claude` folder in the destination's home? */
function rootIsHomeClaude(claudeDir: string, homeDir: string): boolean {
  return resolve(claudeDir) === resolve(homeDir, ".claude");
}

/** The `ok` references' names, whatever the config root. */
function okRels(settings: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  for (const r of collectSettingsScriptRefs(settings)) {
    if (r.verdict === "ok") out.add(r.rel);
  }
  return out;
}

/**
 * The top-level script names the imported executable values run, or an empty
 * set when the config root is not `<homeDir>/.claude` (the value runs
 * `$HOME/.claude/<name>`, so any other root is not the exact path it runs).
 */
export function referencedScriptRels(
  settings: Record<string, unknown>,
  claudeDir: string,
  homeDir: string
): Set<string> {
  return rootIsHomeClaude(claudeDir, homeDir) ? okRels(settings) : new Set();
}

/**
 * Plan each manifest `settingsScripts` entry (exact duplicates collapse). The
 * first failing check wins: not `settings-scripts/<name>`; not referenced (or
 * referenced from another root); no such member; then containment on the
 * DESTINATION name (a link member refuses the whole archive, as for every
 * producer); not a regular file; another script already claims the same
 * case/NFC-folded name. A planned script is owner-executable (R13).
 */
export function planSettingsScripts(
  entries: TarEntry[],
  manifest: Pick<PorterManifest, "settingsScripts">,
  settings: Record<string, unknown>,
  claudeDir: string,
  homeDir: string,
  stagingDir: string
): { plans: StagedPlan[]; skipped: Omission[] } {
  const plans: StagedPlan[] = [];
  const skipped: Omission[] = [];
  const referenced = referencedScriptRels(settings, claudeDir, homeDir);
  const named = okRels(settings);
  const claimed = new Set<string>();
  const skip = (path: string, reason: string): void => {
    skipped.push({ surface: settingsScriptEntrySurface(path), reason });
  };
  const r = SETTINGS_SCRIPT_IMPORT_REASONS;
  for (const path of new Set(manifest.settingsScripts.map(e => e.path))) {
    const name = path.startsWith(PREFIX) ? path.slice(PREFIX.length) : "";
    if (name.length === 0) {
      skip(path, r.notUnderDir);
      continue;
    }
    if (!referenced.has(name)) {
      skip(path, named.has(name) ? r.notHomeConfigRoot : r.unreferenced);
      continue;
    }
    const member = findEntry(entries, path);
    if (!member) {
      skip(path, r.missing);
      continue;
    }
    const destPath = assertSafeEntry(claudeDir, {
      path: name,
      kind: member.kind,
    });
    if (member.kind !== "file") {
      skip(path, r.notRegularFile);
      continue;
    }
    const key = includeKey(name);
    if (claimed.has(key)) {
      skip(path, r.duplicate(name));
      continue;
    }
    claimed.add(key);
    plans.push({
      item: {
        kind: "settings-script",
        name,
        destPath,
        stagedPath: join(stagingDir, "tree", name),
        incomingHash: hashContent(member.data),
        mode: (member.mode ?? 0o644) | 0o100,
      },
      content: member.data,
    });
  }
  return { plans, skipped };
}

/**
 * Stage each planned script and add it to the plan's file list, exactly as the
 * CLAUDE.md producer does.
 */
export async function stageSettingsScripts(
  plans: readonly StagedPlan[],
  files: PlannedFileItem[],
  stagedItems: StagedFileItem[]
): Promise<void> {
  for (const { item, content } of plans) {
    await mkdir(dirname(item.stagedPath), { recursive: true });
    await writeFile(item.stagedPath, content);
    files.push(item);
    stagedItems.push({ destPath: item.destPath, content });
  }
}

/**
 * The settings keys a plan-time `differs` conflict holds back unless
 * overwritten. A conflict's destPath is `<file>#<key>`, so the key follows the
 * LAST `#`: the config root itself may hold one.
 */
export function differingSettingsKeys(
  settingsConflicts: readonly Conflict[]
): Set<string> {
  return new Set(
    settingsConflicts
      .filter(c => c.kind === "differs")
      .map(c => c.destPath.slice(c.destPath.lastIndexOf("#") + 1))
  );
}

/**
 * Does a settings key land in the merge? Not when it already exists, its value
 * differs (`conflictKeys`) and the operator did not choose to overwrite it.
 * `mergeSettings` applies this per key. The D4 hold reads the same plan-time
 * `conflictKeys` (`differingSettingsKeys`) but not the commit-time
 * `keyExists`, so a kept key deleted between plan and commit lands while its
 * script stays held (the plan/commit window the doc's Known limits name).
 */
export function settingsKeyLands(
  key: string,
  opts: {
    conflictKeys: ReadonlySet<string>;
    overwrite: ReadonlySet<string>;
    settingsPath: string;
    keyExists?: boolean;
  }
): boolean {
  const { conflictKeys, overwrite, settingsPath, keyExists = true } = opts;
  return !(
    keyExists &&
    conflictKeys.has(key) &&
    !overwrite.has(`${settingsPath}#${key}`)
  );
}

/** A content preview for the review (D5): inert text, never executed. */
export interface ScriptPreview {
  text: string;
  truncated: boolean;
  binary: boolean;
  size: number;
}

/**
 * One review row per config-root reference an imported executable value makes
 * (R11). `carried`: a planned item of any kind writes `destPath` (a `hook-lib`
 * for a `hooks/` reference included); `on-destination`: nothing writes it but
 * the file exists; `missing`: neither; `not-carried`: the reference cannot be
 * carried (`reason`). `gatedBy` is set for a `settings-script` item: empty when
 * a referencing key lands as it stands, else every `<settings.json>#<key>`
 * whose overwrite would let it land (D4). Values are surfaced deliberately,
 * like the executable values themselves (#2600), and never logged.
 */
export interface ExecutableScriptReview {
  key: ExecutableSettingsKey;
  reference: string;
  verdict: SettingsScriptNameVerdict;
  status: "carried" | "on-destination" | "missing" | "not-carried";
  reason?: string;
  destPath?: string;
  kind?: PlannedItemKind;
  sha256?: string;
  conflict?: Conflict["kind"];
  gatedBy?: string[];
  preview?: ScriptPreview;
}

function previewOf(content: Buffer): ScriptPreview {
  const binary = content.includes(0);
  return {
    text: binary
      ? ""
      : content.subarray(0, SETTINGS_SCRIPT_PREVIEW_BYTES).toString("utf-8"),
    truncated: content.length > SETTINGS_SCRIPT_PREVIEW_BYTES,
    binary,
    size: content.length,
  };
}

export function buildExecutableScriptReview(input: {
  settings: Record<string, unknown>;
  claudeDir: string;
  homeDir: string;
  files: readonly PlannedFileItem[];
  stagedItems: readonly StagedFileItem[];
  fileConflicts: readonly Conflict[];
  settingsConflicts: readonly Conflict[];
}): ExecutableScriptReview[] {
  const { settings, claudeDir, homeDir } = input;
  const homeRoot = rootIsHomeClaude(claudeDir, homeDir);
  const refs = collectSettingsScriptRefs(settings);
  const fileAt = new Map(input.files.map(f => [f.destPath, f]));
  const contentAt = new Map(
    input.stagedItems.map(s => [s.destPath, s.content])
  );
  const conflictAt = new Map(input.fileConflicts.map(c => [c.destPath, c]));
  const kept = differingSettingsKeys(input.settingsConflicts);
  const settingsPath = join(claudeDir, "settings.json");
  const keysFor = new Map<string, ExecutableSettingsKey[]>();
  for (const r of refs) {
    if (r.verdict !== "ok") continue;
    const k = keysFor.get(r.rel) ?? [];
    if (!k.includes(r.key)) k.push(r.key);
    keysFor.set(r.rel, k);
  }
  const rows: ExecutableScriptReview[] = [];
  for (const r of refs) {
    if (r.verdict === "outside") continue;
    const row: ExecutableScriptReview = {
      key: r.key,
      reference: r.ref,
      verdict: r.verdict,
      status: "not-carried",
    };
    rows.push(row);
    if (r.verdict !== "ok" && r.verdict !== "section") {
      row.reason = SETTINGS_SCRIPT_SKIP_REASONS[r.verdict];
      continue;
    }
    if (!homeRoot) {
      row.reason = SETTINGS_SCRIPT_IMPORT_REASONS.notHomeConfigRoot;
      continue;
    }
    // Keyed as the planner keys its items (`assertSafeEntry` resolves), so a
    // relative config root still finds its planned script and its D4 gate.
    const destPath = resolve(claudeDir, r.rel);
    row.destPath = destPath;
    const item = fileAt.get(destPath);
    if (!item) {
      row.status = existsSync(destPath) ? "on-destination" : "missing";
      continue;
    }
    row.status = "carried";
    row.kind = item.kind;
    row.sha256 = item.incomingHash;
    const conflict = conflictAt.get(destPath);
    if (conflict) row.conflict = conflict.kind;
    const content = contentAt.get(destPath);
    if (content) row.preview = previewOf(content);
    if (item.kind === "settings-script") {
      const keys = keysFor.get(r.rel) ?? [];
      row.gatedBy = keys.some(k => !kept.has(k))
        ? []
        : keys.map(k => `${settingsPath}#${k}`);
    }
  }
  return rows;
}

/**
 * D4: the carried scripts the commit must hold back — every `settings-script`
 * row whose gating keys are all still kept (none chosen for overwrite). Maps
 * each destPath to the keys whose overwrite would release it.
 */
export function heldSettingsScripts(
  rows: readonly ExecutableScriptReview[],
  overwrite: ReadonlySet<string>
): Map<string, string[]> {
  const held = new Map<string, string[]>();
  for (const row of rows) {
    if (row.kind !== "settings-script" || !row.destPath) continue;
    if (settingsScriptGateHolds(row.gatedBy, overwrite)) {
      held.set(row.destPath, row.gatedBy ?? []);
    }
  }
  return held;
}
