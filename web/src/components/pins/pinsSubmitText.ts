// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The Submit dialog's words (#6803): what each row says, what the toast says
 * after a Send, and the plain message an older node is sent instead. Pure
 * helpers, moved out of `PinsSubmitDialog.tsx` so the component stays under
 * the `max-lines` guard (#2077); `pinsSubmitText.test.ts` covers them.
 */
import {
  effectiveSavedTo,
  formatPinAnswersMessage,
  hasPinAnswer,
  isReservedPinKey,
  type Pin,
  type PinSubmissionEntry,
  type PinSubmissionRequest,
  type PinSubmissionResponse,
} from "@hapi/protocol";
import { browserTimeZone } from "@/lib/pins/submission";

/** What a row's answer cell says, and the caption line under the row. */
export type DialogAnswer = {
  cell: string;
  /**
   * #6803 (R8): "Note · pin stays open". On its own line, because at 393 px
   * the answer cell is 40% wide and would cut it.
   */
  caption?: string;
};

/**
 * #6803: a pin answered by choosing one of its options, read from the cached
 * pin, because a dry run's rows carry none: open, a decision or variants pin,
 * with options, and not a server-owned key.
 */
export function isChoosableCachedPin(pin: Pin | undefined): boolean {
  return (
    pin !== undefined &&
    pin.status === "open" &&
    (pin.kind === "decision" || pin.kind === "variants") &&
    (pin.options?.length ?? 0) > 0 &&
    !isReservedPinKey(pin.key)
  );
}

/**
 * One entry's answer, as the dialog lists it: "B. Wait", "B. Wait · Note"
 * (#6768 R8), "Your answer: <words>" (#6803), or "Steps 2/3 · Note".
 * #6453: a save reads "Saved", also for one the server added from another
 * device's Save (no request entry, but the result's pin has a saved folder).
 * #6539: a dismissal reads "Dismiss", ahead of everything else.
 * #6803 (R8): a note or questions alone on a choosable pin say the pin stays
 * open, on a caption line.
 */
export function dialogAnswer(
  entry: PinSubmissionEntry | undefined,
  pin?: Parameters<typeof effectiveSavedTo>[0],
  cached?: Pin
): DialogAnswer {
  if (!entry) return { cell: pin && effectiveSavedTo(pin) ? "Saved" : "" };
  if (entry.dismiss === true) {
    return { cell: entry.note ? "Dismiss · Note" : "Dismiss" };
  }
  if (entry.choice !== undefined) {
    const choice = `${entry.choice}${entry.label ? `. ${entry.label}` : ""}`;
    return { cell: entry.note ? `${choice} · Note` : choice };
  }
  if (entry.writeIn !== undefined) {
    const words = `Your answer: ${entry.writeIn.trim()}`;
    return { cell: entry.note ? `${words} · Note` : words };
  }
  const parts: string[] = [];
  if (entry.steps) parts.push(`Steps ${entry.steps.done}/${entry.steps.total}`);
  const questions = entry.questions?.length ?? 0;
  if (questions > 0) {
    parts.push(`${questions} question${questions === 1 ? "" : "s"}`);
  }
  if (entry.note) parts.push("Note");
  // #6452 (ruling D5): an automatic-pick move or off the agent has not heard.
  if (entry.automaticPick) parts.push("Automatic pick change");
  if (entry.saved) parts.push("Saved");
  const notesOnly =
    (entry.note !== undefined || questions > 0) &&
    !entry.steps &&
    !entry.automaticPick &&
    !entry.saved;
  if (notesOnly && isChoosableCachedPin(cached)) {
    return { cell: "", caption: `${parts.join(" · ")} · pin stays open` };
  }
  return { cell: parts.join(" · ") };
}

/** The kinds of sent row a toast names (R8); a question-only row has its own word. */
type ToastPart = "answer" | "dismissal" | "note" | "question" | "update";

const PART_WORDS: Record<ToastPart, [string, string]> = {
  answer: ["answer", "answers"],
  dismissal: ["dismissal", "dismissals"],
  note: ["note", "notes"],
  question: ["question", "questions"],
  update: ["other update", "other updates"],
};

/**
 * What one sent row did to its pin: an answer (a choice, a write-in, or all
 * steps done), a dismissal, a note or question on a pin that stays open, or an
 * update (everything else: a partial steps report, a save, a pick change, a
 * row the request did not list, and the save of a key whose entry dropped).
 * A row that carries only questions is counted as a question, so the toast
 * never calls a question a note.
 */
function partOf(
  entry: PinSubmissionEntry | undefined,
  droppedHere: boolean
): ToastPart {
  if (!entry || droppedHere) return "update";
  if (entry.dismiss === true) return "dismissal";
  if (
    entry.choice !== undefined ||
    entry.writeIn !== undefined ||
    (entry.steps !== undefined && entry.steps.done === entry.steps.total)
  ) {
    return "answer";
  }
  if (entry.note?.trim()) return "note";
  if ((entry.questions?.length ?? 0) > 0) return "question";
  return "update";
}

/** "A", "A and B", "A, B, and C". */
function oxford(items: readonly string[]): string {
  if (items.length <= 2) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

/**
 * #6803 (R8): the Send toast, counted by sent result row: "Sent 1 note", "Sent
 * 2 answers and 1 note", "Sent 1 answer, 1 dismissal, and 2 notes". Every sent
 * row falls in exactly one part, so a Send with a sent row never reads empty.
 */
export function sentToastText(
  request: PinSubmissionRequest,
  result: PinSubmissionResponse
): string {
  const byKey = new Map(request.entries.map(entry => [entry.key, entry]));
  const dropped = new Set(
    result.entries.filter(e => e.outcome === "dropped").map(e => e.key)
  );
  const counts = new Map<ToastPart, number>();
  for (const row of result.entries) {
    if (row.outcome !== "sent") continue;
    const part = partOf(byKey.get(row.key), dropped.has(row.key));
    counts.set(part, (counts.get(part) ?? 0) + 1);
  }
  const order: ToastPart[] = [
    "answer",
    "dismissal",
    "note",
    "question",
    "update",
  ];
  const parts = order.flatMap(part => {
    const n = counts.get(part) ?? 0;
    if (n === 0) return [];
    const [one, many] = PART_WORDS[part];
    return [`${n} ${n === 1 ? one : many}`];
  });
  return parts.length > 0 ? `Sent ${oxford(parts)}` : "Sent 0 answers";
}

/**
 * The message an older node cannot compose: the same `hapi_pin_answers/1`
 * text, built here in the device's zone, to send as a plain message that
 * records nothing. A save-only entry (#6453) is left out: an older node has no
 * saved folder to report, and an entry with nothing to send would not compose.
 * #6803 (RV-3): a write-in goes in it like a choice, and is recorded nowhere.
 */
export function fallbackText(
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
      ...(entry.writeIn !== undefined ? { writeIn: entry.writeIn } : {}),
      ...(entry.note ? { note: entry.note } : {}),
      ...(entry.questions ? { questions: entry.questions } : {}),
      ...(entry.steps ? { steps: entry.steps } : {}),
    })),
  });
  return message.ok ? message.text : null;
}

/** #6539: what happens to dismissals a node cannot take. */
export const DISMISSALS_STAY =
  "The dismissals stay staged here. Undo on a pin releases it.";

type RefusedFields = readonly ("dismiss" | "writeIn" | "longNote")[];

/** "a", "a or b", "a, b, or c" (Oxford comma). */
function eitherOf(words: readonly string[]): string {
  if (words.length < 3) return words.join(" or ");
  return `${words.slice(0, -1).join(", ")}, or ${words.at(-1)}`;
}

/** "a", "a and b", "a, b, and c" (Oxford comma). */
function allOf(words: readonly string[]): string {
  if (words.length < 3) return words.join(" and ");
  return `${words.slice(0, -1).join(", ")}, and ${words.at(-1)}`;
}

/** #6539, #6803, #6969: what stays staged, one phrase per refused kind. */
function stayingOf(fields: RefusedFields): string {
  const words = fields.map(
    field =>
      ({
        dismiss: "the dismissals",
        writeIn: "your own answers",
        longNote: "the long notes",
      })[field]
  );
  return allOf(words);
}

const sentenceCase = (text: string): string =>
  text.charAt(0).toUpperCase() + text.slice(1);

/**
 * #6539, #6803 (R7), #6969 (D2): the older-node phase's title. `maxNoteChars`
 * is the longest note the node takes, which a long-note refusal names.
 */
export function refusedFieldsTitle(
  fields: RefusedFields,
  maxNoteChars: number
): string {
  const limit = maxNoteChars.toLocaleString("en-US");
  if (fields.length === 1 && fields[0] === "longNote") {
    return `This session's node is older and takes notes up to ${limit} characters`;
  }
  const words = fields.map(
    field =>
      ({
        dismiss: "dismissals",
        writeIn: "your own answers",
        longNote: `notes over ${limit} characters`,
      })[field]
  );
  return `This session's node is older and cannot receive ${eitherOf(words)}`;
}

/**
 * #6539, #6803 (R7), #6969 (D2): the older-node phase's text: whether the other
 * answers can go, and what stays staged. The dismissal texts are #6539's, and
 * the write-in texts #6803's, byte for byte.
 */
export function refusedFieldsText(
  fields: RefusedFields,
  hasOthers: boolean
): string {
  const staying = stayingOf(fields);
  if (hasOthers) {
    return `Send your other answers now? ${sentenceCase(staying)} stay staged here.`;
  }
  const releases = fields.includes("dismiss")
    ? fields.length > 1
      ? "Undo or Clear"
      : "Undo"
    : "Clear";
  return `${sentenceCase(staying)} stay staged here. ${releases} on a pin releases it.`;
}

/** #6539, #6803 (R7), #6969: the button that sends the other answers. */
export function refusedFieldsButton(fields: RefusedFields): string {
  return `Send without ${stayingOf(fields)}`;
}
