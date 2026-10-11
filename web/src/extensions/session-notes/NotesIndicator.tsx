// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `NotesIndicator` — the session-detail info-field badge contributed by
 * `builtin.session-notes` (issue #1284, Sub-Issue T of epic #1264).
 *
 * Renders the current note count. Zero-prop for the same reason as `NotesTab` —
 * C's slot contract renders `<Render />` with no props — so it self-sources
 * `sessionId` from the route.
 *
 * ## Why it renders `null` at zero
 *
 * A "0" badge is noise: it occupies chrome to tell the user nothing is there,
 * on every session that has never used the feature (i.e. almost all of them).
 * Returning null keeps the info-field row clean until the feature is actually
 * in use, and matches the slot hosts' own convention of producing no DOM when a
 * slot is empty.
 *
 * It shares `sessionNotesKey(sessionId)` with `NotesTab`, so a mutation in the
 * tab invalidates one cache entry and both components re-render together — the
 * "CRUD works in real time" requirement, without an SSE round-trip.
 */
import { useParams } from "@tanstack/react-router";

import { useAppContext } from "@/lib/app-context";
import { useNotes } from "./hooks/useNotes";

export default function NotesIndicator() {
  const { sessionId } = useParams({ from: "/sessions/$sessionId" });
  const { api } = useAppContext();
  const { count } = useNotes(api, sessionId);

  if (count === 0) return null;

  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-[var(--app-subtle-bg)] px-2 py-0.5 text-xs text-[var(--app-hint)]"
      data-testid="session-notes-indicator"
      title={`${count} note${count === 1 ? "" : "s"} on this session`}
    >
      <span aria-hidden="true">📝</span>
      <span>{count}</span>
    </span>
  );
}
