// SPDX-License-Identifier: AGPL-3.0-only
import type { ApiClient } from "@/api/client";
import { useDaemonCapacity } from "@/hooks/queries/useDaemonCapacity";

/**
 * Spawn-capacity source for the Create page's `CapacityNotice` (#4417, Task 8, R5).
 *
 * For a LOCAL target it polls the daemon via `useDaemonCapacity` (15 s); for a REMOTE
 * target it reads the already-polled federation summary fields off the selected node.
 * The result is ADVISORY only — the daemon gate stays the sole enforcement, so a missing
 * field degrades to "no notice", never to a blocked spawn.
 *
 * Extraction pattern mirrors `NewSession/useGitHubSection.ts`: the hook owns the data and
 * the pure `computeCapacityNotice` owns the decision, keeping `NewSession/index.tsx` to a
 * mount line.
 */
export interface SpawnCapacity {
  effectiveCount: number | null;
  recommended: number | null;
  max: number | null;
}

/** The selected spawn target's capacity inputs. Remote nodes carry the federation
 *  summary's optional capacity fields (undefined for a pre-#4417 peer). */
export type SpawnCapacityTarget =
  | { kind: "local" }
  | {
      kind: "remote";
      node: {
        effectiveCount?: number;
        recommendedConcurrent?: number;
        maxConcurrent?: number;
      };
    }
  | null;

export type CapacityNoticeState =
  | { kind: "none" }
  | { kind: "warn"; effectiveCount: number; recommended: number }
  | { kind: "refuse"; effectiveCount: number; max: number };

/**
 * Decide the Create-page notice from a capacity reading. Pure + exhaustively tested.
 * - `effectiveCount >= max` → refusal copy (the daemon gate would reject the spawn).
 * - else `effectiveCount >= recommended` → a non-blocking warning.
 * - else / unknown → no notice.
 *
 * Refusal is checked FIRST so that when `recommended === max` (the default layer, or an
 * explicit env/settings cap at or below the derived recommendation) the two states
 * coincide and the refusal copy wins — the warning is not also shown (directive 4417-11).
 */
export function computeCapacityNotice(cap: SpawnCapacity): CapacityNoticeState {
  const { effectiveCount, recommended, max } = cap;
  if (effectiveCount == null) return { kind: "none" };
  if (max != null && effectiveCount >= max) {
    return { kind: "refuse", effectiveCount, max };
  }
  if (recommended != null && effectiveCount >= recommended) {
    return { kind: "warn", effectiveCount, recommended };
  }
  return { kind: "none" };
}

/**
 * Resolve the live capacity for the selected spawn target. `useDaemonCapacity` is called
 * unconditionally (hook rule) but enabled only for a local target; a remote target reads
 * the summary fields passed in.
 */
export function useSpawnCapacity(
  api: ApiClient | null,
  target: SpawnCapacityTarget
): SpawnCapacity {
  const isLocal = target?.kind === "local";
  const local = useDaemonCapacity(api, { enabled: isLocal });

  if (target?.kind === "remote") {
    return {
      effectiveCount: target.node.effectiveCount ?? null,
      recommended: target.node.recommendedConcurrent ?? null,
      max: target.node.maxConcurrent ?? null,
    };
  }
  if (isLocal && local.data) {
    return {
      effectiveCount: local.data.effectiveCount,
      recommended: local.data.recommendedConcurrent,
      max: local.data.maxConcurrent,
    };
  }
  return { effectiveCount: null, recommended: null, max: null };
}
