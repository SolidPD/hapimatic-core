// SPDX-License-Identifier: AGPL-3.0-only
/**
 * SessionIdDisplay - Toggle display between the Hapimatic short ID and the
 * harness's NATIVE session ID, labelled "CLI ID" (issue #3811 made it
 * harness-neutral; issue #4479 fixed the label to "CLI ID").
 *
 * The native id + its tooltip come from the flavor's `nativeSessionId`
 * manifest descriptor, resolved by the caller (`SessionExpandedDetails` via
 * `resolveNativeSessionId`) and passed in as `nativeId` / `nativeIdDescription`.
 * A flavor with no descriptor (`hasNativeId=false`, e.g. a tier-2 CLI) shows
 * only the Hapimatic short ID.
 *
 * Features:
 * - Click/tap on the ID row shows a dialog with both IDs
 * - Auto-copies the currently displayed ID to clipboard
 * - Dialog provides options to: switch display type, copy either ID, or close
 * - The row always shows the monitor icon; only the ID text changes on toggle
 *   (#4479)
 * - Defaults to Hapimatic short ID (always available)
 * - Preference persisted to localStorage as "cli" | "hapi" (#4479)
 *
 * Layout (#4479): rendered in the RIGHT column of SessionExpandedDetails,
 * beneath the Session Action Cluster. The row is width-pinned to the column so
 * a long CLI ID cannot widen it (clipped by FadeTruncate), and the button
 * carries an invisible 32px hit band (`before:` pseudo-element) that adds no
 * layout and stops at the cluster's bottom edge.
 */

import { useState } from "react";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { useSessionIdDisplayType } from "@/hooks/useSessionIdDisplayType";
import { Button } from "@/components/ui/button";
import { MonitorIcon, TerminalIcon } from "@/components/icons";
import { FadeTruncate } from "@/components/session/FadeTruncate";

type SessionIdDisplayProps = {
  /** Hapimatic short ID - "hapi-" prefix + first 8 chars of session.id (e.g., "hapi-2d9e7b12") */
  hapiShortId: string | undefined;
  /** The flavor's native session id (Claude UUID / codex threadId / ACP session
   *  id), resolved from the flavor's `nativeSessionId` manifest descriptor.
   *  undefined = not yet available OR the flavor has no native-id descriptor. */
  nativeId: string | undefined;
  /** Long tooltip/description of the native id (e.g. "Claude session ID (UUID
   *  from Claude Code)") — surfaced as a hover title on the dialog's native-id row. */
  nativeIdDescription?: string;
  /** True when the flavor declares a native-session-id descriptor (mode "native").
   *  False (absent / tier-2 CLI) → the toggle is hidden and only the Hapimatic
   *  short ID is shown, WITHOUT overwriting the persisted display preference (R4). */
  hasNativeId: boolean;
};

// Copy icon for dialog buttons
function CopyIcon(props: { className?: string; size?: number }) {
  const size = props.size ?? 14;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

// Toggle/swap icon for dialog button
function ToggleIcon(props: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
    >
      <polyline points="17 1 21 5 17 9" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <polyline points="7 23 3 19 7 15" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </svg>
  );
}

// X icon for close button
function XIcon(props: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

// Check icon for copied state
function CheckIcon(props: { className?: string; size?: number }) {
  const size = props.size ?? 14;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export function SessionIdDisplay({
  hapiShortId,
  nativeId,
  nativeIdDescription,
  hasNativeId,
}: SessionIdDisplayProps) {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const { copied, copy } = useCopyToClipboard();
  const [copiedId, setCopiedId] = useState<"hapi" | "native" | null>(null);
  const [idDisplayType, toggleIdDisplayType] = useSessionIdDisplayType();

  // Determine what to display based on preference. When the flavor has no
  // native-id descriptor (absent / tier-2), force the Hapimatic view WITHOUT
  // mutating the stored preference — returning to a session whose flavor has a
  // native id restores the user's selection (#3811 R4).
  const showingHapi = hasNativeId ? idDisplayType === "hapi" : true;
  const currentId = showingHapi ? hapiShortId : nativeId;
  const currentLabel = showingHapi ? "Hapimatic ID" : "CLI ID";

  // Handle opening dialog - auto-copy current ID
  const handleOpenDialog = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (currentId) {
      copy(currentId);
      setCopiedId(showingHapi ? "hapi" : "native");
    }
    setIsDialogOpen(true);
  };

  // Handle copy Hapimatic ID
  const handleCopyHapi = () => {
    if (hapiShortId) {
      copy(hapiShortId);
      setCopiedId("hapi");
    }
  };

  // Handle copy native session ID
  const handleCopyNative = () => {
    if (nativeId) {
      copy(nativeId);
      setCopiedId("native");
    }
  };

  // Handle toggle display type
  const handleToggle = () => {
    toggleIdDisplayType();
    setIsDialogOpen(false);
  };

  // Handle close dialog
  const handleClose = () => {
    setIsDialogOpen(false);
    setCopiedId(null);
  };

  // Handle backdrop click
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      handleClose();
    }
  };

  return (
    <>
      {/* Width pin (#4479 R4): `w-0` contributes nothing to the right column's
          intrinsic width, and `min-w-full` then fills the width set by the
          column's other children (the action cluster, or the harness line if
          that is wider) — so a UUID-length CLI ID can never widen the column. */}
      <div className="w-0 min-w-full">
        {/* The WHOLE row is the button (icon inside) so the `before:` hit band
            spans the full column width AND resolves to the button — the list
            card's row-navigation guard (`isInteractiveTarget`) ignores taps on
            it. Band = 8px up (`-top-2`: exactly the column's gap-2, ending at
            the cluster's bottom edge, never over chain/trash/kebab) + 13px
            down (`-bottom-3.25`: into the display-only harness line) ≈ 32px
            on an ~11px row. */}
        <Button
          type="button"
          variant="ghostStatic"
          onClick={handleOpenDialog}
          data-testid="session-id-trigger"
          className="relative flex w-full h-auto min-w-0 items-center justify-start gap-1 p-0 pl-1.5 text-left text-[9px] leading-tight font-normal cursor-pointer hover:text-[var(--app-fg)] before:absolute before:inset-x-0 before:-top-2 before:-bottom-3.25 before:content-['']" /* design-tokens-allow: 9px sub-caption metadata size; no exact type-scale token (ladder floor is 10px) - L2 exception (#3404), same as SessionModelInfo */
          title={currentId ?? `Tap for ID options (${currentLabel})`}
        >
          {/* Always the monitor icon (#4479 R2) — only the text toggles. */}
          <MonitorIcon className="size-2.75 shrink-0 text-[var(--app-hint)]" />
          {copied && !isDialogOpen ? (
            <span className="text-[var(--app-badge-success-text)]">
              Copied!
            </span>
          ) : currentId ? (
            <FadeTruncate>{currentId}</FadeTruncate>
          ) : showingHapi ? (
            <span className="italic truncate">No Hapimatic ID</span>
          ) : (
            <span className="italic truncate">Retrieving session ID...</span>
          )}
        </Button>
      </div>

      {/* Dialog overlay */}
      {isDialogOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={handleBackdropClick}
        >
          <div
            className="bg-[var(--app-bg)] border border-[var(--app-border)] rounded-lg shadow-xl mx-4 max-w-sm w-full"
            onClick={e => e.stopPropagation()}
          >
            {/* Dialog header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--app-border)]">
              <h3 className="text-sm font-medium text-[var(--app-fg)]">
                Session IDs
              </h3>
              <Button
                type="button"
                variant="ghost"
                onClick={handleClose}
                className="h-auto p-1 rounded font-normal hover:text-[var(--app-hint)]"
              >
                <XIcon />
              </Button>
            </div>

            {/* Dialog content */}
            <div className="px-4 py-3 space-y-3">
              {/* Hapimatic ID row */}
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <MonitorIcon className="size-2.75 text-[var(--app-hint)] shrink-0" />
                  <div className="min-w-0">
                    <div className="text-[length:var(--text-caption-xs)] text-[var(--app-hint)] uppercase tracking-wide">
                      Hapimatic ID
                    </div>
                    <div className="text-xs text-[var(--app-fg)] font-mono truncate">
                      {hapiShortId ?? (
                        <span className="italic text-[var(--app-hint)]">
                          Not available
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={handleCopyHapi}
                  disabled={!hapiShortId}
                  className="flex h-auto items-center gap-1 px-2 py-1 text-[length:var(--text-caption)] rounded font-normal bg-[var(--app-hover)] hover:bg-[var(--app-border)] disabled:cursor-not-allowed text-[var(--app-fg)]"
                >
                  {copiedId === "hapi" ? (
                    <>
                      <CheckIcon className="text-[var(--app-badge-success-text)]" />
                      <span className="text-[var(--app-badge-success-text)]">
                        Copied
                      </span>
                    </>
                  ) : (
                    <>
                      <CopyIcon />
                      <span>Copy</span>
                    </>
                  )}
                </Button>
              </div>

              {/* Native session ID row — driven by the flavor's descriptor.
                  Hidden for a flavor with no descriptor (absent / tier-2) so only
                  the Hapimatic short ID shows (#3811 R4). */}
              {hasNativeId && (
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <TerminalIcon className="size-2.75 text-[var(--app-hint)] shrink-0" />
                    <div className="min-w-0">
                      <div
                        className="text-[length:var(--text-caption-xs)] text-[var(--app-hint)] uppercase tracking-wide"
                        title={nativeIdDescription}
                      >
                        CLI ID
                      </div>
                      <div className="text-xs text-[var(--app-fg)] font-mono truncate">
                        {nativeId ?? (
                          <span className="italic text-[var(--app-hint)]">
                            Retrieving...
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={handleCopyNative}
                    disabled={!nativeId}
                    className="flex h-auto items-center gap-1 px-2 py-1 text-[length:var(--text-caption)] rounded font-normal bg-[var(--app-hover)] hover:bg-[var(--app-border)] disabled:cursor-not-allowed text-[var(--app-fg)]"
                  >
                    {copiedId === "native" ? (
                      <>
                        <CheckIcon className="text-[var(--app-badge-success-text)]" />
                        <span className="text-[var(--app-badge-success-text)]">
                          Copied
                        </span>
                      </>
                    ) : (
                      <>
                        <CopyIcon />
                        <span>Copy</span>
                      </>
                    )}
                  </Button>
                </div>
              )}
            </div>

            {/* Dialog footer */}
            <div className="px-4 py-3 border-t border-[var(--app-border)] flex gap-2">
              {/* Toggle hidden for a flavor with no native-id descriptor
                  (absent / tier-2) — nothing to switch to (#3811 R4). */}
              {hasNativeId && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={handleToggle}
                  className="flex-1 flex h-auto items-center justify-center gap-2 px-3 py-2 text-xs rounded font-normal bg-[var(--app-hover)] hover:bg-[var(--app-border)] text-[var(--app-fg)]"
                >
                  <ToggleIcon />
                  <span>Switch to {showingHapi ? "CLI" : "Hapimatic"} ID</span>
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                onClick={handleClose}
                className="h-auto px-4 py-2 text-xs rounded font-normal bg-[var(--app-badge-success-bg)] text-[var(--app-badge-success-text)] hover:bg-[var(--app-badge-success-bg)] hover:text-[var(--app-badge-success-text)] hover:opacity-80"
              >
                Close
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
