// SPDX-License-Identifier: AGPL-3.0-only
/**
 * SpawningSessionView (issue #3515).
 *
 * The live placeholder screen shown at `/sessions/<placeholderId>` during the
 * optimistic-create window — where `placeholderId` is the future session's TAG
 * (the pre-generated `hapiSessionId`, finding 3515-1), NOT a row uuid. It is a
 * LOCAL-only composer: the real session does not exist yet, so it does NOT reuse
 * `SessionPage` (whose `useSession`/`useMessages`/`useSendMessage` are bound to
 * the route id and would 404 a tag / POST to a non-existent session). The user
 * can type a first prompt (R2); it is held in the client handover store and
 * written ONCE to the real uuid at the swap (R3).
 *
 * Three terminal transitions, each fired exactly once (settledRef):
 *   - materialised → the real row appears under the shared tag (`tag ===
 *     placeholderId`, a fresh uuid `id`). Apply the deferred handover
 *     (emoji/linkedIssue/draft) to the real uuid, then navigate (replace) to it.
 *   - failed → the placeholder flips to `lifecycleState:"failed"` (SSE-marked or
 *     the server TTL backstop) OR the `hapi:spawnFailed` SSE arrives. Return to
 *     Create with a code-specific toast and the form preserved for a single-click
 *     retry (R4).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { ApiClient } from "@/api/client";
import { LOCAL_NODE_ID, LOCAL_NODE_LABEL } from "@hapi/protocol";
import { useSessions } from "@/hooks/queries/useSessions";
import { useFederatedSessions } from "@/hooks/queries/useFederatedSessions";
import { buildReloginToast } from "@/lib/reloginLink";
import { useToast } from "@/components/Toast";
import { LoadingState } from "@/components/LoadingState";
import {
  getSpawnHandover,
  setSpawnDraft,
  endSpawnHandover,
  stashRetryForm,
} from "@/lib/spawn-draft";

/** Map a pre-daemon refusal code to actionable copy; fall back to the message. */
function failureMessage(code: string | undefined, fallback?: string): string {
  switch (code) {
    case "account_token_expired":
      return "Spawn failed — the selected account's token expired. Re-login and try again.";
    case "at_capacity":
      return "Spawn failed — the machine is at its session capacity. Free a slot and try again.";
    default:
      return fallback && fallback.trim().length > 0
        ? fallback
        : "Spawn failed. Please try again.";
  }
}

export function SpawningSessionView({
  api,
  placeholderId,
  onFailureBack,
}: {
  api: ApiClient;
  placeholderId: string;
  /** Return-to-Create navigation used on a spawn failure (R4). */
  onFailureBack: () => void;
}) {
  const navigate = useNavigate();
  const { sessions } = useSessions(api);
  const { showToast } = useToast();
  // Issue #4461 (R8): this placeholder is the LOCAL optimistic create, so the
  // node that refused an account_unrefreshable spawn is the UI host.
  const { localNode } = useFederatedSessions(api);

  // The placeholder row (id === tag === hapiSessionId) while spawning/failed.
  const placeholder = sessions.find(s => s.id === placeholderId);
  const placeholderState = placeholder?.lifecycleState;
  // The real row materialised under the shared tag (a fresh uuid id).
  const realSession = sessions.find(
    s => s.tag === placeholderId && s.id !== placeholderId
  );

  // Fire the swap / failure navigation exactly once.
  const settledRef = useRef(false);
  // The refusal code carried by the spawn-failed SSE (code-specific copy).
  const failureCodeRef = useRef<string | undefined>(undefined);

  // Composer text, seeded from any prior draft so it survives a remount.
  const [draft, setDraft] = useState(
    () => getSpawnHandover(placeholderId)?.draft ?? ""
  );
  const onDraftChange = useCallback(
    (value: string) => {
      setDraft(value);
      setSpawnDraft(placeholderId, value);
    },
    [placeholderId]
  );

  // Capture the code from the spawn-failed SSE (arrives immediately; the
  // list-row `failed` state is the poll-visible backstop for a lost SSE).
  useEffect(() => {
    const onSpawnFailed = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        sessionId?: string;
        code?: string;
      } | null;
      if (detail && detail.sessionId === placeholderId) {
        failureCodeRef.current = detail.code;
      }
    };
    window.addEventListener("hapi:spawnFailed", onSpawnFailed);
    return () => window.removeEventListener("hapi:spawnFailed", onSpawnFailed);
  }, [placeholderId]);

  // Swap: the real session appeared → hand the deferred properties + draft to
  // the real uuid, then navigate (replace) to it.
  useEffect(() => {
    if (settledRef.current || !realSession) return;
    settledRef.current = true;
    const realId = realSession.id;
    const handover = getSpawnHandover(placeholderId);
    void (async () => {
      try {
        if (handover?.emoji) {
          await api.updateSessionEmoji(realId, handover.emoji);
        }
        if (handover?.linkedIssue) {
          await api.updateSessionLinkedIssue(realId, handover.linkedIssue);
        }
        // R3: write the typed draft ONCE, under the real uuid — NEVER an empty
        // string (open #3636 forbids a second empty-string writer on this route)
        // and NEVER under the tag (the route resolves by uuid and 404s a tag).
        if (handover && handover.draft.trim().length > 0) {
          await api.updateSessionPromptDraft(realId, handover.draft);
        }
      } catch {
        // The session exists — never block the swap on a property write. Warn so
        // a lost emoji/draft is visible rather than silent.
        showToast("Session created — some details could not be applied.", {
          type: "warning",
        });
      }
      endSpawnHandover(placeholderId);
      void navigate({
        to: "/sessions/$sessionId",
        params: { sessionId: realId },
        replace: true,
      });
    })();
  }, [realSession, placeholderId, api, navigate, showToast]);

  // Failure: the placeholder flipped to `failed` → return to Create with a
  // code-specific toast and the form preserved for a single-click retry (R4).
  useEffect(() => {
    if (settledRef.current || placeholderState !== "failed") return;
    settledRef.current = true;
    const handover = getSpawnHandover(placeholderId);
    if (handover) stashRetryForm(handover.form);
    endSpawnHandover(placeholderId);
    if (failureCodeRef.current === "account_unrefreshable") {
      // Issue #4461 (R8): name the node and offer the re-login there.
      const { message, action } = buildReloginToast({
        nodeId: localNode?.nodeId ?? LOCAL_NODE_ID,
        nodeLabel: localNode?.nodeLabel ?? LOCAL_NODE_LABEL,
      });
      showToast(`Spawn failed — ${message}.`, { type: "error", action });
    } else {
      showToast(
        failureMessage(
          failureCodeRef.current,
          placeholder?.metadata?.summary?.text
        ),
        { type: "error" }
      );
    }
    onFailureBack();
  }, [
    placeholderState,
    placeholderId,
    placeholder,
    showToast,
    onFailureBack,
    localNode,
  ]);

  // ── Render ────────────────────────────────────────────────────────
  if (placeholderState === "failed" || realSession) {
    // A brief transitional frame — the effects above navigate away.
    return (
      <div className="flex flex-1 items-center justify-center p-4">
        <LoadingState
          label={realSession ? "Opening session…" : "Spawn failed — returning…"}
        />
      </div>
    );
  }

  const handoverEmoji = getSpawnHandover(placeholderId)?.emoji;
  const name =
    placeholder?.metadata?.name?.trim() ||
    getSpawnHandover(placeholderId)?.form.name?.trim() ||
    "New session";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2">
        {handoverEmoji ? (
          <span aria-hidden="true" className="text-lg">
            {handoverEmoji}
          </span>
        ) : null}
        <div className="min-w-0 flex-1 truncate font-semibold text-[var(--app-fg)]">
          {name}
        </div>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
        <LoadingState label="Starting your session…" spinnerSize="lg" />
        <p className="text-sm text-[var(--app-hint)]">
          You can type your first message below — it will be waiting when the
          session is ready.
        </p>
      </div>

      <div className="shrink-0 border-t border-[var(--app-divider)] bg-[var(--app-bg)] p-3">
        <textarea
          value={draft}
          onChange={e => onDraftChange(e.target.value)}
          rows={3}
          aria-label="First message"
          placeholder="Type your first message…"
          className="w-full resize-none rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 py-2 text-sm text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-1 focus:ring-[var(--app-accent)]"
        />
      </div>
    </div>
  );
}
