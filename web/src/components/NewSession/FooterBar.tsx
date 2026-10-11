// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { ChevronIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { LiveTerminalPreview } from "./LiveTerminalPreview";
import type { SpawnDisplayContext, SpawnSelections } from "./spawnCommand";
import type { SessionMode } from "./types";

/**
 * The pinned-footer utility row: the Terminal Command preview toggle
 * (standard mode only — scheduled runs have no spawn command). Extracted from
 * `index.tsx` (Create-page defaults round, `max-lines` guardrail); the
 * collapsed-by-default preview state is local UI state and lives here. The
 * saved-defaults bulk actions moved to `DefaultsActionsBar` at the top of the
 * form.
 */
export function FooterBar(props: {
  sessionMode: SessionMode;
  selections: SpawnSelections;
  display: SpawnDisplayContext;
}) {
  const [showTerminalCommand, setShowTerminalCommand] = useState(false);

  if (props.sessionMode !== "standard") return null;

  return (
    <div className="border-b border-[var(--app-divider)]">
      <Button
        type="button"
        variant="ghostStatic"
        onClick={() => setShowTerminalCommand(v => !v)}
        className="flex h-auto w-full items-center justify-start gap-1.5 rounded-none px-3 py-1 text-left text-xs font-medium text-[var(--app-hint)] hover:text-[var(--app-fg)]"
        aria-expanded={showTerminalCommand}
      >
        <ChevronIcon
          className="h-3 w-3 shrink-0"
          collapsed={!showTerminalCommand}
        />
        <span className="whitespace-nowrap">Terminal Command</span>
      </Button>
      {showTerminalCommand && (
        <div className="pb-1.5">
          <LiveTerminalPreview
            selections={props.selections}
            display={props.display}
          />
        </div>
      )}
    </div>
  );
}
