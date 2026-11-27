// SPDX-License-Identifier: AGPL-3.0-only
import type {
  Pin,
  PinSubmissionEntry,
  PinSubmissionRequest,
} from "@hapi/protocol";
import { PIN_SORTS, stagedIsStale, stepsSent } from "@/lib/pins/ledger";
import { optionPointsToNote } from "@/lib/pins/noteOption";
import {
  hasChosenWriteIn,
  hasUpdates,
  STAGED_LEGACY_NOTE_MAX_CHARS,
  STAGED_MESSAGE_MAX_CHARS,
  STAGED_WRITE_IN_MAX_CHARS,
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
 * A staged pin left out of the request; it stays staged, whole, until it can
 * go. #6768 (R7): its choice's option says the answer is in the note, and the
 * note is empty. #6969 (R3): its note is over the session's note limit, or its
 * chosen write-in over its own, by `over` characters; nothing is ever cut, so
 * the operator shortens it. #6969 (E1): with it the agent's message would pass
 * its cap, so it goes in the next Submit and the rest go now. `unread`: the
 * session's note limit could not be read, so the note waits at 2,048.
 */
export type HeldStaged =
  | { key: string; reason: "note_empty" }
  | {
      key: string;
      reason: "note_too_long" | "write_in_too_long";
      over: number;
      limit: number;
      unread?: true;
    }
  | { key: string; reason: "message_full" };

export type BuiltSubmission = {
  /** Null when nothing staged has anything to send. */
  request: PinSubmissionRequest | null;
  /** The staged entries this request was built from, for `clearSubmitted`. */
  submitted: Record<string, Readonly<StagedPin>>;
  /** Shown before the server's dry run answers. */
  stale: StaleStaged[];
  /** Staged pins held back: an empty note (#6768 R7), a text over its limit, or a full message (#6969). */
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
 * #6969 (R3): a staged note longer than `noteMax`, or a chosen write-in longer
 * than its cap. A request carrying it would be refused whole, so the pin is
 * held, with how far over it is. Length is `String.length`, what Zod counts.
 */
function overLimit(
  staged: Readonly<StagedPin>,
  noteMax: number | null
): Omit<Extract<HeldStaged, { over: number }>, "key"> | null {
  const note = staged.note?.trim() ? staged.note : "";
  const limit = noteMax ?? STAGED_LEGACY_NOTE_MAX_CHARS;
  if (note.length > limit) {
    return {
      reason: "note_too_long",
      over: note.length - limit,
      limit,
      ...(noteMax === null ? { unread: true as const } : {}),
    };
  }
  const writeIn = hasChosenWriteIn(staged) ? (staged.writeIn ?? "") : "";
  if (writeIn.length > STAGED_WRITE_IN_MAX_CHARS) {
    return {
      reason: "write_in_too_long",
      over: writeIn.length - STAGED_WRITE_IN_MAX_CHARS,
      limit: STAGED_WRITE_IN_MAX_CHARS,
    };
  }
  return null;
}

/**
 * #6969 (E1): the agent's message outside its entries, never less: the
 * heading's time, counts and "and N more", the fence, the block's session and
 * two times, and the relay line a Project Manager's copy opens with (two names
 * of at most 80 characters each, `server/src/sync/pinSubmission.ts`).
 */
const MESSAGE_FIXED_CHARS = 1_000;
/** A summary item past its key: ` → ` and a 40-character token, or a dismissal's or a save's wording. */
const SUMMARY_ITEM_CHARS = 80;
/** An approval token's length; it cleans to `[approval token removed]`, one longer. */
const TOKEN_CHARS = 23;
/** The longest form an automatic pick takes in the message. */
const PICK = { at: "2026-01-01T00:00:00.000Z", local: "x".repeat(40) };

function longest(...texts: (string | undefined)[]): string {
  return texts.reduce<string>(
    (best, text) =>
      text !== undefined && text.length > best.length ? text : best,
    ""
  );
}

/**
 * #6969 (E1): how many characters an entry adds to the agent's message, never
 * fewer. It builds the entry the way the server does (`messageEntry`,
 * `server/src/sync/pinSubmission.ts`), from the pin this page holds: its kind,
 * ID, title for a dismissal, option label, and saved folder (bounded by its
 * longest evidence path when Save recorded none), pretty-printed two levels
 * deep in the block, with its summary item and one character per possible
 * approval token. A note or questions that answer nothing are counted with an
 * automatic pick, because the server turns a running pick off beside them
 * (`{off: true}`). The other scrubs shorten what they match, save a few short
 * shapes such as `Bearer x`; those, and a partial Save's file list (which the
 * server drops before it refuses), are left to the server's 413, the backstop.
 */
export function estimateEntryChars(
  entry: PinSubmissionEntry,
  pin: Pin | undefined
): number {
  const answering = entry.dismiss !== true;
  const label =
    entry.choice === undefined
      ? undefined
      : longest(
          entry.choice,
          entry.label,
          pin?.options?.find(o => o.id === entry.choice)?.label
        );
  const title = answering ? undefined : (pin?.title ?? "");
  const savedTo =
    pin?.savedTo ?? longest(...(pin?.evidence ?? []).map(e => e.path));
  const shape = {
    pin: entry.key,
    rev: entry.rev,
    kind: pin?.kind ?? "",
    ...(pin?.pinId ? { pinId: pin.pinId } : {}),
    ...(title !== undefined ? { dismissed: true, title } : {}),
    ...(answering && label !== undefined
      ? { answer: { choice: entry.choice, label } }
      : {}),
    ...(answering && entry.writeIn !== undefined
      ? { writeIn: entry.writeIn }
      : {}),
    ...(entry.note ? { note: entry.note } : {}),
    ...(entry.questions?.length ? { questions: entry.questions } : {}),
    ...(entry.automaticPick ||
    (answering &&
      entry.choice === undefined &&
      entry.writeIn === undefined &&
      (Boolean(entry.note?.trim()) || (entry.questions?.length ?? 0) > 0))
      ? { automaticPick: PICK }
      : {}),
    ...(entry.steps ? { steps: entry.steps } : {}),
    ...(savedTo ? { savedTo } : {}),
    ...(savedTo && (pin?.savedSkipped ?? 0) > 0
      ? { notSaved: { count: pin?.savedSkipped, files: [] } }
      : {}),
  };
  const printed = JSON.stringify(shape, null, 2);
  const words = [
    entry.note,
    entry.writeIn,
    entry.choice,
    label,
    title,
    savedTo,
    ...(entry.questions ?? []),
  ].reduce((n, text) => n + (text?.length ?? 0), 0);
  return (
    printed.length +
    // Two levels deeper in the block, and the ",\n" before the next entry.
    printed.split("\n").length * 4 +
    2 +
    entry.key.length +
    SUMMARY_ITEM_CHARS +
    Math.ceil(words / TOKEN_CHARS)
  );
}

/**
 * #6969 (E1): the whole message's length a request would make, never less:
 * {@link estimateEntryChars} for each entry and the parts outside them.
 */
export function estimateMessageChars(
  entries: readonly PinSubmissionEntry[],
  pins: readonly Pin[]
): number {
  const byKey = new Map(pins.map(pin => [pin.key, pin]));
  return entries.reduce(
    (n, entry) => n + estimateEntryChars(entry, byKey.get(entry.key)),
    MESSAGE_FIXED_CHARS
  );
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
  // #6803: only a chosen write-in with words is sent; a draft, or a chosen one
  // with no words, sends nothing.
  const writeIn = hasChosenWriteIn(staged) ? staged.writeIn : undefined;
  if (
    staged.choice === undefined &&
    writeIn === undefined &&
    !note &&
    !questions &&
    !steps &&
    !saved
  ) {
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
      : writeIn !== undefined
        ? { writeIn }
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
 * #6969: a pin whose note is over `noteMaxChars` or whose chosen write-in is
 * over its cap is held, whole (R3); so is, in that same order, each pin whose
 * entry would take the agent's message past its cap, and a later, smaller
 * entry may still fit (E1).
 */
export function buildSubmissionRequest(input: {
  staged: StagedPins;
  pins: readonly Pin[];
  submissionId: string;
  /**
   * #6969 (D2, R-4): the session's note limit, as its node states it on the
   * list the counter reads (`resolveNoteMax`: 2,048 from a node that states
   * none); null when that list could not be read, so a note over 2,048 waits
   * and says why. Required, so no caller can miss it.
   */
  noteMaxChars: number | null;
  /**
   * #6969: rebuilt beside a pending Submit's frozen request, which goes as it
   * is. Every key in such a rebuild is one the frozen request carries, so no
   * entry is held: a hold read from today's staging or limit would list as Not
   * sent an entry the request is sending.
   */
  frozen?: boolean;
}): BuiltSubmission {
  const noteMax = input.noteMaxChars;
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
  const reports = pendingDeadlineReports(input.pins).sort((a, b) =>
    PIN_SORTS.priority(a, b)
  );
  // #6969 (E1): the message's room for the staged entries. Each pending
  // automatic-pick change, and each pending Save the server adds for a pin the
  // request does not carry (#6453), is set aside first, as the entry it is
  // when it goes alone, because it goes whatever is held.
  let room = input.frozen
    ? Number.POSITIVE_INFINITY
    : STAGED_MESSAGE_MAX_CHARS -
      estimateMessageChars(
        [
          ...reports.map(pin => ({
            key: pin.key,
            rev: pin.revision,
            via: "pins" as const,
            automaticPick: true as const,
          })),
          ...input.pins
            .filter(pin => pin.saveReportPending === true)
            .map(pin => ({
              key: pin.key,
              rev: pin.revision,
              via: "pins" as const,
              saved: true as const,
            })),
        ],
        input.pins
      );
  for (const key of keys) {
    const staged = input.staged[key] as Readonly<StagedPin>;
    const pin = byKey.get(key);
    if (!input.frozen && pointsToEmptyNote(staged, pin)) {
      held.push({ key, reason: "note_empty" });
      continue;
    }
    const tooLong = input.frozen ? null : overLimit(staged, noteMax);
    if (tooLong) {
      held.push({ key, ...tooLong });
      continue;
    }
    const entry = entryFor(key, staged, pin);
    if (!entry) continue;
    const size = estimateEntryChars(entry, pin);
    if (size > room) {
      held.push({ key, reason: "message_full" });
      continue;
    }
    room -= size;
    entries.push(entry);
    submitted[key] = staged;
    if (pin && stagedIsStale(staged, pin)) {
      stale.push({ key, staged: staged.rev, current: pin.revision });
    }
  }
  // #6452 (ruling D5): each pending automatic-pick change rides along. A pin
  // answered by choice settles, so its change no longer matters to the agent;
  // a dismissed pin closes, so its entry is left alone too (#6539). A held
  // pin (#6768, #6969) is not sent, so its pin's change goes alone, as the
  // server would add it beside any other entry.
  const heldKeys = new Set(held.map(item => item.key));
  for (const pin of reports) {
    const index = entries.findIndex(entry => entry.key === pin.key);
    const entry = entries[index];
    if (entry) {
      // #6803: a write-in settles its pin like a choice.
      if (
        entry.choice === undefined &&
        entry.writeIn === undefined &&
        entry.dismiss !== true
      ) {
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
