// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef } from "react";
import { useToast } from "@/components/Toast";
import {
  createToastCoalescer,
  type ToastCoalescer,
} from "@/lib/toast-coalescer";

// R7: one `retrying` toast per session per 60s (in addition to ToastProvider's
// 2s global dedup). Reset on any non-retrying phase for that session.
const RETRYING_THROTTLE_MS = 60_000;

// #1612 burst-protection constants (mirror ToolErrorToastListener). Scoped to
// the `exhausted` phase — see the coalescer rationale in the component doc
// comment below.
const API_ERROR_COALESCE_THRESHOLD = 3; // first N in a window toast individually
const API_ERROR_COALESCE_WINDOW_MS = 1000; // the AC's "<1s" burst definition
const API_ERROR_SUMMARY_DEDUP_MS = 2000; // mirrors Toast DEDUP_WINDOW_MS
const API_ERROR_RECONNECT_SUPPRESS_MS = 2500; // covers a reconnect backlog burst

type ApiErrorPhase = "retrying" | "exhausted" | "recovered" | "give-up";

type ApiErrorDetail = {
  sessionId: string;
  phase: ApiErrorPhase;
  errorType: string;
  retryAttempt?: number;
  maxRetries?: number;
  requestId?: string;
};

/**
 * Bridges `hapi:apiError` CustomEvents (dispatched by useSSE for api-error
 * SyncEvents) to the Toast system. Mounts inside ToastProvider so useToast()
 * resolves to a real provider. Issue #1233 (Epic #1231).
 *
 * Phase-aware rendering (R4):
 *   - retrying  → info,    5s, message `API retrying (n/m)...`; throttled to one
 *                 per session per 60s (R7)
 *   - exhausted → warning, 10s; message keyed on errorType (LC-2):
 *                 `overloaded_error` → "API overloaded — please review and retry",
 *                 else neutral "API error — please review and retry"
 *                 EXCEPT `spend_limit_error` (#4936) → error, 10s, "API spend
 *                 limit reached — auto-recovery is off for this session"; one
 *                 per failed turn, NOT routed through the burst coalescer below
 *   - recovered → success, 5s, "Resumed after API overload" (fired by #1234)
 *   - give-up   → error,   10s, "Auto-recovery exhausted — please review and
 *                 retry manually" (fired by #1234)
 *   - unknown   → console.warn, no toast (defensive; R8)
 *
 * `recovered` / `give-up` are fired by Sub-Issue C (#1234); handled here so C
 * needs no edit to this file, and so the test surface is complete in one place.
 *
 * #1612 burst protection (directive Task 6 point 6): a widespread Anthropic
 * overload can deliver a flood of api-error events (especially an SSE reconnect
 * backlog), the exact scenario that crashed the app with React #185 for
 * tool-errors. We reuse BOTH #1612 mechanisms:
 *   1. Reconnect-suppression window — severity-agnostic, so it applies to ALL
 *      non-retrying phases; a reconnect backlog of stale terminal-state toasts
 *      never replays.
 *   2. Burst coalescer — scoped to the `exhausted` phase only. `exhausted` is
 *      the homogeneous, warning-severity, high-volume phase a widespread
 *      overload produces (matching #1612's "N tool errors" summary). The
 *      heterogeneous `recovered` (success) / `give-up` (error) phases are NOT
 *      routed through it, because collapsing them into a warning-severity
 *      "N API errors" summary would corrupt their semantics — and they are rare
 *      per-session terminal events (fired by #1234's staggered recovery timers)
 *      that do not flood.
 * `retrying` is covered by its own per-session 60s throttle. The renderer stays
 * crash-safe for every phase via ToastProvider's post-#1612 MAX_VISIBLE=3
 * synchronous overflow-drop + 2s dedup.
 */
export function ApiErrorToastListener(): null {
  const { showToast } = useToast();
  const lastRetryingAtBySession = useRef<Map<string, number>>(new Map());
  const coalescerRef = useRef<ToastCoalescer | null>(null);
  const coalescer =
    coalescerRef.current ??
    (coalescerRef.current = createToastCoalescer({
      threshold: API_ERROR_COALESCE_THRESHOLD,
      windowMs: API_ERROR_COALESCE_WINDOW_MS,
      summaryDedupMs: API_ERROR_SUMMARY_DEDUP_MS,
    }));
  const suppressUntilRef = useRef(0);

  // On every SSE (re)connect, open a coalescing window and suppress individual
  // non-retrying toasts for a short window so a reconnect-delivered backlog can
  // never flood the renderer (mirrors #1612's ToolErrorToastListener).
  useEffect(() => {
    const onConnect = () => {
      const now = Date.now();
      suppressUntilRef.current = now + API_ERROR_RECONNECT_SUPPRESS_MS;
      coalescer.forceSummaryWindow(now);
    };
    window.addEventListener("hapi:sseConnected", onConnect);
    return () => window.removeEventListener("hapi:sseConnected", onConnect);
  }, [coalescer]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<ApiErrorDetail>).detail;
      if (!detail?.sessionId || !detail?.phase) return;

      if (detail.phase === "retrying") {
        const now = Date.now();
        const last = lastRetryingAtBySession.current.get(detail.sessionId) ?? 0;
        if (now - last < RETRYING_THROTTLE_MS) return; // R7 throttle
        lastRetryingAtBySession.current.set(detail.sessionId, now);
        showToast(
          `API retrying (${detail.retryAttempt ?? "?"}/${
            detail.maxRetries ?? "?"
          })...`,
          { type: "info", duration: 5000 }
        );
        return;
      }

      // Non-retrying phases reset this session's retry throttle so a
      // recovery-then-overload cycle shows the next `retrying` toast
      // immediately (R7).
      lastRetryingAtBySession.current.delete(detail.sessionId);

      const now = Date.now();
      // Reconnect-suppression window (severity-agnostic) covers all
      // non-retrying phases.
      const suppressed = now < suppressUntilRef.current;

      if (
        detail.phase === "exhausted" &&
        detail.errorType === "spend_limit_error"
      ) {
        // #4936: a terminal spend cap / user-set spend limit — one per failed
        // turn, error severity, never folded into an "N API errors" summary.
        // The durable in-thread card carries the key label and resume date.
        if (suppressed) return;
        showToast(
          "API spend limit reached — auto-recovery is off for this session",
          { type: "error", duration: 10000 }
        );
        return;
      }

      if (detail.phase === "exhausted") {
        // Burst coalescer scoped to the homogeneous warning phase.
        const decision = coalescer.record(now);
        if (decision.action === "individual" && suppressed) return;
        if (decision.action === "silent") return;
        if (decision.action === "summary") {
          const n = decision.count;
          showToast(`${n} API error${n === 1 ? "" : "s"}`, {
            type: "warning",
            duration: 10000,
          });
          return;
        }
        // LC-2: errorType is #1232's NORMALIZED inner Anthropic error type; only
        // claim "overloaded" when it actually is.
        const msg =
          detail.errorType === "overloaded_error"
            ? "API overloaded — please review and retry"
            : "API error — please review and retry";
        showToast(msg, { type: "warning", duration: 10000 });
        return;
      }

      // recovered / give-up: rare per-session terminal events (fired by #1234).
      // Kept as individual, severity-correct toasts (NOT routed through the
      // warning-severity coalescer), but still gated by the reconnect-
      // suppression window so a stale backlog never replays.
      if (suppressed) return;

      if (detail.phase === "recovered") {
        showToast("Resumed after API overload", {
          type: "success",
          duration: 5000,
        });
      } else if (detail.phase === "give-up") {
        showToast(
          "Auto-recovery exhausted — please review and retry manually",
          { type: "error", duration: 10000 }
        );
      } else {
        // Defensive: an unrecognized phase must not crash or toast (R8). The
        // server degrades unknown phases to "exhausted", so this only fires for
        // a genuinely out-of-contract payload.
        console.warn("[ApiErrorToastListener] unknown phase, no toast", detail);
      }
    };
    window.addEventListener("hapi:apiError", handler);
    return () => window.removeEventListener("hapi:apiError", handler);
  }, [showToast, coalescer]);

  return null;
}
