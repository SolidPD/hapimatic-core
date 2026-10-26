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
 * #5172: and for each MCP server's command, args, and url as the commit writes
 * them (`mcpServers[].definition`); a secret slot is shown by name, never value.
 */
import {
  EXECUTABLE_SETTINGS_KEYS,
  type ImportPlanSummary,
  type Omission,
} from "@hapi/protocol/porter";
import type { ImportPlan } from "./importArchive";
import { computeGroups, type EmittedImportGroups } from "./commitSelection";
import { reviewMcpServers } from "./mcpReviewDefinition";

// #5601: the wire shape lives in @hapi/protocol/porter (importWire.ts);
// `importArchive.ts` re-exports it from here for public-API parity.
export type { ImportPlanSummary };

/**
 * #5601 (D4): what this server emits. The wire type keeps `policySkips`,
 * `notices` and `groups.memory` optional because an older server omitted them;
 * this server always sends them, and says so here so its own callers and tests
 * can rely on it.
 */
export type EmittedPlanSummary = ImportPlanSummary & {
  groups: EmittedImportGroups;
  policySkips: Omission[];
  notices: Omission[];
};

export function toPlanSummary(plan: ImportPlan): EmittedPlanSummary {
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
    mcpServers: reviewMcpServers(plan),
    plugins: {
      descriptorPresent: plan.pluginDescriptorPresent,
      remediation: plan.pluginRemediation,
    },
    // #5202 (U8): the complete list. Never derive either list from
    // `manifest.omissions`: the importer's own notices and refusals live only
    // on the plan.
    omissions: plan.omissions,
    policySkips: plan.policySkips,
    notices: plan.notices,
    expiresAt: plan.createdAt + plan.ttlMs,
  };
}
