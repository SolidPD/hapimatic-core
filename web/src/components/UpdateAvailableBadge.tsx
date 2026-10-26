// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { BareButton } from "@/components/ui/BareButton";
import { Spinner } from "@/components/Spinner";
import {
  useUpdateStatus,
  useStageUpdate,
  useTriggerUpdate,
  useCancelDeferral,
  type UpdateMode,
} from "@/hooks/useUpdateStatus";
import {
  activateSwUpdate,
  isSwUpdatePending,
  onSwUpdateAvailable,
  requestSwUpdateCheck,
} from "@/lib/sw-update";

/**
 * The single mint-green update bar (issue #3057) — the ONE surface for both the
 * VM binary-update pipeline (#1006/#2589) and the service-worker asset refresh
 * (#1793). It replaces the old two-bar UX (a yellow "Update available" badge
 * stacked over a green "New version — Reload" banner) with one truthful,
 * phase-aware bar rendered below the title bar in BrandedFrame.
 *
 * ## Lifecycle (durable two-phase updater)
 *
 * The bar's phase comes from `/api/update-status`'s durable `job` record — NOT
 * from a resolved mutation, since an HTTP 202 is launch acceptance, not
 * completion (expert-review S-1). The flow:
 *
 *   available → [click: stage] → staging (spinner) → ready → [dialog: confirm]
 *     → applying (spinner, tolerant of the self-restart) → succeeded
 *     → SW check → guarded reload
 *
 *  - **available:** versioned copy; the first click starts the non-disruptive
 *    download (`useStageUpdate`) — it does NOT open the confirm dialog yet (R2).
 *  - **staging:** a spinner rides the bar for the whole durable staging phase;
 *    duplicate starts are disabled (R2).
 *  - **ready:** the existing #2589 restart/session dialog opens — automatically
 *    if this click initiated the stage, or on a later click if the update was
 *    already staged (R3). "Later" closes it without applying; the ready update
 *    remains offered (R4).
 *  - **applying:** the dialog closes; one "Updating…" state shows and tolerates
 *    the server disappearing as it restarts itself (R5). "Update when idle"
 *    keeps its pending/cancel UI and never reloads on deferral acceptance (R4).
 *  - **succeeded:** the terminal reload waits for the target server to be healthy,
 *    then asks the SW to check for the new worker and activates it through the
 *    visibility-guarded path (R5/R8). A persisted "reloaded-for" flag makes this
 *    fire exactly once — the post-reload page stays quiet (no reload loop). It
 *    fires only in a page that first saw the server on an older version, and a
 *    stalled reload turns into a tappable "reload to finish" bar (#4924).
 *  - **failed / timeout:** one actionable bar with retry/error copy; the update
 *    is never silently hidden nor falsely reported complete (R7).
 *
 * A standalone SW-only refresh (fresh static assets, no pipeline update) renders
 * the SAME bar with truthful GENERIC copy (never the old version number) and a
 * single click that activates safely (R1/R8).
 */

/** How long to wait for the new SW after apply before offering a manual Reload (R5). */
const SW_ACTIVATE_TIMEOUT_MS = 8000;

/** Port-scoped flag: the target version this browser has already reloaded onto. */
const RELOADED_KEY = `hapi:update-reloaded-for::${
  typeof window !== "undefined" ? window.location.origin : ""
}`;

function readReloadedFor(): string | null {
  try {
    return localStorage.getItem(RELOADED_KEY);
  } catch {
    return null;
  }
}
function markReloadedFor(version: string): void {
  try {
    localStorage.setItem(RELOADED_KEY, version);
  } catch {
    // A disabled/full store just means the once-guard degrades to per-mount; the
    // terminalFiredRef still prevents a same-mount double reload.
  }
}

/**
 * The first real server version this PAGE saw (#4924). Module scope, not a ref:
 * the app remounts the bar during its auth bootstrap, and a per-mount ref would
 * forget what the page loaded against. It resets on reload, the only point at
 * which the page can pick up new assets. A page that first saw the server already
 * on a job's target loaded after that update, so it starts no reload flow; if it
 * still runs an older precached shell, the sw-only bar offers the new worker.
 */
let firstServerVersion: string | null = null;
const REAL_VERSION = /^\d+\.\d+\.\d+/;

function noteServerVersion(version: string | undefined): void {
  if (firstServerVersion === null && version && REAL_VERSION.test(version)) {
    firstServerVersion = version;
  }
}

/** Test-only reset of the page-scoped state (mirrors resetSwUpdateForTests). */
export function resetUpdateBadgeStateForTests(): void {
  firstServerVersion = null;
}

type BarPhase =
  | "pending"
  | "available"
  | "staging"
  | "ready"
  | "applying"
  | "reloading"
  | "failed"
  | "sw-only"
  | null;

export function UpdateAvailableBadge() {
  const { data, refetch } = useUpdateStatus();
  const stage = useStageUpdate();
  const trigger = useTriggerUpdate();
  const cancelDeferral = useCancelDeferral();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [swPending, setSwPending] = useState(isSwUpdatePending);
  const [awaitingReady, setAwaitingReady] = useState(false);
  const [reloadInFlight, setReloadInFlight] = useState(false);
  const [reloadStalled, setReloadStalled] = useState(false);
  const [dismissedFailure, setDismissedFailure] = useState(false);
  const terminalFiredRef = useRef(false);

  // R9 mount-race latch + later events: a waiting SW can be signalled before this
  // mounts (the event is one-shot), so read the latch on mount AND subscribe.
  useEffect(() => {
    if (isSwUpdatePending()) setSwPending(true);
    return onSwUpdateAvailable(() => setSwPending(true));
  }, []);

  const jobPhase = data?.job?.phase;
  const target = data?.job?.targetVersion;
  const available = data?.updateAvailable === true;
  const pendingDeferral = data?.deferred?.pending === true;
  const latest = data?.latestVersion;
  const current = data?.currentVersion;
  const sessionImpact = data?.sessionImpact;
  const machine = data?.machineName?.trim() || "this instance";
  const jobIsForLatest = jobPhase !== undefined && target === latest;

  // The initiating click opens the confirm dialog once staging reaches `ready` (R3).
  useEffect(() => {
    if (awaitingReady && jobPhase === "ready" && jobIsForLatest) {
      setDialogOpen(true);
      setAwaitingReady(false);
    }
  }, [awaitingReady, jobPhase, jobIsForLatest]);

  // Declared BEFORE the terminal effect so the first data render records the
  // version before the terminal check reads it (effects run in order).
  useEffect(() => {
    noteServerVersion(current);
  }, [current]);

  // Completion → drive the terminal reload EXACTLY once (R5/R6/R8). We only reload
  // when the browser is actually stale: the server now runs the job's target AND
  // this page first saw it on another version (#4924 — `job.json` is never
  // deleted, so a `succeeded` record outlives its update and must not start a
  // reload in a page that loaded afterwards). A persisted "reloaded-for" flag also
  // records that this browser already started the reload flow for the target, so
  // it never re-fires; a page still on the old worker gets the sw-only bar instead.
  useEffect(() => {
    const completed =
      !!target &&
      current === target &&
      (jobPhase === "succeeded" || jobPhase === "applying");
    if (!completed || terminalFiredRef.current) return;
    terminalFiredRef.current = true;
    if (firstServerVersion === target) {
      // This page loaded after the update, so it starts no reload flow. It may
      // still run an older shell from the outgoing worker's precache (a reload
      // during the restart), so look for the new worker once: if one installs,
      // the manual sw-only bar offers it.
      requestSwUpdateCheck();
      return;
    }
    if (readReloadedFor() === target) {
      // Steady state: this browser already ran the reload flow for this target.
      return;
    }
    markReloadedFor(target); // mark BEFORE reloading so the reloaded page is quiet
    setReloadInFlight(true);
    requestSwUpdateCheck(); // ask the SW machinery for the new worker (self-clearing)
  }, [jobPhase, target, current]);

  // The stall timer lives in its own effect (#4924): inside the terminal effect it
  // was cleared by that effect's cleanup when the phase moved from `applying` to
  // `succeeded`, and the early return on terminalFiredRef never re-armed it, so
  // the bar spun on "Update complete — reloading…" with no way out.
  useEffect(() => {
    if (!reloadInFlight) return;
    const t = setTimeout(() => setReloadStalled(true), SW_ACTIVATE_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [reloadInFlight]);

  // A waiting SW appeared during the terminal flow → activate it through the
  // visibility-guarded path (never a raw location.reload — R8, #1793/#3053).
  useEffect(() => {
    if (reloadInFlight && swPending) activateSwUpdate();
  }, [reloadInFlight, swPending]);

  // ── Derive the single effective bar phase (priority-ordered) ────────────────
  let phase: BarPhase = null;
  if (pendingDeferral) phase = "pending";
  // #3737 defect #4: guard `applying` the same way the `failed` branch below is guarded
  // (`jobIsForLatest || !available`) so a stale/foreign-target applying job never masks a
  // genuinely-newer available update. During a real apply `target === latest`, so
  // `jobIsForLatest` holds and the healthy "Updating…" flow is unchanged; a leftover applying
  // for an older target falls through to `available` instead of pinning a permanent spinner.
  else if (jobPhase === "applying" && (jobIsForLatest || !available))
    phase = "applying";
  // #4924: a waiting worker must still surface here — after a stalled tap the
  // page reloads onto the same old worker with `reloaded-for` already set.
  else if (jobPhase === "succeeded" && jobIsForLatest)
    phase = reloadInFlight ? "reloading" : swPending ? "sw-only" : null;
  else if (
    jobPhase === "failed" &&
    !dismissedFailure &&
    (jobIsForLatest || !available)
  )
    phase = "failed";
  else if (jobPhase === "staging" && jobIsForLatest) phase = "staging";
  else if (available && jobPhase === "ready" && jobIsForLatest) phase = "ready";
  else if (available) phase = "available";
  else if (reloadInFlight) phase = "reloading";
  else if (swPending) phase = "sw-only";

  if (phase === null) return null;

  const busy = stage.isPending || trigger.isPending || cancelDeferral.isPending;
  // #4924: once the terminal reload has stalled, the bar says "reload to finish"
  // and must take the tap (a spinning bar is disabled and its click handler
  // returns early).
  const spinning =
    phase === "staging" ||
    phase === "applying" ||
    (phase === "reloading" && !reloadStalled);

  // ── Copy ────────────────────────────────────────────────────────────────────
  const honestCopy =
    `A new version (v${data?.latestVersion}) is available (currently v${data?.currentVersion}). ` +
    `Updating briefly restarts this instance of Hapimatic (${machine}); active Claude Code ` +
    `sessions running on ${machine} will be interrupted, then reconnect automatically. ` +
    `Update now?`;
  const pendingCopy =
    `An update to v${data?.latestVersion} is scheduled to apply automatically once every ` +
    `Claude Code session on ${machine} has finished responding. It survives closing this ` +
    `tab and a server restart. You can apply it now or cancel it below.`;

  const label = ((): string => {
    switch (phase) {
      case "pending":
        return `Update v${data?.latestVersion} pending — waiting for sessions to finish responding`;
      case "available":
        return `Update v${data?.latestVersion} is now available. Click to update.`;
      case "staging":
        return `Downloading update v${target ?? data?.latestVersion}…`;
      case "ready":
        return `Update v${data?.latestVersion} is ready — review & apply`;
      case "applying":
        return `Updating ${machine}…`;
      case "reloading":
        return reloadStalled
          ? "Update installed — reload to finish"
          : "Update complete — reloading…";
      case "failed":
        return `Update to v${target ?? data?.latestVersion} failed${
          data?.job?.rollback ? " and was rolled back" : ""
        } — tap to retry`;
      case "sw-only":
        return "A new version of the app is ready. Tap to reload.";
      default:
        return "Update available";
    }
  })();

  const icon = ((): string => {
    if (spinning) return "";
    if (phase === "pending") return "⏳";
    if (phase === "failed") return "⚠";
    return "⬆";
  })();

  // ── Actions ─────────────────────────────────────────────────────────────────
  const errMsg = (err: unknown, fallback: string): string =>
    err instanceof Error ? err.message : fallback;

  const beginStage = async () => {
    setError(null);
    setAwaitingReady(true);
    try {
      await stage.mutateAsync();
      void refetch?.();
    } catch (err) {
      setAwaitingReady(false);
      setError(errMsg(err, "Couldn't start the update. Please try again."));
    }
  };

  const retry = async () => {
    setError(null);
    setDismissedFailure(false);
    if (available) {
      // A staged/apply failure that left the marker → re-stage (the actionable path).
      await beginStage();
    } else {
      // An apply that rolled back and consumed the marker → nothing to re-stage.
      // Acknowledge the failure (the instance is safely on the prior version).
      setDismissedFailure(true);
    }
  };

  const onBarClick = () => {
    if (busy || spinning) return; // duplicate-start guard
    setError(null);
    if (phase === "pending" || phase === "ready") {
      setDialogOpen(true);
      void refetch?.(); // 2589-4: pull fresh session counts as the dialog opens
      return;
    }
    if (phase === "failed") {
      void retry();
      return;
    }
    if (phase === "sw-only" || phase === "reloading") {
      activateSwUpdate();
      return;
    }
    if (phase === "available") {
      void beginStage();
    }
  };

  const runUpdate = async (mode: UpdateMode) => {
    setError(null);
    try {
      await trigger.mutateAsync({ mode });
      setDialogOpen(false);
      void refetch?.();
    } catch (err) {
      setError(errMsg(err, "Update failed. Please try again."));
    }
  };

  const runCancel = async () => {
    setError(null);
    try {
      await cancelDeferral.mutateAsync();
      setDialogOpen(false);
      void refetch?.();
    } catch (err) {
      setError(
        errMsg(err, "Couldn't cancel the deferred update. Please try again.")
      );
    }
  };

  const closeDialog = () => setDialogOpen(false);

  return (
    <>
      {/* Placement (issue #1793 follow-up): a SLIM, full-width mint band in normal
          document flow *below the title bar* — NOT a `fixed top-0 … z-50` overlay
          (that covered the title bar and made the action unclickable, and is the
          notch hazard #2779 documents). Keep this flowed and low-padding. The mint
          comes from the theme-driven `bg-accent` token — never the hardcoded
          #5ae6ab / the old #f59e0b amber (design-token swap contract). */}
      <BareButton
        type="button"
        onClick={onBarClick}
        disabled={spinning}
        title={label}
        aria-label={label}
        className="flex w-full items-center justify-center gap-1.5 whitespace-normal bg-accent px-3 py-1 text-xs font-semibold text-[var(--palette-accent-fg)] shadow-sm disabled:opacity-90"
      >
        {spinning ? (
          <Spinner size="sm" label={null} className="!text-inherit" />
        ) : (
          <span aria-hidden="true">{icon}</span>
        )}
        <span>{label}</span>
      </BareButton>

      <Dialog open={dialogOpen} onOpenChange={open => !open && closeDialog()}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Update Hapimatic</DialogTitle>
            <DialogDescription className="mt-2">
              {pendingDeferral ? pendingCopy : honestCopy}
            </DialogDescription>
          </DialogHeader>

          {/* R1: live session impact (only when the server could read it). */}
          {!pendingDeferral && sessionImpact ? (
            <p className="mt-3 text-sm text-[var(--app-muted-fg)]">
              {sessionImpact.active} active session
              {sessionImpact.active === 1 ? "" : "s"} on {machine}
              {sessionImpact.thinking > 0
                ? `, ${sessionImpact.thinking} mid-response`
                : ""}
              .
            </p>
          ) : null}

          {/* #3735: while a deferral is pending, surface the count the gate is
              actually waiting on. `blocking` is the SAME predicate the server gate
              uses (excludes stuck-but-not-inferring sessions); fall back to `thinking`
              for an older/peer server that omits it. */}
          {pendingDeferral && sessionImpact
            ? (() => {
                const blocking =
                  sessionImpact.blocking ?? sessionImpact.thinking;
                return (
                  <p className="mt-3 text-sm text-[var(--app-muted-fg)]">
                    {blocking > 0
                      ? `${blocking} session${
                          blocking === 1 ? "" : "s"
                        } still responding on ${machine} — the update applies automatically when they finish, or apply it now below.`
                      : `No sessions are blocking on ${machine} — the update should apply momentarily.`}
                  </p>
                );
              })()
            : null}

          {error ? (
            <div className="mt-3 rounded-md bg-red-900/20 p-3 text-sm text-red-400">
              {error}
            </div>
          ) : null}

          <div className="mt-4 flex flex-wrap justify-end gap-2">
            {pendingDeferral ? (
              <>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={closeDialog}
                  disabled={busy}
                >
                  Keep waiting
                </Button>
                {/* #3735: force path. Reuses the SAME apply as "Update now" —
                    runUpdate("now") → POST /update-trigger {mode:"now"} clears the
                    deferral and fires the apply, bypassing the wedged idle-gate.
                    Reachable WITHOUT cancelling first (R3). */}
                <Button
                  type="button"
                  variant="default"
                  onClick={() => runUpdate("now")}
                  disabled={busy}
                >
                  {trigger.isPending ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Spinner
                        size="sm"
                        label={null}
                        className="!text-inherit"
                      />
                      Applying…
                    </span>
                  ) : (
                    "Apply anyway"
                  )}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={runCancel}
                  disabled={busy}
                >
                  {cancelDeferral.isPending ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Spinner
                        size="sm"
                        label={null}
                        className="!text-inherit"
                      />
                      Cancelling…
                    </span>
                  ) : (
                    "Cancel update"
                  )}
                </Button>
              </>
            ) : (
              <>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={closeDialog}
                  disabled={busy}
                >
                  Later
                </Button>
                {/* R4 — the deferral choice only appears when the server can report
                    session state; without it we degrade to two choices (R6). */}
                {sessionImpact ? (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => runUpdate("when-idle")}
                    disabled={busy}
                  >
                    Update when idle
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="default"
                  onClick={() => runUpdate("now")}
                  disabled={busy}
                >
                  {trigger.isPending ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Spinner
                        size="sm"
                        label={null}
                        className="!text-inherit"
                      />
                      Starting update…
                    </span>
                  ) : (
                    "Update now"
                  )}
                </Button>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
