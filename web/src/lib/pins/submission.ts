// SPDX-License-Identifier: AGPL-3.0-only
import type {
  Pin,
  PinSubmissionEntry,
  PinSubmissionRequest,
} from "@hapi/protocol";
import { PIN_SORTS, stagedIsStale, stepsSent } from "@/lib/pins/ledger";
import { optionPointsToNote } from "@/lib/pins/noteOption";
import {
  hasUpdates,
  type StagedPin,
  type StagedPins,
} from "@/lib/pins/staging";

/**
 * A Submit's id, made once per dialog opening and reused for every retry. Not
 * `makeClientSideId`: `crypto.randomUUID` exists only in a secure context, and
 * its fallback holds a `.` the server's `[A-Za-z0-9_-]{8,80}` refuses, so every
 * Submit from a plain-HTTP tailnet address would fail. `getRandomValues` works
 * in any context.
 */
export function makeSubmissionId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const random = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join(
    ""
  );
  return `${Date.now().toString(36)}-${random}`;
}

/**
 * The browser's IANA zone, sent with a Submit so the summary line reads in the
 * operator's own time when they set no Time Log zone (R8), never the node's
 * (ms1 runs in UTC). Undefined when the runtime reports none.
 */
export function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** A staged choice or tick made on an older revision than the pin's now. */
export type StaleStaged = { key: string; staged: number; current: number };

/**
 * #6768 (R7): a staged choice left out of the request; it stays staged. Its
 * option says the answer is in the note, and the note is empty.
 */
export type HeldStaged = { key: string; reason: "note_empty" };

export type BuiltSubmission = {
  /** Null when nothing staged has anything to send. */
  request: PinSubmissionRequest | null;
  /** The staged entries this request was built from, for `clearSubmitted`. */
  submitted: Record<string, Readonly<StagedPin>>;
  /** Shown before the server's dry run answers. */
  stale: StaleStaged[];
  /** #6768 (R7): staged choices held back until their note is written. */
  held: HeldStaged[];
  /**
   * #6768 (R3): the whole staged set this request was read from, so the dialog
   * can tell whether staging moved on before it sends.
   */
  from: StagedPins;
};

/**
 * #6768 (R7, ruling 2A): a staged choice whose option points to the note, with
 * the note empty. The pin's option decides, else the label staged with it (a
 * pin the cache no longer holds). A dismissal carries no choice.
 */
function pointsToEmptyNote(
  staged: Readonly<StagedPin>,
  pin: Pin | undefined
): boolean {
  if (staged.choice === undefined || staged.note?.trim()) return false;
  const option = pin?.options?.find(o => o.id === staged.choice) ?? {
    id: staged.choice,
    label: staged.label,
  };
  return optionPointsToNote(option);
}

/**
 * One request entry from a staged pin, or null when it has nothing new: a
 * choice, a non-empty note, its questions, ticks whose count differs from what
 * the server already has, and a save (#6453). `rev` is the staged revision, never the pin's
 * current one, so a choice made on r2 of a pin now at r3 is recorded moot. A
 * staged dismissal (#6539) is sent on its own, with only its note and a staged
 * save, because the server refuses anything else beside it.
 */
function entryFor(
  key: string,
  staged: Readonly<StagedPin>,
  pin: Pin | undefined
): PinSubmissionEntry | null {
  const note = staged.note?.trim() ? staged.note : undefined;
  if (staged.dismiss === true) {
    return {
      key,
      rev: staged.rev,
      via: staged.via,
      dismiss: true,
      ...(note ? { note } : {}),
      ...(staged.saved === true ? { saved: true as const } : {}),
    };
  }
  const questions = staged.questions?.length
    ? [...staged.questions]
    : undefined;
  let steps: PinSubmissionEntry["steps"];
  if (pin && staged.ticks?.length) {
    const ids = new Set((pin.steps ?? []).map(step => step.id));
    const total = ids.size;
    const done = staged.ticks.filter(id => ids.has(id)).length;
    if (total > 0 && done > 0 && done !== stepsSent(pin)) {
      steps = { done, total };
    }
  }
  const saved = staged.saved === true;
  if (staged.choice === undefined && !note && !questions && !steps && !saved) {
    return null;
  }
  return {
    key,
    rev: staged.rev,
    via: staged.via,
    ...(staged.choice !== undefined
      ? {
          choice: staged.choice,
          ...(staged.label !== undefined ? { label: staged.label } : {}),
        }
      : {}),
    ...(note ? { note } : {}),
    ...(questions ? { questions } : {}),
    ...(steps ? { steps } : {}),
    ...(saved ? { saved: true as const } : {}),
  };
}

/**
 * #6452 (ruling D5): the open pins whose automatic pick the operator moved or
 * turned off since the agent last heard. The next Submit carries the change.
 */
export function pendingDeadlineReports(pins: readonly Pin[]): Pin[] {
  return pins.filter(
    pin => pin.status === "open" && pin.deadlineReportPending === true
  );
}

/**
 * How many pins a Submit would send: staged updates and pending
 * automatic-pick changes, each pin once, so a change alone can be sent.
 */
export function countSubmittable(
  staged: StagedPins,
  pins: readonly Pin[]
): number {
  const keys = new Set(
    Object.keys(staged).filter(key => hasUpdates(staged[key]))
  );
  for (const pin of pendingDeadlineReports(pins)) keys.add(pin.key);
  return keys.size;
}

/**
 * The Submit request from what is staged, in the order the operator saw the
 * pins (the Ledger's priority), so the agent reads them that way too. A staged
 * pin the cache does not hold is still sent: the server says why it drops it.
 */
export function buildSubmissionRequest(input: {
  staged: StagedPins;
  pins: readonly Pin[];
  submissionId: string;
}): BuiltSubmission {
  const byKey = new Map(input.pins.map(pin => [pin.key, pin]));
  const timeZone = browserTimeZone();
  const keys = Object.keys(input.staged).sort((a, b) => {
    const pa = byKey.get(a);
    const pb = byKey.get(b);
    if (pa && pb) return PIN_SORTS.priority(pa, pb);
    if (pa || pb) return pa ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const entries: PinSubmissionEntry[] = [];
  const submitted: Record<string, Readonly<StagedPin>> = {};
  const stale: StaleStaged[] = [];
  const held: HeldStaged[] = [];
  for (const key of keys) {
    const staged = input.staged[key] as Readonly<StagedPin>;
    const pin = byKey.get(key);
    if (pointsToEmptyNote(staged, pin)) {
      held.push({ key, reason: "note_empty" });
      continue;
    }
    const entry = entryFor(key, staged, pin);
    if (!entry) continue;
    entries.push(entry);
    submitted[key] = staged;
    if (pin && stagedIsStale(staged, pin)) {
      stale.push({ key, staged: staged.rev, current: pin.revision });
    }
  }
  // #6452 (ruling D5): each pending automatic-pick change rides along. A pin
  // answered by choice settles, so its change no longer matters to the agent;
  // a dismissed pin closes, so its entry is left alone too (#6539). A held
  // choice (#6768) is not sent, so its pin's change goes alone, as the server
  // would add it beside any other entry.
  const reports = pendingDeadlineReports(input.pins).sort((a, b) =>
    PIN_SORTS.priority(a, b)
  );
  const heldKeys = new Set(held.map(item => item.key));
  for (const pin of reports) {
    const index = entries.findIndex(entry => entry.key === pin.key);
    const entry = entries[index];
    if (entry) {
      if (entry.choice === undefined && entry.dismiss !== true) {
        entries[index] = { ...entry, automaticPick: true };
      }
      continue;
    }
    if (input.staged[pin.key]?.choice !== undefined && !heldKeys.has(pin.key)) {
      continue;
    }
    entries.push({
      key: pin.key,
      rev: pin.revision,
      via: "pins",
      automaticPick: true,
    });
  }
  return {
    request:
      entries.length > 0
        ? {
            submissionId: input.submissionId,
            ...(timeZone ? { timeZone } : {}),
            entries,
          }
        : null,
    submitted,
    stale,
    held,
    from: input.staged,
  };
}
