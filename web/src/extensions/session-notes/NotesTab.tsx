// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `NotesTab` — the session-detail tab contributed by `builtin.session-notes`
 * (issue #1284, Sub-Issue T of epic #1264).
 *
 * ## Why this component takes NO props (and reads the route instead)
 *
 * C's slot contract narrows `SessionDetailTabSpec.render` to a ZERO-PROP
 * `ComponentType` (`web/src/ext/slots.tsx`) — the host renders `<Render />` with
 * nothing passed. A slot component that needs context must therefore source it
 * itself. `useParams({ from: "/sessions/$sessionId" })` is the same call
 * `SessionPage` makes (`web/src/router.tsx:766`), so the value is identical to
 * what a prop would have carried.
 *
 * The trade-off is real and worth naming: this couples the extension to the
 * router's route SHAPE. If the session route path ever changes, this breaks at
 * typecheck (TanStack's `from` is a typed literal), not silently at runtime —
 * which is the acceptable failure mode. Widening the slot contract to pass a
 * session context is the follow-up that would remove the coupling.
 */
import { useState } from "react";
import { useParams } from "@tanstack/react-router";

import { useAppContext } from "@/lib/app-context";
import { SimpleMarkdown } from "@/components/SimpleMarkdown";
import {
  MAX_NOTE_LENGTH,
  useNoteActions,
  useNotes,
  type SessionNote,
} from "./hooks/useNotes";

/** Locale-stable timestamp for a note row. */
function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Zero-notes state. Kept in this file rather than a sibling: it is ~10 lines,
 * has exactly one consumer, and lives and dies with the tab's copy — extracting
 * it would add a file without removing any duplication.
 */
function EmptyState() {
  return (
    <div
      className="rounded-md border border-dashed border-[var(--app-border)] p-4 text-center text-sm text-[var(--app-hint)]"
      data-testid="session-notes-empty"
    >
      <p className="font-medium text-[var(--app-fg)]">No notes yet</p>
      <p className="mt-1">
        Add a note below to keep track of decisions, context, or follow-ups for
        this session.
      </p>
    </div>
  );
}

function NoteRow(props: {
  note: SessionNote;
  onSave: (content: string) => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.note.content);

  if (editing) {
    return (
      <li className="rounded-md border border-[var(--app-border)] p-2">
        <textarea
          autoCapitalize="none"
          className="w-full resize-y rounded-sm bg-[var(--app-subtle-bg)] p-2 text-sm text-[var(--app-fg)]"
          rows={3}
          maxLength={MAX_NOTE_LENGTH}
          value={draft}
          aria-label="Edit note"
          onChange={e => setDraft(e.target.value)}
        />
        <div className="mt-1.5 flex justify-end gap-2">
          <button
            type="button"
            className="text-xs text-[var(--app-hint)] hover:text-[var(--app-fg)]"
            onClick={() => {
              setDraft(props.note.content);
              setEditing(false);
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="text-xs font-medium text-accent disabled:opacity-50"
            disabled={props.busy || draft.trim().length === 0}
            onClick={() => {
              props.onSave(draft.trim());
              setEditing(false);
            }}
          >
            Save
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className="rounded-md border border-[var(--app-border)] p-2">
      <div className="text-sm text-[var(--app-fg)]">
        <SimpleMarkdown content={props.note.content} />
      </div>
      <div className="mt-1.5 flex items-center justify-between">
        <span className="text-xs text-[var(--app-hint)]">
          {formatTimestamp(props.note.createdAt)}
        </span>
        <span className="flex gap-2">
          <button
            type="button"
            className="text-xs text-[var(--app-hint)] hover:text-[var(--app-fg)]"
            onClick={() => setEditing(true)}
          >
            Edit
          </button>
          <button
            type="button"
            className="text-xs text-[var(--app-hint)] hover:text-[var(--app-fg)] disabled:opacity-50"
            disabled={props.busy}
            onClick={props.onDelete}
          >
            Delete
          </button>
        </span>
      </div>
    </li>
  );
}

export default function NotesTab() {
  const { sessionId } = useParams({ from: "/sessions/$sessionId" });
  const { api } = useAppContext();
  const { notes, isLoading, error } = useNotes(api, sessionId);
  const { create, update, remove } = useNoteActions(api, sessionId);
  const [draft, setDraft] = useState("");

  const busy = create.isPending || update.isPending || remove.isPending;

  return (
    <div className="flex flex-col gap-3 py-2" data-testid="session-notes-tab">
      {isLoading ? (
        <p className="text-sm text-[var(--app-hint)]">Loading notes…</p>
      ) : error ? (
        <p className="text-sm text-[var(--app-danger)]">{error}</p>
      ) : notes.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="flex flex-col gap-2">
          {notes.map(note => (
            <NoteRow
              key={note.id}
              note={note}
              busy={busy}
              onSave={content => update.mutate({ noteId: note.id, content })}
              onDelete={() => remove.mutate(note.id)}
            />
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-1.5">
        <textarea
          autoCapitalize="none"
          className="w-full resize-y rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-2 text-sm text-[var(--app-fg)]"
          rows={2}
          maxLength={MAX_NOTE_LENGTH}
          placeholder="Add a note…"
          aria-label="New note"
          value={draft}
          onChange={e => setDraft(e.target.value)}
        />
        <div className="flex justify-end">
          <button
            type="button"
            className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-[var(--app-accent-fg)] disabled:opacity-50"
            disabled={busy || draft.trim().length === 0}
            onClick={() => {
              create.mutate(draft.trim(), { onSuccess: () => setDraft("") });
            }}
          >
            Add note
          </button>
        </div>
      </div>
    </div>
  );
}
