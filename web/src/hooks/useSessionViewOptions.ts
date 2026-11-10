// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useVersion } from "@/hooks/useVersion";
import { useSessionOpenPinCount } from "@/hooks/queries/useSession";
import type { SessionViewOptions } from "@/lib/session-view";

/** What `useVersion` resolves to when `/api/version` answers non-OK. */
const VERSION_FALLBACK = "?.?.?";

/**
 * The mount re-read is module-wide and spaced out: several consumers mount
 * together, and a view that remounts while the read keeps failing must not
 * turn into a re-read loop (each failure re-renders every consumer).
 */
const MOUNT_REREAD_MIN_INTERVAL_MS = 5_000;
let lastMountRereadAt = Number.NEGATIVE_INFINITY;

/** Test-only: forget the last mount re-read. */
export function __resetVersionMountReread(): void {
  lastMountRereadAt = Number.NEGATIVE_INFINITY;
}

/**
 * #6449: the one source of session-view availability inputs, shared by the
 * View Picker, the `SessionChat` open-redirect, the full-screen restore, and
 * the Pins page, so they never disagree about which views exist.
 *
 * - `desktopEligible` and `pinsEnabled` come from `GET /api/version`.
 * - `pinCountKnown` is true when the session detail carries a numeric
 *   `openPinCount` (`0` included).
 * - `settled` is true once the version has been read and the detail query has
 *   answered; a persisted Pins view waits for it (`pendingOpenRedirect`).
 *
 * A failed version read (an error, or the fallback a non-OK response
 * resolves to) says nothing about the pins gate, so it is not settled: the
 * Pins page and a saved Pins view wait instead of reading the gate as closed.
 * `useVersion` never refetches on its own, so while the read has failed the
 * version is read again when a consumer mounts and each time the event stream
 * (re)connects. The Pins tab stays hidden until a read succeeds.
 *
 * The result is memoized on its four primitives, so it is safe in effect deps.
 */
export function useSessionViewOptions(
  sessionId: string | null
): SessionViewOptions {
  const queryClient = useQueryClient();
  const version = useVersion();
  const { openPinCount, detailSettled } = useSessionOpenPinCount(sessionId);
  const desktopEligible = version.data?.desktopEligible;
  const pinsEnabled = version.data?.pinsEnabled === true;
  const pinCountKnown = typeof openPinCount === "number";
  const versionFailed =
    version.status === "error" ||
    (version.status === "success" &&
      version.data?.version === VERSION_FALLBACK);
  const settled =
    version.status === "success" && !versionFailed && detailSettled;

  useEffect(() => {
    if (!versionFailed) return;
    const reread = () => {
      void queryClient.invalidateQueries({
        queryKey: ["version"],
        exact: true,
      });
    };
    // Once now, because the failed read may predate this mount and the last
    // reconnect (at most every few seconds across all consumers, and never
    // while a read is in flight), then on each reconnect.
    const now = Date.now();
    if (
      now - lastMountRereadAt >= MOUNT_REREAD_MIN_INTERVAL_MS &&
      queryClient.isFetching({ queryKey: ["version"], exact: true }) === 0
    ) {
      lastMountRereadAt = now;
      reread();
    }
    window.addEventListener("hapi:sseConnected", reread);
    return () => window.removeEventListener("hapi:sseConnected", reread);
  }, [versionFailed, queryClient]);

  return useMemo(
    () => ({ desktopEligible, pinsEnabled, pinCountKnown, settled }),
    [desktopEligible, pinsEnabled, pinCountKnown, settled]
  );
}
