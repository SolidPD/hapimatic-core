// SPDX-License-Identifier: AGPL-3.0-only
import {
  PORTER_SOURCE_IDS,
  PORTER_SOURCE_LABELS,
  type PorterSourceId,
} from "@hapi/protocol/porter";
import type { ImportGroups, ImportPlanSummary } from "@/types/porter";

/**
 * The per-source review cards above the import's selection tree (#3448 Sub C,
 * R3), split out of `PorterImportPanel.tsx` for #5169 so the panel stays under
 * its size cap. Each card is a whole-source toggle over that source's keys in
 * `groups.bySource`, which the server computes (`commitSelection.ts`).
 */

/** Tri-state of a skill's parent checkbox, derived from its leaves' exclusion. */
export function skillCheckState(
  leaves: readonly string[],
  excluded: ReadonlySet<string>
): { checked: boolean; indeterminate: boolean } {
  if (leaves.length === 0) return { checked: true, indeterminate: false };
  const ex = leaves.filter(k => excluded.has(k)).length;
  return { checked: ex === 0, indeterminate: ex > 0 && ex < leaves.length };
}

/**
 * #3448 (Sub C, R3): a one-line summary of what a source contributes. #5169:
 * every dimension is counted by membership in the source's own keys, so a
 * Codex skill counts on the Codex card and not on the Claude Code one (and a
 * Codex instructions rule reads as an instructions file). The MCP count comes
 * from the manifest `sources[]` metadata when present (which distinguishes
 * found-but-empty), else from the source's grouped keys (a legacy archive
 * without `sources` counts every MCP server as Claude Code's). #5614: output
 * styles and CLAUDE.md with its includes ("instructions file", the #5169 Codex
 * wording) are counted too, so a card holding only them is not "no importable
 * items".
 */
export function sourceSummary(
  id: PorterSourceId,
  groups: ImportGroups,
  sources: ImportPlanSummary["sources"]
): string {
  const rec = sources?.find(s => s.id === id);
  const keys = new Set(groups.bySource[id].keys);
  const plural = (n: number, w: string): string =>
    `${n} ${w}${n === 1 ? "" : "s"}`;
  const mine = (list: readonly string[]): number =>
    list.filter(k => keys.has(k)).length;
  const mcpFallback =
    id === "claude-code" && !sources
      ? groups.mcpServers.length
      : mine(groups.mcpServers);
  const mcpCount = rec?.counts.mcpServers ?? mcpFallback;
  const hookCount =
    groups.independentHooks.filter(h => keys.has(h.id)).length +
    groups.skills.reduce((n, s) => n + mine(s.servingHooks), 0);
  const parts = (
    [
      [
        groups.skills.filter(s => s.files.some(f => keys.has(f))).length,
        "skill",
      ],
      [hookCount, "hook"],
      [mine(groups.commands), "command"],
      [mine(groups.agents), "agent"],
      [mine(groups.rules), id === "codex" ? "instructions file" : "rule"],
      [mine(groups.outputStyles), "output style"],
      [mine(groups.claudeMd), "instructions file"],
      [mine(groups.memory ?? []), "memory file"],
      [mcpCount, "MCP server"],
    ] as [number, string][]
  )
    .filter(([n]) => n > 0)
    .map(([n, w]) => plural(n, w));
  if (parts.length > 0) return parts.join(" · ");
  // Cursor / Claude Desktop are MCP-only: "0 MCP servers", as before.
  return id === "claude-code" || id === "codex"
    ? "no importable items"
    : plural(0, "MCP server");
}

/**
 * #3448 (Sub C, R3): the per-source review cards, above the selection tree.
 * One card per {@link PORTER_SOURCE_IDS}: a found source is checked while ANY of
 * its keys are selected and its checkbox cascades over that source's keys (via
 * `onToggleSource`, the same all-or-nothing toggle skills use); a not-found
 * source is disabled with a "Not found" caption. The cascade drives the ONE
 * existing `excluded` set — no parallel selection state (D3(a)).
 */
export function SourceCards({
  groups,
  sources,
  excluded,
  onToggleSource,
}: {
  groups: ImportGroups;
  sources: ImportPlanSummary["sources"];
  excluded: Set<string>;
  onToggleSource: (keys: string[]) => void;
}) {
  return (
    <section data-testid="source-cards" className="flex flex-col gap-2">
      <h3 className="text-[length:var(--text-caption)] font-semibold uppercase tracking-wide text-[var(--app-hint)]">
        Choose what to bring over
      </h3>
      {PORTER_SOURCE_IDS.map(id => {
        const { found, keys } = groups.bySource[id];
        const st = skillCheckState(keys, excluded);
        return (
          <label
            key={id}
            data-testid={`source-card-${id}`}
            className={`flex items-start gap-3 rounded-lg border p-3 ${
              found
                ? "cursor-pointer border-[var(--app-border)]"
                : "cursor-not-allowed border-[var(--app-border)] opacity-60"
            } ${
              found && st.checked
                ? "border-l-2 border-l-[var(--app-success)]"
                : ""
            }`}
          >
            <input
              type="checkbox"
              checked={found && st.checked}
              disabled={!found}
              ref={el => {
                if (el) el.indeterminate = found && st.indeterminate;
              }}
              onChange={() => onToggleSource(keys)}
              data-testid={`source-toggle-${id}`}
              className="mt-0.5 h-4 w-4 flex-shrink-0 accent-[var(--app-link)]"
            />
            <div className="min-w-0 flex-1">
              <div className="text-[length:var(--text-body)] font-medium text-[var(--app-fg)]">
                {PORTER_SOURCE_LABELS[id]}
              </div>
              <div className="text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
                {found ? sourceSummary(id, groups, sources) : "Not found"}
              </div>
            </div>
          </label>
        );
      })}
    </section>
  );
}
