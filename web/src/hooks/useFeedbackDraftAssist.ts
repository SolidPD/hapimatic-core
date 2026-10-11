// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useRef, useState } from "react";
import { scrubString } from "@hapi/protocol/sentryScrub";
import type { ApiClient } from "@/api/client";
import type { DecryptedMessage, FeedbackCategory } from "@/types/api";
import { makeClientSideId } from "@/lib/messages";
import { normalizeDecryptedMessage } from "@/chat/normalize";
import { useMessages } from "@/hooks/queries/useMessages";
import { useSession } from "@/hooks/queries/useSession";

/**
 * Feature flag for the "Help me describe this" AI assist (issue #2668, epic
 * #2663). The assist is STRICTLY ADDITIVE to the #2664 `FeedbackModal` MVP:
 * flipping this to `false` removes the action with ZERO effect on the plain
 * description path (R3). No feature-flag framework exists in `web/src`, so this
 * exported const IS the flag — flip it here or delete the hook + modal action.
 */
export const FEEDBACK_AI_ASSIST_ENABLED = true;

/**
 * Hard ceiling on how long we wait for the in-session draft reply. A live
 * session can fail by SILENCE (queued, or active-but-unresponsive), and
 * `POST /sessions/:id/messages` is fire-and-forget with no delivery guarantee,
 * so the timeout is the ONLY recovery — it resolves to a user-facing error and
 * leaves the manual-typing path intact.
 */
export const FEEDBACK_ASSIST_TIMEOUT_MS = 45_000;

/**
 * Minimum length of a prior-conversation line the verbatim-overlap check will
 * strip from a draft (R4 transcript-dump detector). Short shared phrases would
 * false-positive; a 40-char line is long enough to be a genuine transcript
 * fragment rather than an incidental collision.
 */
const VERBATIM_OVERLAP_MIN_LEN = 40;

const CATEGORY_LABEL: Record<FeedbackCategory, string> = {
  bug: "a bug report",
  feature: "a feature request",
  other: "feedback",
};

export interface FeedbackDraftAssist {
  /** True only when the assist can actually be offered (flag on + active session). */
  available: boolean;
  /** The scrubbed drafted description, or null before/without a draft. */
  draft: string | null;
  /** True while a draft request is in flight. */
  isDrafting: boolean;
  /** User-facing error (send failure or timeout); null when clear. */
  error: string | null;
  /** Kick off a draft from the user's rough notes + category. */
  requestDraft: (notes: string, category: FeedbackCategory) => void;
  /** Clear draft/error/in-flight state (called when the modal closes). */
  reset: () => void;
}

/**
 * The constrained prompt (R4): asks Claude for a feedback description ONLY — no
 * transcript, no code, no secrets/tokens — and to reply with just the text.
 * Exported for unit testing.
 */
export function buildDraftPrompt(
  notes: string,
  category: FeedbackCategory
): string {
  const trimmed = notes.trim();
  const roughNotes =
    trimmed.length > 0
      ? `My rough notes: "${trimmed}"`
      : "I have not written any notes yet.";
  return [
    `I'm filling out an in-app feedback form (${CATEGORY_LABEL[category]}) about our current work.`,
    roughNotes,
    "Please write a concise, clear feedback description I can submit.",
    "Reply with ONLY the description text — no preamble, no surrounding quotes.",
    "Do NOT include any conversation transcript, code, file contents, tokens, secrets, or credentials — describe the issue in your own words.",
  ].join("\n");
}

/** Visible assistant text from a message (excludes reasoning + tool blocks). */
function extractAgentText(msg: DecryptedMessage): string {
  const norm = normalizeDecryptedMessage(msg);
  if (!norm || norm.role !== "agent" || !Array.isArray(norm.content)) return "";
  return norm.content
    .flatMap(block => (block.type === "text" ? [block.text] : []))
    .join("\n")
    .trim();
}

/** Any plain text (user or agent) from a message, for the overlap check. */
function extractAnyText(msg: DecryptedMessage): string {
  const norm = normalizeDecryptedMessage(msg);
  if (!norm) return "";
  if (norm.role === "user") {
    return typeof norm.content?.text === "string" ? norm.content.text : "";
  }
  if (norm.role === "agent" && Array.isArray(norm.content)) {
    return norm.content
      .flatMap(block =>
        block.type === "text" || block.type === "reasoning" ? [block.text] : []
      )
      .join("\n");
  }
  return "";
}

/**
 * R4 scrub applied to the drafted text before it reaches the description field:
 *   (a) mask token-shaped content via the shared `scrubString`
 *       (`@hapi/protocol/sentryScrub`, same helper `web/src/sentry.ts` uses); and
 *   (b) strip any draft line that verbatim-matches a line of the PRIOR
 *       conversation — an honest transcript-DUMP detector. The prior
 *       conversation is every message BEFORE the assist prompt.
 * Exported for unit testing.
 */
export function scrubDraft(raw: string, priorConversation: string[]): string {
  const tokenScrubbed = scrubString(raw);
  const banned = new Set<string>();
  for (const text of priorConversation) {
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length >= VERBATIM_OVERLAP_MIN_LEN) banned.add(trimmed);
    }
  }
  if (banned.size === 0) return tokenScrubbed.trim();
  return tokenScrubbed
    .split("\n")
    .map(line =>
      banned.has(line.trim()) ? "[removed: quoted session content]" : line
    )
    .join("\n")
    .trim();
}

/**
 * In-session "help me describe this" draft assist (issue #2668). Reuses the
 * existing send path (`api.sendMessage` → `POST /sessions/:id/messages`) and the
 * app-wide SSE → `useMessages` cache (it does NOT mount a second `useSSE` — the
 * connection at `web/src/App.tsx` already feeds the cache). Sends a constrained
 * prompt, correlates the reply by the sent message's `localId` echo → `seq`,
 * finalizes once the session stops thinking, scrubs the result (R4), and returns
 * it as EDITABLE text (never auto-submitted — R2).
 */
export function useFeedbackDraftAssist(params: {
  api: ApiClient | null;
  sessionId: string | null | undefined;
  /** Gate the queries + availability (e.g. the modal's `open` state). */
  enabled?: boolean;
}): FeedbackDraftAssist {
  const { api, sessionId, enabled = true } = params;

  // Only talk to a session when the flag is on, the caller enabled us, and we
  // actually have a session id. When closed, `querySessionId` is null so the
  // underlying queries are disabled (no fetch, no availability).
  const gateOpen = FEEDBACK_AI_ASSIST_ENABLED && enabled && Boolean(sessionId);
  const querySessionId = gateOpen ? (sessionId ?? null) : null;

  const [draft, setDraft] = useState<string | null>(null);
  const [isDrafting, setIsDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // In-flight request tracking. Refs (not state) so mutating them never causes
  // a render; the effect below reads `pendingRef.current` fresh on each run.
  const pendingRef = useRef<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Poll session state while drafting so `thinking` stays fresh even if an SSE
  // event is missed (mirrors SessionChat's isActiveSession usage).
  const { session } = useSession(api, querySessionId, isDrafting);
  const { messages } = useMessages(api, querySessionId);

  const available = gateOpen && session?.active === true;

  const clearTimer = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const finish = useCallback(() => {
    pendingRef.current = null;
    setIsDrafting(false);
    clearTimer();
  }, [clearTimer]);

  const requestDraft = useCallback(
    (notes: string, category: FeedbackCategory) => {
      if (!api || !sessionId) {
        setError("The assist needs an active session to draft a description.");
        return;
      }
      if (pendingRef.current) return; // a draft is already in flight

      const localId = makeClientSideId("feedback-assist");
      pendingRef.current = localId;
      setDraft(null);
      setError(null);
      setIsDrafting(true);

      clearTimer();
      timeoutRef.current = setTimeout(() => {
        if (pendingRef.current === localId) {
          setError(
            "The assist timed out — the session didn't respond. Please type your description."
          );
          finish();
        }
      }, FEEDBACK_ASSIST_TIMEOUT_MS);

      void api
        .sendMessage(sessionId, buildDraftPrompt(notes, category), localId)
        .catch(() => {
          if (pendingRef.current === localId) {
            setError(
              "Couldn't reach the session to draft a description. Please type it manually."
            );
            finish();
          }
        });
    },
    [api, sessionId, clearTimer, finish]
  );

  // Watch for the reply: our prompt's `localId` echo → its persisted `seq` → the
  // agent text that follows it. Finalize only once the session has stopped
  // thinking so we capture the complete reply, not a mid-stream fragment.
  useEffect(() => {
    const pendingLocalId = pendingRef.current;
    if (!pendingLocalId) return;

    const echo = messages.find(m => m.localId === pendingLocalId);
    if (!echo || typeof echo.seq !== "number") return; // prompt not yet persisted
    const mySeq = echo.seq;

    const replyText = messages
      .filter(m => typeof m.seq === "number" && m.seq > mySeq)
      .map(extractAgentText)
      .filter(Boolean)
      .join("\n")
      .trim();
    if (!replyText) return; // no assistant text yet
    if (session?.thinking === true) return; // still generating — wait

    const priorConversation = messages
      .filter(m => typeof m.seq === "number" && m.seq < mySeq)
      .map(extractAnyText);

    setDraft(scrubDraft(replyText, priorConversation));
    finish();
  }, [messages, session?.thinking, finish]);

  // Clear in-flight state if the caller disables us (e.g. modal closed) while a
  // request is outstanding, so a stale reply can't populate a reopened modal.
  useEffect(() => {
    if (!gateOpen && pendingRef.current) {
      pendingRef.current = null;
      setIsDrafting(false);
      clearTimer();
    }
  }, [gateOpen, clearTimer]);

  // Cancel any pending timer on unmount.
  useEffect(() => () => clearTimer(), [clearTimer]);

  const reset = useCallback(() => {
    pendingRef.current = null;
    setDraft(null);
    setError(null);
    setIsDrafting(false);
    clearTimer();
  }, [clearTimer]);

  return { available, draft, isDrafting, error, requestDraft, reset };
}
