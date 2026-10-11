// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Commit-time selection & exclusion computation for the porter import (#3247,
 * epic #2339). ONE shared pure module consumed by BOTH the plan-side projection
 * (`toPlanSummary` in `importPlanSummary.ts`, via {@link computeGroups}) and the
 * commit-side write (`runCommit` in `importArchive.ts`, via
 * {@link resolveCommitExclusions}), so the hierarchical grouping the UI renders
 * and the exclusion the commit applies CANNOT drift — they are the same code.
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
import { basename, join } from "node:path";
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

/** One skill and its EXACT membership (files) + the hooks that serve it. */
export interface SkillGroup {
  /** The owning skill's dimension-entry name (`PlannedFileItem.name`). */
  skill: string;
  /** destPaths of this skill's file items (`kind === "skill"`, exact `name` match). */
  files: string[];
  /** hook-file destPaths of hooks whose command references `skills/<skill>/`. */
  servingHooks: string[];
}

/** A hook that serves no skill — its own top-level selection unit. */
export interface IndependentHook {
  /** The hook-file destPath — the exclusion key (registration + file travel as one). */
  id: string;
  command: string;
  events: string[];
}

/**
 * Hierarchical grouping of ALL plan dimensions for the pre-import selection UI
 * (#3247 R1/D3a). Every value is the item's EXCLUSION KEY: file destPaths for
 * file dimensions, hook-file destPaths for hooks, server names for MCP. `hook-lib`
 * support files carry NO group of their own — they follow the hooks (written iff
 * any hook survives). #4173: `settings-script` files carry no group either, and
 * are no exclusion key: a script's fate follows the setting that runs it (D4,
 * the commit's `held` set), and settings keys are not selectable (#3247).
 */
export interface ImportGroups {
  skills: SkillGroup[];
  independentHooks: IndependentHook[];
  mcpServers: string[];
  agents: string[];
  commands: string[];
  rules: string[];
  outputStyles: string[];
  /** `claude-md` + `claude-md-include` file destPaths. */
  claudeMd: string[];
  /**
   * #3448 (Sub C, R3/D3(a)): per-source grouping for the archive-received review
   * cards. Each source id maps to `found` (manifest `sources[]` metadata — TRUE
   * even for a found-but-empty source) and its EXCLUSION keys, so a card is an
   * honest whole-source toggle. claude-code owns every file + hook dimension
   * (they come only from `~/.claude`) plus its MCP names; Cursor / Claude Desktop
   * carry MCP server names only. A card cascades over its keys inside the ONE
   * existing `excluded` set — no parallel selection path.
   */
  bySource: Record<PorterSourceId, { found: boolean; keys: string[] }>;
}

/** The plan slice both the grouping and the exclusion resolver need. */
type PlanForSelection = Pick<
  ImportPlan,
  "files" | "hookEntries" | "mcpServers" | "claudeDir" | "manifest"
>;

/**
 * A hook's exclusion key = its hook-file item's destPath, so excluding the hook
 * drops BOTH the registration (via {@link CommitExclusions.selectedHookEntries})
 * AND the file (via {@link CommitExclusions.isItemExcluded} on the `hook-file`
 * item, which shares this destPath). Falls back to the canonical `hooks/<base>`
 * path if the archive omitted the file (registration-only edge case).
 */
function hookFileId(
  h: HookEntry,
  hookFileByName: ReadonlyMap<string, string>,
  claudeDir: string
): string {
  const base = basename(h.file.path);
  return hookFileByName.get(base) ?? join(claudeDir, "hooks", base);
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

/** Build a basename→destPath map of the plan's hook-file items. */
function hookFileMap(files: readonly PlannedFileItem[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of files) if (f.kind === "hook-file") m.set(f.name, f.destPath);
  return m;
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
export function computeGroups(plan: PlanForSelection): ImportGroups {
  const { files, hookEntries, mcpServers, claudeDir, manifest } = plan;
  const hookFileByName = hookFileMap(files);

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
    const id = hookFileId(h, hookFileByName, claudeDir);
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

  // #3448 (Sub C, R3): per-source grouping for the review cards. `found` is the
  // manifest `sources[]` metadata (TRUE even for a found-but-empty source; a
  // legacy archive with no `sources` collapses to claude-code found + others
  // not). The keys are that source's EXCLUSION keys, so a card is an honest
  // whole-source toggle. Every file + hook dimension comes ONLY from ~/.claude,
  // so they all belong to claude-code; Cursor / Claude Desktop bring MCP servers
  // only. A card's toggle cascades over these keys in the ONE `excluded` set.
  const sourcesMeta = manifest.sources ?? [];
  const mcpNamesFor = (id: PorterSourceId): string[] =>
    manifest.mcpServers
      .filter(s => (s.source ?? "claude-code") === id)
      .map(s => s.name);
  const claudeCodeKeys = [
    ...skills.flatMap(s => [...s.files, ...s.servingHooks]),
    ...independentHooks.map(h => h.id),
    ...agents,
    ...commands,
    ...rules,
    ...outputStyles,
    ...claudeMd,
    ...mcpNamesFor("claude-code"),
  ];
  const bySource = {} as Record<
    PorterSourceId,
    { found: boolean; keys: string[] }
  >;
  for (const id of PORTER_SOURCE_IDS) {
    const meta = sourcesMeta.find(s => s.id === id);
    bySource[id] = {
      found: meta ? meta.found : id === "claude-code",
      keys: id === "claude-code" ? claudeCodeKeys : mcpNamesFor(id),
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
 * valid exclusion key: the script follows its setting. The route still accepts
 * such a key as a silent no-op until #4237 refuses unknown keys.
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
  const hookFileByName = hookFileMap(plan.files);
  const selectedHookEntries = plan.hookEntries.filter(
    h => !expanded.has(hookFileId(h, hookFileByName, plan.claudeDir))
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
