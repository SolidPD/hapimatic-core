// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useMemo, useRef, useState } from "react";
import { TriangleAlert } from "lucide-react";
import {
  effectiveSavedTo,
  formatPinAnswersMessage,
  hasPinAnswer,
  resolveDenialOutcome,
  type Pin,
  type PinSubmissionEntry,
  type PinSubmissionRequest,
  type PinSubmissionResponse,
  type PinSubmissionResult,
} from "@hapi/protocol";
import { ApiError, type ApiClient } from "@/api/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/components/Toast";
import { PinKindBadge } from "@/components/pins/pinsShared";
import {
  usePins,
  useSetPinDeadline,
  useSubmitPinAnswers,
} from "@/hooks/queries/usePins";
import { restoredPickAt } from "./PinDismissAction";
import { useSessionProjectManager } from "@/hooks/queries/usePinDashboards";
import {
  browserTimeZone,
  buildSubmissionRequest,
  makeSubmissionId,
  type BuiltSubmission,
} from "@/lib/pins/submission";
import {
  clearPendingSubmission,
  clearSubmitted,
  dropPins,
  getStagedPins,
  loadPendingSubmission,
  pendingStillStaged,
  savePendingSubmission,
  type StagedPin,
} from "@/lib/pins/staging";

type Refusal = {
  code?: string;
  error: string;
  entries?: PinSubmissionResult[];
};

type Phase =
  | { kind: "checking" }
  | { kind: "empty"; dropped: PinSubmissionResult[] }
  | { kind: "preview"; preview: PinSubmissionResponse }
  | { kind: "sending"; preview: PinSubmissionResponse }
  /** Delivered; some pins were recorded moot or could not be recorded yet. */
  | { kind: "result"; result: PinSubmissionResponse }
  | {
      kind: "denied";
      preview: PinSubmissionResponse;
      title: string;
      text: string;
    }
  | { kind: "inactive"; preview?: PinSubmissionResponse }
  /** #6454: waiting for a resumed session to come back, then sending. */
  | { kind: "resuming"; preview: PinSubmissionResponse }
  | { kind: "unsupported" }
  /** #6539: the session's node predates dismissals; nothing was sent. */
  | { kind: "dismissUnsupported" }
  | { kind: "error"; message: string; preview?: PinSubmissionResponse };

/** #6454: how often, and how long, Resume and send waits for the session. */
export const RESUME_POLL_MS = 1_500;
export const RESUME_TIMEOUT_MS = 90_000;

/** The session a Submit goes to, plus what a relay to its PM needs. */
export type SubmitDialogSession = {
  id: string;
  tag?: string | null;
  active?: boolean;
  /** For naming the session, and the dialog's own title. */
  name?: string | null;
  parentSessionId?: string | null;
  parentRelationship?: string | null;
};

/** A phase that can carry the last preview gets it; any other stays as it is. */
function withPreview(
  phase: Phase,
  preview: PinSubmissionResponse | undefined
): Phase {
  if (!preview) return phase;
  if (phase.kind === "error" || phase.kind === "inactive") {
    return { ...phase, preview };
  }
  return phase;
}

/** The request for one target: the session (no `deliverTo`) or its PM. */
function requestFor(
  request: PinSubmissionRequest | null | undefined,
  target: string | null
): PinSubmissionRequest | null {
  if (!request) return null;
  const { deliverTo: _previous, ...rest } = request;
  return target ? { ...rest, deliverTo: target } : rest;
}

const sleep = (ms: number) =>
  new Promise<void>(resolve => window.setTimeout(resolve, ms));

/** The refusals of a relay that delivered nothing: the session takes the answers instead. */
function isRelayRefusal(code: string | undefined): boolean {
  return (
    code === "session_active" ||
    code === "parent_unavailable" ||
    code === "parent_mismatch"
  );
}

function refusalOf(error: unknown): Refusal | null {
  if (!(error instanceof ApiError)) return null;
  try {
    const body = JSON.parse(error.body ?? "") as Refusal;
    return { ...body, code: body.code ?? error.code };
  } catch {
    return { code: error.code, error: error.message };
  }
}

/**
 * #6539: the same Submit without its dismissals, under a new id, because the
 * entry set changed and the old id may be on record somewhere. Its `submitted`
 * holds only the pins it still sends, so the dismissals stay staged.
 */
function withoutDismissals(built: BuiltSubmission): BuiltSubmission {
  const entries = (built.request?.entries ?? []).filter(
    entry => entry.dismiss !== true
  );
  const kept = new Set(entries.map(entry => entry.key));
  return {
    request:
      built.request && entries.length > 0
        ? { ...built.request, submissionId: makeSubmissionId(), entries }
        : null,
    submitted: Object.fromEntries(
      Object.entries(built.submitted).filter(([key]) => kept.has(key))
    ),
    stale: built.stale.filter(row => kept.has(row.key)),
  };
}

/** #6539: dropped keys. A sent row under one is the pin's save (#6453), not its
 *  dismissal or answer. */
function droppedKeysOf(
  entries: readonly { key: string; outcome: string }[]
): Set<string> {
  return new Set(entries.filter(e => e.outcome === "dropped").map(e => e.key));
}

/**
 * #6539 R1: the server's code for a dismissal staged before the agent revised
 * the pin. The pin stays open, so the dismissal stays staged (with any pick it
 * holds) for the operator to Undo or redo, and is never forgotten.
 */
const STALE_DISMISS = "pin_dismiss_stale";

/** "Sent 2 answers and 1 dismissal": dismissals are counted apart (#6539). */
function sentToast(answers: number, dismissals: number): string {
  const many = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  const parts = [
    answers > 0 || dismissals === 0 ? many(answers, "answer") : null,
    dismissals > 0 ? many(dismissals, "dismissal") : null,
  ].filter(Boolean);
  return `Sent ${parts.join(" and ")}`;
}

/**
 * One entry's answer, as the dialog lists it: "B. Wait", or "Steps 2/3 · Note".
 * #6453: a save reads "Saved", also for one the server added from another
 * device's Save (no request entry, but the result's pin has a saved folder).
 * #6539: a dismissal reads "Dismiss", ahead of everything else.
 */
function answerText(
  entry: PinSubmissionEntry | undefined,
  pin?: Parameters<typeof effectiveSavedTo>[0]
): string {
  if (!entry) return pin && effectiveSavedTo(pin) ? "Saved" : "";
  if (entry.dismiss === true) return entry.note ? "Dismiss · Note" : "Dismiss";
  if (entry.choice !== undefined) {
    return `${entry.choice}${entry.label ? `. ${entry.label}` : ""}`;
  }
  const parts: string[] = [];
  if (entry.steps) parts.push(`Steps ${entry.steps.done}/${entry.steps.total}`);
  if (entry.questions?.length) {
    const n = entry.questions.length;
    parts.push(`${n} question${n === 1 ? "" : "s"}`);
  }
  if (entry.note) parts.push("Note");
  // #6452 (ruling D5): an automatic-pick move or off the agent has not heard.
  if (entry.automaticPick) parts.push("Automatic pick change");
  if (entry.saved) parts.push("Saved");
  return parts.join(" · ");
}

/**
 * The message an older node cannot compose: the same `hapi_pin_answers/1`
 * text, built here in the device's zone, to send as a plain message that
 * records nothing. A save-only entry (#6453) is left out: an older node has no
 * saved folder to report, and an entry with nothing to send would not compose.
 */
function fallbackText(
  request: PinSubmissionRequest,
  pins: readonly Pin[],
  session: string
): string | null {
  const byKey = new Map(pins.map(pin => [pin.key, pin]));
  const message = formatPinAnswersMessage({
    session,
    now: Date.now(),
    timeZone: request.timeZone ?? browserTimeZone() ?? "UTC",
    entries: request.entries.filter(hasPinAnswer).map(entry => ({
      pin: entry.key,
      rev: entry.rev,
      kind: byKey.get(entry.key)?.kind ?? "decision",
      ...(entry.choice !== undefined
        ? {
            answer: {
              choice: entry.choice,
              label: entry.label ?? entry.choice,
            },
          }
        : {}),
      ...(entry.note ? { note: entry.note } : {}),
      ...(entry.questions ? { questions: entry.questions } : {}),
      ...(entry.steps ? { steps: entry.steps } : {}),
    })),
  });
  return message.ok ? message.text : null;
}

/**
 * #6450: the Submit dialog (R6), centered. On open it builds the request from
 * what is staged and asks the server for a dry run, so it lists, from the live
 * pins, every entry that will be sent, every staged entry that will be dropped
 * and why, and the exact message. Cancel sends and records nothing. Send uses
 * the same `submissionId`, so a retry can neither deliver twice nor record twice.
 */
export function PinsSubmitDialog(props: {
  api: ApiClient | null;
  session: SubmitDialogSession;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { api, session, open, onOpenChange } = props;
  const sessionId = session.id;
  const pinsQuery = usePins(api, sessionId, open);
  const submit = useSubmitPinAnswers(api, sessionId);
  const { showToast } = useToast();
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  const [built, setBuilt] = useState<BuiltSubmission | null>(null);
  const busy = useRef(false);
  // #6454: mirrors `busy` for rendering, so Cancel is disabled whenever a
  // request or the Resume wait is out.
  const [working, setWorking] = useState(false);
  const setBusy = (on: boolean) => {
    busy.current = on;
    setWorking(on);
  };
  const { setDeadline } = useSetPinDeadline(api, sessionId);
  // #6539: a dismissal that did not take gives back the pick it held off, as
  // Undo does; a failed restore leaves the pin's line reading "off".
  const releasePicks = (held: Record<string, StagedPin>, keys: string[]) => {
    for (const key of keys) {
      const pickAt = held[key]?.dismiss ? held[key]?.pickAt : undefined;
      if (pickAt === undefined) continue;
      const at = new Date(restoredPickAt(pickAt, Date.now())).toISOString();
      void setDeadline(key, { at }).catch(() => undefined);
    }
  };
  // #6454: where the answers go: the session (null) or its Project Manager.
  const [target, setTarget] = useState<string | null>(null);
  // The target a pending (unanswered) Submit already used: its id may only go
  // there again. Undefined when nothing is pending.
  const [pinnedTarget, setPinnedTarget] = useState<string | null | undefined>(
    undefined
  );
  // Running again: resumed here, or the server said so.
  const [resumed, setResumed] = useState(false);
  // The server refused a send because the session is not running, whatever
  // the session record this dialog was opened with said.
  const [stopped, setStopped] = useState(false);
  const [relayNotice, setRelayNotice] = useState<string | null>(null);
  // False once this dialog closes or unmounts: an async step that resumes after
  // that (the Resume wait, a dry run) does nothing (#6454 review).
  const alive = useRef(open);
  alive.current = open;
  useEffect(
    () => () => {
      alive.current = false;
    },
    []
  );
  // Each opening's dry run, so a late answer from a previous opening is ignored.
  const opening = useRef(0);
  // The latest `refused`, for the opening's dry run (an effect, which keeps its
  // first render's closures).
  const refusedRef = useRef<typeof refused | null>(null);
  const sessionRunning = resumed || (session.active === true && !stopped);
  const pm = useSessionProjectManager(api, session, open && !sessionRunning);
  const pins = useMemo(
    () => (pinsQuery.data?.kind === "ready" ? pinsQuery.data.pins : []),
    [pinsQuery.data]
  );
  const pinsSettled = pinsQuery.data !== undefined || pinsQuery.isError;

  // One request per opening, built once the list has answered; every retry in
  // this opening reuses it and its id.
  useEffect(() => {
    if (!open) {
      opening.current += 1;
      setBuilt(null);
      setPhase({ kind: "checking" });
      busy.current = false;
      setWorking(false);
      setTarget(null);
      setPinnedTarget(undefined);
      setResumed(false);
      setStopped(false);
      setRelayNotice(null);
      return;
    }
    if (built || !pinsSettled) return;
    const staged = getStagedPins(sessionId);
    const pending = loadPendingSubmission(sessionId);
    let next: BuiltSubmission;
    let firstTarget: string | null = null;
    if (pending && pendingStillStaged(pending, staged)) {
      // #6454: a pending id goes only where it went before.
      firstTarget = pending.request.deliverTo ?? null;
      setPinnedTarget(firstTarget);
      setTarget(firstTarget);
      // A Submit whose answer never arrived: finish it under its own id, so the
      // server replays it instead of delivering a second message.
      const subset = Object.fromEntries(
        Object.keys(pending.stamps).map(key => [key, staged[key] as StagedPin])
      );
      next = {
        ...buildSubmissionRequest({
          staged: subset,
          pins,
          submissionId: pending.submissionId,
        }),
        request: pending.request,
      };
    } else {
      if (pending) clearPendingSubmission(sessionId);
      next = buildSubmissionRequest({
        staged,
        pins,
        submissionId: makeSubmissionId(),
      });
    }
    setBuilt(next);
    const request = requestFor(next.request, firstTarget);
    if (!request) {
      setPhase({ kind: "empty", dropped: [] });
      return;
    }
    const token = opening.current;
    void submit({ ...request, dryRun: true }).then(
      preview => {
        if (token !== opening.current || !alive.current) return;
        if (preview.delivered) {
          // Already delivered and on record: settle it, send nothing.
          settleStaging(sessionId, preview, next.submitted);
          if (allRecorded(preview)) clearPendingSubmission(sessionId);
          setPhase({ kind: "result", result: preview });
          return;
        }
        setPhase(
          preview.entries.some(e => e.outcome === "sent")
            ? { kind: "preview", preview }
            : { kind: "empty", dropped: preview.entries }
        );
      },
      (error: unknown) => {
        if (token !== opening.current || !alive.current) return;
        // #6454 review GR-1: a pending relay the server now refuses (the session
        // runs again, or its PM stopped or dropped it) delivered nothing, so it
        // falls back to the session as a send or Check again would; `built` is
        // not set yet in this closure, so the request goes with it.
        if (isRelayRefusal(refusalOf(error)?.code) && refusedRef.current) {
          void refusedRef.current(error, undefined, next.request);
          return;
        }
        setPhase(phaseForError(error));
      }
    );
  }, [open, built, pinsSettled, pins, sessionId, submit]);

  const preview =
    "preview" in phase && phase.preview ? phase.preview : undefined;
  const sent = preview?.entries.filter(e => e.outcome === "sent") ?? [];
  const dropped = preview?.entries.filter(e => e.outcome === "dropped") ?? [];
  const droppedKeys = droppedKeysOf(dropped);
  const titleOf = (key: string) =>
    pins.find(pin => pin.key === key)?.title ?? key;
  const kindOf = (key: string) =>
    pins.find(pin => pin.key === key)?.kind ??
    built?.submitted[key]?.kind ??
    "";

  /** #6454: a dry run for one target, so the dialog previews what it receives. */
  const check = async (
    to: string | null,
    base: PinSubmissionRequest | null | undefined = built?.request
  ) => {
    const request = requestFor(base, to);
    if (!request) return;
    setTarget(to);
    setBusy(true);
    setPhase({ kind: "checking" });
    try {
      const next = await submit({ ...request, dryRun: true });
      setPhase(
        next.entries.some(e => e.outcome === "sent")
          ? { kind: "preview", preview: next }
          : { kind: "empty", dropped: next.entries }
      );
    } catch (error) {
      if (!isRelayRefusal(refusalOf(error)?.code)) {
        // Nothing was sent by a dry run: leave the relay target behind (an
        // older owning node, a network fault) unless a pending id pins it.
        setTarget(typeof pinnedTarget === "string" ? pinnedTarget : null);
      }
      await refused(error, undefined, base);
    } finally {
      setBusy(false);
    }
  };

  /**
   * A refusal: a relay the server would not take falls back to the session
   * (#6454); anything else is shown with the last preview.
   */
  const refused = async (
    error: unknown,
    last: PinSubmissionResponse | undefined,
    base: PinSubmissionRequest | null | undefined = built?.request
  ) => {
    const refusal = refusalOf(error);
    // The PM the refused request named: a reopened relay may have gone to
    // one that is no longer the running PM this dialog found (#6454 review).
    const refusedPm = base?.deliverTo;
    const pmName =
      pm && (refusedPm === undefined || refusedPm === pm.id)
        ? pm.name
        : "Its Project Manager";
    if (refusal?.code === "session_inactive") {
      setResumed(false);
      setStopped(true);
    }
    if (refusal?.code === "session_active") {
      setResumed(true);
      setRelayNotice(
        "The session is running again, so your answers go to it directly"
      );
      await check(null, base);
      return;
    }
    if (
      refusal?.code === "parent_unavailable" ||
      refusal?.code === "parent_mismatch"
    ) {
      setRelayNotice(
        `${pmName} cannot take them: ${refusal.error}. Resume the session to send`
      );
      setPinnedTarget(prev => (prev === undefined ? prev : null));
      await check(null, base);
      return;
    }
    setPhase(withPreview(phaseForError(error), last));
  };
  refusedRef.current = refused;
  const currentBuilt = built;
  const currentPreview = preview;

  /**
   * #6539 (ruling D2): the session's node cannot take dismissals, so send the
   * other answers through the normal Submit, which records them, and leave
   * every dismissal staged with its note and its held pick. One press: the dry
   * run for the smaller request, then the send under the same new id.
   */
  const sendWithoutDismissals = async () => {
    if (!built || busy.current) return;
    const next = withoutDismissals(built);
    const request = requestFor(next.request, target);
    if (!request) return;
    setBuilt(next);
    setBusy(true);
    setPhase({ kind: "checking" });
    let nextPreview: PinSubmissionResponse;
    try {
      nextPreview = await submit({ ...request, dryRun: true });
    } catch (error) {
      setBusy(false);
      await refused(error, undefined, next.request);
      return;
    }
    setBusy(false);
    if (!alive.current) return;
    if (!nextPreview.entries.some(e => e.outcome === "sent")) {
      setPhase({ kind: "empty", dropped: nextPreview.entries });
      return;
    }
    setPhase({ kind: "preview", preview: nextPreview });
    // #6539 R2: what this dry run drops is shown, with its reason, before
    // anything is sent; the operator then presses Send.
    if (nextPreview.entries.some(e => e.outcome === "dropped")) return;
    await send(target, { built: next, preview: nextPreview });
  };

  const send = async (
    to: string | null = target,
    // #6539: a request built in this same turn (Send without the dismissals),
    // which the state this closure read does not hold yet.
    override?: { built: BuiltSubmission; preview: PinSubmissionResponse }
  ) => {
    const built = override?.built ?? currentBuilt;
    const preview = override?.preview ?? currentPreview;
    const request = requestFor(built?.request, to);
    if (!request || busy.current || !preview || !built) return;
    setBusy(true);
    setPhase({ kind: "sending", preview });
    // Before the request leaves: a lost response or a closed app must reopen on
    // the same id, and on the same target (#6454): from here this id may only
    // go where it went, so the relay stops being offered for it, and Resume too
    // once it went to the PM.
    setPinnedTarget(to);
    savePendingSubmission(sessionId, {
      submissionId: request.submissionId,
      request,
      stamps: Object.fromEntries(
        Object.entries(built.submitted).map(([key, entry]) => [
          key,
          entry.updatedAt,
        ])
      ),
      at: Date.now(),
    });
    try {
      const result = await submit({ ...request, dryRun: false });
      if (!result.delivered) {
        clearPendingSubmission(sessionId);
        setPinnedTarget(undefined);
        const outcome =
          (result.denied?.outcome as {
            title?: string;
            explanation?: string;
          }) ??
          resolveDenialOutcome(
            result.denied?.hookId ?? "",
            result.denied?.reason ?? "denied",
            {}
          );
        setPhase({
          kind: "denied",
          preview,
          title: outcome.title ?? "The session refused the message",
          text: outcome.explanation ?? "",
        });
        return;
      }
      settleStaging(sessionId, result, built.submitted);
      const unmade = result.entries.filter(
        e => (e.outcome !== "sent" || e.moot) && e.code !== STALE_DISMISS
      );
      const unmadeKeys = unmade.map(e => e.key);
      releasePicks(built.submitted, unmadeKeys);
      if (allRecorded(result)) clearPendingSubmission(sessionId);
      const pending = result.entries.filter(
        e => e.outcome === "sent" && (e.recorded === false || e.moot)
      );
      // #6539 R1: an entry the real Send dropped that the preview listed as
      // sent (the agent revised the pin meanwhile) is shown, never closed on.
      const shown = droppedKeysOf(preview.entries);
      const lateDrop = result.entries.some(
        e => e.outcome === "dropped" && !shown.has(e.key)
      );
      if (pending.length > 0 || lateDrop) {
        setPhase({ kind: "result", result });
        return;
      }
      const sentKeys = new Set(
        result.entries.filter(e => e.outcome === "sent").map(e => e.key)
      );
      const droppedKeys = droppedKeysOf(result.entries);
      const dismissals = request.entries.filter(
        e =>
          e.dismiss === true && sentKeys.has(e.key) && !droppedKeys.has(e.key)
      ).length;
      showToast(sentToast(sentKeys.size - dismissals, dismissals), {
        type: "success",
      });
      onOpenChange(false);
    } catch (error) {
      // A refusal (4xx) delivered nothing; a lost response may have.
      if (error instanceof ApiError && error.status < 500) {
        clearPendingSubmission(sessionId);
        setPinnedTarget(undefined);
      }
      setBusy(false);
      // The request that was sent: its target names the PM a refusal is about.
      await refused(error, preview, request);
    } finally {
      setBusy(false);
    }
  };

  /**
   * #6454: reconnect the session (it keeps its id), wait until it runs, then
   * send the same request. A timeout or a failed reconnect leaves the answers
   * staged and says so.
   */
  const resumeAndSend = async () => {
    if (!api || busy.current || !preview) return;
    setBusy(true);
    setPhase({ kind: "resuming", preview });
    try {
      const reconnected = await api.reconnectSession(sessionId);
      if (reconnected?.newSessionId && reconnected.newSessionId !== sessionId) {
        throw new Error(
          "The session came back under a new id. Open Submit there to send"
        );
      }
      const deadline = Date.now() + RESUME_TIMEOUT_MS;
      for (;;) {
        if (!alive.current) return;
        const current = await api.getSession(sessionId);
        if (current.session.active) break;
        if (Date.now() >= deadline) {
          throw new Error(
            "The session did not come back within 90 seconds. Your answers are still staged"
          );
        }
        await sleep(RESUME_POLL_MS);
      }
    } catch (error) {
      setPhase({
        kind: "error",
        message: error instanceof Error ? error.message : "Could not resume",
        preview,
      });
      setBusy(false);
      return;
    }
    if (!alive.current) return;
    setResumed(true);
    setStopped(false);
    setBusy(false);
    await send(null);
  };

  const sendPlain = async () => {
    // #6539 (KD9): a plain message records nothing, so a dismissal never goes
    // out this way. It stays staged; only the other entries are sent and cleared.
    const plain = built ? withoutDismissals(built) : null;
    const request = plain?.request;
    if (!api || !request || busy.current) return;
    const text = fallbackText(request, pins, session.tag ?? sessionId);
    if (!text) {
      setPhase({ kind: "error", message: "The message is too large to send" });
      return;
    }
    setBusy(true);
    try {
      const result = await api.sendMessage(
        sessionId,
        text,
        `pins-${request.submissionId}`
      );
      if (!result.ok) {
        setPhase({ kind: "error", message: "The session refused the message" });
        return;
      }
      // Sent: the same answers must not go again with the next Submit.
      if (plain) clearSubmitted(sessionId, plain.submitted);
      clearPendingSubmission(sessionId);
      showToast("Sent as a plain message. The pins stay open", {
        type: "info",
      });
      onOpenChange(false);
    } catch (error) {
      setPhase({
        kind: "error",
        message: error instanceof Error ? error.message : "Could not send",
      });
    } finally {
      setBusy(false);
    }
  };

  const sending = phase.kind === "sending";
  const ready =
    (phase.kind === "preview" || phase.kind === "error") && Boolean(preview);
  const canSend = ready && (target !== null || sessionRunning);
  // #6454: a stopped session offers Resume and, through its Project Manager on
  // the same node, a relay; a pending id keeps to the target it used.
  const offerRelay =
    ready &&
    !sessionRunning &&
    target === null &&
    pm !== null &&
    pm.sameNode &&
    pinnedTarget !== null;
  const offerResume =
    (ready || phase.kind === "inactive") &&
    Boolean(preview) &&
    !sessionRunning &&
    target === null &&
    typeof pinnedTarget !== "string";
  const pmName = pm?.name ?? "its Project Manager";
  // #6539: what a node that cannot take dismissals can still be sent.
  const isDismissal = (key: string) =>
    built?.request?.entries.some(e => e.key === key && e.dismiss === true) ??
    false;
  const hasDismissals =
    built?.request?.entries.some(e => e.dismiss === true) ?? false;
  const hasOthers =
    built?.request?.entries.some(e => e.dismiss !== true) ?? false;
  // Named wherever the dialog says which session it means: opened from a
  // Project Manager's page, "the session" would read as the page's own.
  const sessionName = session.name?.trim() || session.tag || null;

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        // Never while a request is out: closing then would lose its answer.
        if (!next && busy.current) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        className="max-w-md"
        description="Review the answers that will be sent to the session"
        hideCloseButton={sending}
        onEscapeKeyDown={event => {
          if (busy.current) event.preventDefault();
        }}
        onInteractOutside={event => {
          if (busy.current) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {target !== null
              ? `Send to ${pmName}`
              : `Send to ${sessionName ?? "the session"}`}
          </DialogTitle>
        </DialogHeader>

        <div className="mt-2 max-h-[55vh] overflow-y-auto text-[length:var(--text-body)]">
          {phase.kind === "checking" ? (
            <Line text="Checking your answers against the pins…" />
          ) : null}
          {phase.kind === "resuming" ? (
            <Line
              text={`Resuming ${sessionName ?? "the session"}, then sending (up to 90 seconds)…`}
            />
          ) : null}
          {relayNotice ? <Notice title={relayNotice} text="" /> : null}
          {target !== null && preview ? (
            <Line
              text={`${sessionName ?? "This session"} is not running, so ${pm ? `${pm.name}, its Project Manager,` : "its Project Manager"} receives these answers. They are recorded on ${sessionName ? `${sessionName}'s` : "this session's"} pins`}
            />
          ) : null}
          {phase.kind === "empty" ? (
            <>
              <Line text="Nothing staged can be sent." />
              <DroppedRows rows={phase.dropped} titleOf={titleOf} />
            </>
          ) : null}
          {preview && phase.kind !== "result" ? (
            <>
              <ul className="border-t border-[var(--app-divider)]">
                {sent.map(entry => (
                  <li
                    key={entry.key}
                    className="flex min-h-8 items-center gap-1.5 border-b border-[var(--app-divider)] py-1"
                  >
                    <PinKindBadge kind={kindOf(entry.key)} armed={false} />
                    <span className="min-w-0 flex-1 truncate font-semibold">
                      {titleOf(entry.key)}
                    </span>
                    {entry.stale ? (
                      <span
                        className="shrink-0 rounded-full border px-1.5 text-[length:var(--text-caption)] text-[var(--status-warn)]"
                        style={{ borderColor: "var(--status-warn)" }}
                      >
                        Changed since you chose
                      </span>
                    ) : null}
                    <span
                      className={`max-w-[40%] shrink-0 truncate ${
                        isDismissal(entry.key) && !droppedKeys.has(entry.key)
                          ? "text-[var(--app-badge-error-text)]"
                          : "text-[var(--app-hint)]"
                      }`}
                    >
                      {answerText(
                        droppedKeys.has(entry.key)
                          ? undefined
                          : built?.request?.entries.find(
                              e => e.key === entry.key
                            ),
                        entry.pin
                      )}
                    </span>
                  </li>
                ))}
              </ul>
              <DroppedRows rows={dropped} titleOf={titleOf} />
              <details className="mt-2">
                <summary className="cursor-pointer text-[var(--app-hint)]">
                  Message
                </summary>
                <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--app-subtle-bg)] p-2 text-[length:var(--text-caption)]">
                  {preview.text}
                </pre>
              </details>
            </>
          ) : null}
          {phase.kind === "result" ? (
            <ResultRows
              result={phase.result}
              titleOf={titleOf}
              isDismissal={isDismissal}
            />
          ) : null}
          {phase.kind === "denied" ? (
            <Notice
              title={phase.title}
              text={phase.text || "Your answers are still staged."}
            />
          ) : null}
          {target === null &&
          !sessionRunning &&
          (phase.kind === "inactive" || ready) ? (
            <Notice
              title={`${sessionName ?? "The session"} is not running`}
              text={
                pm && !pm.sameNode
                  ? `${pm.name} runs on ${pm.nodeLabel ?? "another node"}, so only Resume can reach ${sessionName ?? "this session"}. Your answers stay staged until you send them`
                  : offerRelay
                    ? `Resume it and send, or send your answers to ${pmName}, its Project Manager. Your answers stay staged until you send them`
                    : "Resume it and send. Your answers stay staged until you send them"
              }
            />
          ) : null}
          {phase.kind === "unsupported" ? (
            <Notice
              title="This session's node is older and cannot receive pin answers"
              text={
                !hasOthers
                  ? DISMISSALS_STAY
                  : hasDismissals
                    ? `Send your other answers as a plain message instead? Pins will stay open. ${DISMISSALS_STAY}`
                    : "Send them as a plain message instead? Pins will stay open."
              }
            />
          ) : null}
          {phase.kind === "dismissUnsupported" ? (
            <Notice
              title="This session's node is older and cannot receive dismissals"
              text={
                hasOthers
                  ? "Send your other answers now? The dismissals stay staged here."
                  : DISMISSALS_STAY
              }
            />
          ) : null}
          {phase.kind === "error" ? (
            <Notice title="Not sent" text={phase.message} />
          ) : null}
        </div>

        {/* Wraps on a phone, where Cancel, the relay and Resume do not fit one line. */}
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              // Never while a request or the Resume wait is out (#6454).
              if (busy.current) return;
              onOpenChange(false);
            }}
            disabled={working}
          >
            {phase.kind === "result" ? "Close" : "Cancel"}
          </Button>
          {offerRelay ? (
            <Button
              type="button"
              variant="secondary"
              disabled={working}
              onClick={() => void (pm ? check(pm.id) : undefined)}
              title={`Send your answers to ${pmName}, its Project Manager`}
            >
              <span className="truncate" style={{ maxWidth: "14rem" }}>
                {`Send to ${pmName}`}
              </span>
            </Button>
          ) : null}
          {offerResume ? (
            <Button
              type="button"
              disabled={working}
              onClick={() => void resumeAndSend()}
            >
              Resume and send
            </Button>
          ) : phase.kind === "unsupported" ? (
            hasOthers ? (
              <Button type="button" onClick={() => void sendPlain()}>
                Send as a message
              </Button>
            ) : null
          ) : phase.kind === "dismissUnsupported" ? (
            // Only dismissals staged: nothing this node can take, so no send.
            hasOthers ? (
              <Button
                type="button"
                disabled={working}
                onClick={() => void sendWithoutDismissals()}
              >
                Send without the dismissals
              </Button>
            ) : null
          ) : phase.kind === "empty" && staleKeys(phase, built).length > 0 ? (
            <Button
              type="button"
              onClick={() => {
                releasePicks(built?.submitted ?? {}, staleKeys(phase, built));
                dropPins(sessionId, staleKeys(phase, built));
                onOpenChange(false);
              }}
            >
              Clear these
            </Button>
          ) : phase.kind === "error" && !preview ? (
            <Button
              type="button"
              onClick={() => {
                // The reopen path re-derives the target from any pending id.
                setTarget(null);
                setBuilt(null);
                setPhase({ kind: "checking" });
              }}
            >
              Check again
            </Button>
          ) : phase.kind === "result" &&
            phase.result.entries.some(e => e.recorded === false) ? (
            <Button
              type="button"
              onClick={() => void retryRecord(phase.result)}
            >
              Retry
            </Button>
          ) : phase.kind !== "result" && phase.kind !== "resuming" ? (
            <Button
              type="button"
              disabled={!canSend || working}
              onClick={() => void send()}
            >
              {sending
                ? "Sending…"
                : phase.kind === "error"
                  ? "Retry"
                  : target !== null
                    ? `Send to ${pmName}`
                    : "Send"}
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );

  // A delivered Submit whose record failed: the same id delivers nothing new
  // and records once.
  async function retryRecord(previous: PinSubmissionResponse) {
    const request = built?.request;
    if (!request || busy.current) return;
    setBusy(true);
    try {
      const result = await submit({
        ...(requestFor(request, target) ?? request),
        dryRun: false,
      });
      if (built) settleStaging(sessionId, result, built.submitted);
      if (allRecorded(result)) clearPendingSubmission(sessionId);
      setPhase({ kind: "result", result });
    } catch (error) {
      setPhase({
        kind: "result",
        result: previous,
      });
      showToast(
        error instanceof Error ? error.message : "Could not record the answers",
        { type: "error" }
      );
    } finally {
      setBusy(false);
    }
  }
}

/** Staged pins the server would not take: offered for clearing. */
function staleKeys(
  phase: Extract<Phase, { kind: "empty" }>,
  built: BuiltSubmission | null
): string[] {
  return phase.dropped
    .map(row => row.key)
    .filter(key => built?.submitted[key] !== undefined);
}

/** True when every entry the session received is on record. */
function allRecorded(result: PinSubmissionResponse): boolean {
  return result.entries.every(
    e => e.outcome !== "sent" || e.recorded !== false
  );
}

/**
 * What was sent and recorded leaves staging, and what the server dropped is
 * forgotten, except a stale dismissal (#6539 R1), whose pin is still open; an
 * entry delivered but not yet recorded stays staged, so closing before Retry
 * loses nothing.
 */
function settleStaging(
  sessionId: string,
  result: PinSubmissionResponse,
  submitted: Readonly<Record<string, Readonly<StagedPin>>>
): void {
  // #6539 R1: a stale dismissal stays staged, even when the pin's save went.
  const keep = new Set(
    result.entries.filter(e => e.code === STALE_DISMISS).map(e => e.key)
  );
  const done: Record<string, Readonly<StagedPin>> = {};
  for (const entry of result.entries) {
    const staged = submitted[entry.key];
    if (
      entry.outcome === "sent" &&
      entry.recorded !== false &&
      staged &&
      !keep.has(entry.key)
    ) {
      done[entry.key] = staged;
    }
  }
  clearSubmitted(sessionId, done);
  dropPins(
    sessionId,
    result.entries
      .filter(e => e.outcome === "dropped" && !keep.has(e.key))
      .map(e => e.key)
  );
}

function phaseForError(error: unknown): Phase {
  const refusal = refusalOf(error);
  if (refusal?.code === "session_inactive") return { kind: "inactive" };
  if (refusal?.code === "pin_answers_unsupported")
    return { kind: "unsupported" };
  if (refusal?.code === "pin_dismiss_unsupported")
    return { kind: "dismissUnsupported" };
  if (refusal?.code === "pin_submission_empty") {
    return { kind: "empty", dropped: refusal.entries ?? [] };
  }
  return {
    kind: "error",
    message:
      refusal?.error ??
      (error instanceof Error ? error.message : "Could not reach the session"),
  };
}

/**
 * #6539 R1: why a pin was not sent, in plain words. A stale dismissal names
 * what happened and that it is still staged; any other drop keeps the
 * server's reason.
 */
export const STALE_DISMISS_TEXT =
  "Not dismissed: the agent changed this pin after you chose to dismiss it. It is still marked Will dismiss.";
function droppedText(entry: PinSubmissionResult): string {
  if (entry.code === STALE_DISMISS) return STALE_DISMISS_TEXT;
  return entry.reason ? `Not sent: ${entry.reason}` : "Not sent";
}

/** #6539: what happens to dismissals a node cannot take. */
const DISMISSALS_STAY =
  "The dismissals stay staged here. Undo on a pin releases it.";

function Line(props: { text: string }) {
  return <div className="py-2 text-[var(--app-hint)]">{props.text}</div>;
}

function Notice(props: { title: string; text: string }) {
  return (
    <div className="mt-2 flex gap-1.5 rounded-md border border-[var(--app-border)] p-2">
      <TriangleAlert
        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--status-warn)]"
        aria-hidden
      />
      <div>
        <div className="font-semibold">{props.title}</div>
        {props.text ? (
          <div className="text-[var(--app-hint)]">{props.text}</div>
        ) : null}
      </div>
    </div>
  );
}

function DroppedRows(props: {
  rows: readonly PinSubmissionResult[];
  titleOf: (key: string) => string;
}) {
  if (props.rows.length === 0) return null;
  return (
    <div className="mt-2">
      <div className="text-[length:var(--text-caption)] font-semibold uppercase tracking-wide text-[var(--app-hint)]">
        Not sent
      </div>
      <ul>
        {props.rows.map((row, index) => (
          <li
            key={`${row.key}:${index}`}
            className="flex min-h-7 items-center gap-1.5 border-b border-[var(--app-divider)]"
          >
            <span className="min-w-0 flex-1 truncate">
              {props.titleOf(row.key)}
            </span>
            <span className="shrink-0 text-[var(--app-hint)]">
              {row.reason ?? "dropped"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ResultRows(props: {
  result: PinSubmissionResponse;
  titleOf: (key: string) => string;
  /** #6539: a dismissal is worded as one, never as an answer. */
  isDismissal: (key: string) => boolean;
}) {
  const sent = props.result.entries.filter(e => e.outcome === "sent");
  const dropped = props.result.entries.filter(e => e.outcome === "dropped");
  const droppedKeys = droppedKeysOf(props.result.entries);
  const isDismissal = (key: string) =>
    props.isDismissal(key) && !droppedKeys.has(key);
  const unrecorded = sent.filter(e => e.recorded === false);
  const undismissed = unrecorded.filter(e => isDismissal(e.key)).length;
  const unanswered = unrecorded.length - undismissed;
  const pins = (n: number) => `${n} pin${n === 1 ? "" : "s"}`;
  const failures = [
    unanswered > 0 ? `${pins(unanswered)} could not be marked answered` : null,
    undismissed > 0 ? `${pins(undismissed)} could not be dismissed` : null,
  ].filter(Boolean);
  return (
    <>
      <Line
        text={
          failures.length > 0
            ? `Sent to the session. ${failures.join(", and ")}.`
            : "Sent to the session."
        }
      />
      <ul className="border-t border-[var(--app-divider)]">
        {sent.map(entry => {
          const dismissal = isDismissal(entry.key);
          return (
            <li
              key={entry.key}
              className="border-b border-[var(--app-divider)] py-1"
            >
              {/* The status on its own line, so a long one never hides the title. */}
              <span className="block truncate">{props.titleOf(entry.key)}</span>
              <span
                className={`block text-[length:var(--text-caption)] ${entry.moot || entry.recorded === false ? "text-[var(--status-warn)]" : "text-[var(--app-hint)]"}`}
              >
                {entry.recorded === false
                  ? dismissal
                    ? "Not dismissed yet"
                    : "Not marked answered yet"
                  : entry.moot
                    ? dismissal
                      ? "Not dismissed: the pin changed since you chose to dismiss"
                      : "Recorded as moot: the pin changed since you chose"
                    : dismissal
                      ? "Dismissed"
                      : "Recorded"}
              </span>
            </li>
          );
        })}
      </ul>
      {dropped.length > 0 ? (
        <ul className="mt-2">
          {dropped.map((entry, index) => (
            <li
              key={`${entry.key}:${index}`}
              className="border-b border-[var(--app-divider)] py-1"
            >
              <span className="block truncate">{props.titleOf(entry.key)}</span>
              <span className="block text-[length:var(--text-caption)] text-[var(--status-warn)]">
                {droppedText(entry)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
