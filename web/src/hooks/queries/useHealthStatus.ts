// SPDX-License-Identifier: AGPL-3.0-only
import { useState, useEffect } from "react";
import { type ApiClient, ApiError } from "@/api/client";
import { errorReporter } from "@/lib/error-reporter";
import {
  calculateHealthStatus,
  type HealthStatus,
  type SystemHealthMetrics,
} from "@/lib/systemHealth";

/**
 * Discriminates WHY a poll is not returning live health metrics:
 * - "none": last poll succeeded (or none has run yet).
 * - "disabled": the health endpoint returned 503 — system health is disabled
 *   (standalone/spoke steady state). NOT an outage; never reported.
 * - "outage": a non-503 failure — a genuine server outage, auth expiry, or a
 *   network-level rejection. Reported to errorReporter for /settings/error-logs.
 */
type HealthPollError = "none" | "disabled" | "outage";

/**
 * Hook for continuous background health status polling.
 * Polls at a slower rate (default 12s) to provide status indicator updates
 * without overwhelming the server.
 *
 * Promoted out of `SystemHealthModal.tsx` (issue #1037, Task 1) so both the
 * top-bar SystemHealth icon (`App.tsx`, `useSystemHealthDisplayTarget`) and the
 * Federation Health Dashboard can consume it without importing the whole modal.
 * The status-calculation logic and types now live in `@/lib/systemHealth`
 * (extracted from the deleted modal in #3460); this hook imports
 * `calculateHealthStatus` / `HealthStatus` / `SystemHealthMetrics` from there.
 */
export function useHealthStatus(api: ApiClient | null, pollInterval = 12000) {
  const [status, setStatus] = useState<HealthStatus>("unknown");
  const [metrics, setMetrics] = useState<SystemHealthMetrics | null>(null);
  const [pollError, setPollError] = useState<HealthPollError>("none");

  useEffect(() => {
    if (!api) {
      setStatus("unknown");
      setPollError("none");
      return;
    }

    const fetchStatus = async () => {
      try {
        const result = await api.getSystemHealth();
        setMetrics(result);
        setStatus(calculateHealthStatus(result));
        setPollError("none");
      } catch (err) {
        // Keep the safe "unknown" status, but discriminate WHY so a genuine
        // outage is distinguishable from the 503 health-disabled steady state
        // (issue #1792, mirroring useNodeHealth's 503/error taxonomy).
        setStatus("unknown");
        if (err instanceof ApiError && err.status === 503) {
          // Health disabled (standalone/spoke). Expected — do NOT report.
          setPollError("disabled");
        } else {
          // Genuine outage / auth failure / network rejection. The ApiClient
          // boundary already reports HTTP non-2xx, but a network-level rejection
          // (server down) never reaches it — this is the path that makes a real
          // outage observable in /settings/error-logs.
          setPollError("outage");
          errorReporter.report({
            message:
              err instanceof Error
                ? `System health poll failed: ${err.message}`
                : "System health poll failed: unknown error",
            category: "system-health",
            severity: "warn",
            statusCode: err instanceof ApiError ? err.status : null,
            context: "useHealthStatus poll",
          });
        }
      }
    };

    // Initial fetch
    void fetchStatus();

    // Set up continuous polling
    const interval = setInterval(() => {
      void fetchStatus();
    }, pollInterval);

    return () => clearInterval(interval);
  }, [api, pollInterval]);

  return {
    status,
    metrics,
    isHealthDisabled: pollError === "disabled",
    isOutage: pollError === "outage",
  };
}
