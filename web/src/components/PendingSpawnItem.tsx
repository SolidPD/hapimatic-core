// SPDX-License-Identifier: AGPL-3.0-only
/**
 * PendingSpawnItem — Lightweight stub entry for remote sessions being spawned.
 *
 * Mimics SessionItem layout but uses NO API hooks (the session doesn't exist
 * yet). Shows spinner while spawning, error state on failure with dismiss.
 */

import type { PendingSpawn } from "@/lib/pending-spawns";
import { dismissPendingSpawn } from "@/lib/pending-spawns";
import { Spinner } from "@/components/Spinner";
import { NodeBadge } from "@/components/NodeBadge";
import { FolderIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";

function XIcon({ className }: { className?: string }): React.ReactElement {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function AlertCircleIcon({
  className,
}: {
  className?: string;
}): React.ReactElement {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

export function PendingSpawnItem({
  spawn,
}: {
  spawn: PendingSpawn;
}): React.ReactElement {
  const isFailed = spawn.state === "failed";
  const displayName = spawn.name || "New Session";
  const emoji = spawn.emoji ?? "🟢";
  const dirName =
    spawn.directory
      .split(/[\\/]+/)
      .filter(Boolean)
      .pop() ?? spawn.directory;

  return (
    <div
      className={`relative border-l-4 pr-2 py-1.5 text-left select-none ${
        isFailed
          ? "border-l-red-500/60 bg-red-950/20"
          : "border-l-[var(--app-hint)]/30 bg-[var(--app-bg)]"
      }`}
      style={{ paddingLeft: "8px" }}
    >
      <div className={`flex gap-2 min-w-0 ${isFailed ? "" : "opacity-50"}`}>
        {/* Left: Two rows mimicking SessionItem */}
        <div className="flex flex-col gap-0.5 min-w-0 flex-1">
          {/* Row 1: Spinner/error + Emoji + Name */}
          <div className="flex items-center gap-1 min-w-0">
            {/* Status indicator — sm spinner is h-4 w-4, match container */}
            <span className="flex h-4 w-4 items-center justify-center shrink-0">
              {isFailed ? (
                <AlertCircleIcon className="h-4 w-4 text-red-400" />
              ) : (
                <Spinner size="sm" label="Spawning session" />
              )}
            </span>

            {/* Emoji */}
            <span className="text-[length:var(--text-label-strong)] leading-tight shrink-0">
              {emoji}
            </span>

            {/* Name */}
            <span className="truncate text-[length:var(--text-label-strong)] font-medium leading-tight px-1 py-0.5 -mx-1">
              {displayName}
            </span>
          </div>

          {/* Row 2: Directory path + status text */}
          <div className="flex items-center gap-2 min-w-0">
            <span className="flex h-3 w-3 items-center justify-center shrink-0">
              <FolderIcon className="h-3 w-3 text-[var(--app-hint)]" />
            </span>
            <div className="flex flex-wrap items-center gap-x-1 text-[length:var(--text-body-dense)] text-[var(--app-hint)] min-w-0">
              <span
                className="shrink-0 text-[length:var(--text-caption-xs)]"
                title={spawn.directory}
              >
                {dirName}
              </span>
              <span className="shrink-0 text-[length:var(--text-caption-xs)]">
                ·
              </span>
              {isFailed ? (
                <span className="shrink-0 text-[length:var(--text-caption-xs)] text-red-400">
                  {spawn.error ?? "Spawn failed"}
                </span>
              ) : (
                <span className="shrink-0 text-[length:var(--text-caption-xs)] text-[var(--app-hint)]">
                  Creating on remote node…
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Right: Node badge + dismiss button */}
        <div className="flex flex-col items-end gap-0.5 shrink-0 self-center">
          <NodeBadge nodeId={spawn.nodeId} nodeLabel={spawn.nodeLabel} />
          {isFailed && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => dismissPendingSpawn(spawn.id)}
              className="flex h-5 w-5 items-center justify-center rounded p-0 font-normal text-red-400 hover:bg-red-500/20 hover:text-red-300"
              title="Dismiss"
            >
              <XIcon className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
