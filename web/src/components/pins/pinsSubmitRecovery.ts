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
  PinSubmissionRequest,
  PinSubmissionResponse,
  PinSubmissionResult,
} from "@hapi/protocol";
import { ApiError } from "@/api/client";
import type { BuiltSubmission } from "@/lib/pins/submission";
import {
  clearSubmitted,
  type PendingSubmission,
  type StagedPin,
  type StagedPins,
} from "@/lib/pins/staging";

/** A server refusal, read from an `ApiError`'s body. */
export type Refusal = {
  code?: string;
  error: string;
  entries?: PinSubmissionResult[];
};

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
    request: entries.length > 0 ? { ...next.request, entries } : null,
    submitted: Object.fromEntries(
      Object.entries(next.submitted).filter(([key]) => kept.has(key))
    ),
    stale: next.stale.filter(row => kept.has(row.key)),
  };
}
