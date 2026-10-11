// SPDX-License-Identifier: AGPL-3.0-only
import type { ImportPlanSummary } from "@/types/porter";
import { isModeRowExcluded } from "./ImportHooksReview";

/**
 * #4177: the Step-2 conflict list, moved out of PorterImportPanel.tsx (the
 * 1,500-line max-lines cap, #2077) and made selection-aware with the commit's
 * own rule, so Step 2 never offers an overwrite the commit will not write.
 */

export type ResolvableConflict = {
  /** The exact string the commit endpoint matches (destPath, or MCP server name). */
  key: string;
  label: string;
  category: "File" | "Setting" | "MCP server";
};

/**
 * #4177: whether Step 1 excludes the item behind a Step-2 conflict — the
 * commit's own rule (`server/src/porter/commitSelection.ts`, via
 * {@link isModeRowExcluded}): a `hook-lib` file follows the hooks as a group;
 * any other key (a file, a `settings.json#key`, an MCP name) its own. Builds
 * the `destPath → kind` map once, so a caller filters many keys cheaply.
 */
export function conflictExcludedBy(
  summary: Pick<ImportPlanSummary, "items" | "groups">,
  excluded: ReadonlySet<string>
): (key: string) => boolean {
  const kindOf = new Map(summary.items.map(i => [i.destPath, i.kind]));
  return key => {
    const kind = kindOf.get(key);
    return kind === undefined
      ? excluded.has(key)
      : isModeRowExcluded({ destPath: key, kind }, excluded, summary.groups);
  };
}

/**
 * Files/settings key overwrites match on destPath; MCP overwrites on server
 * name. Conflicts of Step-1-excluded items are dropped (an excluded item is
 * never overwrite-resolved), and so is an unresolvable MCP server's: the
 * commit drops that server whatever Step 1 says (commitSelection.ts, #2640).
 */
export function resolvableConflicts(
  summary: ImportPlanSummary,
  excluded: ReadonlySet<string>
): ResolvableConflict[] {
  const isExcluded = conflictExcludedBy(summary, excluded);
  return [
    ...summary.conflicts
      .filter(c => c.kind === "differs")
      .map(c => ({
        key: c.destPath,
        label: c.destPath,
        category: "File" as const,
      })),
    ...summary.settings.conflicts
      .filter(c => c.kind === "differs")
      .map(c => ({
        key: c.destPath,
        label: c.destPath,
        category: "Setting" as const,
      })),
    ...summary.mcpServers
      .filter(s => s.conflict?.kind === "differs" && s.resolvable !== false)
      .map(s => ({
        key: s.name,
        label: s.name,
        category: "MCP server" as const,
      })),
  ].filter(c => !isExcluded(c.key));
}
