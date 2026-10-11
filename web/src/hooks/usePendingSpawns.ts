// SPDX-License-Identifier: AGPL-3.0-only
import { useSyncExternalStore } from "react";
import {
  subscribePendingSpawns,
  getPendingSpawnsSnapshot,
  type PendingSpawn,
} from "@/lib/pending-spawns";

/**
 * Reactive hook for the pending spawns store.
 * Returns the current list of pending spawn stubs (spawning + failed).
 */
export function usePendingSpawns(): PendingSpawn[] {
  return useSyncExternalStore(subscribePendingSpawns, getPendingSpawnsSnapshot);
}
