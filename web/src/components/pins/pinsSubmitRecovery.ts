// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The Submit dialog's recovery rules for a Submit whose outcome is unknown
 * (#6521 S2/S3, ER-D2, #6458 review): one id belongs to one frozen request,
 * which refusals prove it undelivered, and how the edits made since go as a new
 * Submit. Pure helpers, moved out of `PinsSubmitDialog.tsx` so the component
 * stays under the `max-lines` guard (#2077); the dialog's tests cover them
 * through the component, `pinsSubmitRecovery.test.ts` directly.
 */
import type {
  PinSubmissionEntry,
  PinSubmissionRequest,
  PinSubmissionResponse,
  PinSubmissionResult,
} from "@hapi/protocol";
import { ApiError } from "@/api/client";
import { makeSubmissionId, type BuiltSubmission } from "@/lib/pins/submission";
import {
  clearSubmitted,
  hasUpdates,
  resolveNoteMax,
  type PendingSubmission,
  type StagedPin,
  type StagedPins,
} from "@/lib/pins/staging";

/** A server refusal, read from an `ApiError`'s body. */
export type Refusal = {
  code?: string;
  error: string;
  entries?: PinSubmissionResult[];
  /**
   * #6803: the request fields an older node refused (`dismiss`, `writeIn`).
   * Read through `refusedFieldsOf`, which trusts only an array of strings.
   * #6969: `longNote`, a note over the node's `maxNoteChars`.
   */
  unsupported?: unknown;
  /** #6969 (D2): the longest note the node takes; read through `resolveNoteMax`. */
  maxNoteChars?: unknown;
};

/**
 * #6803: the request fields an older node may refuse, each its own extension.
 * #6969 (D2): `longNote`, a note longer than an older node takes.
 */
export const REFUSABLE_FIELDS = ["dismiss", "writeIn", "longNote"] as const;
export type RefusableField = (typeof REFUSABLE_FIELDS)[number];

/** Each refusal code, and what it means when its 501 lists nothing. */
const REFUSAL_CODES: Record<string, RefusableField> = {
  pin_dismiss_unsupported: "dismiss",
  pin_writein_unsupported: "writeIn",
  pin_long_note_unsupported: "longNote",
};

/**
 * #6539, #6803, #6969: the fields an older node refused, from its 501. A hub
 * from before #6803 sends `pin_dismiss_unsupported` with no list, which means
 * the dismissals alone. Null for any other refusal.
 */
export function refusedFieldsOf(
  refusal: Refusal | null
): RefusableField[] | null {
  const alone = refusal?.code ? REFUSAL_CODES[refusal.code] : undefined;
  if (!refusal || !alone) return null;
  const listed = refusal.unsupported;
  if (Array.isArray(listed) && listed.every(item => typeof item === "string")) {
    const fields = REFUSABLE_FIELDS.filter(field => listed.includes(field));
    if (fields.length > 0) return fields;
  }
  return [alone];
}

/** #6969 (D2): the longest note a refusing node takes, else 2,048. */
export function refusedNoteMaxOf(refusal: Refusal | null): number {
  return resolveNoteMax(refusal?.maxNoteChars);
}

/**
 * #6803, #6969: whether an entry carries a refused field: a dismissal or a
 * write-in by its presence, a long note by its length against `maxNoteChars`.
 */
export function carriesRefused(
  entry: PinSubmissionEntry,
  field: RefusableField,
  maxNoteChars: number
): boolean {
  return field === "longNote"
    ? (entry.note?.length ?? 0) > maxNoteChars
    : entry[field] !== undefined;
}

/**
 * #6539, #6803: the same Submit without every entry that carries one of
 * `fields`, each left out whole with its note, under a new id, because the
 * entry set changed and the old id may be on record somewhere. Its `submitted`
 * holds only the pins it still sends, so the left-out entries stay staged.
 */
export function withoutFields(
  built: BuiltSubmission,
  fields: readonly RefusableField[],
  maxNoteChars: number
): BuiltSubmission {
  const entries = (built.request?.entries ?? []).filter(
    entry => !carriesAny(entry, fields, maxNoteChars)
  );
  const kept = new Set(entries.map(entry => entry.key));
  return {
    ...built,
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

/** #6539: the same Submit without its dismissals (a plain message records none). */
export function withoutDismissals(built: BuiltSubmission): BuiltSubmission {
  return withoutFields(built, ["dismiss"], Number.POSITIVE_INFINITY);
}

/** #6803, #6969: whether an entry carries any of `fields`. */
export function carriesAny(
  entry: PinSubmissionEntry,
  fields: readonly RefusableField[],
  maxNoteChars: number
): boolean {
  return fields.some(field => carriesRefused(entry, field, maxNoteChars));
}

/**
 * #6803, #6969: the entries the older-node phase lists with their words when
 * nothing else can go: each carrying a refused write-in or long note.
 */
export function refusedWordKeys(
  entries: readonly PinSubmissionEntry[],
  fields: readonly RefusableField[],
  maxNoteChars: number
): string[] {
  const withWords = fields.filter(field => field !== "dismiss");
  return entries
    .filter(entry => carriesAny(entry, withWords, maxNoteChars))
    .map(entry => entry.key);
}

export function refusalOf(error: unknown): Refusal | null {
  if (!(error instanceof ApiError)) return null;
  try {
    const body = JSON.parse(error.body ?? "") as Refusal;
    return { ...body, code: body.code ?? error.code };
  } catch {
    return { code: error.code, error: error.message };
  }
}

/** #6521 S2: the server's code for an entry a replayed Submit did not carry. */
export const NOT_IN_SUBMISSION = "pin_not_in_submission";

/** #6539: the server's code for a dismissal made on an older revision. */
export const STALE_DISMISS = "pin_dismiss_stale";

/**
 * A dropped entry the Submit keeps staged, so it goes again with its note: a
 * stale dismissal (#6539 R1) and a replay's entry not in the message already
 * sent (#6521 S2/N). #6768: its row offers nothing to clear.
 */
export function keepsStaged(entry: Pick<PinSubmissionResult, "code">): boolean {
  return entry.code === STALE_DISMISS || entry.code === NOT_IN_SUBMISSION;
}

/** #6521 S2: what the dialog says after a lost response or a 5xx. */
export const UNCERTAIN_TEXT =
  "The answer did not come back, so the session may already have your answers. Send again: it finishes the same Submit and never delivers twice.";

/**
 * #6458 (review D1): the Submit refusals the server returns only after it
 * found the id undelivered, in the session's chat and the named PM's
 * (`server/src/sync/pinSubmission.ts`). Any of them on a frozen request's dry
 * run proves it never arrived, so its pending record may go.
 */
const UNDELIVERED_CODES: ReadonlySet<string> = new Set([
  "session_active",
  "session_inactive",
  "parent_unavailable",
  "parent_mismatch",
  "pin_submission_empty",
  "pin_submission_too_large",
]);

export function provesUndelivered(error: unknown): boolean {
  const code = refusalOf(error)?.code;
  return typeof code === "string" && UNDELIVERED_CODES.has(code);
}

/**
 * #6521 S2: a lost response (no HTTP answer) or a 5xx may have delivered. A
 * 501 is a definite answer (the node does not serve that Submit, #6458 review),
 * so it is not an unknown outcome.
 */
export function uncertainOf(error: unknown): { uncertain?: true } {
  if (error instanceof ApiError && (error.status < 500 || error.status === 501))
    return {};
  return { uncertain: true };
}

/** #6521 S2: the entries a frozen Submit was built from, by their stamps. */
export function stampedSubmitted(
  pending: PendingSubmission
): Record<string, Readonly<StagedPin>> {
  return Object.fromEntries(
    Object.entries(pending.stamps).map(([key, updatedAt]) => [
      key,
      { updatedAt } as StagedPin,
    ])
  );
}

/** The staged entries a pending Submit names, as staged now. */
export function subsetOf(
  staged: StagedPins,
  pending: PendingSubmission
): Record<string, StagedPin> {
  return Object.fromEntries(
    Object.keys(pending.stamps)
      .filter(key => staged[key] !== undefined)
      .map(key => [key, staged[key] as StagedPin])
  );
}

/**
 * #6521 S2/S3 (ER-D2): a new Submit for the edits made after `delivered` went
 * out, without the questions and the identical notes the agent already has. An
 * entry left with nothing to say is cleared from staging, because the message
 * already delivered carried all of it.
 */
export function withoutDelivered(
  next: BuiltSubmission,
  delivered: PinSubmissionRequest,
  result: PinSubmissionResponse,
  sessionId: string
): BuiltSubmission {
  if (!next.request) return next;
  // Only what the message carried: an entry the server dropped never reached
  // the agent, so its note and questions still go.
  const carried = new Set(
    result.entries.filter(e => e.outcome === "sent").map(e => e.key)
  );
  const sentByKey = new Map(
    delivered.entries.filter(e => carried.has(e.key)).map(e => [e.key, e])
  );
  const emptied: Record<string, Readonly<StagedPin>> = {};
  const entries = next.request.entries.flatMap(entry => {
    const sent = sentByKey.get(entry.key);
    if (!sent) return [entry];
    const questions = (entry.questions ?? []).filter(
      q => !(sent.questions ?? []).includes(q)
    );
    const note =
      entry.note !== undefined && entry.note === sent.note
        ? undefined
        : entry.note;
    const { questions: _q, note: _n, ...rest } = entry;
    const stripped = {
      ...rest,
      ...(questions.length > 0 ? { questions } : {}),
      ...(note !== undefined ? { note } : {}),
    };
    const saysSomething =
      stripped.choice !== undefined ||
      // #6803: a write-in staged after a delivered Submit is new, so it goes.
      stripped.writeIn !== undefined ||
      stripped.note !== undefined ||
      (stripped.questions?.length ?? 0) > 0 ||
      stripped.steps !== undefined ||
      stripped.automaticPick !== undefined ||
      stripped.saved === true ||
      stripped.dismiss === true;
    if (saysSomething) return [stripped];
    const staged = next.submitted[entry.key];
    if (staged) emptied[entry.key] = staged;
    return [];
  });
  if (Object.keys(emptied).length > 0) clearSubmitted(sessionId, emptied);
  const kept = new Set(entries.map(e => e.key));
  return {
    ...next,
    request: entries.length > 0 ? { ...next.request, entries } : null,
    submitted: Object.fromEntries(
      Object.entries(next.submitted).filter(([key]) => kept.has(key))
    ),
    stale: next.stale.filter(row => kept.has(row.key)),
  };
}

/** #6768 (R3): said when the dialog re-checked instead of sending. */
export const STAGING_MOVED_TEXT = "Your answers changed, so check them again";

/**
 * #6768 (R3): staging moved on after this request was built, so sending it
 * would send what the operator no longer has staged, or leave out what they
 * added: an entry it sends changed or went, or an entry with something to send
 * is not the one the build read. An entry the build left out and that has not
 * changed (a held choice, ticks with no pin to send them to) is not a move, so
 * it never turns every Send into another check.
 */
export function stagingMovedSince(
  built: Pick<BuiltSubmission, "from" | "submitted">,
  staged: StagedPins
): boolean {
  for (const [key, entry] of Object.entries(built.submitted)) {
    if (staged[key]?.updatedAt !== entry.updatedAt) return true;
  }
  return Object.entries(staged).some(
    ([key, entry]) =>
      hasUpdates(entry) && built.from[key]?.updatedAt !== entry.updatedAt
  );
}
