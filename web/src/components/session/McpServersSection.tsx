// SPDX-License-Identifier: AGPL-3.0-only
/**
 * McpServersSection (issue #3290, S5) — the collapsible "MCP Servers" subsection
 * of the Session Configuration Modal (R5). The subheading IS the collapsible
 * header: "MCP Servers" + an inline tri-count (visible while collapsed) + a
 * far-right chevron. Expanded, it reveals the per-server enable toggles (the list
 * scrolls when long) and right-justified "Enable all / Disable all" tappable
 * text — BOTH hidden while collapsed, leaving only the header.
 *
 * The tri-count reuses the epic's shared `formatMcp` string helper
 * (`session/badgeFormat.ts`, #3287) and mirrors the #3289 MCP-chip count mapping
 * (`AssistantChat/SessionConfigCluster.tsx` — `a = connected + hosted` (green),
 * `b = needs-auth` (amber), `c = failed` (red)), so the modal's collapsed count is
 * byte-identical to the composer's chip.
 *
 * This is a CONTROLLED view over the modal's draft MCP set: it renders `desired`
 * and calls `onToggleServer` / `onSetAll`, owning no MCP state beyond its own
 * expand/collapse. The modal keeps the single source of MCP truth (the
 * `mcpDesired` diff baseline + the no-clobber async reconcile) — extracting this
 * view must not fork it.
 */
import { useState } from "react";
import { formatMcp } from "@/components/session/badgeFormat";
import type { UseMcpStatusReturn } from "@/hooks/useMcpStatus";
import { BareButton } from "@/components/ui/BareButton";
import { ChevronIcon } from "@/components/icons";

export type McpServersSectionProps = {
  /** Live per-project MCP status (server list + status counts). */
  mcp: UseMcpStatusReturn;
  /** Draft desired-enabled map (name → enabled), owned by the modal. */
  desired: Record<string, boolean>;
  /** Toggles disabled while the modal is busy / non-editable. */
  disabled?: boolean;
  /** Toggle a single server's desired-enabled state. */
  onToggleServer: (name: string, enabled: boolean) => void;
  /** Set every listed server's desired-enabled state (Enable all / Disable all). */
  onSetAll: (enabled: boolean) => void;
};

export function McpServersSection({
  mcp,
  desired,
  disabled,
  onToggleServer,
  onSetAll,
}: McpServersSectionProps) {
  const [expanded, setExpanded] = useState(false);

  // Tri-count a·b·c — mirrors #3289's MCP-chip mapping so the collapsed count
  // matches the composer chip: connected = connected + hosted, attention =
  // needs-auth, failed = failed.
  const connected = mcp.connectedCount + mcp.hostedCount;
  const attention = mcp.needsAuthCount;
  const failed = mcp.failedCount;
  const countLabel = formatMcp(connected, attention, failed);

  const hasServers = mcp.servers.length > 0;

  return (
    <div className="flex flex-col gap-1">
      {/* The subheading IS the collapsible header (R5): title + inline tri-count
          (visible collapsed) + a far-right chevron. E9 `.mcpsub`: a divider
          above, the title in body weight/color (semibold, fg), the tri-count
          muted + tabular. */}
      <BareButton
        type="button"
        onClick={() => setExpanded(e => !e)}
        aria-expanded={expanded}
        className="flex items-center gap-2 border-t border-[var(--app-divider)] pb-1 pt-3 text-sm font-semibold text-[var(--app-fg)] hover:text-[var(--app-fg)]"
      >
        <span>MCP Servers</span>
        <span className="text-xs font-semibold tabular-nums text-[var(--app-hint)]">
          {countLabel}
        </span>
        <ChevronIcon
          className="ml-auto h-3.5 w-3.5 text-[var(--app-hint)]"
          collapsed={!expanded}
        />
      </BareButton>

      {expanded &&
        (mcp.isLoading ? (
          <span className="text-xs text-[var(--app-hint)]">Loading…</span>
        ) : !hasServers ? (
          <span className="text-xs text-[var(--app-hint)]">
            No MCP servers configured for this project.
          </span>
        ) : (
          <>
            {/* Enable all / Disable all — right-justified, shown ONLY when
                expanded. */}
            <div className="flex items-center justify-end gap-3">
              <BareButton
                type="button"
                disabled={disabled}
                onClick={() => onSetAll(true)}
                className="text-xs font-normal text-[var(--app-link)] hover:underline disabled:opacity-50"
              >
                Enable all
              </BareButton>
              <BareButton
                type="button"
                disabled={disabled}
                onClick={() => onSetAll(false)}
                className="text-xs font-normal text-[var(--app-link)] hover:underline disabled:opacity-50"
              >
                Disable all
              </BareButton>
            </div>
            {/* Per-server toggles — the list scrolls when long. */}
            <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
              {mcp.servers.map(s => (
                <label
                  key={s.name}
                  className="flex items-center gap-2 text-xs text-[var(--app-fg)]"
                >
                  <input
                    type="checkbox"
                    checked={desired[s.name] ?? false}
                    disabled={disabled}
                    onChange={e => onToggleServer(s.name, e.target.checked)}
                  />
                  <span className="truncate">{s.name}</span>
                  <span className="ml-auto text-[length:var(--text-caption-xs)] uppercase text-[var(--app-hint)]">
                    {s.status}
                  </span>
                </label>
              ))}
            </div>
          </>
        ))}
    </div>
  );
}
