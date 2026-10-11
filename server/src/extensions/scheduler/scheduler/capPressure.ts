// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Cap-pressure reading for the scheduler (#2703, epic #2698 L4).
 *
 * L4 is a cooperative SOFT layer above the daemon's three spawn gates, which
 * it never changes: the quiesce flag, the hard cap
 * `effectiveCount >= maxConcurrent`, and the per-schedule spawn rate limit
 * (`cli/src/daemon/sessionSpawner.ts`). Under pressure the scheduler defers
 * its own spawns and reaps its own idle sessions sooner, so slots stay free for
 * interactive / PM work.
 *
 * Every failure fails OPEN ("no pressure"): the daemon gates still bound the
 * node, so a broken reading can only lose the optimisation, never over-spawn
 * or wrongly reap.
 *
 * Local-only by design: `getDaemonCapacity()` measures the LOCAL daemon, so a
 * reading says nothing about another machine. `isPressureOnMachine` applies it
 * only to the local machine; any other machine — or an unknown local id — is
 * treated as not under pressure, and that machine's own hard cap protects it.
 *
 * Staleness: after a reap, `effectiveCount` can keep counting the reaped
 * session for up to ~60 s (tracked-PID cleanup), so the next tick may still
 * read pressure. The only cost is one more deferred run, which re-arms.
 */

import { readSettings } from "../../../config/settings";
import { configuration } from "../../../configuration";
import {
  getDaemonCapacity,
  type DaemonCapacityResult,
} from "../../../utils/daemonControlClient";
import { SCHEDULER_CAP_PRESSURE_HEADROOM } from "./types";

export type PressureReading =
  | {
      available: true;
      underPressure: boolean;
      effectiveCount: number;
      maxConcurrent: number;
      floor: number;
      /** This node's daemon machine id, or null when it cannot be read. */
      localMachineId: string | null;
    }
  | { available: false; reason: string };

export type PressureDeps = {
  getCapacity: () => Promise<DaemonCapacityResult>;
  getLocalMachineId: () => Promise<string | null>;
  headroom: number;
};

/** A lazily-evaluated reading; one reader instance issues at most one read. */
export type PressureReader = () => Promise<PressureReading>;

/**
 * The live-session count at which the node is under pressure. Never below 1,
 * so a node with no live sessions is never under pressure — even when the cap
 * is at or below the headroom (a small Pi cap would otherwise yield forever).
 */
export function computePressureFloor(
  maxConcurrent: number,
  headroom: number
): number {
  return Math.max(1, maxConcurrent - headroom);
}

/** Read the local node's pressure state. Never throws. */
export async function readCapPressure(
  deps: PressureDeps
): Promise<PressureReading> {
  try {
    const capacity = await deps.getCapacity();
    if ("error" in capacity) {
      return { available: false, reason: capacity.error };
    }
    const { effectiveCount, maxConcurrent } = capacity;
    if (!Number.isFinite(effectiveCount) || !Number.isFinite(maxConcurrent)) {
      return { available: false, reason: "non-finite capacity reading" };
    }
    let localMachineId: string | null = null;
    try {
      localMachineId = (await deps.getLocalMachineId()) || null;
    } catch {
      localMachineId = null;
    }
    const floor = computePressureFloor(maxConcurrent, deps.headroom);
    return {
      available: true,
      underPressure: effectiveCount >= floor,
      effectiveCount,
      maxConcurrent,
      floor,
      localMachineId,
    };
  } catch (err) {
    return {
      available: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * THE locality predicate for both L4 actions (spawn defer and accelerated
 * reap): true only when the reading is available, under pressure, and the
 * given machine is this node's own daemon machine.
 */
export function isPressureOnMachine(
  reading: PressureReading | undefined,
  machineId: string | undefined
): boolean {
  return (
    reading !== undefined &&
    reading.available &&
    reading.underPressure &&
    reading.localMachineId !== null &&
    machineId === reading.localMachineId
  );
}

/**
 * A reader that performs the read on first call and returns the same promise
 * afterwards, so one scheduler tick issues at most one `/effective-count` POST
 * and every decision in the tick sees the same reading.
 */
export function createTickPressureReader(deps: PressureDeps): PressureReader {
  let reading: Promise<PressureReading> | null = null;
  return () => {
    reading ??= readCapPressure(deps);
    return reading;
  };
}

/** Production dependencies: the local daemon + the shared settings.json. */
export function defaultPressureDeps(): PressureDeps {
  return {
    getCapacity: getDaemonCapacity,
    getLocalMachineId: async () => {
      try {
        return (
          (await readSettings(configuration.settingsFile))?.machineId ?? null
        );
      } catch {
        return null;
      }
    },
    headroom: SCHEDULER_CAP_PRESSURE_HEADROOM,
  };
}
