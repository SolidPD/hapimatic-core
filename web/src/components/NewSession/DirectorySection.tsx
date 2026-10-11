// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import type { ApiClient } from "@/api/client";
import { CONTROL_BASE } from "./controls";
import { DirectoryBrowser } from "./DirectoryBrowser";
import { FormField } from "./FormField";
import { Button } from "@/components/ui/button";
import { BareButton } from "@/components/ui/BareButton";

/**
 * Directory picker for the Create-Session form (issue #2019).
 *
 * A field-button (NOT an inline-editable input): tapping it opens the
 * `DirectoryBrowser` modal, which owns ALL directory entry — browsing,
 * typing/pasting an exact path, and the recent-paths list. The bar itself is a
 * pure display + tap-trigger. This dissolves the prior z-index bug: there is no
 * longer an absolutely-positioned recent-paths/suggestions dropdown inside the
 * accordion to be clipped by the footer.
 */
export function DirectorySection(props: {
  api: ApiClient;
  machineId: string | null;
  nodeId?: string | null;
  /** #2533: the selected node's home dir — seeds the browser's start path when
   *  the Directory field is empty (a remote node's real home, not the hub's). */
  nodeHomeDir?: string;
  directory: string;
  isDisabled: boolean;
  onDirectoryChange: (value: string) => void;
  /** Recently-used directories — surfaced in the browser's path-bar dropdown. */
  recentPaths?: readonly string[];
  /** Record a directory as recent when the user Selects it (A2, #2412). */
  onAddRecentPath?: (path: string) => void;
  /** Remove a path from the recent list (drives the browser's per-entry ✕). */
  onRemoveRecentPath?: (path: string) => void;
}) {
  const [isBrowserOpen, setIsBrowserOpen] = useState(false);

  const canBrowse = !props.isDisabled && (!!props.machineId || !!props.nodeId);

  const handleBrowseClick = () => {
    if (canBrowse) {
      setIsBrowserOpen(true);
    }
  };

  const handleBrowserSelect = (path: string) => {
    props.onDirectoryChange(path);
    // A2 (#2412): confirming a directory records it as a recent — the "recently
    // selected paths" the picker-first Recents panel surfaces. Fires only on the
    // explicit Select action (not the Clear button, which passes ""), and spawn
    // still records too (index.tsx), so launched dirs remain a superset.
    props.onAddRecentPath?.(path);
  };

  return (
    <div className="flex flex-col gap-1 px-3 py-1.5">
      <FormField
        label="Directory"
        tooltip="The project folder the session starts in on the selected node. The agent reads and writes files here, and git operations run against this folder's repository. Tap to browse the node's filesystem, type an exact path, or pick a recent one."
        bookmarkId="directory"
      >
        {/* Inline clear: the × sits INSIDE the field (absolute, right edge) —
            a sibling of the browse button, never a child (nested interactive
            elements are invalid HTML). pr-9 keeps the path clear of the ×. */}
        <div className="relative">
          <BareButton
            type="button"
            onClick={handleBrowseClick}
            disabled={!canBrowse}
            title="Browse directories"
            aria-label="Browse directories"
            className={`${CONTROL_BASE} flex items-center gap-2 px-2.5 text-left font-normal ${
              props.directory && !props.isDisabled ? "pr-9" : ""
            }`}
          >
            <svg
              className="h-4 w-4 shrink-0 text-[var(--app-hint)]"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2z" />
            </svg>
            <span
              className={`flex-1 truncate ${
                props.directory ? "" : "text-[var(--app-hint)]"
              }`}
            >
              {props.directory || "/path/to/project"}
            </span>
          </BareButton>
          {props.directory && !props.isDisabled && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => props.onDirectoryChange("")}
              title="Clear directory"
              aria-label="Clear directory"
              className="absolute right-1.5 top-1/2 h-auto -translate-y-1/2 rounded p-1"
            >
              <svg
                className="h-3.5 w-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </Button>
          )}
        </div>
      </FormField>

      {isBrowserOpen && (props.machineId || props.nodeId) && (
        <DirectoryBrowser
          api={props.api}
          machineId={props.machineId}
          nodeId={props.nodeId}
          initialPath={props.directory || props.nodeHomeDir || "/"}
          recentPaths={props.recentPaths}
          onRemoveRecentPath={props.onRemoveRecentPath}
          onSelect={handleBrowserSelect}
          onClose={() => setIsBrowserOpen(false)}
        />
      )}
    </div>
  );
}
