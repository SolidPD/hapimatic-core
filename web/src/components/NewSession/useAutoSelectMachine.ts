// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect } from "react";
import type { Machine } from "@/types/api";
import { MACHINE_PREFIX } from "./MachineSelector";

/**
 * Auto-select a local machine on the Create page once machines load (extracted
 * from `index.tsx` for #2930). Keeps a still-valid current selection, never
 * overrides a remote-node target, and otherwise prefers the last-used machine,
 * falling back to the first available. Drives the caller's `selectedValue` via
 * the passed setter.
 */
export function useAutoSelectMachine(opts: {
  machines: Machine[];
  localMachineId: string | null;
  isRemoteTarget: boolean;
  getLastUsedMachineId: () => string | null;
  setSelectedValue: (value: string) => void;
}): void {
  const {
    machines,
    localMachineId,
    isRemoteTarget,
    getLastUsedMachineId,
    setSelectedValue,
  } = opts;

  // Auto-select first machine when machines load
  useEffect(() => {
    if (machines.length === 0) return;
    // If current selection is already a valid local machine, keep it
    if (localMachineId && machines.find(m => m.id === localMachineId)) {
      return;
    }
    // If current selection is a remote node, don't override it
    if (isRemoteTarget) return;

    const lastUsed = getLastUsedMachineId();
    const foundLast = lastUsed ? machines.find(m => m.id === lastUsed) : null;

    if (foundLast) {
      setSelectedValue(`${MACHINE_PREFIX}${foundLast.id}`);
    } else if (machines[0]) {
      setSelectedValue(`${MACHINE_PREFIX}${machines[0].id}`);
    }
  }, [
    machines,
    localMachineId,
    isRemoteTarget,
    getLastUsedMachineId,
    setSelectedValue,
  ]);
}
