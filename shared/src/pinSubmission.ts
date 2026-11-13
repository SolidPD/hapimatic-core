// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";
import {
  PIN_ANSWER_NOTE_MAX_CHARS,
  PIN_MAX_OPEN_PER_SESSION,
  PinKeySchema,
  PinSchema,
} from "./pins";

// Its own module, not pins.ts: the main web bundle already loads pins.ts (through
// schemas.ts), and these schemas are needed only by the Submit path, which is
// code-split (#6450).

/** Where an answer was made: the Pins tab or the inline chat card. */
export const PIN_SUBMISSION_VIAS = ["pins", "chat"] as const;
/** A submission request, refused before parsing. Notes and questions make it large. */
export const PIN_SUBMISSION_REQUEST_MAX_BYTES = 256 * 1024;
export const PIN_SUBMISSION_MAX_ENTRIES = PIN_MAX_OPEN_PER_SESSION;
export const PIN_SUBMISSION_MAX_QUESTIONS = 5;
/**
 * One question's length, chosen so a typical Submit fits one pin's 8 KiB history
 * (`PIN_ANSWERS_MAX_BYTES`). Not a guarantee: the caps count characters, and a
 * Submit is recorded whole, so five full questions with a full note, or non-ASCII
 * text, can leave that pin's history over 8 KiB.
 */
export const PIN_SUBMISSION_QUESTION_MAX_CHARS = 1000;
/** An IANA zone name; the longest real one is 32 characters. */
export const PIN_SUBMISSION_TIME_ZONE_MAX_CHARS = 64;

/**
 * The fields a dismissal refuses beside it (#6539): each one answers the pin, or
 * changes its automatic pick, which a dismissal ends.
 */
const PIN_DISMISS_EXCLUDES = [
  "choice",
  "label",
  "steps",
  "questions",
  "automaticPick",
] as const;

/**
 * One pin's staged answer as the PWA sends it. Strict, so `by` can never come
 * from a client. `rev` is required, unlike the agent's resolve: an answer that
 * silently bound to the current revision would settle a question the operator
 * never saw, which is what `moot` exists to prevent. K and F add their own
 * optional fields here; G added `saved` (#6453): the device that saved a pin's
 * files stages it so its Submit is enabled, but the server's own record of the
 * unreported save decides what the message reports. N added `dismiss` (#6539):
 * the operator dismissed the pin without answering it. A dismissal may carry a
 * note and `saved`, and nothing else: an answer beside it would contradict it.
 */
export const PinSubmissionEntrySchema = z
  .strictObject({
    key: PinKeySchema,
    rev: z.number().int().positive(),
    choice: z.string().min(1).max(64).optional(),
    /** The option's label when it was chosen, for a choice on an older revision. */
    label: z.string().max(200).optional(),
    note: z.string().max(PIN_ANSWER_NOTE_MAX_CHARS).optional(),
    questions: z
      .array(z.string().min(1).max(PIN_SUBMISSION_QUESTION_MAX_CHARS))
      .max(PIN_SUBMISSION_MAX_QUESTIONS)
      .optional(),
    steps: z
      .strictObject({
        done: z.number().int().nonnegative(),
        total: z.number().int().positive(),
      })
      .optional(),
    /**
     * Report this pin's automatic-pick change to the agent (#6452, ruling D5).
     * Only a flag: the server builds the `{at, local}` or `{off: true}` it sends
     * from its own state, never from the client.
     */
    automaticPick: z.literal(true).optional(),
    /** #6453: this device saved the pin's files ("Save to session folder"). */
    saved: z.literal(true).optional(),
    /**
     * #6539: close this pin as dismissed and tell the agent, in the same
     * transaction as the message. An older node refuses the field (400), so a
     * dismissal is never sent to a node that could not record it.
     */
    dismiss: z.literal(true).optional(),
    via: z.enum(PIN_SUBMISSION_VIAS),
  })
  .superRefine((entry, ctx) => {
    if (
      !hasPinAnswer(entry) &&
      entry.automaticPick === undefined &&
      entry.saved !== true &&
      entry.dismiss !== true
    ) {
      ctx.addIssue({
        code: "custom",
        path: [],
        message:
          "must carry a choice, a note, a question, steps, an automatic-pick change, a save or a dismissal",
      });
    }
    if (entry.dismiss === true) {
      for (const field of PIN_DISMISS_EXCLUDES) {
        if (entry[field] !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: [field],
            message: "does not go with a dismissal",
          });
        }
      }
    }
    if (entry.label !== undefined && entry.choice === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["label"],
        message: "only goes with a choice",
      });
    }
    if (entry.steps && entry.steps.done > entry.steps.total) {
      ctx.addIssue({
        code: "custom",
        path: ["steps", "done"],
        message: "must not exceed total",
      });
    }
  });
export type PinSubmissionEntry = z.infer<typeof PinSubmissionEntrySchema>;

/**
 * True when an entry answers anything: a choice, a non-blank note, a question,
 * or steps. An entry that only carries `saved` (#6453) does not, and neither
 * does a dismissal (#6539), which closes the question without answering it.
 */
export function hasPinAnswer(
  entry: Pick<PinSubmissionEntry, "choice" | "note" | "questions" | "steps">
): boolean {
  return (
    entry.choice !== undefined ||
    (entry.note !== undefined && entry.note.trim() !== "") ||
    (entry.questions?.length ?? 0) > 0 ||
    entry.steps !== undefined
  );
}

/**
 * `POST .../pin-answers`. The same `submissionId` on a retry delivers no second
 * message and records nothing twice. `dryRun` checks and composes without
 * sending, for the Submit dialog's preview.
 */
export const PinSubmissionRequestSchema = z.strictObject({
  submissionId: z
    .string()
    .regex(
      /^[A-Za-z0-9_-]{8,80}$/,
      "must be 8 to 80 letters, digits, '-' or '_'"
    ),
  dryRun: z.boolean().optional(),
  /**
   * The submitting browser's IANA zone. The summary line uses it when the
   * operator set no Time Log timezone; the server ignores an unknown zone.
   */
  timeZone: z
    .string()
    .min(1)
    .max(PIN_SUBMISSION_TIME_ZONE_MAX_CHARS)
    .optional(),
  entries: z
    .array(PinSubmissionEntrySchema)
    .min(1)
    .max(PIN_SUBMISSION_MAX_ENTRIES),
  /**
   * Relay the answers to this running session, the stopped session's Project
   * Manager, instead (#6454): its spawn parent, or a session whose live dashboard
   * names it in a lane, on the same node. The answers are still recorded on the
   * stopped session's pins. An older node refuses the field (400), so nothing is
   * sent to the wrong place.
   */
  deliverTo: z.string().min(1).max(200).optional(),
});
export type PinSubmissionRequest = z.infer<typeof PinSubmissionRequestSchema>;

/** One entry's outcome. A `moot` entry was recorded but changed nothing. */
export const PinSubmissionResultSchema = z
  .object({
    key: z.string(),
    outcome: z.enum(["sent", "dropped"]),
    /** Why it was dropped, or why recording failed. */
    reason: z.string().optional(),
    code: z.string().optional(),
    /** Answered against an older revision; recorded moot. */
    stale: z.boolean().optional(),
    moot: z.boolean().optional(),
    /** False when delivered but not recorded (retry with the same `submissionId`). */
    recorded: z.boolean().optional(),
    pin: PinSchema.optional(),
  })
  .loose();
export type PinSubmissionResult = z.infer<typeof PinSubmissionResultSchema>;

export const PinSubmissionResponseSchema = z
  .object({
    submissionId: z.string(),
    /** The exact message, also for a dry run. */
    text: z.string(),
    delivered: z.boolean(),
    denied: z
      .object({ hookId: z.string(), reason: z.string() })
      .loose()
      .optional(),
    entries: z.array(PinSubmissionResultSchema),
    openPinCount: z.number().int().nonnegative(),
    /** The session the message went to, when relayed to a Project Manager (#6454). */
    deliveredTo: z.string().optional(),
  })
  .loose();
export type PinSubmissionResponse = z.infer<typeof PinSubmissionResponseSchema>;
