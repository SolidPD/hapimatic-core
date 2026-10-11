// SPDX-License-Identifier: AGPL-3.0-only
/**
 * useModelSwitchVerification (issue #2455, R3 / AC3) — client-side optimistic
 * model-switch display with verify/revert.
 *
 * 🔴 The issue text says this is "built on `handleSessionAlive`" — but that
 * method is SERVER-SIDE (`server/src/sync/syncEngine.ts`, `sessionCache.ts`):
 * the server fires `isSessionModelDowngraded` and refreshes each client's
 * `session.resolvedModel` via a `session-updated` SSE → query invalidation. The
 * client has NO `handleSessionAlive`; the verify/revert is therefore a React
 * effect that WATCHES `resolvedModel`.
 *
 * Verification is a FAMILY-SUBSTRING match of the requested mode against the
 * full-ID `resolvedModel` (mirrors `isModelDowngraded`, `sessionHelpers.ts`).
 * 🔴 It deliberately does NOT use `deriveModelModeFromRaw`: that only matches
 * bare aliases and returns "default" for every FULL model ID (which is what
 * `resolvedModel` always is — e.g. "claude-opus-4-6"), so it would make every
 * successful family switch false-mismatch → revert + error toast.
 *
 * Guards (OR-3): only a CHANGED `resolvedModel` counts as evidence; an expected
 * mode of "default" is UNVERIFIABLE (never toast); and a safety timeout clears a
 * stuck pending optimistic state SILENTLY (never toast) for the "no next turn
 * yet" case — model switches are launcher-dependent (sdk = next-message,
 * tmux/pty = restart, #1633), so confirmation latency varies.
 */
import { useCallback, useEffect, useState } from "react";
import type { ModelMode } from "@hapi/protocol";

/** Silent give-up window for a pending optimistic switch (no confirming
 *  resolvedModel change arrives). Reverts the display to the real value WITHOUT
 *  a toast — absence of confirmation is not evidence of a mismatch (OR-3). */
export const MODEL_SWITCH_PENDING_TIMEOUT_MS = 60_000;

export type ModelFamily = "sonnet" | "opus" | "fable" | null;

/**
 * The model family a raw value belongs to, by case-insensitive substring —
 * mirrors the `isModelDowngraded` family check. Accepts a bare mode ("opus") or
 * a full ID ("claude-opus-4-6"). Returns null for "default" and any
 * unrecognized value (both unverifiable). Exported for #2456's pinned-version
 * (`rawModel`) verify, which needs the same family/ID comparison.
 */
export function modelFamilyOf(value: string | undefined | null): ModelFamily {
  const v = value?.toLowerCase() ?? "";
  if (v.includes("sonnet")) return "sonnet";
  if (v.includes("opus")) return "opus";
  if (v.includes("fable")) return "fable";
  return null;
}

/** The family an explicit ModelMode implies. "default" is unverifiable (null) —
 *  it maps to whatever the session resolves, so it can never mismatch. */
export function expectedFamilyForMode(mode: ModelMode): ModelFamily {
  return mode === "default" ? null : modelFamilyOf(mode);
}

type PendingSwitch = {
  expectedMode: ModelMode;
  /** `resolvedModel` at switch time — a change away from this is the evidence. */
  snapshotResolved: string | undefined;
};

export function useModelSwitchVerification(params: {
  resolvedModel?: string;
  /** Invoked once when a switch settles to a DIFFERENT family than requested.
   *  The caller shows an error toast; the displayed model reverts automatically
   *  (pendingMode clears → the caller falls back to the real resolvedModel). */
  onMismatch?: (realResolvedModel: string | undefined) => void;
}): {
  /** The optimistically-selected mode while a switch is in flight, else null.
   *  The caller shows this mode's label until verification settles. */
  pendingMode: ModelMode | null;
  /** Begin an optimistic switch: snapshot the current resolvedModel and mark
   *  `pendingMode`. The caller separately invokes the real `setModelMode`. */
  switchTo: (mode: ModelMode) => void;
  /** Issue #2768: clear a pending optimistic switch immediately (e.g. the
   *  mutation was rejected), reverting the display without waiting for the 60s
   *  silent timeout. */
  cancelSwitch: () => void;
} {
  const { resolvedModel, onMismatch } = params;
  const [pending, setPending] = useState<PendingSwitch | null>(null);

  const switchTo = useCallback(
    (mode: ModelMode) => {
      setPending({ expectedMode: mode, snapshotResolved: resolvedModel });
    },
    [resolvedModel]
  );

  // Verify/revert: fires when a NEW resolvedModel arrives while pending.
  useEffect(() => {
    if (!pending) return;
    // No change yet — keep waiting (never toast merely for lack of confirmation).
    if (resolvedModel === pending.snapshotResolved) return;
    const expectedFamily = expectedFamilyForMode(pending.expectedMode);
    // "default" is unverifiable — accept whatever it resolved to, silently.
    if (expectedFamily === null) {
      setPending(null);
      return;
    }
    if (modelFamilyOf(resolvedModel) === expectedFamily) {
      setPending(null); // success — resolved to the requested family
      return;
    }
    // Settled to a different family → revert (clear pending) + toast.
    setPending(null);
    onMismatch?.(resolvedModel);
  }, [pending, resolvedModel, onMismatch]);

  // Safety net: give up a stuck pending switch silently after the timeout.
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(
      () => setPending(null),
      MODEL_SWITCH_PENDING_TIMEOUT_MS
    );
    return () => clearTimeout(timer);
  }, [pending]);

  // Issue #2768: clear a pending switch immediately (e.g. the mutation was
  // rejected) so the display reverts now rather than after the silent timeout.
  const cancelSwitch = useCallback(() => setPending(null), []);

  return {
    pendingMode: pending?.expectedMode ?? null,
    switchTo,
    cancelSwitch,
  };
}
