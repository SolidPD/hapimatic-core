// SPDX-License-Identifier: AGPL-3.0-only
/**
 * McpServersSection (issue #3290, S5; reworked by #6171) — the collapsible "MCP
 * Servers" subsection, shared by the Session Configuration Modal and the New
 * Session form. The subheading IS the collapsible header: "MCP Servers" + an
 * inline tri-count (visible while collapsed) + the selected servers' memory total
 * when one is known + a far-right chevron. Expanded, it shows one compact row per
 * server and, right-justified, "Enable all / Disable all" beside an optional
 * footer (the form's project-default actions).
 *
 * A row is one line on a fixed pitch (brand-visual-language §10 R10-a/R10-b): a
 * `Checkbox`, the name (truncated first), the cost (`157 MB · 1.2k`, tabular) and
 * the status caption. Cost and status each carry a hover tooltip. Only the name
 * is shown, never the server's URL, which can hold a stdio command line or query
 * tokens. A server that is off for the project reads OFF FOR PROJECT; ticking one
 * adds a single line under the list, because turning it on is project-wide.
 *
 * The tri-count reuses the shared `formatMcp` helper (`session/badgeFormat.ts`,
 * #3287) with the #3289 chip mapping (`connected + hosted` · `needs auth` ·
 * `failed`), so the collapsed count matches the composer's chip.
 *
 * This is a CONTROLLED view over the caller's draft: it renders `desired` and
 * calls `onToggleServer` / `onSetAll`, owning nothing beyond its own
 * expand/collapse.
 */
import { useId, useState, type ReactNode } from "react";
import { HAPI_MCP_SERVER_NAME } from "@hapi/protocol";
import type { McpCatalogEntry } from "@hapi/protocol/schemas";
import { formatMcp } from "@/components/session/badgeFormat";
import { BareButton } from "@/components/ui/BareButton";
import { Checkbox } from "@/components/ui/Checkbox";
import { HoverTooltip } from "@/components/ui/tooltip";
import { ChevronIcon } from "@/components/icons";
import { formatTokens } from "@/lib/formatTokens";
import { formatRelativeTime } from "@/lib/sessionHelpers";

export type McpServersSectionProps = {
  /** The catalog rows to list (name, status, project state, costs). */
  servers: readonly McpCatalogEntry[];
  /** True while the first list is loading. */
  isLoading?: boolean;
  /** Draft desired-enabled map (name → enabled), owned by the caller. */
  desired: Record<string, boolean>;
  /** Toggles disabled while the caller is busy / non-editable. */
  disabled?: boolean;
  /** Toggle a single server's desired-enabled state. */
  onToggleServer: (name: string, enabled: boolean) => void;
  /** Set every listed server's desired-enabled state (Enable all / Disable all). */
  onSetAll: (enabled: boolean) => void;
  /** Optional actions on the same row as Enable all / Disable all. */
  footer?: ReactNode;
  /** Optional line under the list (the modal's relaunch note). */
  note?: ReactNode;
  /** The line shown when a project-disabled server is ticked. */
  projectEnableNote?: string;
  /** Start expanded. */
  defaultExpanded?: boolean;
};

const DEFAULT_PROJECT_ENABLE_NOTE =
  "Starting this session also turns these on for this project.";

const STATUS_LABEL: Record<McpCatalogEntry["status"], string> = {
  connected: "connected",
  hosted: "hosted",
  failed: "failed",
  needs_auth: "needs auth",
  pending_approval: "pending",
  unknown: "not checked",
};

function statusCaption(server: McpCatalogEntry): string {
  return server.projectDisabled
    ? "OFF FOR PROJECT"
    : STATUS_LABEL[server.status];
}

function statusTooltip(server: McpCatalogEntry): string {
  if (server.projectDisabled) {
    return "Off for this project in Claude Code's settings. Turning it on here turns it on for the whole project.";
  }
  if (server.hosted) {
    return "Runs on Anthropic's servers, no local process.";
  }
  if (server.status === "unknown") {
    return "Not in the last status check of this node.";
  }
  return `Last status check: ${STATUS_LABEL[server.status]}.`;
}

/**
 * The other servers sharing this one's key, or none (#6409 item 3). Claude Code
 * reports their tools together, so the catalog sends no number for them.
 */
function sharedKeyNames(server: McpCatalogEntry): string[] {
  return server.sharedKeyWith ?? [];
}

/** `157 MB · 1.2k`, or the half that is known, or "—" until measured. */
function costLabel(server: McpCatalogEntry): string {
  if (sharedKeyNames(server).length > 0) return "—";
  const parts: string[] = [];
  if (server.ram) parts.push(`${server.ram.medianMb} MB`);
  if (server.context) parts.push(formatTokens(server.context.inContextTokens));
  return parts.length > 0 ? parts.join(" · ") : "—";
}

function costTooltip(server: McpCatalogEntry): string {
  const others = sharedKeyNames(server);
  if (others.length > 0) {
    const named = others
      .map(name =>
        name === HAPI_MCP_SERVER_NAME ? "Hapimatic's own server" : name
      )
      .join(", ");
    return `Not shown: shares a tool prefix with ${named} on this node, so Claude Code reports their tools together.`;
  }
  const lines: string[] = [];
  if (!server.ram && !server.context) {
    lines.push(
      server.hosted
        ? "Not measured yet: its context cost appears after a session's first turn with it."
        : "Not measured yet: memory appears after the next sample while a session runs it, context after a session's first turn with it."
    );
  }
  if (server.hosted) {
    lines.push("Runs on Anthropic's servers, no local process.");
  } else if (server.ram) {
    const ago = formatRelativeTime(Date.parse(server.ram.sampledAt));
    lines.push(
      `Memory: median of ${server.ram.instances} running ${
        server.ram.instances === 1 ? "copy" : "copies"
      } on this node${ago ? `, measured ${ago}` : ""}.`
    );
    if (server.ram.withBrowser) {
      lines.push(
        `With its browser open: ${server.ram.withBrowser.medianMb} MB.`
      );
    }
  }
  if (server.context) {
    lines.push(
      `Context: ${server.context.inContextTokens.toLocaleString()} tokens this server adds to a session, ${server.context.deferredTokens.toLocaleString()} more deferred until a tool is used.`
    );
  }
  return lines.join(" ");
}

export function McpServersSection({
  servers,
  isLoading,
  desired,
  disabled,
  onToggleServer,
  onSetAll,
  footer,
  note,
  projectEnableNote = DEFAULT_PROJECT_ENABLE_NOTE,
  defaultExpanded = false,
}: McpServersSectionProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const idPrefix = useId();

  const connected = servers.filter(
    s => s.status === "connected" || s.status === "hosted"
  ).length;
  const attention = servers.filter(s => s.status === "needs_auth").length;
  const failed = servers.filter(s => s.status === "failed").length;
  const countLabel = formatMcp(connected, attention, failed);

  const selected = servers.filter(s => desired[s.name]);
  // #6409 item 3: a shared-key server's memory belongs to no one of them, so
  // the total leaves it out (and under-counts) rather than count it twice.
  const measured = selected.filter(
    s => s.ram && sharedKeyNames(s).length === 0
  );
  const selectedMb = measured.reduce(
    (sum, s) => sum + (s.ram?.medianMb ?? 0),
    0
  );
  const enablesForProject = selected.some(s => s.projectDisabled);

  return (
    <div className="flex flex-col gap-1">
      {/* The subheading IS the collapsible header (R5). */}
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
        {measured.length > 0 && (
          <span className="text-xs tabular-nums text-[var(--app-hint)]">
            ≈ {selectedMb} MB
          </span>
        )}
        <ChevronIcon
          className="ml-auto h-3.5 w-3.5 text-[var(--app-hint)]"
          collapsed={!expanded}
        />
      </BareButton>

      {expanded &&
        (isLoading && servers.length === 0 ? (
          <span className="text-xs text-[var(--app-hint)]">Loading…</span>
        ) : servers.length === 0 ? (
          <span className="text-xs text-[var(--app-hint)]">
            No MCP servers configured for this project.
          </span>
        ) : (
          <>
            {/* Enable all / Disable all, right-justified, beside the footer. */}
            <div className="flex items-center gap-3">
              {footer && (
                <div className="flex min-w-0 items-center gap-3">{footer}</div>
              )}
              <div className="ml-auto flex items-center gap-3">
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
            </div>
            {/* One row per server on a fixed pitch; the list scrolls when long. */}
            <div className="flex max-h-48 flex-col overflow-y-auto">
              {servers.map((s, index) => {
                const cost = costLabel(s);
                // Per-instance and index-based: names carry spaces and colons.
                const id = `${idPrefix}-mcp-${index}`;
                return (
                  <div
                    key={s.name}
                    className="flex min-h-7 items-center gap-2 text-xs text-[var(--app-fg)]"
                  >
                    <Checkbox
                      id={id}
                      checked={desired[s.name] ?? false}
                      disabled={disabled}
                      onChange={e => onToggleServer(s.name, e.target.checked)}
                    />
                    <label htmlFor={id} className="min-w-0 flex-1 truncate">
                      {s.name}
                    </label>
                    <HoverTooltip content={costTooltip(s)}>
                      <span className="shrink-0 tabular-nums text-[var(--app-hint)]">
                        {cost}
                      </span>
                    </HoverTooltip>
                    <HoverTooltip content={statusTooltip(s)}>
                      <span
                        className={`shrink-0 text-[length:var(--text-caption-xs)] uppercase ${
                          s.projectDisabled
                            ? "text-[var(--app-badge-warning-text)]"
                            : "text-[var(--app-hint)]"
                        }`}
                      >
                        {statusCaption(s)}
                      </span>
                    </HoverTooltip>
                  </div>
                );
              })}
            </div>
            {enablesForProject && (
              <span className="text-xs text-[var(--app-badge-warning-text)]">
                {projectEnableNote}
              </span>
            )}
            {note && (
              <span className="text-xs text-[var(--app-hint)]">{note}</span>
            )}
          </>
        ))}
    </div>
  );
}
