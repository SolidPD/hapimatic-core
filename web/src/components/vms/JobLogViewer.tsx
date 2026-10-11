// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from "react";
import type { JobState } from "@hapi/protocol/adminVms";
import type { ApiClient } from "@/api/client";
import { parseSseStream } from "@/lib/sse-stream";
import { useVmJob } from "@/hooks/queries/useVmInventory";

/**
 * JobLogViewer — live phase-by-phase log for one admin-VM job (issue #2470 R4).
 *
 * Two data sources, deliberately (Fallback-Preservation):
 *   1. `useVmJob` polls `/api/admin-vms/jobs/:id` for the AUTHORITATIVE terminal
 *      state + `actionItems` + `result`. It also IS the SSE poll-fallback — if
 *      the log stream drops, the job's state still resolves here.
 *   2. A fetch-based SSE stream of `/api/admin-vms/jobs/:id/logs` supplies the
 *      LIVE log lines. It uses an `Authorization: Bearer` header (NOT
 *      `EventSource`, which cannot send headers, and NOT the query-token, which
 *      is an intentionally narrow allowlist — expert review D1-B).
 *
 * `capacity-waiting` is rendered visually distinct from `failed` — the epic's
 * decision is that OCI capacity exhaustion is a WAITING state (a retry-cron will
 * pick it up), not an error.
 */

const TERMINAL_STATES: ReadonlySet<JobState> = new Set([
  "succeeded",
  "failed",
  "capacity-waiting",
]);

function isTerminal(state: JobState | undefined): boolean {
  return state !== undefined && TERMINAL_STATES.has(state);
}

/**
 * The server emits a single `event: state` SSE frame at terminal whose data is a
 * bare terminal JobState string. `parseSseStream` drops the `event:` field, so a
 * data payload EXACTLY equal to a terminal state is that frame — not a log line.
 * The authoritative state comes from the poll, so drop it from the log buffer.
 */
const TERMINAL_STATE_VALUES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "capacity-waiting",
]);

/** `provision.sh` prints `══ Phase N ══` banners — the progress structure. */
const PHASE_MARKER = /══+\s*Phase\s+\d+/i;

interface StateStyle {
  label: string;
  className: string;
  note?: string;
}

function stateStyle(state: JobState): StateStyle {
  switch (state) {
    case "succeeded":
      return {
        label: "Succeeded",
        className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
      };
    case "failed":
      return {
        label: "Failed",
        className: "border-red-500/40 bg-red-500/10 text-red-300",
      };
    case "capacity-waiting":
      return {
        label: "Capacity-waiting",
        className: "border-amber-500/40 bg-amber-500/10 text-amber-300",
        note: "OCI capacity is exhausted right now — the retry-cron will pick this up automatically. This is a waiting state, not a failure.",
      };
    case "running":
      return {
        label: "Running",
        className:
          "border-[var(--app-border)] bg-[var(--app-secondary-bg)] text-[var(--app-fg)]",
      };
    case "queued":
      return {
        label: "Queued",
        className:
          "border-[var(--app-border)] bg-[var(--app-secondary-bg)] text-[var(--app-hint)]",
      };
  }
}

export function JobLogViewer(props: {
  api: ApiClient | null;
  token: string;
  jobId: string;
}) {
  const { api, token, jobId } = props;
  const [logLines, setLogLines] = useState<string[]>([]);
  const [sseFailed, setSseFailed] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const jobQuery = useVmJob(api, jobId, {
    // Poll while non-terminal; stop once the job reaches a terminal state.
    refetchInterval: query =>
      isTerminal(query.state.data?.state) ? false : 2000,
  });
  const job = jobQuery.data;
  const state = job?.state;
  const terminal = isTerminal(state);
  const actionItems = job?.actionItems ?? null;

  // Reset the log buffer when the viewed job changes.
  useEffect(() => {
    setLogLines([]);
    setSseFailed(false);
  }, [jobId]);

  // Live log SSE (Bearer header). On any drop the poll above still resolves state.
  useEffect(() => {
    if (!jobId || !token) return;
    const controller = new AbortController();
    let cancelled = false;

    void (async () => {
      try {
        const res = await fetch(
          `/api/admin-vms/jobs/${encodeURIComponent(jobId)}/logs`,
          {
            headers: {
              authorization: `Bearer ${token}`,
              accept: "text/event-stream",
            },
            signal: controller.signal,
          }
        );
        if (!res.ok || !res.body) {
          if (!cancelled) setSseFailed(true);
          return;
        }
        if (!cancelled) setSseFailed(false);
        const reader = res.body.getReader();
        controller.signal.addEventListener(
          "abort",
          () => {
            reader.cancel().catch(() => {});
          },
          { once: true }
        );
        await parseSseStream(reader, {
          onEvent: data => {
            if (cancelled) return;
            if (TERMINAL_STATE_VALUES.has(data)) return; // state frame — poll owns state
            setLogLines(prev => [...prev, data]);
          },
        });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setSseFailed(true); // poll fallback still resolves terminal state
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [jobId, token]);

  // Autoscroll to the newest line.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logLines]);

  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-3"
      data-testid="job-log-viewer"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[length:var(--text-caption)] text-[var(--app-hint)]">
          {job?.kind ?? "job"} · {jobId.slice(0, 8)}
        </span>
        {state && (
          <span
            className={`rounded border px-1.5 py-0.5 text-[length:var(--text-caption)] font-medium ${stateStyle(state).className}`}
            data-testid="job-state-badge"
          >
            {stateStyle(state).label}
          </span>
        )}
        {!terminal && !sseFailed && (
          <span className="text-[length:var(--text-caption)] text-[var(--app-hint)]">
            streaming…
          </span>
        )}
      </div>

      {state === "capacity-waiting" && (
        <p
          className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-200"
          data-testid="capacity-waiting-note"
        >
          {stateStyle("capacity-waiting").note}
        </p>
      )}

      {sseFailed && !terminal && (
        <p
          className="text-[length:var(--text-caption)] text-[var(--app-hint)]"
          data-testid="sse-fallback-note"
        >
          Live log stream unavailable — polling for job status instead.
        </p>
      )}

      <div
        ref={scrollRef}
        className="max-h-72 overflow-auto rounded bg-[var(--app-bg)] p-2 font-mono text-[length:var(--text-caption)] leading-relaxed text-[var(--app-fg)]"
        data-testid="job-log-body"
      >
        {logLines.length === 0 ? (
          <p className="text-[var(--app-hint)]">Waiting for output…</p>
        ) : (
          logLines.map((line, i) =>
            PHASE_MARKER.test(line) ? (
              <div
                key={i}
                className="mt-1.5 border-t border-[var(--app-border)] pt-1.5 font-semibold text-[var(--app-link)]"
                data-testid="job-log-phase"
              >
                {line}
              </div>
            ) : (
              <div
                key={i}
                className="whitespace-pre-wrap break-words"
                data-testid="job-log-line"
              >
                {line}
              </div>
            )
          )
        )}
      </div>

      {terminal && actionItems && actionItems.length > 0 && (
        <div
          className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2.5"
          data-testid="job-action-items"
        >
          <h4 className="text-xs font-semibold uppercase tracking-wide text-amber-200">
            ⚠️ Action items — complete these now
          </h4>
          <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-5 text-xs text-amber-100">
            {actionItems.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
