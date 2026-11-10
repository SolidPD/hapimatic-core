// SPDX-License-Identifier: AGPL-3.0-only
import {
  effectiveSavedTo,
  formatPinAnswersMessage,
  formatPinAnswerTime,
  hasPinAnswer,
  isAutoPickEligible,
  isReservedPinKey,
  laneSessionRefs,
  neutralizeApprovalTokens,
  parseDashboardLanes,
  PIN_ANSWERS_MESSAGE_MAX_CHARS,
  scrubSecretTokens,
  type Pin,
  type PinAnswersEntry,
  type PinAutomaticPick,
  type PinSubmissionEntry,
  type PinSubmissionRequest,
  type PinSubmissionResponse,
  type PinSubmissionResult,
} from "@hapi/protocol";

import {
  isValidTimezone,
  loadTimeLogPreferenceTimezone,
} from "../config/timeLogConfig";
import type { PinBatchAnswer, PinBatchOutcome } from "../store/pinStore";
import { RecordVetoError } from "./messageService";
import type { MessageOrigin } from "./sentFrom";
import type { Session, SyncEngine } from "./syncEngine";

/**
 * What a Submit needs of the engine: the pins, the ordinary send path, a
 * namespace-scoped lookup for a relay's Project Manager, and the `localId` check
 * that finds where an earlier attempt was delivered (#6454).
 */
export type PinSubmissionEngine = Pick<
  SyncEngine,
  "pins" | "sendMessage" | "getSessionByNamespace" | "hasMessageLocalId"
>;

/** The submitting session as a Submit reads it. */
export type PinSubmissionSession = Pick<
  Session,
  | "id"
  | "tag"
  | "namespace"
  | "active"
  | "metadata"
  | "parentSessionId"
  | "parentRelationship"
>;

export type PinSubmissionContext = {
  /** Who sent it, derived from the authenticated request, never the body. */
  origin?: MessageOrigin;
  /**
   * The zone for the message's time strings: the operator's Time Log zone, else
   * the submitting browser's, else the host's (`resolvePinAnswersTimeZone`).
   */
  timeZone: string;
  now?: number;
};

export type PinSubmissionRefusal = {
  ok: false;
  status: 400 | 409 | 413;
  code:
    | "pin_submission_empty"
    | "pin_submission_too_large"
    | "session_inactive"
    | "session_active"
    | "parent_unavailable"
    | "parent_mismatch";
  error: string;
  /** Why each entry would not be sent, so the dialog can say so. */
  entries: PinSubmissionResult[];
};

export type PinSubmissionOutcome =
  | { ok: true; response: PinSubmissionResponse }
  | PinSubmissionRefusal;

type Kept = {
  entry: PinSubmissionEntry;
  pin: Pin;
  stale: boolean;
  /** #6452: the operator's pick change this entry reports, built from server state. */
  report?: PinAutomaticPick;
  /** #6452 (ruling D3): a question or note turns this pin's running pick off. */
  offForQuestion?: boolean;
  /** #6452: a report-only entry the server added; it records no answer. */
  reportOnly?: boolean;
  /** #6452: the operator change this entry reports, so only that one is marked. */
  reportedChange?: number;
};

type Checked =
  | { kept: Kept }
  | { dropped: { key: string; reason: string; code: string } };

/** Secrets out first, then approval tokens, so the record and the message agree. */
function clean(text: string): string {
  return neutralizeApprovalTokens(scrubSecretTokens(text));
}

function check(
  entry: PinSubmissionEntry,
  pin: Pin | undefined,
  seen: Set<string>
): Checked {
  const drop = (reason: string, code: string): Checked => ({
    dropped: { key: entry.key, reason, code },
  });
  if (seen.has(entry.key)) return drop("listed twice", "pin_listed_twice");
  seen.add(entry.key);
  if (!pin) return drop("no longer exists", "pin_missing");
  // #6455 mirrors native prompts as `prompt:` pins, which resolve through their
  // own control; `detected:` pins are dismiss-only.
  if (isReservedPinKey(pin.key)) {
    return drop("answered through its own prompt", "pin_reserved");
  }
  if (pin.kind === "dashboard") {
    return drop("a dashboard takes no answers", "pin_dashboard");
  }
  if (pin.status !== "open") return drop(`already ${pin.status}`, "pin_closed");
  if (entry.rev > pin.revision) {
    return drop("unknown revision", "pin_unknown_revision");
  }
  const stale = entry.rev < pin.revision;
  // Only the current revision can refuse a choice or a step count: an older one
  // may have offered what the current one removed, and is recorded moot.
  if (!stale) {
    if (
      entry.choice !== undefined &&
      !pin.options?.some(option => option.id === entry.choice)
    ) {
      return drop("unknown option", "pin_unknown_option");
    }
    if (
      entry.steps &&
      (pin.kind !== "steps" || entry.steps.total !== (pin.steps?.length ?? 0))
    ) {
      return drop("steps do not match the pin", "pin_steps_mismatch");
    }
  }
  return { kept: { entry, pin, stale } };
}

function cleanNote(entry: PinSubmissionEntry): string | undefined {
  return entry.note?.trim() ? clean(entry.note) : undefined;
}

/**
 * The label the message shows: the current option's label for a live answer,
 * else the operator's snapshot, because a later revision may have dropped it.
 */
function labelOf({ entry, pin, stale }: Kept): string | undefined {
  if (entry.choice === undefined) return undefined;
  const option = pin.options?.find(o => o.id === entry.choice);
  if (option && !stale) return option.label;
  if (entry.label !== undefined) return clean(entry.label);
  return option?.label ?? entry.choice;
}

function messageEntry(kept: Kept): PinAnswersEntry {
  const { entry, pin } = kept;
  const label = labelOf(kept);
  const note = cleanNote(entry);
  const questions = (entry.questions ?? []).map(clean);
  // #6453: the pin's saved folder rides every answer to it, Save's or the agent's own.
  const savedTo = effectiveSavedTo(pin);
  return {
    pin: pin.key,
    rev: entry.rev,
    kind: pin.kind,
    ...(entry.choice !== undefined
      ? { answer: { choice: entry.choice, label: label ?? entry.choice } }
      : {}),
    ...(note ? { note } : {}),
    ...(questions.length > 0 ? { questions } : {}),
    ...(kept.report ? { automaticPick: kept.report } : {}),
    ...(entry.steps ? { steps: entry.steps } : {}),
    ...(savedTo !== null ? { savedTo } : {}),
  };
}

/** #6453: an unreported Save on a pin the operator answered nothing else about. */
function saveEntry(pin: Pin): PinAnswersEntry {
  return {
    pin: pin.key,
    rev: pin.revision,
    kind: pin.kind,
    savedTo: effectiveSavedTo(pin) ?? "",
  };
}

/**
 * The operator's pick change to report (#6452, ruling D5), from the pin's own
 * state: the running time, or off. Undefined when there is nothing to say (the
 * agent removed the pick since, which suspends it).
 */
function reportOf(pin: Pin, timeZone: string): PinAutomaticPick | undefined {
  if (pin.deadlineBy === "off") return { off: true };
  if (typeof pin.deadlineAt === "string") {
    const ms = Date.parse(pin.deadlineAt);
    return { at: pin.deadlineAt, local: formatPinAnswerTime(ms, timeZone) };
  }
  return undefined;
}

/** Whether an entry settles its pin, which makes a pick change moot. */
function resolves(entry: PinSubmissionEntry): boolean {
  return (
    entry.choice !== undefined ||
    (entry.steps !== undefined && entry.steps.done === entry.steps.total)
  );
}

/** A running pick: one an operator's question or note turns off (ruling D3). */
function hasRunningPick(pin: Pin): boolean {
  return typeof pin.deadlineAt === "string" && pin.deadlineBy !== "off";
}

/**
 * One pin's entries in record order: each question, then the note on its own
 * when nothing else carries it, then the partial steps or the resolving answer.
 * The settling entry is last, so it is also the newest, which `trimAnswers` keeps.
 */
function batchItems(kept: Kept, deliveredTo?: string): PinBatchAnswer[] {
  const { entry, pin } = kept;
  const base = {
    key: pin.key,
    revision: entry.rev,
    by: "operator" as const,
    via: entry.via,
    ...(deliveredTo !== undefined ? { deliveredTo } : {}),
  };
  const note = cleanNote(entry);
  const items: PinBatchAnswer[] = (entry.questions ?? []).map(question => ({
    ...base,
    text: clean(question),
    resolves: false,
  }));
  if (entry.choice !== undefined) {
    const label = labelOf(kept);
    items.push({
      ...base,
      option: entry.choice,
      ...(label !== undefined ? { label } : {}),
      ...(note ? { note } : {}),
      resolves: true,
    });
  } else if (entry.steps) {
    const { done, total } = entry.steps;
    const allDone = done === total;
    items.push({
      ...base,
      text: allDone
        ? `All ${total} steps done`
        : `${done} of ${total} steps done`,
      steps: entry.steps,
      ...(note ? { note } : {}),
      resolves: allDone,
    });
  } else if (note) {
    items.push({ ...base, note, resolves: false });
  }
  return items;
}

function wasRecordedBy(pin: Pin | undefined, submission: string): boolean {
  return pin?.answers.some(a => a.submission === submission) ?? false;
}

/**
 * Whether `parent` manages `session` (#6454): it spawned it, or one of its live
 * dashboards names it in a lane, by id or tag. A dashboard row this build cannot
 * read names nothing.
 */
function managesSession(
  engine: PinSubmissionEngine,
  parent: Pick<Session, "id">,
  session: PinSubmissionSession
): boolean {
  if (
    session.parentRelationship === "spawn" &&
    session.parentSessionId === parent.id
  ) {
    return true;
  }
  for (const ref of engine.pins.listLiveDashboardRefs()) {
    if (ref.sessionId !== parent.id) continue;
    let lanes: unknown;
    try {
      lanes = engine.pins.getDashboard(ref.sessionId, ref.key)?.lanes;
    } catch {
      continue;
    }
    const named = laneSessionRefs(parseDashboardLanes(lanes).lanes);
    if (
      named.includes(session.id) ||
      (session.tag !== undefined &&
        session.tag !== null &&
        named.includes(session.tag))
    ) {
      return true;
    }
  }
  return false;
}

const RELAY_TEXT_MAX_CHARS = 80;

/**
 * A session's name or tag on one line of the relay: no control characters or
 * backticks (a name set through session metadata could otherwise open a fence
 * ahead of the real answers block), whitespace collapsed, capped, then cleaned.
 */
function relayText(text: string): string {
  const flat = text
    .replace(/[\p{Cc}`]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean(
    flat.length > RELAY_TEXT_MAX_CHARS
      ? `${flat.slice(0, RELAY_TEXT_MAX_CHARS - 1)}…`
      : flat
  );
}

/**
 * The line a relayed message opens with (#6454). Cleaned, because a session's
 * name is agent-settable and an approval token in it would otherwise reach the
 * Project Manager inside the operator's message.
 */
function relayLine(session: PinSubmissionSession): string {
  const tag = relayText(session.tag ?? session.id);
  const name = relayText(session.metadata?.name ?? "");
  const who = name ? `${name} (${tag})` : tag;
  return `Answers for ${who}, which is not running, relayed to you as its Project Manager`;
}

/** The message cap as the refusal states it: "48,000". */
const MESSAGE_LIMIT = PIN_ANSWERS_MESSAGE_MAX_CHARS.toLocaleString("en-US");

/**
 * The operator's Submit (#6450, ruling DQ1 = A): check each staged entry against
 * the live pin, compose ONE ordinary user message in the `hapi_pin_answers/1`
 * format, and deliver it through `engine.sendMessage` (the code `POST /messages`
 * runs: message hooks, `localId` de-duplication, CLI delivery). Runs on the
 * session's owning node, so the check reads the live pins, never a client's cache.
 *
 * #6452: the answers are recorded in the SAME transaction as the message insert
 * (`sendMessage`'s `record` step), so a message is never delivered without its
 * answers recorded, nor the reverse. A busy store fails the whole send (the
 * route answers 503) and a retry starts clean. Each kept pin is claimed across
 * the send, so an automatic pick never lands on a pin whose answer is in flight;
 * a pin already claimed by an automatic pick is dropped.
 *
 * #6453: every unreported Save rides the message, on its pin's entry or on
 * an entry of its own, and is marked reported in that same record step; an
 * entry that only says "saved" is reported from the server's record.
 *
 * #6454: `deliverTo` relays the message to the stopped session's Project Manager
 * on this node; the answers are still recorded on this session's pins, stamped
 * `deliveredTo`. Before any refusal, a `pins-<id>` message already in the
 * session's chat or the named PM's makes the request a replay, so an id goes to
 * one chat only, whichever target a retry names.
 *
 * Idempotent on `submissionId`: the message's `localId` is `pins-<id>`, so a
 * resend returns the stored message instead of a second one, and a pin that
 * already holds an answer from this submission records nothing again.
 */
export async function submitPinAnswers(
  engine: PinSubmissionEngine,
  session: PinSubmissionSession,
  request: PinSubmissionRequest,
  context: PinSubmissionContext
): Promise<PinSubmissionOutcome> {
  const { submissionId } = request;
  const live = new Map<string, Pin | undefined>();
  for (const { key } of request.entries) {
    if (!live.has(key)) live.set(key, engine.pins.get(session.id, key)?.pin);
  }

  if ([...live.values()].some(pin => wasRecordedBy(pin, submissionId))) {
    // A relayed submission's answers carry the PM they went to (#6454 review).
    const recordedTo = [...live.values()]
      .flatMap(pin => pin?.answers ?? [])
      .find(a => a.submission === submissionId && a.deliveredTo)?.deliveredTo;
    return {
      ok: true,
      response: {
        ...replay(engine, session, request, live),
        ...(recordedTo ? { deliveredTo: recordedTo } : {}),
      },
    };
  }

  // #6453: the server's record of unreported saves decides what is reported. An
  // entry that only says "saved" is not checked like an answer, because a save of
  // an answered pin or a dashboard is legitimate.
  const pendingSaves = new Map(
    engine.pins.listPendingSaves(session.id).map(save => [save.pin.key, save])
  );
  const seen = new Set<string>();
  const kept: Kept[] = [];
  const dropped: PinSubmissionResult[] = [];
  const drop = (key: string, reason: string, code: string) =>
    dropped.push({ key, reason, code, outcome: "dropped" });
  const savedOnly: PinSubmissionEntry[] = [];
  for (const entry of request.entries) {
    if (entry.saved === true && !hasPinAnswer(entry) && !entry.automaticPick) {
      savedOnly.push(entry);
      continue;
    }
    const checked = check(entry, live.get(entry.key), seen);
    if ("kept" in checked) kept.push(checked.kept);
    else
      drop(checked.dropped.key, checked.dropped.reason, checked.dropped.code);
  }

  // #6452: the operator's pick changes (ruling D5) and questions (ruling D3).
  const pending = new Set(engine.pins.listDeadlineReportPending(session.id));
  for (const item of kept) {
    if (resolves(item.entry)) continue;
    const engaged =
      (item.entry.questions?.length ?? 0) > 0 ||
      (item.entry.note?.trim() ?? "") !== "";
    if (engaged && hasRunningPick(item.pin)) {
      item.offForQuestion = true;
      item.report = { off: true };
    } else if (pending.has(item.pin.key)) {
      item.report = reportOf(item.pin, context.timeZone);
      item.reportedChange = changedAtOf(engine, session.id, item.pin.key);
    }
  }
  // An entry the client sent only to report a change, with nothing to report.
  for (let i = kept.length - 1; i >= 0; i--) {
    const item = kept[i] as Kept;
    if (!messageCarries(item)) {
      kept.splice(i, 1);
      drop(item.pin.key, "nothing new to report", "pin_nothing_to_report");
    }
  }
  // Every other open pin with an unreported change rides along (D5).
  const listed = new Set(request.entries.map(entry => entry.key));
  for (const key of pending) {
    if (listed.has(key)) continue;
    const pin = engine.pins.get(session.id, key)?.pin;
    if (!pin || pin.status !== "open" || isReservedPinKey(pin.key)) continue;
    const report = reportOf(pin, context.timeZone);
    if (!report) continue;
    kept.push({
      entry: {
        key,
        rev: pin.revision,
        via: "pins",
        automaticPick: true,
      },
      pin,
      stale: false,
      report,
      reportOnly: true,
      reportedChange: changedAtOf(engine, session.id, key),
    });
  }

  // A pin an automatic pick is deciding right now is not answered twice.
  for (let i = kept.length - 1; i >= 0; i--) {
    const item = kept[i] as Kept;
    if (engine.pins.claimedBy(session.id, item.pin.key) === "auto") {
      kept.splice(i, 1);
      drop(item.pin.key, "being decided automatically now", "pin_auto_picking");
    }
  }

  // #6453: pending saves on pins the message does not otherwise carry ride along.
  const keptKeys = new Set(kept.map(({ pin }) => pin.key));
  const saves = [...pendingSaves.values()].filter(
    ({ pin }) => !keptKeys.has(pin.key)
  );
  // A set-aside save the agent has already heard about (another device's Submit,
  // or this one's first attempt whose answer was lost) is done, not an error.
  const alreadyReported: PinSubmissionResult[] = [];
  for (const entry of savedOnly) {
    if (
      keptKeys.has(entry.key) ||
      pendingSaves.has(entry.key) ||
      seen.has(entry.key)
    ) {
      continue;
    }
    seen.add(entry.key);
    const pin = live.get(entry.key);
    if (!pin) {
      drop(entry.key, "no longer exists", "pin_missing");
    } else if (pin.savedTo) {
      alreadyReported.push({
        key: pin.key,
        outcome: "sent",
        recorded: true,
        pin,
      });
    } else {
      drop(entry.key, "it has no saved files to report", "pin_not_saved");
    }
  }
  // Every save the message reports: the appended ones and those riding an entry.
  const reported = [...pendingSaves.values()];

  const refuse = (
    status: PinSubmissionRefusal["status"],
    code: PinSubmissionRefusal["code"],
    error: string
  ): PinSubmissionOutcome => ({
    ok: false,
    status,
    code,
    error,
    entries: dropped,
  });

  if (kept.length === 0 && saves.length === 0 && alreadyReported.length > 0) {
    // Only saves the agent already has: nothing to send, which is success, the
    // way D answers a retry whose message was already delivered (#6453).
    return {
      ok: true,
      response: {
        submissionId,
        text: "",
        delivered: request.dryRun !== true,
        ...(request.dryRun ? {} : { replayed: true }),
        entries: [...alreadyReported, ...dropped],
        openPinCount: engine.pins.countOpen(session.id),
      },
    };
  }

  // #6454: a relay goes to the stopped session's Project Manager, on this node,
  // within the namespace. Refused before anything is composed or sent.
  //
  // Where an earlier attempt of this id was delivered decides where it goes
  // now: `localId` de-duplicates per session only, so a retry aimed elsewhere
  // (the session resumed, or its PM stopped) would deliver a second copy. An
  // attempt already held by the session or by the named PM is a replay there
  // (IR-3, #6453), whatever either's state is now: nothing is sent, recorded
  // or marked.
  const localId = `pins-${submissionId}`;
  let recipient: Pick<Session, "id" | "tag" | "active"> = session;
  let deliveredTo: string | undefined;
  let alreadyDelivered = engine.hasMessageLocalId(session.id, localId);
  const parent =
    !alreadyDelivered && request.deliverTo !== undefined
      ? engine.getSessionByNamespace(request.deliverTo, session.namespace)
      : undefined;
  if (parent && engine.hasMessageLocalId(parent.id, localId)) {
    alreadyDelivered = true;
    recipient = parent;
    deliveredTo = parent.tag ?? parent.id;
  } else if (!alreadyDelivered && request.deliverTo !== undefined) {
    if (session.active === true) {
      return refuse(
        409,
        "session_active",
        "The session is running again; send to it directly"
      );
    }
    if (!parent || parent.active !== true) {
      return refuse(
        409,
        "parent_unavailable",
        "Its Project Manager is not running on this node"
      );
    }
    if (!managesSession(engine, parent, session)) {
      return refuse(
        409,
        "parent_mismatch",
        "That session does not manage this one"
      );
    }
    recipient = parent;
    deliveredTo = parent.tag ?? parent.id;
  }

  if (kept.length === 0 && saves.length === 0) {
    // A preview says why: through a federation proxy a refusal keeps only its
    // message, so the dialog would lose each entry's reason.
    if (request.dryRun) {
      return {
        ok: true,
        response: {
          submissionId,
          text: "",
          delivered: false,
          entries: dropped,
          openPinCount: engine.pins.countOpen(session.id),
        },
      };
    }
    return refuse(400, "pin_submission_empty", "Nothing left to send");
  }
  const now = context.now ?? Date.now();
  const message = formatPinAnswersMessage({
    session: session.tag ?? session.id,
    now,
    timeZone: context.timeZone,
    entries: [
      ...kept.map(messageEntry),
      ...saves.map(({ pin }) => saveEntry(pin)),
    ],
  });
  if (!message.ok) {
    return message.reason === "too_large"
      ? refuse(
          413,
          "pin_submission_too_large",
          `The message would be ${message.length} characters; the limit is ${MESSAGE_LIMIT}. Send fewer answers at once.`
        )
      : refuse(400, "pin_submission_empty", "Nothing left to send");
  }
  const text =
    deliveredTo === undefined
      ? message.text
      : `${relayLine(session)}\n\n${message.text}`;
  if (text.length > PIN_ANSWERS_MESSAGE_MAX_CHARS) {
    return refuse(
      413,
      "pin_submission_too_large",
      `The message would be ${text.length} characters; the limit is ${MESSAGE_LIMIT}. Send fewer answers at once.`
    );
  }
  const relayed = deliveredTo !== undefined ? { deliveredTo } : {};

  const planned = (extra: Partial<PinSubmissionResult> = {}) => [
    ...kept.map(
      ({ pin, stale }): PinSubmissionResult => ({
        key: pin.key,
        outcome: "sent",
        ...(stale ? { stale: true } : {}),
        ...extra,
      })
    ),
    ...saves.map(
      ({ pin }): PinSubmissionResult => ({
        key: pin.key,
        outcome: "sent",
        ...extra,
      })
    ),
  ];

  if (request.dryRun) {
    return {
      ok: true,
      response: {
        submissionId,
        text,
        delivered: false,
        entries: [...planned(), ...alreadyReported, ...dropped],
        openPinCount: engine.pins.countOpen(session.id),
        ...relayed,
      },
    };
  }
  if (alreadyDelivered) {
    // #6453 (IR-3): this submission's message is already in the recipient's
    // chat, so this is a replay. Nothing is sent, recorded or marked.
    return {
      ok: true,
      response: { ...replay(engine, session, request, live), ...relayed },
    };
  }
  if (recipient.active !== true) {
    return refuse(409, "session_inactive", "Resume the session to send");
  }

  // Claim before the first await; the claim and the release bracket the send.
  const claimed: string[] = [];
  for (const { pin } of kept) {
    if (engine.pins.tryClaim(session.id, pin.key, "operator")) {
      claimed.push(pin.key);
    }
  }
  let batch: PinBatchOutcome[] = [];
  let replayedSend = false;
  try {
    const sent = await engine.sendMessage(recipient.id, {
      text,
      localId,
      sentFrom: "webapp",
      origin: context.origin,
      // #6452: recorded in the message's own transaction. The answers stay on
      // the submitting session's pins; a relay (#6454) stamps each with where it
      // was delivered, and marks the reports it carries, as the session's own
      // message would (Pins PM ruling, 2026-11-08).
      record: () => {
        batch = engine.pins.recordBatch(
          session,
          submissionId,
          kept.flatMap(item => batchItems(item, deliveredTo))
        );
        const reports: Array<{ key: string; changedAt: number }> = [];
        for (const item of kept) {
          if (item.offForQuestion) {
            engine.pins.setDeadlineOffForQuestion(
              session.id,
              item.pin.key,
              now
            );
            item.reportedChange = changedAtOf(engine, session.id, item.pin.key);
          }
          if (item.report && item.reportedChange !== undefined) {
            reports.push({ key: item.pin.key, changedAt: item.reportedChange });
          }
        }
        if (reports.length > 0) {
          engine.pins.markDeadlinesReported(session.id, reports);
        }
        // #6453: the agent hears about these saves with this message; a save
        // that lands while the send is in flight stays pending (compare-and-set).
        engine.pins.markSavesReported(session, reported);
        return true;
      },
    });
    // #6453 (IR-3): this submission's message was already stored, so the
    // record step did not run and nothing was marked; answer as a replay.
    if (sent.delivered && sent.replayed) replayedSend = true;
    if (sent.delivered === false) {
      return {
        ok: true,
        response: {
          submissionId,
          text,
          delivered: false,
          ...relayed,
          denied: {
            hookId: sent.hookId,
            reason: sent.reason,
            outcome: sent.outcome,
            ...(sent.params ? { params: sent.params } : {}),
          },
          entries: [
            ...planned({ recorded: false }),
            ...alreadyReported,
            ...dropped,
          ],
          openPinCount: engine.pins.countOpen(session.id),
        },
      };
    }
  } finally {
    for (const key of claimed) engine.pins.release(session.id, key);
  }
  if (replayedSend) {
    return {
      ok: true,
      response: { ...replay(engine, session, request, live), ...relayed },
    };
  }

  const openPinCount = engine.pins.publishBatch(session, batch);
  // A reported change with no recorded answer (the server's report-only entry,
  // or the client's `automaticPick` entry alone) is in no batch event: publish
  // it, so every device drops its pending report.
  const published = new Set(batch.map(r => r.key));
  for (const item of kept) {
    if (item.report === undefined || published.has(item.pin.key)) continue;
    engine.pins.publishChange(session, item.pin.key, "rescheduled");
  }
  const entries = kept.map(item => {
    const results = batch.filter(r => r.key === item.pin.key);
    if (results.length === 0 && !recordsAnswer(item)) {
      const pin = engine.pins.get(session.id, item.pin.key)?.pin;
      return {
        key: item.pin.key,
        outcome: "sent" as const,
        recorded: true,
        ...(pin ? { pin } : {}),
      };
    }
    return resultFor(item.pin.key, item.stale, results.at(-1)?.result ?? null);
  });
  // A save records nothing in the answer history: it was sent, which is all
  // there is to record (#6453).
  const saveResults = saves.map(({ pin }): PinSubmissionResult => {
    const current = engine.pins.get(session.id, pin.key)?.pin;
    return {
      key: pin.key,
      outcome: "sent",
      recorded: true,
      ...(current ? { pin: current } : {}),
    };
  });
  return {
    ok: true,
    response: {
      submissionId,
      text,
      delivered: true,
      entries: [...entries, ...saveResults, ...alreadyReported, ...dropped],
      openPinCount,
      ...relayed,
    },
  };
}

/** When the operator last changed a pin's pick, or undefined if never. */
function changedAtOf(
  engine: PinSubmissionEngine,
  sessionId: string,
  key: string
): number | undefined {
  return (
    engine.pins.getDeadlineRow(sessionId, key)?.deadline.changedAt ?? undefined
  );
}

/** Whether the message would carry anything for this entry beyond pin, rev and kind. */
function messageCarries(item: Kept): boolean {
  const { entry } = item;
  return (
    entry.choice !== undefined ||
    (entry.note?.trim() ?? "") !== "" ||
    (entry.questions?.length ?? 0) > 0 ||
    entry.steps !== undefined ||
    item.report !== undefined
  );
}

/** Whether `batchItems` records anything for this entry. */
function recordsAnswer(item: Kept): boolean {
  return !item.reportOnly && batchItems(item).length > 0;
}

function resultFor(
  key: string,
  stale: boolean,
  result: ReturnType<
    SyncEngine["pins"]["answerBatch"]
  >["results"][number]["result"]
): PinSubmissionResult {
  const base: PinSubmissionResult = {
    key,
    outcome: "sent",
    ...(stale ? { stale: true } : {}),
  };
  if (!result) {
    return { ...base, recorded: false, reason: "no longer exists" };
  }
  if ("unknownOption" in result) {
    return { ...base, recorded: false, reason: "unknown option" };
  }
  if ("duplicate" in result) {
    return { ...base, recorded: true, pin: result.duplicate };
  }
  return { ...base, recorded: true, moot: result.moot, pin: result.pin };
}

/** Why an automatic pick did not fire this time (#6452). */
export type PinDeadlineSkip =
  | "missing"
  | "not_due"
  | "inactive"
  | "claimed"
  | "ineligible"
  | "foreign_revision"
  | "changed"
  | "denied";

export type PinDeadlineFireOutcome =
  | { fired: true; pin: Pin; openPinCount: number }
  | { fired: false; reason: PinDeadlineSkip };

/**
 * An automatic pick (#6452): when a pin's deadline passes unanswered, answer it
 * with the named option through the SAME message format and send path as the
 * operator's Submit, but as the programmatic sender `pin-deadline`, `by: "auto"`,
 * `via: "deadline"`, and a `Pins automatic pick,` summary line (ruling D8).
 *
 * Exactly once: the message and the record commit in one transaction, and the
 * record step re-reads the pin inside it, refusing unless the pin is still open,
 * still due, still eligible, at the same revision and deadline id the text was
 * built from, and not held by an operator's Submit. The message's `localId` is
 * `pins-auto-<deadline id>`, so even a duplicate call stores one message, while a
 * re-armed deadline (a new id) is a new question and a new message. Fail-safe:
 * every refusal leaves the pin open for the operator.
 *
 * The caller resolves the zone before calling, so the only await between the
 * read and the commit is the send's own hook stage, which the record step's
 * re-check covers.
 */
export async function firePinDeadline(
  engine: PinSubmissionEngine,
  session: Pick<Session, "id" | "tag" | "namespace" | "active">,
  key: string,
  context: { now: number; timeZone: string }
): Promise<PinDeadlineFireOutcome> {
  const { now, timeZone } = context;
  const row = engine.pins.getDeadlineRow(session.id, key);
  if (!row) return { fired: false, reason: "missing" };
  const { deadline, content } = row;
  const pick = content.ifUnanswered;
  if (
    row.status !== "open" ||
    !pick ||
    deadline.at === null ||
    deadline.by === "off" ||
    deadline.at > now
  ) {
    return { fired: false, reason: "not_due" };
  }
  if (!isAutoPickEligible(content))
    return { fired: false, reason: "ineligible" };
  if (deadline.revision !== row.revision) {
    return { fired: false, reason: "foreign_revision" };
  }
  if (session.active !== true) return { fired: false, reason: "inactive" };
  if (!engine.pins.tryClaim(session.id, key, "auto")) {
    return { fired: false, reason: "claimed" };
  }

  const firedAt = deadline.at;
  const deadlineId = deadline.id ?? `${firedAt}`;
  try {
    const option = content.options?.find(o => o.id === pick.option);
    const message = formatPinAnswersMessage({
      session: session.tag ?? session.id,
      now,
      timeZone,
      automatic: true,
      entries: [
        {
          pin: content.key,
          rev: row.revision,
          kind: content.kind,
          answer: { choice: pick.option, label: option?.label ?? pick.option },
          automaticPick: {
            at: new Date(firedAt).toISOString(),
            local: formatPinAnswerTime(firedAt, timeZone),
          },
        },
      ],
    });
    if (!message.ok) return { fired: false, reason: "changed" };

    const sent = await engine.sendMessage(session.id, {
      text: message.text,
      localId: `pins-auto-${deadlineId}`,
      sentFrom: "pin-deadline",
      record: () => {
        const fresh = engine.pins.getDeadlineRow(session.id, key);
        if (
          !fresh ||
          fresh.status !== "open" ||
          fresh.revision !== row.revision ||
          fresh.deadline.revision !== fresh.revision ||
          fresh.deadline.id !== deadline.id ||
          fresh.deadline.by === "off" ||
          fresh.deadline.at === null ||
          fresh.deadline.at > now ||
          fresh.content.ifUnanswered?.option !== pick.option ||
          !isAutoPickEligible(fresh.content)
        ) {
          return false;
        }
        const recorded = engine.pins.recordAutomaticPick(session.id, key, {
          option: pick.option,
          revision: row.revision,
          submission: `auto-${deadlineId}`,
          now,
        });
        // Anything but a live settle rolls the whole transaction back.
        return recorded !== null && "pin" in recorded && !recorded.moot;
      },
    });
    if (sent.delivered === false) return { fired: false, reason: "denied" };
    // #6453: this deadline's message is already stored, so its record step did
    // not run again: the same outcome as the veto it used to meet.
    if (sent.replayed) return { fired: false, reason: "changed" };
  } catch (error) {
    if (error instanceof RecordVetoError) {
      return { fired: false, reason: "changed" };
    }
    throw error;
  } finally {
    engine.pins.release(session.id, key);
  }
  const openPinCount = engine.pins.publishAnswered(session, key);
  const pin = engine.pins.get(session.id, key)?.pin;
  return pin
    ? { fired: true, pin, openPinCount }
    : { fired: false, reason: "missing" };
}

/**
 * A retry of a submission whose message was already delivered: some pin
 * recorded it, or (#6453) its `pins-<id>` message is already stored. Report
 * what is on record and send nothing. An entry that only says "saved" records
 * no answer, so it reads as sent when its save has been reported (by that
 * message or another); any other entry no pin recorded was not in that message.
 */
function replay(
  engine: PinSubmissionEngine,
  session: Pick<Session, "id">,
  request: PinSubmissionRequest,
  live: Map<string, Pin | undefined>
): PinSubmissionResponse & { replayed: true } {
  const seen = new Set<string>();
  const entries: PinSubmissionResult[] = [];
  for (const entry of request.entries) {
    const { key } = entry;
    if (seen.has(key)) continue;
    seen.add(key);
    const pin = live.get(key);
    const savedOnly =
      entry.saved === true && !hasPinAnswer(entry) && !entry.automaticPick;
    if (savedOnly && pin?.savedTo && pin.saveReportPending !== true) {
      entries.push({ key, outcome: "sent", recorded: true, pin });
    } else if (pin && wasRecordedBy(pin, request.submissionId)) {
      const mine = pin.answers.filter(
        a => a.submission === request.submissionId
      );
      entries.push({
        key,
        outcome: "sent",
        recorded: true,
        moot: mine.at(-1)?.moot ?? false,
        pin,
      });
    } else {
      entries.push({
        key,
        outcome: "dropped",
        reason: "not in the message already sent",
        code: "pin_not_in_submission",
      });
    }
  }
  return {
    submissionId: request.submissionId,
    text: "",
    delivered: true,
    replayed: true,
    entries,
    openPinCount: engine.pins.countOpen(session.id),
  };
}

/**
 * The zone the summary line is written in (R8): the Time Log timezone the
 * operator chose (#4613, the one F #6452 uses for automatic picks), else the
 * zone of the browser that submitted, else the host's. The host comes last
 * because a node's zone is rarely the operator's (ms1 runs in UTC). A settings
 * read must never stop a Submit, so a failed one falls through.
 */
export async function resolvePinAnswersTimeZone(
  dataDir: string,
  browserZone?: string
): Promise<string> {
  return (
    (await resolvePinPreferenceTimeZone(dataDir)) ??
    browserOrHostTimeZone(browserZone)
  );
}

/**
 * The operator's Time Log zone, or null when none is set (#6452). Pin reads
 * carry it, so the Pins tab shows times in the zone an automatic pick's message
 * is written in. A failed read or an unknown zone is null (the web then uses
 * the browser's zone), because a bad setting must never break a read or a
 * Submit's time strings.
 */
export async function resolvePinPreferenceTimeZone(
  dataDir: string
): Promise<string | null> {
  try {
    const zone = await loadTimeLogPreferenceTimezone(dataDir);
    return zone && isValidTimezone(zone) ? zone : null;
  } catch {
    return null;
  }
}

/** The browser's zone when it is a real IANA zone, else the host's. */
export function browserOrHostTimeZone(browserZone?: string): string {
  return browserZone && isValidTimezone(browserZone)
    ? browserZone
    : hostTimeZone();
}

/** The host's zone, the last resort when no browser zone came with a Submit. */
export function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
