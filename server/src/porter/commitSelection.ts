// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Commit-time selection & exclusion computation for the porter import (#3247,
 * epic #2339). ONE shared pure module consumed by BOTH the plan-side projection
 * (`toPlanSummary` in `importPlanSummary.ts`, via {@link computeGroups}) and the
 * commit-side write (`runCommit` in `importArchive.ts`, via
 * {@link resolveCommitExclusions}), so the hierarchical grouping the UI renders
 * and the exclusion the commit applies CANNOT drift — they are the same code.
 * The commit route's up-front `excluded` check ({@link unknownExclusions},
 * #4237) reads the same groups, so it accepts every key the UI can send.
 *
 * Split into its own module (not grown into `importArchive.ts`) because that file
 * sits at 1488/1500 under a hard eslint `max-lines` error (`eslint.config.mjs:106`,
 * #2077) — the same decomposition that produced `importArchiveErrors.ts` (#2563)
 * and `importPlanSummary.ts` (#2565). The #2640/#2638 MCP quality-exclusion loop
 * is relocated here too (behaviour-identical) because #3247 ADDS user MCP
 * deselection to the SAME `excludedMcpNames` set that feeds `rebuildMcpItems`, so
 * co-locating the whole exclusion computation is the natural design AND keeps
 * `importArchive.ts` under the cap.
 *
 * Monorepo boundary: `web/` cannot import this module (it may import only from
 * `@hapi/protocol`). The anti-drift guarantee across the client is therefore the
 * `ImportGroups` STRUCTURE — the server computes it once here and ships it in the
 * summary; the client renders + cascades from that same shipped data.
 */
import type { HookEntry } from "@hapi/protocol/porter";
// #3448 (Sub C): the source-id set for the per-source `bySource` grouping the
// review cards cascade over.
import { PORTER_SOURCE_IDS, type PorterSourceId } from "@hapi/protocol/porter";
import type {
  ImportPlan,
  McpExclusion,
  PlannedFileItem,
  PlannedItemKind,
} from "./importArchive";
import { hookFileDest } from "./planHooks";
import { relative, sep } from "node:path";
import { SECTION_FOLDER, normalizeEntryPath } from "./plannedDestinations";
import type {
  ImportGroups,
  IndependentHook,
  SkillGroup,
} from "@hapi/protocol/porter";
// #5601: the wire shapes live in @hapi/protocol/porter (importWire.ts).
export type {
  SkillGroup,
  IndependentHook,
  ImportGroups,
} from "@hapi/protocol/porter";

/**
 * #5601 (D4): what this server computes. The wire type keeps `memory` optional
 * because a server that predates #4373 omitted it; this one always sends it.
 */
export type EmittedImportGroups = ImportGroups & { memory: string[] };

/** The plan slice both the grouping and the exclusion resolver need. */
type PlanForSelection = Pick<
  ImportPlan,
  "files" | "hookEntries" | "mcpServers" | "claudeDir" | "manifest"
>;

/**
 * A hook's exclusion key = its hook-file item's destPath, so excluding the hook
 * drops BOTH the registration (via {@link CommitExclusions.selectedHookEntries})
 * AND the file (via {@link CommitExclusions.isItemExcluded} on the `hook-file`
 * item, which shares this destPath). #4331: the path-preserved destination
 * (./planHooks `hookFileDest`), never the basename, so two same-named hooks in
 * different folders are two selection units. The same key covers a
 * registration whose file the archive omitted.
 */
function hookFileId(h: HookEntry, claudeDir: string): string {
  return hookFileDest(claudeDir, h.file.path);
}

/**
 * The ONLY inference layer: a hook serves skill S iff its `registration.command`
 * references `skills/<S>/` (Pass-2 rule). Everything else — file→skill membership
 * — is exact (`kind === "skill"` items carry the owning skill in `name`). A hook
 * that matches no skill is independent (the common infra-hook case), a safe
 * failure (it becomes a separately selectable top-level checkbox, never data loss).
 */
function servingSkillOf(
  command: string,
  skillNames: readonly string[]
): string | null {
  for (const s of skillNames) {
    if (command.includes(`skills/${s}/`)) return s;
  }
  return null;
}

/**
 * #5169 (R9): the destPaths of every planned file a `source: "codex"` section
 * entry brought — a file at or under the entry's normalized path (the
 * planner's own spelling rule, `normalizeEntryPath`), so the Codex card holds
 * exactly the files those entries plan. An entry with an empty, `.` or `..`
 * part, which `planDimension` matches as written (#5188), is not on the card:
 * a planned file does not record which entry spelling matched it, and the
 * Codex exporter writes canonical entries.
 */
function codexFileKeys(
  files: readonly PlannedFileItem[],
  claudeDir: string,
  manifest: PlanForSelection["manifest"]
): Set<string> {
  const prefixes: string[] = [];
  for (const field of Object.keys(
    SECTION_FOLDER
  ) as (keyof typeof SECTION_FOLDER)[]) {
    for (const e of manifest[field] ?? []) {
      if (e.source !== "codex") continue;
      const n = normalizeEntryPath(e.path);
      if (n !== null) prefixes.push(n);
    }
  }
  const keys = new Set<string>();
  if (prefixes.length === 0) return keys;
  for (const f of files) {
    const rel = relative(claudeDir, f.destPath).split(sep).join("/");
    if (prefixes.some(p => rel === p || rel.startsWith(p + "/"))) {
      keys.add(f.destPath);
    }
  }
  return keys;
}

/** Append `value` to the array stored at `key`, creating it on first use. */
function pushInto(
  map: Map<string, string[]>,
  key: string,
  value: string
): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

/**
 * Group ALL plan dimensions for the selection UI (#3247 Task 1). Pure; the SAME
 * function feeds `toPlanSummary` and (transitively) `resolveCommitExclusions`.
 */
export function computeGroups(plan: PlanForSelection): EmittedImportGroups {
  const { files, hookEntries, mcpServers, claudeDir, manifest } = plan;

  // Skills: group skill-kind file items by owning skill name (EXACT membership).
  const skillFiles = new Map<string, string[]>();
  for (const f of files) {
    if (f.kind !== "skill") continue;
    pushInto(skillFiles, f.name, f.destPath);
  }
  const skillNames = [...skillFiles.keys()];

  // Hooks: serving-a-skill (command-reference rule) vs independent.
  const servingBySkill = new Map<string, string[]>();
  const independentHooks: IndependentHook[] = [];
  for (const h of hookEntries) {
    const id = hookFileId(h, claudeDir);
    const served = servingSkillOf(h.registration.command, skillNames);
    if (served) {
      pushInto(servingBySkill, served, id);
    } else {
      independentHooks.push({
        id,
        command: h.registration.command,
        events: h.registration.events,
      });
    }
  }

  const skills: SkillGroup[] = skillNames.map(skill => ({
    skill,
    files: skillFiles.get(skill) ?? [],
    servingHooks: servingBySkill.get(skill) ?? [],
  }));

  const byKind = (k: PlannedItemKind): string[] =>
    files.filter(f => f.kind === k).map(f => f.destPath);

  const agents = byKind("agent");
  const commands = byKind("command");
  const rules = byKind("rule");
  const outputStyles = byKind("output-style");
  const claudeMd = [...byKind("claude-md"), ...byKind("claude-md-include")];
  const memory = byKind("memory");

  // #3448 (Sub C, R3): per-source grouping for the review cards. `found` is the
  // manifest `sources[]` metadata (TRUE even for a found-but-empty source; a
  // legacy archive with no `sources` collapses to claude-code found + others
  // not). The keys are that source's EXCLUSION keys, so a card is an honest
  // whole-source toggle. Every file + hook dimension comes from ~/.claude and
  // belongs to claude-code, except what a Codex-tagged entry brought (#5169):
  // those files, and the hooks serving a skill made only of them, are Codex's.
  // Cursor / Claude Desktop bring MCP servers only. A card's toggle cascades
  // over these keys in the ONE `excluded` set.
  const sourcesMeta = manifest.sources ?? [];
  const mcpNamesFor = (id: PorterSourceId): string[] =>
    manifest.mcpServers
      .filter(s => (s.source ?? "claude-code") === id)
      .map(s => s.name);
  const codexFiles = codexFileKeys(files, claudeDir, manifest);
  const codexKeys = new Set<string>(codexFiles);
  for (const s of skills) {
    if (s.files.length > 0 && s.files.every(f => codexFiles.has(f))) {
      for (const h of s.servingHooks) codexKeys.add(h);
    }
  }
  const claudeCodeKeys = [
    ...skills.flatMap(s => [...s.files, ...s.servingHooks]),
    ...independentHooks.map(h => h.id),
    ...agents,
    ...commands,
    ...rules,
    ...outputStyles,
    ...claudeMd,
    ...memory,
  ].filter(k => !codexKeys.has(k));
  claudeCodeKeys.push(...mcpNamesFor("claude-code"));
  const bySource = {} as Record<
    PorterSourceId,
    { found: boolean; keys: string[] }
  >;
  for (const id of PORTER_SOURCE_IDS) {
    const meta = sourcesMeta.find(s => s.id === id);
    bySource[id] = {
      found: meta ? meta.found : id === "claude-code",
      keys:
        id === "claude-code"
          ? claudeCodeKeys
          : id === "codex"
            ? [...codexKeys, ...mcpNamesFor("codex")]
            : mcpNamesFor(id),
    };
  }

  return {
    skills,
    independentHooks,
    mcpServers: mcpServers.map(s => s.name),
    agents,
    commands,
    rules,
    outputStyles,
    claudeMd,
    memory,
    bySource,
  };
}

/** The exclusion decisions `runCommit` drives every downstream consumer from. */
export interface CommitExclusions {
  /**
   * True iff this planned file item must NOT be written — user-excluded (direct
   * or skill-cascade), or a `hook-lib` support file when ALL hooks are excluded.
   */
  isItemExcluded(item: PlannedFileItem): boolean;
  /**
   * Hook entries that SURVIVE the selection. Drives the settings merge, the
   * `hooks.imported` count, validator attribution, and the settings-backup
   * precondition — so a deselected hook is neither merged nor counted.
   */
  selectedHookEntries: HookEntry[];
  /**
   * MCP server names to exclude before `rebuildMcpItems`: user deselections PLUS
   * the #2640/#2638 quality exclusions (unresolvable / secret-unrestorable).
   */
  excludedMcpNames: ReadonlySet<string>;
  /**
   * #2640/#2638 quality-exclusion records ONLY — a user deselection is a CHOICE,
   * not a failure, and never emits a record (that list means dead-on-arrival).
   */
  mcpExclusions: McpExclusion[];
}

/**
 * Resolve which items/hooks/MCP servers a commit must exclude, given the raw
 * operator `excluded` key set (#3247 Task 2). Applies the skills-only cascade
 * (`skill:<name>` → that skill's files + servingHooks) using the SAME
 * {@link computeGroups} the plan summary shipped, then folds in the #2640/#2638
 * MCP quality exclusions. Default (empty set) = today's write-all behaviour.
 * #4173: `held` names the `settings-script` destPaths the commit holds back
 * (D4); a settings script ignores `excluded`, because its destPath is never a
 * valid exclusion key: the script follows its setting. The commit route refuses
 * such a key up front ({@link unknownExclusions}, #4237); only a library caller
 * can still pass one, and it is ignored here.
 */
export function resolveCommitExclusions(
  plan: PlanForSelection,
  excluded: ReadonlySet<string>,
  held: ReadonlySet<string> = new Set()
): CommitExclusions {
  const groups = computeGroups(plan);

  // Cascade: a `skill:<name>` group key expands to that skill's files + hooks.
  // Idempotent — the client already expands a skill uncheck to its leaf keys, so
  // this only matters when a caller (e.g. a server test) passes a bare skill key.
  const expanded = new Set<string>(excluded);
  for (const s of groups.skills) {
    if (!expanded.has(`skill:${s.skill}`)) continue;
    for (const f of s.files) expanded.add(f);
    for (const h of s.servingHooks) expanded.add(h);
  }

  // Surviving hooks: keyed by hook-file destPath (registration + file as a unit).
  const selectedHookEntries = plan.hookEntries.filter(
    h => !expanded.has(hookFileId(h, plan.claudeDir))
  );
  const allHooksExcluded =
    plan.hookEntries.length > 0 && selectedHookEntries.length === 0;

  // MCP: user deselection (no record) precedes the #2640/#2638 quality checks.
  const excludedMcpNames = new Set<string>();
  const mcpExclusions: McpExclusion[] = [];
  for (const s of plan.mcpServers) {
    if (expanded.has(s.name)) {
      excludedMcpNames.add(s.name);
      continue;
    }
    if (!s.resolvable) {
      excludedMcpNames.add(s.name);
      mcpExclusions.push({
        name: s.name,
        kind: s.nonPortable ? "path" : "runtime",
        detail: s.unresolvedReason ?? "command unresolvable on the destination",
      });
      continue;
    }
    if (!s.secretRestorable) {
      excludedMcpNames.add(s.name);
      mcpExclusions.push({
        name: s.name,
        kind: "secret",
        detail: s.secretFailureKey ?? "secret slot could not be restored",
      });
    }
  }

  const isItemExcluded = (item: PlannedFileItem): boolean => {
    if (item.kind === "settings-script") return held.has(item.destPath);
    return item.kind === "hook-lib"
      ? allHooksExcluded
      : expanded.has(item.destPath);
  };

  return {
    isItemExcluded,
    selectedHookEntries,
    excludedMcpNames,
    mcpExclusions,
  };
}

/**
 * #4237: the `excluded` keys a commit must refuse — every key that is not a
 * selectable item of this plan. `excluded` is an opt-OUT list, so an unmatched
 * key would write the item the caller meant to deselect (for a hook, its
 * registration is merged into settings.json and runs next session).
 *
 * The valid set (K-EXCL) comes from the SAME {@link computeGroups} the plan
 * summary ships, so every key the review can send is valid by construction:
 * every skill's files and serving hooks, every independent hook id, agents,
 * commands, rules, output styles, CLAUDE.md files, MCP server names, every
 * `bySource[*].keys`, and `skill:<name>`. Exact string match, no normalization:
 * a relative or `~`-prefixed path is unknown. `hook-lib` and `settings-script`
 * destPaths are in no group, so they are refused too — excluding either would
 * do nothing.
 *
 * Returns the unknown keys deduped, in input order; empty means all are valid.
 */
export function unknownExclusions(
  plan: PlanForSelection,
  excluded: readonly string[]
): string[] {
  const groups = computeGroups(plan);
  const valid = new Set<string>([
    ...groups.skills.flatMap(s => [
      ...s.files,
      ...s.servingHooks,
      `skill:${s.skill}`,
    ]),
    ...groups.independentHooks.map(h => h.id),
    ...groups.agents,
    ...groups.commands,
    ...groups.rules,
    ...groups.outputStyles,
    ...groups.claudeMd,
    ...groups.memory,
    ...groups.mcpServers,
    ...Object.values(groups.bySource).flatMap(s => s.keys),
  ]);
  return [...new Set(excluded)].filter(k => !valid.has(k));
}
