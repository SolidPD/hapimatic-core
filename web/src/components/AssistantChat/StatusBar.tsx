// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AgentState, McpServerStatus } from "@/types/api";
import { useMcpStatus } from "@/hooks/useMcpStatus";
import { useMcpBatch } from "@/hooks/useMcpBatch";
import { selectMcpServerErrorDisplay } from "@/lib/mcpServerErrorDisplay";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { BareButton } from "@/components/ui/BareButton";

/** Terminal icon (issue #2882 — relocated into the header). */
function TerminalIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" ry="2" />
      <polyline points="7 9 10 12 7 15" />
      <line x1="12" y1="15" x2="17" y2="15" />
    </svg>
  );
}

const STATUS_NAME_COLOR: Record<McpServerStatus["status"], string> = {
  connected: "text-green-500",
  hosted: "text-blue-400",
  failed: "text-red-400",
  needs_auth: "text-amber-400",
  // #2142: extended union. `unknown` = a mcp-list line the parser could not
  // classify (drift-visible, never dropped); `pending_approval` = a ⏸
  // project-scoped server awaiting approval.
  unknown: "text-gray-400",
  pending_approval: "text-yellow-400",
};

const STATUS_DOT_COLOR: Record<McpServerStatus["status"], string> = {
  connected: "bg-green-500",
  hosted: "bg-blue-500",
  failed: "bg-red-500",
  needs_auth: "bg-amber-500",
  unknown: "bg-gray-400",
  pending_approval: "bg-yellow-500",
};

/** Auto-dismiss timeout for the local-mode banner */
const LOCAL_MODE_BANNER_TIMEOUT_MS = 30_000;

// Vibing messages for thinking state
const VIBING_MESSAGES = [
  "Accomplishing",
  "Actioning",
  "Actualizing",
  "Baking",
  "Booping",
  "Brewing",
  "Calculating",
  "Cerebrating",
  "Channelling",
  "Churning",
  "Clauding",
  "Coalescing",
  "Cogitating",
  "Computing",
  "Combobulating",
  "Concocting",
  "Conjuring",
  "Considering",
  "Contemplating",
  "Cooking",
  "Crafting",
  "Creating",
  "Crunching",
  "Deciphering",
  "Deliberating",
  "Determining",
  "Discombobulating",
  "Divining",
  "Doing",
  "Effecting",
  "Elucidating",
  "Enchanting",
  "Envisioning",
  "Finagling",
  "Flibbertigibbeting",
  "Forging",
  "Forming",
  "Frolicking",
  "Generating",
  "Germinating",
  "Hatching",
  "Herding",
  "Honking",
  "Ideating",
  "Imagining",
  "Incubating",
  "Inferring",
  "Manifesting",
  "Marinating",
  "Meandering",
  "Moseying",
  "Mulling",
  "Mustering",
  "Musing",
  "Noodling",
  "Percolating",
  "Perusing",
  "Philosophising",
  "Pontificating",
  "Pondering",
  "Processing",
  "Puttering",
  "Puzzling",
  "Reticulating",
  "Ruminating",
  "Scheming",
  "Schlepping",
  "Shimmying",
  "Simmering",
  "Smooshing",
  "Spelunking",
  "Spinning",
  "Stewing",
  "Sussing",
  "Synthesizing",
  "Thinking",
  "Tinkering",
  "Transmuting",
  "Unfurling",
  "Unravelling",
  "Vibing",
  "Wandering",
  "Whirring",
  "Wibbling",
  "Wizarding",
  "Working",
  "Wrangling",
];

function getConnectionStatus(
  active: boolean,
  thinking: boolean,
  hasPermissions: boolean,
  vibingMessage: string | null
): { text: string; color: string; dotColor: string; isPulsing: boolean } {
  if (!active) {
    return {
      text: "offline",
      color: "text-[#999]",
      dotColor: "bg-[#999]",
      isPulsing: false,
    };
  }

  // Check thinking FIRST — blue indicator takes priority over pending
  // permissions to prevent orange flashes during YOLO-mode tool execution
  if (thinking) {
    return {
      text: vibingMessage ?? "thinking…",
      color: "text-[#007AFF]",
      dotColor: "bg-[#007AFF]",
      isPulsing: true,
    };
  }

  if (hasPermissions) {
    return {
      text: "permission required",
      color: "text-[#FF9500]",
      dotColor: "bg-[#FF9500]",
      isPulsing: true,
    };
  }

  return {
    text: "online",
    color: "text-[#34C759]",
    dotColor: "bg-[#34C759]",
    isPulsing: false,
  };
}

export function StatusBar(props: {
  active: boolean;
  thinking: boolean;
  agentState: AgentState | null | undefined;
  // Project directory for per-project MCP status
  projectDir?: string | null;
  // Session ID — required for MCP toggle interactions (#989); when null/undefined,
  // the modal renders read-only with a tooltip explaining toggling needs a session.
  sessionId?: string | null;
  // Optional leading element (e.g., collapse toggle) that replaces the connection status
  leadingElement?: React.ReactNode;
  // Issue #3289 (S4): the Prompt Text Tools row (Copy · Move · Push · Expand ·
  // Paperclip · Delete) was RELOCATED out of StatusBar into <PromptTextTools>;
  // HappyComposer passes that element here so it renders on the right of Row 1
  // (heading + terminal stay on the left). The old prompt-control props are gone.
  trailingElement?: React.ReactNode;
  // Issue #2882: terminal control relocated into the header (D2(a): retires with
  // #3286's View Picker). Kept wired and functional for #3289.
  showTerminalButton?: boolean;
  onTerminal?: () => void;
  terminalDisabled?: boolean;
  // Issue #3289 (S4): the MCP detail modal's OPEN state is CONTROLLED by
  // HappyComposer (opened from the Session Config Cluster's MCP chip, since R6
  // removed StatusBar's old "MCP {count}" text trigger). StatusBar still owns the
  // modal + its per-server machinery; only open/close is lifted.
  mcpDetailOpen?: boolean;
  onMcpDetailOpenChange?: (open: boolean) => void;
}) {
  // Stable scalar derived from agentState — avoids useMemo invalidation
  // from new object references produced by Zod parsing on every refetch
  const hasPermissions = props.agentState?.requests
    ? Object.keys(props.agentState.requests).length > 0
    : false;

  // Stable vibing message — selected once when thinking starts, held until
  // thinking ends. Prevents random re-rolling on every refetch cycle.
  const vibingMessageRef = useRef<string | null>(null);
  useEffect(() => {
    if (props.thinking) {
      if (!vibingMessageRef.current) {
        vibingMessageRef.current =
          VIBING_MESSAGES[
            Math.floor(Math.random() * VIBING_MESSAGES.length)
          ].toLowerCase() + "…";
      }
    } else {
      vibingMessageRef.current = null;
    }
  }, [props.thinking]);

  const connectionStatus = useMemo(
    () =>
      getConnectionStatus(
        props.active,
        props.thinking,
        hasPermissions,
        vibingMessageRef.current
      ),
    [props.active, props.thinking, hasPermissions]
  );

  // MCP server status (per-project when projectDir is available)
  const mcpStatus = useMcpStatus(props.projectDir);
  // Issue #3289 (S4): open state is controlled by HappyComposer (the Session
  // Config Cluster's MCP chip opens it); closing bubbles up via the callback.
  const showMcpDetail = props.mcpDetailOpen ?? false;
  const closeMcpDetail = () => props.onMcpDetailOpenChange?.(false);

  // Multi-select & batch state (#989; server-side coordinator added in #989 follow-up)
  const sessionId = props.sessionId ?? null;
  const canToggle = sessionId !== null;

  const [selectMode, setSelectMode] = useState(false);
  const [selectedServers, setSelectedServers] = useState<Set<string>>(
    () => new Set()
  );
  const [confirmAction, setConfirmAction] = useState<{
    verb: "Enable" | "Disable";
    names: string[];
  } | null>(null);
  const [localModeBanner, setLocalModeBanner] = useState<string | null>(null);
  const batch = useMcpBatch(sessionId);

  // Auto-dismiss the local-mode banner after a timeout
  useEffect(() => {
    if (!localModeBanner) return;
    const id = setTimeout(
      () => setLocalModeBanner(null),
      LOCAL_MODE_BANNER_TIMEOUT_MS
    );
    return () => clearTimeout(id);
  }, [localModeBanner]);

  // Reset modal state when it closes
  useEffect(() => {
    if (!showMcpDetail) {
      setSelectMode(false);
      setSelectedServers(new Set());
      setLocalModeBanner(null);
    }
  }, [showMcpDetail]);

  // Stable alphabetical ordering — prevents row jitter when servers transition
  // between active and disabled lists after a toggle.
  const sortedActive = useMemo(
    () => [...mcpStatus.servers].sort((a, b) => a.name.localeCompare(b.name)),
    [mcpStatus.servers]
  );
  const sortedDisabled = useMemo(
    () => [...mcpStatus.disabledServers].sort((a, b) => a.localeCompare(b)),
    [mcpStatus.disabledServers]
  );

  const toggleSelected = useCallback((name: string) => {
    setSelectedServers(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  /**
   * Submit the user's selection as a desired-state map. Server-side
   * worker reconciles desired vs current and toggles only the servers
   * that need to change. Survives client backgrounding.
   */
  const runBatch = useCallback(
    async (verb: "Enabling" | "Disabling", names: string[]) => {
      if (!sessionId || names.length === 0) return;
      const enable = verb === "Enabling";
      const desired: Record<string, boolean> = {};
      for (const name of names) desired[name] = enable;
      const result = await batch.setDesired(desired);
      // Exit select mode immediately — progress is rendered from
      // useMcpBatch's snapshot, no need to keep selection visible.
      setSelectMode(false);
      setSelectedServers(new Set());
      if (!result.ok && result.code === "local_mode_not_supported") {
        setLocalModeBanner(
          `This session is in terminal mode — batch ${verb.toLowerCase()} aborted. Toggle MCP servers from the terminal.`
        );
      }
    },
    [sessionId, batch]
  );

  const startConfirm = useCallback(
    (verb: "Enable" | "Disable", names: string[]) => {
      if (names.length === 0) return;
      setConfirmAction({ verb, names });
    },
    []
  );

  // Issue #2882: relocated terminal derived state (D2(a): retires with #3286).
  const terminalDisabled = props.terminalDisabled ?? false;

  return (
    <div className="flex items-center justify-between pb-1">
      {/* Left side: Leading element (or connection status) + Terminal button (#2882).
          The permission-mode control moved to the composer (#2540); the "MCP {count}" text indicator
          was removed (#3289) — the MCP detail modal below is portaled, opened from the
          Config Cluster chip. */}
      {/* #2413: min-w-0 (not whitespace-nowrap) lets this cluster shrink/truncate
          instead of shoving the right icon group off-viewport at 393px. Per-child
          truncate (below) ellipsizes rather than wrapping mid-text. */}
      <div className="flex items-center gap-1.5 min-w-0">
        {props.leadingElement ? (
          props.leadingElement
        ) : (
          <div className="flex items-center gap-1.5">
            <span
              className={`h-2 w-2 rounded-full ${connectionStatus.dotColor} ${connectionStatus.isPulsing ? "animate-pulse" : ""}`}
            />
            <span className={`text-xs ${connectionStatus.color}`}>
              {connectionStatus.text}
            </span>
          </div>
        )}
        {/* Terminal (issue #2882) — sits between the "Prompt" label and the MCP
            text. A compact fixed-width w-6 slot is reserved whenever terminal
            capability is wired (props.onTerminal is always provided by HappyComposer,
            even when the button is hidden for an inactive session), so the MCP text
            never shifts horizontally when the terminal button toggles on
            activate/deactivate — while staying narrow enough that the "Prompt" label
            keeps its one-line width at 393px (issue #2882 iteration AB). */}
        {props.onTerminal ? (
          <div className="flex h-8 w-6 shrink-0 items-center justify-center">
            {props.showTerminalButton ? (
              <BareButton
                type="button"
                aria-label="Terminal"
                title="Terminal"
                onClick={props.onTerminal}
                disabled={terminalDisabled}
                className="flex h-6 w-6 items-center justify-center rounded-full text-[var(--app-fg)]/60 transition-colors hover:bg-[var(--app-hover)] hover:text-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <TerminalIcon />
              </BareButton>
            ) : null}
          </div>
        ) : null}
        {/* Issue #3289 (S4, R6): the old "MCP {count}" text indicator was removed
            — the Session Config Cluster's MCP chip is now the sole MCP indicator
            (never two). The per-server detail modal below is retained and opened
            from that chip via the controlled `mcpDetailOpen` prop. */}
        {/* MCP Server Status Modal — portaled to body to escape CSS containment */}
        {showMcpDetail
          ? createPortal(
              <div
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
                onClick={e => {
                  if (e.target === e.currentTarget) closeMcpDetail();
                }}
              >
                <div
                  className="w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] shadow-2xl overflow-hidden flex flex-col"
                  style={{ maxHeight: "60vh" }}
                >
                  {/* Modal header */}
                  <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--app-border)]">
                    <span className="text-sm font-semibold text-[var(--app-fg)]">
                      MCP Server Status
                    </span>
                    <span className="flex items-center gap-2.5 ml-auto text-xs">
                      {mcpStatus.connectedCount > 0 ? (
                        <span className="flex items-center gap-1">
                          <span className="h-2 w-2 rounded-full bg-green-500" />
                          <span className="text-green-500">
                            {mcpStatus.connectedCount}
                          </span>
                        </span>
                      ) : null}
                      {mcpStatus.hostedCount > 0 ? (
                        <span className="flex items-center gap-1">
                          <span className="h-2 w-2 rounded-full bg-blue-500" />
                          <span className="text-blue-400">
                            {mcpStatus.hostedCount}
                          </span>
                        </span>
                      ) : null}
                      {mcpStatus.needsAuthCount > 0 ? (
                        <span className="flex items-center gap-1">
                          <span className="h-2 w-2 rounded-full bg-amber-500" />
                          <span className="text-amber-400">
                            {mcpStatus.needsAuthCount}
                          </span>
                        </span>
                      ) : null}
                      {mcpStatus.failedCount > 0 ? (
                        <span className="flex items-center gap-1">
                          <span className="h-2 w-2 rounded-full bg-red-500" />
                          <span className="text-red-400">
                            {mcpStatus.failedCount}
                          </span>
                        </span>
                      ) : null}
                      {mcpStatus.pendingApprovalCount > 0 ? (
                        <span className="flex items-center gap-1">
                          <span className="h-2 w-2 rounded-full bg-yellow-500" />
                          <span className="text-yellow-400">
                            {mcpStatus.pendingApprovalCount}
                          </span>
                        </span>
                      ) : null}
                      {mcpStatus.unknownCount > 0 ? (
                        <span className="flex items-center gap-1">
                          <span className="h-2 w-2 rounded-full bg-gray-400" />
                          <span className="text-gray-400">
                            {mcpStatus.unknownCount}
                          </span>
                        </span>
                      ) : null}
                      {mcpStatus.disabledCount > 0 ? (
                        <span className="flex items-center gap-1">
                          <span className="h-2 w-2 rounded-full bg-gray-500" />
                          <span className="text-gray-400">
                            {mcpStatus.disabledCount}
                          </span>
                        </span>
                      ) : null}
                    </span>
                    <Button
                      type="button"
                      variant="ghostStatic"
                      size="bare"
                      onClick={() => closeMcpDetail()}
                      className="ml-2 text-[var(--app-hint)] transition-colors hover:text-[var(--app-fg)]"
                    >
                      ✕
                    </Button>
                  </div>
                  {/* Local-mode banner */}
                  {localModeBanner ? (
                    <div className="flex items-start gap-2 px-4 py-2 bg-amber-500/10 border-b border-amber-500/30 text-xs text-amber-300">
                      <span className="shrink-0 mt-0.5">⚠</span>
                      <span className="flex-1">{localModeBanner}</span>
                      <Button
                        type="button"
                        variant="ghostStatic"
                        size="bare"
                        onClick={() => setLocalModeBanner(null)}
                        className="shrink-0 text-amber-400 hover:text-amber-200"
                        aria-label="Dismiss"
                      >
                        ✕
                      </Button>
                    </div>
                  ) : null}
                  {/* Read-only banner when no session is available */}
                  {!canToggle &&
                  (mcpStatus.totalCount > 0 || mcpStatus.disabledCount > 0) ? (
                    <div className="px-4 py-2 bg-[var(--app-secondary-bg)] border-b border-[var(--app-border)] text-xs text-[var(--app-hint)]">
                      Active session required to toggle MCP servers.
                    </div>
                  ) : null}
                  {/* Modal body — scrollable server list */}
                  <div className="overflow-y-auto px-4 py-2 flex-1">
                    {/* Master checkbox — Gmail-style select-all toggle.
                        Three states:
                          - 0 selected → click selects all
                          - partial    → click selects all
                          - all        → click selects none */}
                    {selectMode ? (
                      <div className="py-1 mb-1 border-b border-[var(--app-border)]">
                        <BareButton
                          type="button"
                          onClick={() => {
                            const allNames = [
                              ...sortedActive.map(s => s.name),
                              ...sortedDisabled,
                            ];
                            const allSelected =
                              allNames.length > 0 &&
                              allNames.every(n => selectedServers.has(n));
                            if (allSelected) {
                              setSelectedServers(new Set());
                            } else {
                              setSelectedServers(new Set(allNames));
                            }
                          }}
                          disabled={batch.isActive}
                          className={`w-full flex items-center justify-start gap-2 text-xs font-normal text-left rounded px-1 -mx-1 transition-colors hover:bg-[var(--app-hover)] cursor-pointer disabled:opacity-30`}
                          title={(() => {
                            const allNames = [
                              ...sortedActive.map(s => s.name),
                              ...sortedDisabled,
                            ];
                            const allSelected =
                              allNames.length > 0 &&
                              allNames.every(n => selectedServers.has(n));
                            return allSelected ? "Deselect all" : "Select all";
                          })()}
                        >
                          {(() => {
                            const allNames = [
                              ...sortedActive.map(s => s.name),
                              ...sortedDisabled,
                            ];
                            const selectedCount = allNames.filter(n =>
                              selectedServers.has(n)
                            ).length;
                            const allSelected =
                              allNames.length > 0 &&
                              selectedCount === allNames.length;
                            const partial = selectedCount > 0 && !allSelected;
                            return (
                              <input
                                type="checkbox"
                                checked={allSelected}
                                ref={el => {
                                  if (el) el.indeterminate = partial;
                                }}
                                readOnly
                                className="shrink-0 accent-[var(--app-link)]"
                              />
                            );
                          })()}
                          <span className="text-[var(--app-hint)]">
                            {(() => {
                              const allNames = [
                                ...sortedActive.map(s => s.name),
                                ...sortedDisabled,
                              ];
                              const selectedCount = allNames.filter(n =>
                                selectedServers.has(n)
                              ).length;
                              if (selectedCount === 0) return "Select all";
                              if (selectedCount === allNames.length)
                                return `All ${allNames.length} selected`;
                              return `${selectedCount} of ${allNames.length} selected`;
                            })()}
                          </span>
                        </BareButton>
                      </div>
                    ) : null}
                    {/* Active servers (alphabetical) */}
                    {sortedActive.map(server => {
                      const isPending = mcpStatus.pendingToggles.has(
                        server.name
                      );
                      const error = mcpStatus.perServerErrors.get(server.name);
                      const isSelected = selectedServers.has(server.name);
                      const dotColor = STATUS_DOT_COLOR[server.status];
                      const nameColor = STATUS_NAME_COLOR[server.status];
                      return (
                        <div key={server.name} className="py-1">
                          <BareButton
                            type="button"
                            onClick={() => {
                              if (selectMode) toggleSelected(server.name);
                            }}
                            disabled={isPending || batch.isActive}
                            className={`w-full flex items-center justify-start gap-2 text-xs font-normal text-left rounded px-1 -mx-1 transition-colors disabled:opacity-100 ${
                              selectMode && !isPending
                                ? "hover:bg-[var(--app-hover)] cursor-pointer"
                                : "cursor-default"
                            }`}
                            title={
                              selectMode
                                ? "Toggle selection"
                                : canToggle
                                  ? "Use Select to enable/disable servers"
                                  : "Active session required"
                            }
                          >
                            {selectMode ? (
                              <input
                                type="checkbox"
                                checked={isSelected}
                                readOnly
                                className="shrink-0 accent-[var(--app-link)]"
                              />
                            ) : null}
                            <span
                              className={`h-2 w-2 rounded-full shrink-0 ${dotColor} ${isPending ? "animate-pulse" : ""}`}
                            />
                            <span
                              className={`truncate ${nameColor} ${isPending ? "animate-pulse" : ""}`}
                            >
                              {server.name}
                            </span>
                            <span
                              className={`ml-auto shrink-0 ${nameColor} ${isPending ? "animate-pulse" : ""}`}
                            >
                              {isPending
                                ? "Disabling…"
                                : (server.statusText ?? server.status)}
                            </span>
                          </BareButton>
                          {(() => {
                            const display = selectMcpServerErrorDisplay(
                              batch.snapshot?.done?.[server.name],
                              error
                            );
                            if (!display) return null;
                            const colorCls =
                              display.kind === "abandoned"
                                ? "text-orange-400"
                                : "text-red-400";
                            return (
                              <div
                                data-testid="mcp-server-error"
                                data-error-kind={display.kind}
                                data-server-name={server.name}
                                className={`ml-4 mt-0.5 flex items-start gap-1.5 text-[10px] ${colorCls}`}
                              >
                                <span className="flex-1">
                                  {display.code}: {display.message}
                                </span>
                                {display.dismissable ? (
                                  <Button
                                    type="button"
                                    variant="ghostStatic"
                                    size="bare"
                                    onClick={() =>
                                      mcpStatus.clearServerError(server.name)
                                    }
                                    className={`${colorCls} transition-colors hover:opacity-70`}
                                    aria-label="Dismiss error"
                                  >
                                    ✕
                                  </Button>
                                ) : null}
                              </div>
                            );
                          })()}
                        </div>
                      );
                    })}
                    {/* Disabled servers (alphabetical) */}
                    {sortedDisabled.length > 0 ? (
                      <>
                        {sortedActive.length > 0 ? (
                          <div className="border-t border-[var(--app-border)] mt-2 mb-1" />
                        ) : null}
                        {sortedDisabled.map(name => {
                          const isPending = mcpStatus.pendingToggles.has(name);
                          const error = mcpStatus.perServerErrors.get(name);
                          const isSelected = selectedServers.has(name);
                          return (
                            <div key={name} className="py-1">
                              <BareButton
                                type="button"
                                onClick={() => {
                                  if (selectMode) toggleSelected(name);
                                }}
                                disabled={isPending || batch.isActive}
                                className={`w-full flex items-center justify-start gap-2 text-xs font-normal text-left rounded px-1 -mx-1 transition-colors disabled:opacity-100 ${
                                  selectMode && !isPending
                                    ? "hover:bg-[var(--app-hover)] cursor-pointer"
                                    : "cursor-default"
                                }`}
                                title={
                                  selectMode
                                    ? "Toggle selection"
                                    : canToggle
                                      ? "Use Select to enable/disable servers"
                                      : "Active session required"
                                }
                              >
                                {selectMode ? (
                                  <input
                                    type="checkbox"
                                    checked={isSelected}
                                    readOnly
                                    className="shrink-0 accent-[var(--app-link)]"
                                  />
                                ) : null}
                                <span
                                  className={`h-2 w-2 rounded-full shrink-0 bg-gray-600 ${isPending ? "animate-pulse" : ""}`}
                                />
                                <span
                                  className={`truncate text-gray-500 ${isPending ? "animate-pulse" : ""}`}
                                >
                                  {name}
                                </span>
                                <span
                                  className={`ml-auto shrink-0 text-gray-600 ${isPending ? "animate-pulse" : ""}`}
                                >
                                  {isPending ? "Enabling…" : "Disabled"}
                                </span>
                              </BareButton>
                              {(() => {
                                const display = selectMcpServerErrorDisplay(
                                  batch.snapshot?.done?.[name],
                                  error
                                );
                                if (!display) return null;
                                const colorCls =
                                  display.kind === "abandoned"
                                    ? "text-orange-400"
                                    : "text-red-400";
                                return (
                                  <div
                                    data-testid="mcp-server-error"
                                    data-error-kind={display.kind}
                                    data-server-name={name}
                                    className={`ml-4 mt-0.5 flex items-start gap-1.5 text-[10px] ${colorCls}`}
                                  >
                                    <span className="flex-1">
                                      {display.code}: {display.message}
                                    </span>
                                    {display.dismissable ? (
                                      <Button
                                        type="button"
                                        variant="ghostStatic"
                                        size="bare"
                                        onClick={() =>
                                          mcpStatus.clearServerError(name)
                                        }
                                        className={`${colorCls} transition-colors hover:opacity-70`}
                                        aria-label="Dismiss error"
                                      >
                                        ✕
                                      </Button>
                                    ) : null}
                                  </div>
                                );
                              })()}
                            </div>
                          );
                        })}
                      </>
                    ) : null}
                  </div>
                  {/* Modal footer — single row, two states.
                      Idle:        [ Select ] ........... Last checked + ↻
                      Select mode: [ Cancel ] [ Enable ] [ Disable ]
                      During an active batch (regardless of mode):
                                   <progress text> .................. ↻ */}
                  <div className="px-4 py-2 border-t border-[var(--app-border)] flex items-center gap-1.5 text-[10px] text-[var(--app-hint)]">
                    {(() => {
                      if (batch.isActive && batch.snapshot) {
                        const total = batch.snapshot.total;
                        const remaining = batch.snapshot.remaining;
                        const completed = total - remaining;
                        const verbText = batch.snapshot.processing
                          ? batch.snapshot.processing
                          : "…";
                        return (
                          <>
                            <span className="truncate flex-1">
                              Reconciling {completed}/{total}: {verbText}
                            </span>
                            <BareButton
                              type="button"
                              onClick={() => mcpStatus.refresh()}
                              disabled={mcpStatus.isRefreshing}
                              className="p-1 rounded hover:bg-[var(--app-hover)] transition-colors disabled:opacity-30 shrink-0 focus-visible:ring-0"
                              title="Refresh MCP status"
                            >
                              <svg
                                className={`h-3 w-3 ${mcpStatus.isRefreshing ? "animate-spin" : ""}`}
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <path d="M21 2v6h-6" />
                                <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
                                <path d="M3 22v-6h6" />
                                <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
                              </svg>
                            </BareButton>
                          </>
                        );
                      }
                      if (
                        selectMode &&
                        canToggle &&
                        (mcpStatus.totalCount > 0 ||
                          mcpStatus.disabledCount > 0)
                      ) {
                        // Select-mode action row replaces last-checked + refresh.
                        const enableTargets = Array.from(
                          selectedServers
                        ).filter(n => mcpStatus.disabledServers.includes(n));
                        const disableTargets = Array.from(
                          selectedServers
                        ).filter(n =>
                          mcpStatus.servers.some(s => s.name === n)
                        );
                        return (
                          <>
                            <Button
                              type="button"
                              variant="ghostStatic"
                              onClick={() => {
                                setSelectMode(false);
                                setSelectedServers(new Set());
                              }}
                              className="h-auto rounded px-2 py-1 text-[length:var(--text-caption-xs)] font-normal text-[var(--app-hint)] hover:text-[var(--app-fg)]"
                            >
                              Cancel
                            </Button>
                            <Button
                              type="button"
                              variant="secondary"
                              onClick={() =>
                                startConfirm("Enable", enableTargets)
                              }
                              disabled={enableTargets.length === 0}
                              className="ml-auto h-auto rounded px-2 py-1 text-[length:var(--text-caption-xs)] font-normal disabled:opacity-30"
                            >
                              Enable ({enableTargets.length})
                            </Button>
                            <Button
                              type="button"
                              variant="secondary"
                              onClick={() =>
                                startConfirm("Disable", disableTargets)
                              }
                              disabled={disableTargets.length === 0}
                              className="h-auto rounded px-2 py-1 text-[length:var(--text-caption-xs)] font-normal disabled:opacity-30"
                            >
                              Disable ({disableTargets.length})
                            </Button>
                          </>
                        );
                      }
                      // Idle: Select left, Last checked + refresh right
                      return (
                        <>
                          {canToggle &&
                          (mcpStatus.totalCount > 0 ||
                            mcpStatus.disabledCount > 0) ? (
                            <Button
                              type="button"
                              variant="secondary"
                              onClick={() => setSelectMode(true)}
                              className="h-auto rounded px-2 py-1 text-xs font-normal hover:opacity-90"
                            >
                              Select
                            </Button>
                          ) : (
                            <span />
                          )}
                          <span className="ml-auto truncate text-right">
                            {mcpStatus.checkedAt
                              ? `Last checked: ${new Date(mcpStatus.checkedAt).toLocaleTimeString()}`
                              : "Not yet checked"}
                          </span>
                          <BareButton
                            type="button"
                            onClick={() => mcpStatus.refresh()}
                            disabled={mcpStatus.isRefreshing}
                            className="p-1 rounded hover:bg-[var(--app-hover)] transition-colors disabled:opacity-30 shrink-0 focus-visible:ring-0"
                            title="Refresh MCP status"
                          >
                            <svg
                              className={`h-3 w-3 ${mcpStatus.isRefreshing ? "animate-spin" : ""}`}
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M21 2v6h-6" />
                              <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
                              <path d="M3 22v-6h6" />
                              <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
                            </svg>
                          </BareButton>
                        </>
                      );
                    })()}
                  </div>
                </div>
              </div>,
              document.body
            )
          : null}
        {/* Confirmation dialog for batch operations (rendered alongside the modal portal) */}
        <ConfirmDialog
          isOpen={confirmAction !== null}
          onClose={() => setConfirmAction(null)}
          title={
            confirmAction
              ? `${confirmAction.verb} ${confirmAction.names.length} MCP server${confirmAction.names.length === 1 ? "" : "s"}?`
              : ""
          }
          description={
            confirmAction
              ? `This batch will run sequentially with a brief delay between each toggle. Estimated time: ~${Math.max(2, Math.ceil(confirmAction.names.length * 2.5))}s. The session can still be used during the batch.`
              : ""
          }
          confirmLabel={
            confirmAction
              ? `${confirmAction.verb} ${confirmAction.names.length}`
              : ""
          }
          confirmingLabel={
            confirmAction
              ? `${confirmAction.verb === "Enable" ? "Enabling" : "Disabling"}…`
              : ""
          }
          onConfirm={async () => {
            if (!confirmAction) return;
            const verb =
              confirmAction.verb === "Enable" ? "Enabling" : "Disabling";
            await runBatch(verb, confirmAction.names);
          }}
          isPending={batch.isSettingDesired}
        />
      </div>

      {props.trailingElement}
    </div>
  );
}
