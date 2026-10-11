// SPDX-License-Identifier: AGPL-3.0-only
type RoleWrappedRecord = {
  role: string;
  content: unknown;
  meta?: unknown;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

export function isRoleWrappedRecord(
  value: unknown
): value is RoleWrappedRecord {
  if (!isObject(value)) return false;
  return typeof value.role === "string" && "content" in value;
}

export function unwrapRoleWrappedRecordEnvelope(
  value: unknown
): RoleWrappedRecord | null {
  if (isRoleWrappedRecord(value)) return value;
  if (!isObject(value)) return null;

  const direct = value.message;
  if (isRoleWrappedRecord(direct)) return direct;

  const data = value.data;
  if (isObject(data) && isRoleWrappedRecord(data.message))
    return data.message as RoleWrappedRecord;

  const payload = value.payload;
  if (isObject(payload) && isRoleWrappedRecord(payload.message))
    return payload.message as RoleWrappedRecord;

  return null;
}

export type { RoleWrappedRecord };

// ────────────────────────────────────────────────────────────────────────
// Gate-denial outcome catalogue (issue #3579, epic #3329 Sub-Issue N)
//
// The SINGLE source of user-facing copy for every gate-class message-hook
// denial — and the non-blocking "notice" kind #3559 (`already-granted`) and
// #3563 (`grant-orphaned`) add to the SAME catalogue. Machine reason codes stay
// for logs/tests; copy is NEVER composed at a call site (R1). No gate jargon
// (R7); timestamps are ISO instants the CLIENT formats to locale (R6) — this
// module never renders an HH:MM.
//
// PRODUCER CONTRACT (frozen — #3559 and #3563 cite these names verbatim; do NOT
// rename `GateDenialOutcome` / `DENIAL_CATALOGUE` / `resolveDenialOutcome`).
// #3579 seeds PLACEHOLDER token-gate copy; #3559 finalizes the token wording +
// `already-granted`, #3563 adds `grant-orphaned`.
// ────────────────────────────────────────────────────────────────────────

/** A one-tap recovery affordance rendered on a notice (R5). `cannedMessage` is
 *  token-free, so tapping it passes the gate as a normal user message. */
export interface GateDenialChip {
  label: string;
  cannedMessage: string;
}

/**
 * The resolved, ready-to-render outcome for one gate event. `kind` discriminates
 * a delivery DENIAL from a non-blocking NOTICE (#3559 `already-granted`, #3563
 * `grant-orphaned`) — both share this shape and this catalogue.
 */
export interface GateDenialOutcome {
  kind: "denial" | "notice";
  title: string;
  explanation: string;
  nextStep: string;
  chip?: GateDenialChip;
}

/** hookId → reasonCode → outcome. A missing (hookId, code) falls back to the
 *  generic entry via {@link resolveDenialOutcome}, which never crashes or
 *  fails-open on an unrecognized reason (R1). */
export type DenialCatalogue = Record<string, Record<string, GateDenialOutcome>>;

/**
 * The token-gate hook id — the {@link DENIAL_CATALOGUE} key for token-gate copy
 * and the id the server persists on a token-gate notice/denial. Exported here (the
 * catalogue's own module) so the web approval card can resolve token-gate copy
 * WITHOUT importing from `server`. Mirrors `server/src/sync/approvalTokenHook.ts`
 * `APPROVAL_TOKEN_HOOK_ID` (frozen #3579 producer contract, #3559). */
export const APPROVAL_TOKEN_HOOK_ID = "user-approval-token-gate";

/** Copy-template params. `{issueNumber}` renders `#N`; `{at}` is a raw ISO
 *  instant (the client re-formats it to locale, R6); `{detail}` is the folded
 *  free-form tail of a `code: detail` reason. */
export type DenialCopyParams = Record<string, string | number>;

/**
 * The generic fallback for any unknown (hookId, code). Copy stands ALONE — it
 * never says "the message above/below", because the `"blocked"` bubble is
 * client-only and a second client or a post-reload view sees the notice with
 * nothing beside it (R3).
 */
export const GENERIC_DENIAL_OUTCOME: GateDenialOutcome = {
  kind: "denial",
  title: "Message not sent",
  explanation:
    "Your message was held before it was sent, so it hasn't reached this session.",
  nextStep: "Try sending it again, or rephrase it and resend.",
};

/**
 * Runner-level failure codes, keyed hook-agnostically. The message-hook runner
 * attaches `code: "hook-timeout" | "hook-error"` on its OWN denials (a hook that
 * timed out or threw) — its prose reason is not code-shaped, so without these a
 * fail-closed timeout would be indistinguishable from an unknown refusal (the
 * one case where "we couldn't check, try again" is the only honest copy).
 */
export const RUNNER_DENIAL_CODES: Record<string, GateDenialOutcome> = {
  "hook-timeout": {
    kind: "denial",
    title: "Couldn't check in time",
    explanation:
      "We couldn't finish checking your message in time, so it wasn't sent.",
    nextStep: "Try sending it again.",
  },
  "hook-error": {
    kind: "denial",
    title: "Couldn't check that",
    explanation:
      "Something went wrong while checking your message, so it wasn't sent.",
    nextStep: "Try sending it again in a moment.",
  },
};

/**
 * The seeded catalogue. #3579 ships PLACEHOLDER `user-approval-token-gate` copy
 * (final token wording is #3559's job) plus a placeholder `already-granted`
 * NOTICE so the non-denial `kind` is wired end-to-end (#3559 finalizes it).
 */
export const DENIAL_CATALOGUE: DenialCatalogue = {
  // #3559 FINAL token-gate copy (was #3579 placeholder). Governing rules:
  //  - R5 (no gate jargon): no "nonce" / "minted" / "consumed" / "replayed" /
  //    "provenance" in ANY user-facing string ("used" and "approval" are allowed).
  //  - R4 chips: `replayed` → Continue; every mismatch/drift/provenance/
  //    indeterminate → re-issue; `already-granted` → NO chip (it is a notice).
  //  - Every chip `cannedMessage` is kept clear of rp1-home's phrase-approval
  //    detector patterns (`^proceed\.?$`, `^ok\.?$`, `^please\s+(do|proceed)\.?$`,
  //    `\bapproved?\b`, `\bclose\s+it\b`, `\bready\s+to\s+(merge|close|ship)\b`),
  //    because a chip sends its text through the NORMAL composer path where that
  //    detector would otherwise mint a LEGACY phrase grant that OVERWRITES the
  //    live nonce grant at the shared path. Pinned by `messages.test.ts`.
  //  - `#N` / the time render from `params` (ledger `ts`, not "now"); each is in a
  //    trailing em-dash clause so `interpolateDenialCopy` drops it WHOLE when the
  //    param is absent (a bypass-scope re-send has no issue number; a ledger-less
  //    path has no time).
  "user-approval-token-gate": {
    "nonce-mismatch": {
      kind: "denial",
      title: "That approval didn't match",
      explanation:
        "That approval didn't match the request we were waiting on, so your message wasn't sent.",
      nextStep:
        "Ask the agent to show the approval prompt again, then approve that one.",
      chip: {
        label: "Ask to re-issue",
        cannedMessage: "Please re-issue the approval prompt.",
      },
    },
    "state-drift": {
      kind: "denial",
      title: "Something changed",
      explanation:
        "The request changed after this approval was set up, so it wasn't applied.",
      nextStep:
        "Ask the agent for a fresh approval prompt and approve that one.",
      chip: {
        label: "Ask to re-issue",
        cannedMessage: "Please re-issue the approval prompt.",
      },
    },
    "provenance-rejected": {
      kind: "denial",
      title: "Couldn't confirm the request",
      explanation:
        "We couldn't tie this approval back to a request we recognize, so your message was held.",
      nextStep:
        "Ask the agent to start the request again and approve the new one.",
      chip: {
        label: "Ask to re-issue",
        cannedMessage: "Please re-issue the approval prompt.",
      },
    },
    "state-indeterminate": {
      kind: "denial",
      title: "Couldn't check the approval",
      explanation:
        "We couldn't confirm this approval right now ({detail}), so your message wasn't sent.",
      nextStep: "Give it another try in a moment.",
      chip: {
        label: "Ask to re-issue",
        cannedMessage: "Please re-issue the approval prompt.",
      },
    },
    replayed: {
      kind: "denial",
      title: "Already used",
      // `{issueNumber}` is a droppable parenthetical and `{at}` a droppable
      // trailing clause, so each degrades INDEPENDENTLY: a ledger hit with a `ts`
      // but an empty `issue` still shows the time (the V2 case), and a hit with
      // neither shows the bare sentence. `{at}` is the LEDGER instant (not "now").
      explanation:
        "This approval was already used (for {issueNumber}), so we didn't apply it again — used at {at}.",
      nextStep:
        "Tap Continue if the work is already done, or ask for a fresh request.",
      chip: {
        label: "Continue",
        cannedMessage: "Continue",
      },
    },
    "already-granted": {
      kind: "notice",
      title: "Already approved",
      // `{issueNumber}` is a droppable parenthetical (a bypass-scope resume has no
      // issue number); the trailing "— the agent…" clause carries no param and
      // always renders.
      explanation:
        "This was already approved (for {issueNumber}), so there's nothing new to send — the agent already has what it needs.",
      nextStep: "You're all set — no need to approve again.",
    },
    // #3563: the PROACTIVE orphaned-grant notice. A grant was approved but this
    // session's turn ended in error/abort before the agent acted on it — so the
    // user is told BEFORE they re-send (the complement to `already-granted`, which
    // handles the re-send). A DISTINCT reason code (not a variant of
    // `already-granted`). NOTICE kind → NO chip (R6). `{issueNumber}` is a droppable
    // parenthetical (a bypass-scope grant has no issue number); `— approved at {at}`
    // is a droppable trailing em-dash clause ({at} = the ISO mint instant, the client
    // formats it to locale, R6). The copy states what happened and offers the resume;
    // it never asserts the session is idle "waiting for you" — a recovery-enabled
    // session may auto-resume on its own shortly after (AutoRecoveryService overlap).
    "grant-orphaned": {
      kind: "notice",
      title: "Approval received — not applied yet",
      explanation:
        "Your approval came through (for {issueNumber}), but this session stopped before acting on it — approved at {at}.",
      nextStep: "Send any message to pick up from where it left off.",
    },
  },
};

const UNRESOLVED = "￿"; // sentinel for a placeholder with no param value

/**
 * Fill `{key}` placeholders from `params`. `{issueNumber}` renders `#N`; any
 * other key renders its literal string form. An UNRESOLVED placeholder degrades
 * to the surrounding sentence — a self-contained `(…)` parenthetical or a
 * trailing `— …` clause built only from the missing value is dropped whole; a
 * bare leftover token is stripped — so we never render literal braces (R1).
 */
export function interpolateDenialCopy(
  template: string,
  params: DenialCopyParams
): string {
  let out = template.replace(/\{(\w+)\}/g, (_m, key: string) => {
    const value = params[key];
    if (value === undefined || value === null || value === "")
      return UNRESOLVED;
    return key === "issueNumber" ? `#${value}` : String(value);
  });
  // Drop a parenthetical clause that became only-unresolved: " (…￿…)".
  out = out.replace(/\s*\([^()]*￿[^()]*\)/g, "");
  // Drop a trailing em-dash clause that became only-unresolved.
  out = out.replace(/\s*—[^—]*￿[^—]*$/g, "");
  // Any remaining sentinel: strip the token itself.
  out = out.split(UNRESOLVED).join("");
  // Normalize whitespace + space-before-punctuation artifacts.
  return out
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
}

/**
 * Resolve a (hookId, reason) pair to a ready-to-render {@link GateDenialOutcome}
 * (R1). `reason` is split at the FIRST `": "` into a lookup `code` and a `detail`
 * tail (folded into `params.detail`); splitting once keeps a detail that itself
 * contains `": "` intact. Resolution order: hook-specific → runner-level →
 * generic fallback. Copy templates are interpolated from `params` (+ the folded
 * detail); an unknown pair never crashes or fails-open.
 *
 * PART OF THE FROZEN PRODUCER CONTRACT — do not rename (see header).
 */
export function resolveDenialOutcome(
  hookId: string,
  reason: string,
  params: DenialCopyParams = {}
): GateDenialOutcome {
  const sep = reason.indexOf(": ");
  const code = sep === -1 ? reason : reason.slice(0, sep);
  const detail = sep === -1 ? undefined : reason.slice(sep + 2);

  const merged: DenialCopyParams = { ...params };
  if (detail !== undefined && merged.detail === undefined)
    merged.detail = detail;

  const entry =
    DENIAL_CATALOGUE[hookId]?.[code] ??
    RUNNER_DENIAL_CODES[code] ??
    GENERIC_DENIAL_OUTCOME;

  return {
    kind: entry.kind,
    title: interpolateDenialCopy(entry.title, merged),
    explanation: interpolateDenialCopy(entry.explanation, merged),
    nextStep: interpolateDenialCopy(entry.nextStep, merged),
    ...(entry.chip
      ? {
          chip: {
            label: interpolateDenialCopy(entry.chip.label, merged),
            cannedMessage: interpolateDenialCopy(
              entry.chip.cannedMessage,
              merged
            ),
          },
        }
      : {}),
  };
}
