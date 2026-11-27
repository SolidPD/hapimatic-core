// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The read-back after a tracked Create (#6780, Task 7: B11, B13, B14).
 *
 * Mounted once, INSIDE `AppContextProvider` (it needs `api`), so the read-back
 * no longer depends on the Create page or the placeholder view staying open.
 * It takes a noted start (`lib/trackedStarts.ts`) once its session exists:
 *   - another node's start on `hapi:federationSpawnSucceeded`, by its
 *     `spawnCorrelationId`;
 *   - a start on this node when a session with `tag === placeholderId` and
 *     another id appears in the session list. The list is read only while such
 *     a start waits (`useAnyLocalTrackedStart`).
 * A failed spawn drops its entry (`hapi:spawnFailed` for a placeholder,
 * `hapi:federationSpawnFailed` for a remote one), because the Create page has
 * unmounted by then.
 *
 * It reads `GET /api/sessions/:id/tracking` once (a remote read is retried once
 * after {@link TRACKED_START_RETRY_MS} on 503 or 404: the node is not polled
 * yet, or the session not located yet), drops the handover's Time Tracking for
 * a local start (`dropHandoverTracking`), and raises at most one warning,
 * claimed through `claimTrackingPopup` only when it is about to warn. Equal
 * says nothing (OC-3 = a); a failed read says nothing either, with one
 * `console.warn` that names the HTTP status only. No rate, note or category is
 * named anywhere (C7). `trackingStart` on the spawn answer is not read.
 */
import { useCallback, useEffect, type ReactNode } from "react";
import { ApiError, type ApiClient } from "@/api/client";
import { useToast } from "@/components/Toast";
import {
  FEDERATION_SPAWN_FAILED_EVENT,
  FEDERATION_SPAWN_SUCCEEDED_EVENT,
} from "@/components/FanOut/remoteSpawnOutcome";
import { useSessions } from "@/hooks/queries/useSessions";
import { useAppContext } from "@/lib/app-context";
import { dropHandoverTracking } from "@/lib/spawn-draft";
import {
  compareTracking,
  dropTrackedStart,
  localTrackedStartKeys,
  takeTrackedStart,
  trackedStartWarning,
  useAnyLocalTrackedStart,
  type TrackedStart,
  type TrackingComparison,
} from "@/lib/trackedStarts";
import { claimTrackingPopup, trackingPopupKeys } from "@/lib/trackingPopups";

/** "A few seconds": a remote read answered 503 or 404 is asked once more. */
export const TRACKED_START_RETRY_MS = 4_000;

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Read the record once (a remote 503 or 404 once more) and compare. */
export async function readBackTrackedStart(
  api: ApiClient,
  start: TrackedStart,
  sessionId: string,
  pause: (ms: number) => Promise<void> = wait
): Promise<TrackingComparison> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await api.getSessionTracking(sessionId);
      return compareTracking(start, response);
    } catch (error) {
      const status = error instanceof ApiError ? error.status : null;
      if (
        start.kind === "remote" &&
        attempt === 0 &&
        (status === 503 || status === 404)
      ) {
        await pause(TRACKED_START_RETRY_MS);
        continue;
      }
      console.warn(
        `[TrackedStartListener] the new session's tracking could not be read (HTTP ${status ?? "no status"})`
      );
      return compareTracking(start, null);
    }
  }
}

type Resolve = (
  start: TrackedStart,
  sessionId: string,
  ids: { spawnCorrelationId?: string; tag?: string }
) => void;

/** Reads the session list only while a start on this node waits. */
function LocalTrackedStartWatcher({
  api,
  onResolved,
}: {
  api: ApiClient;
  onResolved: Resolve;
}): null {
  const { sessions } = useSessions(api);
  useEffect(() => {
    for (const placeholderId of localTrackedStartKeys()) {
      const real = sessions.find(
        s => s.tag === placeholderId && s.id !== placeholderId
      );
      if (!real) continue;
      const start = takeTrackedStart(placeholderId);
      if (!start) continue;
      dropHandoverTracking(placeholderId);
      onResolved(start, real.id, { tag: placeholderId });
    }
  }, [sessions, onResolved]);
  return null;
}

export function TrackedStartListener(): ReactNode {
  const { api } = useAppContext();
  const { showToast } = useToast();
  const anyLocal = useAnyLocalTrackedStart();

  const onResolved = useCallback<Resolve>(
    (start, sessionId, ids) => {
      void readBackTrackedStart(api, start, sessionId).then(comparison => {
        const words = trackedStartWarning(start, comparison);
        if (!words) return;
        const keys = trackingPopupKeys({ ...ids, sessionId });
        if (!claimTrackingPopup(keys)) return;
        showToast(words, { type: "warning" });
      });
    },
    [api, showToast]
  );

  useEffect(() => {
    const onSucceeded = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        spawnCorrelationId?: string;
        sessionId?: string;
      } | null;
      const corr = detail?.spawnCorrelationId;
      if (!corr) return;
      const start = takeTrackedStart(corr);
      if (!start) return;
      if (!detail?.sessionId) return;
      onResolved(start, detail.sessionId, { spawnCorrelationId: corr });
    };
    const onRemoteFailed = (e: Event) => {
      const corr = (e as CustomEvent).detail?.spawnCorrelationId as
        | string
        | undefined;
      if (corr) dropTrackedStart(corr);
    };
    const onLocalFailed = (e: Event) => {
      const placeholderId = (e as CustomEvent).detail?.sessionId as
        | string
        | undefined;
      if (placeholderId) dropTrackedStart(placeholderId);
    };
    window.addEventListener(FEDERATION_SPAWN_SUCCEEDED_EVENT, onSucceeded);
    window.addEventListener(FEDERATION_SPAWN_FAILED_EVENT, onRemoteFailed);
    window.addEventListener("hapi:spawnFailed", onLocalFailed);
    return () => {
      window.removeEventListener(FEDERATION_SPAWN_SUCCEEDED_EVENT, onSucceeded);
      window.removeEventListener(FEDERATION_SPAWN_FAILED_EVENT, onRemoteFailed);
      window.removeEventListener("hapi:spawnFailed", onLocalFailed);
    };
  }, [onResolved]);

  return anyLocal ? (
    <LocalTrackedStartWatcher api={api} onResolved={onResolved} />
  ) : null;
}
