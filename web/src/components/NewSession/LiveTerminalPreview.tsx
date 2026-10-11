// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo } from "react";
import {
  assembleSpawnCommand,
  buildSpawnInput,
  type SpawnDisplayContext,
  type SpawnSelections,
} from "./spawnCommand";

/**
 * #1949 A2 — Live Terminal Preview.
 *
 * Renders the literal `hapi spawn` command assembled from the user's current
 * selections, styled like a terminal block. Presentation-only: it reads NO form
 * state directly — it derives the command from the same `SpawnSelections` /
 * `buildSpawnInput` source the real spawn uses, so preview ⟷ spawn cannot diverge
 * (R4). No chips/badges are rendered (R5) — command line(s) only.
 *
 * Pinning is owned by the parent (NewSession index.tsx) so the Create button can
 * share the same sticky footer directly below this preview (R2/R3).
 */
export function LiveTerminalPreview(props: {
  selections: SpawnSelections;
  display: SpawnDisplayContext;
}) {
  const command = useMemo(
    () =>
      assembleSpawnCommand(buildSpawnInput(props.selections), props.display),
    [props.selections, props.display]
  );

  return (
    <div className="px-3 pt-2">
      <div
        role="region"
        aria-label="Spawn command preview"
        className="overflow-x-auto rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2"
      >
        <pre className="m-0 whitespace-pre font-mono text-[length:var(--text-caption)] leading-relaxed text-[var(--app-fg)]">
          {command}
        </pre>
      </div>
    </div>
  );
}
