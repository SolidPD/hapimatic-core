// SPDX-License-Identifier: AGPL-3.0-only
import type { GatedReportKind } from "../../../sync/runnerIdentity";
import type { SocketWithData } from "../../socketTypes";

/** The registry's per-event backstop, as a handler file is given it. */
export type GateReportFn = (
  socket: SocketWithData,
  sid: string,
  kind: GatedReportKind
) => boolean;

/** After a drop was answered, cut its socket off when its session refuses it. */
export type AfterDroppedReportFn = (socket: SocketWithData) => void;

export type ReportGate = {
  /** True when the report goes ahead; false only for a drop in `enforce`. */
  gate: (sid: string, kind: GatedReportKind) => boolean;
  /** Called once a dropped report was answered (R5, #6974 O6). */
  dropped: () => void;
};

/**
 * Issue #6647 (Tasks 6 and 12, R7, R11), shared by every `/cli` handler file
 * since #6974 (Task 3): the runner identity backstop, asked after a handler's
 * own parse and access checks. A drop answers the report first and then calls
 * `dropped`, which cuts the socket off when its own session refuses it. A
 * throw here must never reach a listener (an uncaught throw on a listener
 * exits the server), so both fail open.
 */
export function createReportGate(
  socket: SocketWithData,
  gateReport?: GateReportFn,
  afterDroppedReport?: AfterDroppedReportFn
): ReportGate {
  const gate = (sid: string, kind: GatedReportKind): boolean => {
    try {
      return gateReport?.(socket, sid, kind) ?? true;
    } catch {
      return true;
    }
  };
  const dropped = (): void => {
    try {
      afterDroppedReport?.(socket);
    } catch {
      // Fail open: the socket stays connected; its next report is dropped too.
    }
  };
  return { gate, dropped };
}
