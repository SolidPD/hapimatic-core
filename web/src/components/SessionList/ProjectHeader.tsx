// SPDX-License-Identifier: AGPL-3.0-only
// ProjectHeader — collapsible group header (repo/folder name, timer sum, actions).
// Extracted from SessionList.tsx (issue #2083, epic #2077 F) — verbatim move.
import type { ApiClient } from "@/api/client";
import {
  ChainIcon,
  ChevronIcon,
  FolderIcon,
  GitHubIcon,
  PencilIcon,
  TrashIcon,
} from "@/components/icons";
import { ClockIcon, ProjectTimer } from "@/components/SessionTimer";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { summarizeBulkSessionResult } from "@/lib/bulkSessionToast";
import { executeBulkSessionAction } from "@/hooks/mutations/useBulkSessionAction";
import { SESSION_NAME_MAX_LENGTH, validateSessionName } from "@hapi/protocol";
import { useEffect, useRef, useState } from "react";
import { NodeBadge, useNodeTone } from "@/components/NodeBadge";
import { getShortPath } from "./grouping";
import type { SessionGroup } from "./grouping";
import {
  isInteractiveTarget,
  splitDragHandle,
  type SortableDragHandle,
} from "./SortableListEntry";

// ── #4538: row-2 node band + icon discs ──────────────────────────────────
// Row-2 node band: a `::before` layer on line 2, painted BEHIND its content
// (z -10 inside the left column's `relative z-0` stacking context) and
// extended past the line's own box to the header's edges — `-left-2` cancels
// the header's `pl-2`; `-top-px` splits the `mt-0.5` gap so the band starts
// where row 1 ends; `-bottom-1` fills the header's `py-1`; and the right edge
// reaches UNDER the icon column: three slots (`--icon-slot` × 2 +
// `--icon-btn-size`) + `gap-2` + `pr-2` (= 1rem). The icon column sits at
// z 10, so its discs float over the purple→band split. The fill rides the
// `--node-band` custom property, set inline from `useNodeTone` — the SAME value
// as the node chip's fill (one resolver, R3).
const NODE_BAND_CLASSES =
  "relative before:absolute before:-z-10 before:content-[''] before:pointer-events-none before:-left-2 before:-top-px before:-bottom-1 before:right-[calc(-1_*_(var(--icon-slot)_*_2_+_var(--icon-btn-size)_+_1rem))] before:bg-[var(--node-band)]";
// `before:pointer-events-none`: the band is a pseudo-element of row 2, which
// lives INSIDE the collapse toggle — without it, taps on the header padding,
// the gap beside the icons, or just below a disc would land on the band and
// collapse the project (they were inert header before the band existed).

// Solid 28px disc behind each header icon (operator rulings F1-a 28px /
// F2-a `--app-banner-bg` via `--header-icon-disc`), centered inside the
// unchanged 32px tap target so the band split never slices through a glyph.
// Hover lightens the disc only while the control is enabled.
function discClass(hoverable: boolean): string {
  return `flex h-7 w-7 items-center justify-center rounded-full bg-[var(--header-icon-disc)] transition-colors${
    hoverable ? " group-hover/disc:bg-[var(--header-icon-disc-hover)]" : ""
  }`;
}

// ── Project Header ──────────────────────────────────────────────────────

export function ProjectHeader(props: {
  group: SessionGroup;
  isCollapsed: boolean;
  /**
   * #3877: render a node badge on line 2 to disambiguate same-path/repo groups on
   * different federation nodes. Set true by the container ONLY when >1 distinct node
   * is present, so a single-node setup shows no badge (no behavioral change).
   */
  showNode?: boolean;
  onToggle: () => void;
  api: ApiClient | null;
  onRefresh: () => void;
  /**
   * Issue #3114: split drag-handle for always-armed project reorder. The
   * pointer/touch listeners arm a press-and-hold drag on the WHOLE header; the
   * keyboard `onKeyDown` + a11y `attributes` go on the col-1 chevron so keyboard
   * reorder stays on the handle (no Enter/Space collision with header toggle).
   * Supplied by SessionListContainer via SortableListEntry (always present now).
   */
  dragHandle?: SortableDragHandle;
}) {
  const { group, isCollapsed, showNode, onToggle, api, onRefresh, dragHandle } =
    props;
  // #3114: split the drag handle — pointer/touch (`dragRowListeners`) arm the whole
  // header; the keyboard handler + a11y attributes go on the chevron (keyboard reorder
  // handle). Interactive header children are excluded from BOTH drag-arming (the guarded
  // sensors) and the collapse toggle (the onClick guard below) via the shared
  // `isInteractiveTarget`, so the two rules can never diverge.
  const {
    attributes: dragAttributes,
    rowListeners: dragRowListeners,
    keyDown: dragKeyDown,
  } = splitDragHandle(dragHandle);
  const [disconnectAllOpen, setDisconnectAllOpen] = useState(false);
  const [deleteDisconnectedOpen, setDeleteDisconnectedOpen] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const { showToast } = useToast();

  // Inline project name editing
  const [isEditingName, setIsEditingName] = useState(false);
  const [editNameValue, setEditNameValue] = useState("");
  const [editNameError, setEditNameError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Repo URL comes from metadata (no lazy API call needed)
  const repoUrl = group.repoUrl;

  // Custom project name from localStorage (user-editable override)
  const storageKey = "hapi:projectGroupNames";
  const getCustomName = (): string | null => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (!stored) return null;
      const map = JSON.parse(stored) as Record<string, string>;
      // #3877: read-fallback to the pre-composite base key so a single-node user's
      // custom project name survives the key-format change (writes stay composite-keyed).
      return map[group.groupKey] ?? map[group.baseKey] ?? null;
    } catch {
      return null;
    }
  };
  const setCustomName = (name: string | null) => {
    try {
      const stored = localStorage.getItem(storageKey);
      const map: Record<string, string> = stored ? JSON.parse(stored) : {};
      if (name) {
        map[group.groupKey] = name;
      } else {
        delete map[group.groupKey];
      }
      localStorage.setItem(storageKey, JSON.stringify(map));
    } catch {
      // Silently ignore localStorage errors
    }
  };

  const displayName = getCustomName() ?? group.displayName;

  const handleStartNameEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditNameValue(displayName);
    setEditNameError(null);
    setIsEditingName(true);
  };

  const handleSaveNameEdit = () => {
    const trimmed = editNameValue.trim();
    // Empty or same as derived name → clear custom name
    if (!trimmed || trimmed === group.displayName) {
      setCustomName(null);
      setIsEditingName(false);
      setEditNameError(null);
      return;
    }
    // Validate: reuse session name validation (tmux-safe characters)
    const validationError = validateSessionName(trimmed);
    if (validationError) {
      setEditNameError(validationError);
      return;
    }
    setCustomName(trimmed);
    setIsEditingName(false);
    setEditNameError(null);
  };

  const handleCancelNameEdit = () => {
    setIsEditingName(false);
    setEditNameValue("");
    setEditNameError(null);
  };

  const handleNameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      handleSaveNameEdit();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      handleCancelNameEdit();
    }
  };

  // Auto-focus name input when editing starts
  useEffect(() => {
    if (isEditingName && nameInputRef.current) {
      nameInputRef.current.focus();
      nameInputRef.current.select();
    }
  }, [isEditingName]);

  // Count connected and disconnected sessions.
  // Schedulers (ScheduledTask[]) are a separate data type rendered via
  // schedulesByGroupKey — they never appear in group.sessions.
  const connectedSessions = group.sessions.filter(s => s.active);
  const disconnectedSessions = group.sessions.filter(s => !s.active);

  const handleDisconnectAll = async () => {
    if (!api || connectedSessions.length === 0) return;
    setIsPending(true);
    try {
      for (const session of connectedSessions) {
        await api.archiveSession(session.id);
      }
      onRefresh();
    } finally {
      setIsPending(false);
      setDisconnectAllOpen(false);
    }
  };

  const handleDeleteDisconnected = async () => {
    if (!api || disconnectedSessions.length === 0) return;
    setIsPending(true);
    try {
      // #3815: chunked by the 100-id server cap, and reported per session — a
      // skipped session is no longer silent.
      const results = await executeBulkSessionAction(
        api,
        "delete",
        disconnectedSessions.map(s => s.id)
      );
      onRefresh();
      const { message, type } = summarizeBulkSessionResult("delete", results);
      showToast(message, { type });
    } finally {
      setIsPending(false);
      setDeleteDisconnectedOpen(false);
    }
  };

  // Get display name for confirmations
  const projectName = group.displayName;

  // #4538: the node tone for the row-2 band. Resolved only when the node badge
  // is shown (showNode — >1 node present), so a single-node list never polls
  // the health list from the header and renders exactly as before (all purple).
  const bandNodeId = showNode && group.nodeId ? group.nodeId : undefined;
  const nodeTone = useNodeTone(bandNodeId, group.nodeStatus);
  // A null band = the node list is not known yet (first-ever load): draw no band
  // rather than a hue that is about to change.
  const bandStyle =
    bandNodeId && nodeTone?.band
      ? ({ "--node-band": nodeTone.band } as React.CSSProperties)
      : undefined;
  const showBand = bandStyle !== undefined;

  return (
    <>
      {/* design-system gap (#3038): the project-rail violet below has no token
          (not in the accent/status/session-rel families) — Sub B follow-up #3335;
          Tailwind v4's violet-600 is oklch-based, so a named-palette swap would
          change the color. Kept as-is pending a token. */}
      <div
        {...dragRowListeners}
        className="sticky top-0 z-10 flex w-full items-start gap-2 pl-2 pr-2 py-1 bg-[var(--brand-primary-dark)] text-white border-b-2 border-[#7c3aed]"
      >
        {/* Left side: toggle area — 2-line layout. #3114: a <div role="button">
            rather than a <button> so a press-and-hold anywhere on the name area
            arms a project drag (the guarded sensors exclude <button>, which would
            otherwise veto the whole header from arming). Tap toggles collapse. */}
        <div
          role="button"
          tabIndex={0}
          onClick={e => {
            if (isInteractiveTarget(e.target)) return;
            onToggle();
          }}
          onKeyDown={e => {
            // #3273: same guard as onClick — a keypress on a focusable child (pencil,
            // GitHub link, name-edit input) must not toggle collapse.
            if (isInteractiveTarget(e.target)) return;
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onToggle();
            }
          }}
          className="relative z-0 flex flex-col min-w-0 flex-1 hover:brightness-110 transition-colors text-left cursor-pointer select-none"
          title={group.directory}
        >
          {/* Line 1: Icon + repo/folder name (primary) */}
          <div className="flex items-center gap-1.5 min-w-0">
            {group.isRepo && repoUrl ? (
              <a
                href={repoUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={e => e.stopPropagation()}
                className="flex shrink-0 text-white/70 hover:text-white transition-colors"
                title={`Open ${group.displayName} on GitHub`}
              >
                <GitHubIcon className="h-3.5 w-3.5" />
              </a>
            ) : group.isRepo ? (
              <GitHubIcon className="h-3.5 w-3.5 text-white/70 shrink-0" />
            ) : (
              <FolderIcon className="h-3.5 w-3.5 text-white/70 shrink-0" />
            )}
            {isEditingName ? (
              <div
                className="flex flex-col gap-0.5 min-w-0"
                onClick={e => e.stopPropagation()}
              >
                <input
                  autoCapitalize="none"
                  ref={nameInputRef}
                  type="text"
                  value={editNameValue}
                  onChange={e => {
                    const v = e.target.value;
                    setEditNameValue(v);
                    const trimmed = v.trim();
                    setEditNameError(
                      trimmed.length === 0 ? null : validateSessionName(trimmed)
                    );
                  }}
                  onKeyDown={handleNameKeyDown}
                  onBlur={handleSaveNameEdit}
                  maxLength={SESSION_NAME_MAX_LENGTH}
                  className={`min-w-15 max-w-full text-sm font-bold leading-tight bg-white/20 text-white px-1 py-0.5 rounded outline-none border ${editNameError ? "border-red-500" : "border-white/40"}`}
                  aria-invalid={editNameError !== null}
                />
                {editNameError && (
                  /* design-system PERMANENT exception (#3336, from #3038 pilot):
                     9px inline-edit validation-error text sits below the type-scale
                     floor (--text-caption-xs = 10px); mapping up changes rendering.
                     Registered in docs/design/design-system/decision-typography.md
                     § Sub-floor type-size exceptions. */
                  <span className="text-[9px] text-red-500 whitespace-nowrap">
                    {editNameError}
                  </span>
                )}
              </div>
            ) : (
              // #3273: plain display span — a name-click now bubbles to the wrapper's
              // onClick (name is no longer an interactive target) and toggles collapse,
              // exactly like the path text; the pencil below is the edit affordance.
              <span className="truncate text-sm font-bold text-white leading-tight">
                {displayName}
              </span>
            )}
            {!isEditingName && (
              // #3273: E9 `.pencil` box (p-0.5 + 10px glyph) from SessionItem, on the header's white palette.
              <Button
                type="button"
                variant="ghost"
                onClick={handleStartNameEdit}
                aria-label="Edit project name"
                title="Edit project name"
                className="shrink-0 h-auto p-0.5 text-white/70 hover:text-white active:bg-white/10"
              >
                <PencilIcon className="h-2.5 w-2.5" />
              </Button>
            )}
          </div>
          {/* Line 2: Clock + timer + node badge + directory path (secondary).
              #4538: when the node badge is shown, this line also paints the NODE
              BAND — a full-bleed layer in the badge's own fill, from the header's
              left edge to its right edge UNDER the icon column (NODE_BAND_CLASSES),
              so two same-repo groups on different nodes read apart at a glance. */}
          <div
            className={`flex items-center gap-1.5 mt-0.5${
              showBand ? ` ${NODE_BAND_CLASSES}` : ""
            }`}
            style={bandStyle}
            data-testid="project-header-line-2"
          >
            {/* Issue #1892 (Sub H2): read-only per-project total — summed
                serverAccumulatedMs plus any live in-flight segments (rolled up
                inside ProjectTimer). The legacy reset-all-timers action operated
                on the deleted free-running client timers and was removed. */}
            <span className="flex items-center gap-1">
              <ClockIcon className="h-2.5 w-2.5 text-white/50 shrink-0" />
              <span className="text-[length:var(--text-caption)] text-white/50">
                <ProjectTimer sessions={group.sessions} />
              </span>
            </span>
            {/* #3877: node badge for same-path/repo disambiguation across federation
                nodes. Rendered only when >1 node is present (showNode) so a single-node
                setup shows no badge (no behavioral change). It sits BEFORE the path it
                qualifies, and carries the node's url + status so it resolves the same
                color as the session rows' badge; it shrink-wraps its label (no
                `fillCell`) where the rows use a fixed-width cell. */}
            {showNode && group.nodeId && (
              <NodeBadge
                nodeId={group.nodeId}
                nodeLabel={group.nodeLabel}
                nodeUrl={group.nodeUrl}
                nodeStatus={group.nodeStatus}
              />
            )}
            <span
              className="truncate text-[length:var(--text-caption)] text-white/50 leading-tight"
              title={group.directory}
            >
              {getShortPath(group.directory)}
            </span>
          </div>
        </div>

        {/* Right side: action buttons on solid discs (#4538). The always-on
            session-count badge that used to sit beneath this icon row (#3133) was
            removed from the project header on operator request — it made the
            header too busy, in both the expanded and collapsed states. (The badge
            still renders on the branch/managed-cluster and scheduler surfaces.)
            `relative z-10` lifts the whole icon column above the row-2 node band
            (z -10 inside the left column), so the discs float over the
            purple→band split instead of being sliced by it. */}
        <div className="relative z-10 shrink-0">
          <div
            className="icon-row"
            style={{
              width: "calc(var(--icon-slot) * 2 + var(--icon-btn-size))",
            }}
          >
            {/* #4538: the col-4 GitHub button is gone — the repo hotlink now lives
                in the expanded session details (SessionRepoRow); the name-line
                Octocat above still opens the repo. Three slots remain. */}
            {/* Disconnect All button — col-3 */}
            <div className="icon-col-3">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={e => {
                  e.stopPropagation();
                  setDisconnectAllOpen(true);
                }}
                disabled={connectedSessions.length === 0}
                className={
                  connectedSessions.length > 0
                    ? "group/disc text-white/70 hover:text-white hover:bg-transparent"
                    : "group/disc text-white/30 cursor-not-allowed disabled:opacity-100 hover:bg-transparent"
                }
                title={
                  connectedSessions.length > 0
                    ? `Disconnect all ${connectedSessions.length} active session${connectedSessions.length === 1 ? "" : "s"}`
                    : "No active sessions"
                }
              >
                <span
                  data-testid="header-icon-disc"
                  className={discClass(connectedSessions.length > 0)}
                >
                  <ChainIcon className="h-5 w-5" connected={false} />
                </span>
              </Button>
            </div>

            {/* Delete All Disconnected button — col-2 */}
            <div className="icon-col-2">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={e => {
                  e.stopPropagation();
                  setDeleteDisconnectedOpen(true);
                }}
                disabled={disconnectedSessions.length === 0}
                className={
                  disconnectedSessions.length > 0
                    ? "group/disc text-[var(--app-badge-error-text)] hover:text-[var(--app-badge-error-text)] hover:bg-transparent"
                    : "group/disc text-white/30 cursor-not-allowed disabled:opacity-100 hover:bg-transparent"
                }
                title={
                  disconnectedSessions.length > 0
                    ? `Delete all ${disconnectedSessions.length} disconnected session${disconnectedSessions.length === 1 ? "" : "s"}`
                    : "No disconnected sessions"
                }
              >
                <span
                  data-testid="header-icon-disc"
                  className={discClass(disconnectedSessions.length > 0)}
                >
                  <TrashIcon className="h-5 w-5" />
                </span>
              </Button>
            </div>

            {/* Expand/Collapse chevron — col-1 (rightmost). #3114: also the KEYBOARD
              project-reorder handle (a11y attributes + dnd-kit onKeyDown); pointer/
              touch reorder is armed by the whole header. Tap toggles collapse. */}
            <div className="icon-col-1">
              <button /* design-tokens-allow: dnd-kit keyboard reorder handle (#3114) — carries the sortable a11y {...dragAttributes} + dnd-kit onKeyDown; the guarded drag sensors EXCLUDE <button>, so converting would break keyboard drag (R3 off-limits) */
                type="button"
                {...dragAttributes}
                onKeyDown={dragKeyDown}
                onClick={e => {
                  e.stopPropagation();
                  onToggle();
                }}
                className="group/disc flex size-[var(--icon-btn-size)] items-center justify-center rounded-full text-white/70 hover:text-white transition-colors"
                title={isCollapsed ? "Expand project" : "Collapse project"}
                aria-label={isCollapsed ? "Expand project" : "Collapse project"}
              >
                <span
                  data-testid="header-icon-disc"
                  className={discClass(true)}
                >
                  <ChevronIcon
                    className="h-3.5 w-3.5"
                    collapsed={isCollapsed}
                  />
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Disconnect All confirmation */}
      <ConfirmDialog
        isOpen={disconnectAllOpen}
        onClose={() => setDisconnectAllOpen(false)}
        title="Disconnect All Sessions"
        description={`Disconnect all ${connectedSessions.length} active session${connectedSessions.length === 1 ? "" : "s"} in "${projectName}"?`}
        confirmLabel="Disconnect All"
        confirmingLabel="Disconnecting..."
        onConfirm={handleDisconnectAll}
        isPending={isPending}
      />

      {/* Delete All Disconnected confirmation */}
      <ConfirmDialog
        isOpen={deleteDisconnectedOpen}
        onClose={() => setDeleteDisconnectedOpen(false)}
        title="Delete Disconnected Sessions"
        description={`Delete all ${disconnectedSessions.length} disconnected session${disconnectedSessions.length === 1 ? "" : "s"} in "${projectName}"? This action cannot be undone.`}
        confirmLabel="Delete All"
        confirmingLabel="Deleting..."
        onConfirm={handleDeleteDisconnected}
        isPending={isPending}
        destructive
      />
    </>
  );
}
