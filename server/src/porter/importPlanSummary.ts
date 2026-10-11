// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Read-side projection: {@link ImportPlan} → the client-facing
 * {@link ImportPlanSummary}. Split out of `importArchive.ts` (#2565, F5) to keep
 * that module under the 1,500-line `max-lines` guardrail (#2077) as the porter
 * import surface accretes fixes — the same decomposition that moved the error
 * classes to `importArchiveErrors.ts` (#2563).
 *
 * The summary deliberately carries imported VALUES — hook command strings and
 * `env`/`permissions` values (#2600), plus the executable settings-key values
 * `apiKeyHelper`/`statusLine` (#2565) — for review scrutiny. That visibility IS
 * the control, so this projection is intentionally NOT value-free. It writes to
 * no log sink: the summary is API-returned to the authenticated operator only.
 * #4173: the same holds for each carried script's sha256 and content preview
 * (`settings.executableScripts`), the file an executable value runs.
 */
import {
  EXECUTABLE_SETTINGS_KEYS,
  type Omission,
  type PorterManifest,
} from "@hapi/protocol/porter";
import type {
  ImportPlan,
  PlannedItemKind,
  PlannedMcpServer,
} from "./importArchive";
import { computeGroups, type ImportGroups } from "./commitSelection";
import type { Conflict } from "./conflictDetection";
import type { ModeReconcilePreview } from "./modeReconcile";
import type { SettingsLinkState } from "./commitFs";
import type { ExecutableScriptReview } from "./planSettingsScripts";

/**
 * Client-facing plan summary. Ships resolved destination paths
 * (`claudeDir`/`hostConfigPath`) — consistent with `items[].destPath`, which
 * already carries absolute dest paths (#2620 / F6).
 *
 * #2600: imported VALUES (hook command strings, `env` values, `permissions`
 * values) are surfaced DELIBERATELY for review scrutiny — potentially including
 * secrets from a hostile archive. That visibility IS the control, so this
 * summary is intentionally NOT value-free. Moved here from `importArchive.ts`
 * (#3590, #2077 max-lines) to sit beside its {@link toPlanSummary} projection;
 * `importArchive.ts` re-exports it for public-API parity.
 */
export interface ImportPlanSummary {
  stagingHandle: string;
  /**
   * #2620 (F6): resolved destination paths this commit will write to, surfaced
   * so the operator sees the target BEFORE committing. A same-machine instance
   * resolves these to the host `~/.claude` (+ `~/.claude.json`) UNLESS
   * `CLAUDE_CONFIG_DIR`/`claudeDir` redirects the config root (both then follow
   * it, with `hostConfigPath` INSIDE the resolved root).
   */
  claudeDir: string;
  hostConfigPath: string;
  items: { kind: PlannedItemKind; name: string; destPath: string }[];
  /**
   * #3247: hierarchical grouping of items/hooks/MCP for the pre-import selection
   * UI. ADDITIVE beside flat `items`/`hooks`/`mcpServers`; computed by the SAME
   * `commitSelection.computeGroups` the commit cascades from (no plan/commit drift).
   */
  groups: ImportGroups;
  /** #3448 (Sub C): per-source discovery metadata for the review cards (absent on a legacy archive). */
  sources?: PorterManifest["sources"];
  conflicts: Conflict[];
  /**
   * #4129: the fixes the commit may apply (it applies no others) and the files
   * it expects to skip.
   */
  modeReconcile: ModeReconcilePreview;
  settings: {
    keys: string[];
    conflicts: Conflict[];
    skippedKeys: string[];
    /** #2600: env key→value pairs, surfaced for review (NODE_OPTIONS/ANTHROPIC_BASE_URL etc.). */
    envValues: { key: string; value: string }[];
    /** #2600: permissions key→value pairs, surfaced for review (e.g. defaultMode overrides). */
    permissionsValues: { key: string; value: unknown }[];
    /** #2565 (F5): full VALUES of executable settings keys (apiKeyHelper/statusLine) — the
     * subset Claude Code runs as shell commands — surfaced so a values-blind review cannot
     * miss an injected command. Non-executable keys remain name-only (in `keys`). */
    executableValues: { key: string; value: unknown }[];
    /** #4173 (R11): the files those values run — path, sha256, status and a preview. */
    executableScripts: ExecutableScriptReview[];
  };
  /**
   * #4146 (R4): present when the destination settings.json is a symlink and the
   * plan merges settings or hooks. `inside` = the merge writes through it (the
   * link is kept); any other state = the commit refuses (409) unless the request
   * acknowledges `target` (`acknowledgeSymlinkedSettings`), which replaces the link.
   * Both apply only if the commit's selection still merges settings keys or
   * hooks; with every hook deselected and no settings keys, nothing is merged.
   */
  settingsLink?: { target: string; state: SettingsLinkState };
  hooks: {
    count: number;
    unknownEvents: string[];
    commandWarnings: string[];
    /** #2600: per-entry hook command strings, surfaced verbatim for review scrutiny. */
    commands: { events: string[]; matcher?: string; command: string }[];
    /** #3590 (K4/D9): registry-referenced hook names absent from archive + dest. */
    registryMissing: string[];
  };
  mcpServers: PlannedMcpServer[];
  plugins: { descriptorPresent: boolean; remediation: string[] };
  omissions: Omission[];
  expiresAt: number;
}

export function toPlanSummary(plan: ImportPlan): ImportPlanSummary {
  return {
    stagingHandle: plan.stagingHandle,
    claudeDir: plan.claudeDir,
    hostConfigPath: plan.hostConfigPath,
    items: plan.files.map(f => ({
      kind: f.kind,
      name: f.name,
      destPath: f.destPath,
    })),
    // #3247: hierarchical grouping for the pre-import selection UI — the SAME
    // helper `runCommit` cascades from, so grouping and exclusion cannot drift.
    groups: computeGroups(plan),
    // #3448 (Sub C): forward the manifest's per-source discovery metadata so the
    // review renders one card per source (absent for a legacy no-`sources` archive).
    sources: plan.manifest.sources,
    conflicts: plan.fileConflicts,
    modeReconcile: plan.modeReconcile,
    settings: {
      keys: Object.keys(plan.settingsToMerge),
      conflicts: plan.settingsConflicts,
      skippedKeys: plan.skippedSettingsKeys,
      envValues: Object.entries(
        (plan.settingsToMerge.env ?? {}) as Record<string, string>
      ).map(([key, value]) => ({ key, value })),
      permissionsValues: Object.entries(
        (plan.settingsToMerge.permissions ?? {}) as Record<string, unknown>
      ).map(([key, value]) => ({ key, value })),
      // #2565 (F5): surface the VALUE of each executable settings key present in the
      // import (apiKeyHelper/statusLine) — not written to any log sink (R4).
      executableValues: EXECUTABLE_SETTINGS_KEYS.filter(
        k => k in plan.settingsToMerge
      ).map(k => ({
        key: k,
        value: (plan.settingsToMerge as Record<string, unknown>)[k],
      })),
      executableScripts: plan.executableScripts,
    },
    // #4146 (R4): project only target + state (the resolved path stays server-side).
    settingsLink: plan.settingsLink && {
      target: plan.settingsLink.target,
      state: plan.settingsLink.state,
    },
    hooks: {
      count: plan.hookEntries.length,
      unknownEvents: plan.unknownHookEvents,
      commandWarnings: plan.hookCommandWarnings,
      commands: plan.hookEntries.map(h => ({
        events: h.registration.events,
        matcher: h.registration.matcher,
        command: h.registration.command,
      })),
      // #3590 (K4/D9): the plan-time fail-loud registry list the review surfaces.
      registryMissing: plan.registryMissing,
    },
    mcpServers: plan.mcpServers,
    plugins: {
      descriptorPresent: plan.pluginDescriptorPresent,
      remediation: plan.pluginRemediation,
    },
    omissions: plan.omissions,
    expiresAt: plan.createdAt + plan.ttlMs,
  };
}
