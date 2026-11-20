// SPDX-License-Identifier: AGPL-3.0-only
import type { Store } from "../store";

/**
 * Issue #6778 (plan section 3.4, "Rows at start-up"): the ONE function that
 * writes billable-tracking rows at start-up. `server/src/index.ts` calls it
 * once, between `new Store` and `resolveBillableSwitchGate`, inside a `try`.
 * The Store's migrations write no row ("DDL only", #6586's rule), because they
 * also run in every test, rig and tool that opens a Store.
 *
 * PR-A runs step 4 only, the header retirement (R12): every header row that is
 * on is switched off with one `header-off` event (reason `retired`), and every
 * stored header row of another node's report is deleted
 * (`BillableSwitchStore.retireHeaders`), so a previous binary after a roll back
 * starts nothing billable from either. It runs only when the switch schema is
 * there (`billableSwitchStorageReady`). A failure is written to the error log,
 * leaves the gate as it is (PR-A's start rule reads no header) and is tried
 * again at the next boot. PR-B adds the reconcile here (steps 5 and 6).
 */

export type BillableTrackingStartupResult =
  | { ran: false; reason: "schema-not-ready" }
  | {
      ran: true;
      ok: true;
      headersSwitchedOff: number;
      peerHeadersDeleted: number;
    }
  | { ran: true; ok: false; error: string };

/** The error log category of a failed step. */
export const BILLABLE_TRACKING_STARTUP_CATEGORY = "billable-tracking-startup";

export function runBillableTrackingStartup(
  store: Pick<
    Store,
    "billableSwitch" | "billableSwitchStorageReady" | "errorLogs"
  >,
  options: { entryNodeId?: string | null; now?: number } = {}
): BillableTrackingStartupResult {
  if (!store.billableSwitchStorageReady) {
    return { ran: false, reason: "schema-not-ready" };
  }
  try {
    const result = store.billableSwitch.retireHeaders({
      entryNodeId: options.entryNodeId ?? null,
      now: options.now,
    });
    return {
      ran: true,
      ok: true,
      headersSwitchedOff: result.switchedOff,
      peerHeadersDeleted: result.peerHeadersDeleted,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    try {
      store.errorLogs.createEntry({
        severity: "error",
        category: BILLABLE_TRACKING_STARTUP_CATEGORY,
        source: "server",
        message: `The billable tracking start-up step failed; the header retirement runs again at the next boot: ${error}`,
        stack: err instanceof Error ? (err.stack ?? null) : null,
        context: JSON.stringify({ step: "header-retirement" }),
      });
    } catch {
      // The error log cannot be written either; the boot line still says so.
    }
    return { ran: true, ok: false, error };
  }
}

/** The boot line for the step's result. */
export function describeBillableTrackingStartup(
  result: BillableTrackingStartupResult
): string {
  if (!result.ran) {
    return "[Server] Billable tracking start-up: skipped (the switch storage is not ready)";
  }
  if (!result.ok) {
    return `[Server] Billable tracking start-up: FAILED (${result.error}); it runs again at the next boot`;
  }
  return `[Server] Billable tracking start-up: headers switched off=${result.headersSwitchedOff} peer header rows removed=${result.peerHeadersDeleted}`;
}
