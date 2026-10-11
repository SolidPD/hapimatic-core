// SPDX-License-Identifier: AGPL-3.0-only
import { computeCapacityNotice, type SpawnCapacity } from "./useSpawnCapacity";

/**
 * Create-page spawn-capacity notice (#4417, Task 8, R5). ADVISORY ONLY — it never
 * disables the Create button; the daemon gate is the sole enforcement. Renders nothing
 * when capacity is unknown or below the recommended count; a non-blocking amber warning
 * at `effectiveCount ≥ recommended`; and a red "will be refused" notice at
 * `effectiveCount ≥ max`. When `recommended === max` (the default layer, or an explicit
 * cap at or below the derived recommendation) the refusal copy wins — see
 * `computeCapacityNotice`.
 *
 * Styling mirrors the existing NewSession amber-warning / red-error patterns.
 */
export function CapacityNotice({ capacity }: { capacity: SpawnCapacity }) {
  const state = computeCapacityNotice(capacity);

  if (state.kind === "none") return null;

  if (state.kind === "refuse") {
    return (
      <div
        role="alert"
        className="mx-3 mb-1 shrink-0 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-[length:var(--text-caption)] leading-snug text-red-400"
      >
        At capacity ({state.effectiveCount}/{state.max}) — this spawn will be
        refused. Stop a session on this machine first.
      </div>
    );
  }

  return (
    <div
      role="status"
      className="mx-3 mb-1 shrink-0 rounded-md border border-amber-400/30 bg-amber-400/10 px-2.5 py-1.5 text-[length:var(--text-caption)] leading-snug text-amber-300/90"
    >
      Approaching capacity ({state.effectiveCount}/{state.recommended}{" "}
      recommended) — spawning more sessions on this machine may slow it down.
    </div>
  );
}
