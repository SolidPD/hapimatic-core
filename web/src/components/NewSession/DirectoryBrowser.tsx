// SPDX-License-Identifier: AGPL-3.0-only
import {
  useState,
  useEffect,
  useCallback,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { ApiError, type ApiClient } from "@/api/client";
import type { DirectoryEntry } from "@/types/api";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { BareButton } from "@/components/ui/BareButton";
import { useVisualViewportHeight } from "@/hooks/useVisualViewportHeight";

// The Directory browser's "Select" confirm button paints dark text on the mint
// `--app-link` fill. That on-mint text color (#06231a, a dark green) has NO exact
// design token — the `Button` `accent` variant's `--app-button-text` (#111827) is a
// visibly different blue-gray — so the exact hex is preserved verbatim to keep the
// button pixel-identical (design-system migration #3403 R4 fidelity-trap exception).
const SELECT_ON_ACCENT_TEXT = "text-[#06231a]"; // design-tokens-allow: on-mint confirm-button text has no exact token (≠ --app-button-text); preserve exact color per #3403 R4

type DirectoryBrowserProps = {
  api: ApiClient;
  machineId?: string | null;
  nodeId?: string | null;
  initialPath: string;
  /** Recently-used directories for this target — shown in the path-bar dropdown. */
  recentPaths?: readonly string[];
  /** Remove a path from the recent list (parent's optimistic delete). */
  onRemoveRecentPath?: (path: string) => void;
  onSelect: (path: string) => void;
  onClose: () => void;
};

/**
 * Turn a raw fs-list failure (possibly a double-encoded federation proxy body
 * like `HTTP 502 : {"message":"Node returned 500: {\"message\":\"ENOENT:
 * scandir '/home/matt'\"}"}`) into a human-readable line.
 */
function humanizeFsError(raw: string): string {
  if (raw.includes("ENOENT")) {
    const m = raw.match(/scandir '([^']+)'/);
    return m
      ? `Directory not found: ${m[1]}`
      : "Directory not found on this machine";
  }
  // issue #3498 R5: create-directory error codes (the federation path arrives
  // double-encoded through the 502 proxy, so match on the raw code substrings).
  if (raw.includes("EEXIST")) return "A folder with that name already exists";
  if (raw.includes("Access denied") || raw.includes("restricted"))
    return "This location is restricted";
  if (raw.includes("ENOSPC")) return "No space left on the device";
  if (raw.includes("EROFS")) return "This location is read-only";
  if (raw.includes("EACCES")) return "Permission denied";
  if (raw.includes("ENOTDIR")) return "Not a directory";
  return raw;
}

/**
 * Turn a create-directory failure into a human-readable inline message
 * (issue #3498). The machine route returns clean, client-branchable statuses
 * (403 restricted, 409 exists); the federation node route flattens the peer
 * error to 502 with a double-encoded body that `humanizeFsError` parses.
 */
function createDirErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 409) return "A folder with that name already exists";
    if (e.status === 403) return "This location is restricted";
    return humanizeFsError(e.body ?? e.message);
  }
  return humanizeFsError(
    e instanceof Error ? e.message : "Failed to create directory"
  );
}

/**
 * Client-side new-folder name validation (issue #3498 R5), mirroring the #2715
 * pattern (empty / `.` / `..` / `/`) plus `\`, NUL and the 255-char cap. The
 * server Zod schema + daemon guard are the authoritative copy; this is a fast
 * inline check for the single NAME the inline row collects.
 */
function validateFolderName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "Enter a folder name";
  if (trimmed === "." || trimmed === "..") return "Invalid folder name";
  if (trimmed.includes("/") || trimmed.includes("\\"))
    return "Folder names can't contain slashes";
  if (trimmed.includes("\0")) return "Invalid folder name";
  if (trimmed.length > 255) return "Folder name is too long";
  return null;
}

/**
 * Renders a filesystem path with HEAD truncation — the identifying tail is
 * preserved and the ellipsis sits at the start (`…/projects/name`). #2412 D4/R5.
 *
 * Technique: an rtl clipping container puts `text-overflow: ellipsis` at the
 * visual-left (head), while an inner ltr + `unicode-bidi: plaintext` span stops
 * the path's own characters (notably the leading `/`) from being bidi-reordered
 * (which would otherwise flip the ellipsis back to the tail). Used uniformly by
 * the path-field display overlay, every recents row, and the footer current-path
 * so the three can never drift apart.
 */
function TailTruncatedPath({
  path,
  className,
  title,
}: {
  path: string;
  className?: string;
  title?: string;
}) {
  return (
    <span
      dir="rtl"
      title={title}
      className={`block truncate text-left ${className ?? ""}`}
    >
      <span dir="ltr" style={{ unicodeBidi: "plaintext" }}>
        {path}
      </span>
    </span>
  );
}

/**
 * Ubuntu-style directory browser, presented as an ~80% centered modal over a
 * dimmed create page (NOT full-screen). Sticky header (title row + full-width
 * path field) and sticky footer (Cancel/Select) never scroll; only the folder
 * list scrolls. Sized to 80% of the iOS *visual* viewport so it can't overflow.
 *
 * Picker-first (#2412): the path field is readOnly by default — tapping it opens
 * the in-flow Recents panel with NO iOS keyboard. An edit button (pencil-on-paper)
 * at the right end of the path field toggles true edit mode (type an exact path +
 * Enter to jump) — a pencil, not a keyboard glyph, because the keyboard glyph reads
 * as "this summons the software keyboard", the exact opposite of picker-first intent.
 * Each recent entry has an ✕ to remove it (with a confirmation dialog). Long paths
 * truncate on the head, preserving the identifying tail (`…/projects/name`).
 */
export function DirectoryBrowser({
  api,
  machineId,
  nodeId,
  initialPath,
  recentPaths = [],
  onRemoveRecentPath,
  onSelect,
  onClose,
}: DirectoryBrowserProps) {
  const [currentPath, setCurrentPath] = useState(initialPath || "/");
  // The editable path-field text. Tracks `currentPath` after each successful
  // navigation, but diverges freely while the user is typing an exact path.
  const [pathInput, setPathInput] = useState(initialPath || "/");
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Set when the INITIAL path didn't exist on the target machine/node and the
  // browser recovered by walking up to the nearest existing ancestor (the
  // remote-node case: a hub-seeded path like /home/matt need not exist on a
  // federation VM — MS1 trigger, 2026-08-01).
  const [notice, setNotice] = useState<string | null>(null);
  const [showRecent, setShowRecent] = useState(false);
  // Picker-first (#2412 D1/R1-R2): the path field is readOnly by default, so a
  // tap opens Recents with NO iOS keyboard. The path field's trailing edit button
  // flips `editMode` to make it a true editable input. `inputRef` lets that toggle
  // imperatively clear `readOnly` BEFORE `focus()` — WebKit decides keyboard
  // visibility at focus time, and React 19 batches the state update.
  const [editMode, setEditMode] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );
  const vvHeight = useVisualViewportHeight();
  // Per-session cache of visited directories. `/mnt/netshare` is a CIFS
  // `cache=none` mount whose listings can take several seconds per call (measured
  // 6.5s for /mnt/netshare/git vs 13ms for a local dir), so serving a revisited
  // directory from cache makes back-and-forth navigation feel instant.
  const cacheRef = useRef<Map<string, DirectoryEntry[]>>(new Map());

  // issue #3498: inline "New folder" editor row (R1) — open flag, the typed
  // name, a busy flag (disables Create during the request), and an inline error
  // rendered on the row itself.
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderBusy, setNewFolderBusy] = useState(false);
  const [newFolderError, setNewFolderError] = useState<string | null>(null);
  // issue #3498: typed-path "Create & select" (R2) — the full typed path that
  // does not exist yet (a walk-to-ancestor landed at `currentPath`). When set,
  // the dashed create-and-select notice renders in place of the recovery notice.
  const [createSelectTarget, setCreateSelectTarget] = useState<string | null>(
    null
  );

  const loadDirectory = useCallback(
    async (
      path: string,
      recoverFrom?: string,
      // issue #3498 (R2): `typedProbe` marks an edit-mode Enter on a typed path.
      // When such a probe walks to an ancestor (the typed path doesn't exist),
      // set `createSelectTarget` (offer "Create & select") instead of the plain
      // recovery notice used for a mount-time seeded path.
      opts?: { typedProbe?: boolean }
    ): Promise<void> => {
      const target = path.trim() || "/";
      const cached = cacheRef.current.get(target);
      if (cached) {
        setEntries(cached);
        setCurrentPath(target);
        setPathInput(target);
        setError(null);
        setIsLoading(false);
        // A typed-path probe can WALK onto a cached ancestor (the nearest
        // existing folder was visited earlier), so the create-select decision
        // must be made here too — not only in the fresh-fetch branch below —
        // or "Create & select" would never appear for a cached ancestor.
        if (recoverFrom && recoverFrom !== target) {
          if (opts?.typedProbe) {
            setCreateSelectTarget(recoverFrom);
            setNotice(null);
          } else {
            setNotice(
              `${recoverFrom} doesn't exist on this machine — showing the nearest existing folder`
            );
            setCreateSelectTarget(null);
          }
        } else {
          setNotice(null);
          setCreateSelectTarget(null);
        }
        return;
      }
      setIsLoading(true);
      setError(null);
      try {
        const result = nodeId
          ? await api.listNodeDirectory(nodeId, target)
          : machineId
            ? await api.listMachineDirectory(machineId, target)
            : [];
        cacheRef.current.set(target, result);
        setEntries(result);
        setCurrentPath(target);
        setPathInput(target);
        if (recoverFrom && recoverFrom !== target) {
          if (opts?.typedProbe) {
            // Typed path doesn't exist; landed at `target` (nearest ancestor).
            setCreateSelectTarget(recoverFrom);
            setNotice(null);
          } else {
            setNotice(
              `${recoverFrom} doesn't exist on this machine — showing the nearest existing folder`
            );
            setCreateSelectTarget(null);
          }
        } else {
          setNotice(null);
          setCreateSelectTarget(null);
        }
        setIsLoading(false);
      } catch (e) {
        const raw = e instanceof Error ? e.message : "Failed to load directory";
        // Recovery walk (initial load or a typed-path probe): a path seeded from
        // another machine's context — or a path the user just typed — may not
        // exist here; land at the nearest existing ancestor instead of
        // dead-ending on an error screen. isLoading stays true through the walk
        // (no finally: it would flip the flag off as soon as the recursive
        // promise is RETURNED).
        if (recoverFrom && target !== "/") {
          const parent = target.split("/").slice(0, -1).join("/") || "/";
          return loadDirectory(parent, recoverFrom, opts);
        }
        setError(humanizeFsError(raw));
        setIsLoading(false);
      }
    },
    [api, machineId, nodeId]
  );

  useEffect(() => {
    void loadDirectory(currentPath, currentPath);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => clearTimeout(blurTimer.current), []);

  // Escape (no radix Dialog here — custom overlay): while editing the path,
  // first press exits edit mode back to picker-first; a second press — or Escape
  // when already picker-first — closes the dialog. #2412 open-risk decision.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // #3506: yield to a layered dismissable surface. Radix DismissableLayer marks
      // the event (preventDefault) when a topmost layer — the "Up one directory"
      // tooltip, or the ConfirmDialog below — has already consumed Escape; without
      // this guard the custom overlay would still close on top of that dismissal.
      // Keep this GENERIC defaultPrevented check even though `pendingRemove` also
      // gates the confirm dialog: it is what covers the Radix Dialog case, so do not
      // "simplify" it away thinking the state check suffices.
      if (e.defaultPrevented) return;
      if (e.key !== "Escape" || pendingRemove !== null) return;
      // issue #3498: an Escape reaching the document while the inline "New
      // folder" row is open cancels the row (mirrors the pendingRemove guard) —
      // it must NEVER close the whole browser. The row's own onKeyDown stops
      // propagation, so this is the belt-and-suspenders path for a focus drift
      // off the name input.
      if (newFolderOpen) {
        setNewFolderOpen(false);
        setNewFolderName("");
        setNewFolderError(null);
        return;
      }
      if (editMode) {
        setEditMode(false);
        inputRef.current?.blur();
        return;
      }
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, pendingRemove, editMode, newFolderOpen]);

  const handleNavigateUp = useCallback(() => {
    if (currentPath === "/") return;
    const parentPath = currentPath.split("/").slice(0, -1).join("/") || "/";
    void loadDirectory(parentPath);
  }, [currentPath, loadDirectory]);

  const handleEntryClick = useCallback(
    (entry: DirectoryEntry) => {
      if (entry.type !== "directory") return;
      const newPath =
        currentPath === "/" ? `/${entry.name}` : `${currentPath}/${entry.name}`;
      void loadDirectory(newPath);
    },
    [currentPath, loadDirectory]
  );

  const handleSelect = useCallback(() => {
    onSelect(currentPath);
    onClose();
  }, [currentPath, onSelect, onClose]);

  // Edit-button TOGGLE (#2412 D1/R2). Handled on pointerdown with
  // preventDefault so the input's blur never fires — that is what lets a re-tap
  // reliably EXIT edit mode (otherwise blur resets `editMode` before the click,
  // so a click-time toggle would just re-enter and the button could never close).
  // Entering edit mode runs the iOS-critical sequence INSIDE the gesture: clear
  // `readOnly` on the DOM node FIRST, then `focus()`. React 19 batches the
  // `setEditMode` state update, so focusing a still-readOnly input would show NO
  // keyboard on iOS (WebKit decides keyboard visibility at focus() time).
  const handleToggleEdit = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      const el = inputRef.current;
      if (editMode) {
        setEditMode(false);
        el?.blur();
      } else {
        if (el) {
          el.readOnly = false;
          el.focus();
        }
        setEditMode(true);
      }
    },
    [editMode]
  );

  // issue #3498 (R1): inline "New folder" row controls.
  const cancelNewFolder = useCallback(() => {
    setNewFolderOpen(false);
    setNewFolderName("");
    setNewFolderError(null);
  }, []);

  const handleToggleNewFolder = useCallback(() => {
    setNewFolderOpen(prev => {
      if (prev) {
        setNewFolderName("");
        setNewFolderError(null);
      }
      return !prev;
    });
  }, []);

  const handleCreateNewFolder = useCallback(async () => {
    const name = newFolderName.trim();
    const nameError = validateFolderName(name);
    if (nameError) {
      setNewFolderError(nameError);
      return;
    }
    const newPath = currentPath === "/" ? `/${name}` : `${currentPath}/${name}`;
    setNewFolderBusy(true);
    setNewFolderError(null);
    try {
      // recursive:false — the parent (currentPath) exists by construction, so an
      // existing folder surfaces as EEXIST → inline error, nothing created.
      if (nodeId) {
        await api.createNodeDirectory(nodeId, newPath, false);
      } else if (machineId) {
        await api.createMachineDirectory(machineId, newPath, false);
      } else {
        throw new Error("No target machine or node");
      }
      // Invalidate the parent listing BEFORE navigating in: loadDirectory is
      // cache-first with no refresh mode, so "Up" after create would otherwise
      // serve the stale parent WITHOUT the new folder (#3498 R4).
      cacheRef.current.delete(currentPath);
      setNewFolderOpen(false);
      setNewFolderName("");
      await loadDirectory(newPath);
    } catch (e) {
      setNewFolderError(createDirErrorMessage(e));
    } finally {
      setNewFolderBusy(false);
    }
  }, [newFolderName, currentPath, nodeId, machineId, api, loadDirectory]);

  const handleNewFolderKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      // Mark BOTH keys so they never bubble to the path field's Enter-to-jump or
      // the document Escape listener (which would close the whole browser).
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        void handleCreateNewFolder();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancelNewFolder();
      }
    },
    [handleCreateNewFolder, cancelNewFolder]
  );

  // issue #3498 (R2): create every missing segment of the typed path and select
  // it (recursive:true = mkdir -p). The notice only appears when the path does
  // NOT exist, so a silent success on an existing directory cannot bite here.
  const handleCreateAndSelect = useCallback(async () => {
    if (!createSelectTarget) return;
    setNewFolderBusy(true);
    try {
      if (nodeId) {
        await api.createNodeDirectory(nodeId, createSelectTarget, true);
      } else if (machineId) {
        await api.createMachineDirectory(machineId, createSelectTarget, true);
      } else {
        throw new Error("No target machine or node");
      }
      // Every ancestor between the landed dir and the new leaf is now stale.
      cacheRef.current.clear();
      onSelect(createSelectTarget);
      onClose();
    } catch (e) {
      setNotice(createDirErrorMessage(e));
      setCreateSelectTarget(null);
    } finally {
      setNewFolderBusy(false);
    }
  }, [createSelectTarget, nodeId, machineId, api, onSelect, onClose]);

  const directories = entries.filter(e => e.type === "directory");

  // issue #3498: preview path for the inline row helper + the relative segment
  // shown in the "Create & select" notice.
  const newFolderTrimmed = newFolderName.trim();
  const newFolderPreviewPath =
    currentPath === "/"
      ? `/${newFolderTrimmed}`
      : `${currentPath}/${newFolderTrimmed}`;
  const createSelectRelative = createSelectTarget
    ? currentPath === "/"
      ? createSelectTarget.replace(/^\//, "")
      : createSelectTarget.startsWith(`${currentPath}/`)
        ? createSelectTarget.slice(currentPath.length + 1)
        : createSelectTarget
    : "";

  // iOS-WebKit fix (#2019): render through a portal to `document.body` so the
  // `fixed inset-0` overlay escapes the Create-form's `overflow-y-auto` accordion
  // scroll container. iOS Safari anchors `position: fixed` descendants of a
  // scrolling container to that container (not the viewport), which confined this
  // modal to the accordion region — the bug the user saw (header above + buttons
  // below stayed visible/undimmed). Portaling to body makes `fixed` resolve
  // against the true viewport on every engine. Matches the `createPortal`
  // convention used by FullscreenPromptEditorModal / SessionNotesEditorModal.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      // Close ONLY on a genuine backdrop click. React synthetic events bubble
      // through the React tree, not the DOM tree, so the portaled ConfirmDialog
      // (a React child of this backdrop) would otherwise bubble its Cancel/Remove
      // clicks up here and close the whole browser — the "two steps back" a
      // recent-remove Cancel showed. #2412 user-reported.
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex w-full max-w-md flex-col overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] shadow-2xl"
        style={{ height: Math.round(vvHeight * 0.8) }}
        onClick={e => e.stopPropagation()}
      >
        {/* ── Sticky header: variant-C title row + full-width path field ── */}
        <div className="shrink-0 border-b border-[var(--app-divider)]">
          {/* Title row: [up] Browse Directory … [keyboard toggle] [close] (D5) */}
          <div className="flex items-center justify-between gap-2 px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <BareButton
                type="button"
                onClick={handleNavigateUp}
                disabled={currentPath === "/"}
                aria-label="Up one directory"
                title="Up one directory"
                className="shrink-0 rounded-md p-1 text-[var(--app-hint)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-fg)] disabled:opacity-40"
              >
                <svg
                  className="h-4 w-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M9 14l-4-4 4-4" />
                  <path d="M5 10h11a4 4 0 0 1 0 8h-1" />
                </svg>
              </BareButton>
              <span className="text-sm font-medium text-[var(--app-fg)]">
                Browse Directory
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                onClick={onClose}
                aria-label="Close"
                className="h-auto rounded-md p-1"
              >
                <svg
                  className="h-4 w-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </Button>
            </div>
          </div>
          {/* Path field on its own full-width row (D5). The input stays MOUNTED
              at all times — it is the tappable/focusable picker surface (readOnly
              suppresses the keyboard; a tap still focuses → opens Recents). When
              picker-first, a pointer-events-none overlay renders the tail-
              truncated path and the input's own text is hidden. */}
          <div className="px-3 pb-2">
            <div className="relative">
              <input
                ref={inputRef}
                type="text"
                value={pathInput}
                readOnly={!editMode}
                inputMode={editMode ? "text" : "none"}
                placeholder="/path/to/directory"
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                onChange={e => setPathInput(e.target.value)}
                onFocus={() => {
                  clearTimeout(blurTimer.current);
                  setShowRecent(true);
                }}
                // Re-open Recents on EVERY tap, not just the focus transition.
                // Selecting a recent keeps the field focused (the row's
                // onMouseDown preventDefault suppresses blur) while hiding the
                // panel, so a second tap fires NO onFocus — without this onClick
                // the menu would never come back. #2412 user-reported.
                onClick={() => {
                  clearTimeout(blurTimer.current);
                  setShowRecent(true);
                }}
                onBlur={() => {
                  setEditMode(false);
                  blurTimer.current = setTimeout(
                    () => setShowRecent(false),
                    150
                  );
                }}
                onKeyDown={e => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    setShowRecent(false);
                    setEditMode(false);
                    // issue #3498 (R2): probe the typed path with the recovery
                    // walk enabled — a nonexistent path lands at the nearest
                    // ancestor and offers "Create & select" (createSelectTarget).
                    void loadDirectory(pathInput, pathInput, {
                      typedProbe: true,
                    });
                    e.currentTarget.blur();
                  }
                }}
                // 11px mono (variant C / D5). iOS zoom-on-focus is disabled
                // app-wide (viewport meta), so 11px needs no 16px anti-zoom hack.
                // Text/caret are transparent in picker mode so only the tail-
                // truncation overlay shows; edit mode restores the real LTR text.
                // pr-9 leaves room for the trailing edit button so neither the
                // typed text nor the tail-truncation overlay renders under it.
                className={`h-9 w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] pl-2.5 pr-16 font-mono text-[length:var(--text-caption)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)] ${
                  editMode
                    ? "text-[var(--app-fg)]"
                    : "text-transparent caret-transparent"
                }`}
              />
              {!editMode && (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-0 left-0 right-16 flex items-center pl-2.5"
                >
                  <TailTruncatedPath
                    path={pathInput}
                    className="w-full min-w-0 font-mono text-[length:var(--text-caption)] text-[var(--app-fg)]"
                  />
                </div>
              )}
              {/* New-folder affordance (#3498) — a FolderPlus icon beside the
                  pencil. Opens the inline editor row at the top of the folder
                  list. onClick (not onPointerDown): unlike the pencil it doesn't
                  need to survive the input's blur, and a plain click keeps focus
                  handling simple. */}
              <Button
                type="button"
                variant="ghost"
                onClick={handleToggleNewFolder}
                aria-label="New folder"
                aria-pressed={newFolderOpen}
                title="New folder"
                disabled={isLoading || error !== null}
                className={`absolute right-9 top-1/2 h-auto -translate-y-1/2 rounded-md p-1 transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-fg)] disabled:opacity-40 ${
                  newFolderOpen
                    ? "bg-[var(--app-hover)] text-[var(--app-link)]"
                    : "text-[var(--app-hint)]"
                }`}
              >
                <svg
                  className="h-4 w-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
                  <path d="M12 10v6" />
                  <path d="M9 13h6" />
                </svg>
              </Button>
              {/* Trailing edit affordance (pencil-on-paper). A pencil — not a
                  keyboard glyph — signals "you can type here" without implying the
                  software keyboard will pop, which is the whole point of
                  picker-first. Toggles true edit mode via the same pointerdown
                  handler the old title-row button used. */}
              <Button
                type="button"
                variant="ghost"
                onPointerDown={handleToggleEdit}
                aria-label="Edit path"
                aria-pressed={editMode}
                title={editMode ? "Done editing" : "Edit path"}
                className={`absolute right-1 top-1/2 h-auto -translate-y-1/2 rounded-md p-1 transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-fg)] ${
                  editMode
                    ? "bg-[var(--app-hover)] text-[var(--app-link)]"
                    : "text-[var(--app-hint)]"
                }`}
              >
                <svg
                  className="h-4 w-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                </svg>
              </Button>
            </div>
          </div>
        </div>

        {/* ── Recents: in-flow panel (D2/R3), NOT an absolute overlay. Lives
            OUTSIDE the sticky header's shrink-0 subtree and ABOVE the folder
            list, so showing it pushes the folder list down instead of floating
            over it (where the iOS keyboard used to clip it). Row text insets at
            10px (px-2.5) to match the field text exactly (D3/R4). ── */}
        {showRecent && recentPaths.length > 0 && (
          <ul className="mx-3 mb-2 max-h-52 shrink-0 overflow-y-auto rounded-md border border-white/60 bg-[var(--app-surface)] shadow-xl">
            <li className="px-2.5 py-1 text-[length:var(--text-caption-xs)] font-medium uppercase tracking-wide text-[var(--app-hint)]">
              Recent
            </li>
            {recentPaths.map(p => (
              <li
                key={p}
                className="flex items-center border-t border-[var(--app-divider)]"
              >
                <Button
                  type="button"
                  variant="ghost"
                  title={p}
                  onMouseDown={e => {
                    e.preventDefault();
                    setShowRecent(false);
                    setPathInput(p);
                    void loadDirectory(p);
                  }}
                  className="h-auto w-full min-w-0 flex-1 justify-start rounded-none px-2.5 py-2 text-left font-normal hover:bg-[var(--app-hover)]"
                >
                  <TailTruncatedPath
                    path={p}
                    // 11px mono to match the path field above (D3/R4 + user
                    // feedback): recents rows and the field now read as one size.
                    className="min-w-0 flex-1 font-mono text-[length:var(--text-caption)] text-[var(--app-fg)]"
                  />
                </Button>
                {onRemoveRecentPath && (
                  <Button
                    type="button"
                    variant="ghost"
                    aria-label={`Remove ${p} from recent`}
                    title="Remove from recent"
                    onMouseDown={e => {
                      e.preventDefault();
                      setPendingRemove(p);
                    }}
                    className="h-auto shrink-0 rounded p-2"
                  >
                    <svg
                      className="h-3.5 w-3.5"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M18 6 6 18M6 6l12 12" />
                    </svg>
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        {/* A3 (#2412): empty-state hint so a tap on the picker-first field is
            never a dead blank — it explains how Recents get populated (A2 records
            a directory when you Select it). Gated on the same `showRecent` focus
            flag as the populated panel, and mutually exclusive with it. */}
        {showRecent && recentPaths.length === 0 && (
          <div className="mx-3 mb-2 shrink-0 rounded-md border border-dashed border-white/60 bg-[var(--app-surface)] px-2.5 py-3 text-center text-[length:var(--text-caption)] leading-snug text-[var(--app-hint)]">
            No recent directories yet — folders you Select here will appear in
            this list next time.
          </div>
        )}

        {/* Recovery notice: the seeded path didn't exist on this target and
            the browser landed at the nearest existing ancestor instead. */}
        {notice && (
          <div className="mx-3 mb-1 shrink-0 rounded-md border border-amber-400/30 bg-amber-400/10 px-2.5 py-1.5 text-[length:var(--text-caption)] leading-snug text-amber-300/90">
            {notice}
          </div>
        )}

        {/* Create-and-select notice (#3498 R2): the typed path doesn't exist
            yet; offer to create every missing segment (mkdir -p) and select it. */}
        {createSelectTarget && (
          <div className="mx-3 mb-1 flex shrink-0 items-center justify-between gap-2 rounded-md border border-dashed border-[var(--app-link)] bg-[var(--app-surface)] px-2.5 py-1.5">
            <div className="min-w-0 text-[length:var(--text-caption)] leading-snug text-[var(--app-hint)]">
              <span className="font-medium text-[var(--app-fg)]">
                {createSelectRelative}
              </span>{" "}
              doesn&apos;t exist yet under {currentPath}.
            </div>
            <Button
              type="button"
              variant="ghost"
              onClick={() => void handleCreateAndSelect()}
              disabled={newFolderBusy}
              className="h-auto shrink-0 whitespace-nowrap rounded-md border border-[var(--app-link)] px-2 py-1 text-[length:var(--text-caption)] font-medium text-[var(--app-link)] transition-colors hover:bg-[var(--app-hover)] disabled:opacity-50"
            >
              {newFolderBusy ? "Creating…" : "Create & select"}
            </Button>
          </div>
        )}

        {/* ── Scrollable folder list (the only scroll region) ── */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="flex h-full items-center justify-center py-8">
              <div className="text-sm text-[var(--app-hint)]">Loading...</div>
            </div>
          ) : error ? (
            <div className="flex h-full items-center justify-center px-4 py-8">
              <div className="text-center text-sm text-red-500">{error}</div>
            </div>
          ) : (
            <div className="divide-y divide-[var(--app-divider)]">
              {/* Inline "New folder" editor row (#3498 R1) at the top of the
                  list: folder icon · autofocused name input · Create · Cancel ·
                  helper/error line. Keys are marked in handleNewFolderKeyDown so
                  Esc cancels the row (never closing the browser) and Enter never
                  reaches the path field's Enter-to-jump. */}
              {newFolderOpen && (
                <div className="px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <svg
                      className="h-5 w-5 shrink-0 text-[var(--app-link)]"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
                      <path d="M12 10v6" />
                      <path d="M9 13h6" />
                    </svg>
                    <input
                      type="text"
                      value={newFolderName}
                      autoFocus
                      placeholder="Folder name"
                      aria-label="New folder name"
                      spellCheck={false}
                      autoCapitalize="none"
                      autoCorrect="off"
                      disabled={newFolderBusy}
                      onChange={e => {
                        setNewFolderName(e.target.value);
                        setNewFolderError(null);
                      }}
                      onKeyDown={handleNewFolderKeyDown}
                      className="min-w-0 flex-1 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 font-mono text-[length:var(--text-caption)] text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)]"
                    />
                    <Button
                      type="button"
                      variant="accent"
                      onClick={() => void handleCreateNewFolder()}
                      disabled={newFolderBusy || newFolderTrimmed === ""}
                      className={`h-auto shrink-0 px-3 py-1 text-sm ${SELECT_ON_ACCENT_TEXT}`}
                    >
                      {newFolderBusy ? "Creating…" : "Create"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={cancelNewFolder}
                      disabled={newFolderBusy}
                      className="h-auto shrink-0 px-2 py-1 text-sm font-normal text-[var(--app-fg)] hover:bg-[var(--app-hover)]"
                    >
                      Cancel
                    </Button>
                  </div>
                  {newFolderError ? (
                    <div className="mt-1 pl-7 text-[length:var(--text-caption)] text-red-500">
                      {newFolderError}
                    </div>
                  ) : (
                    <div className="mt-1 pl-7 text-[length:var(--text-caption)] leading-snug text-[var(--app-hint)]">
                      Creates{" "}
                      <span className="font-medium text-[var(--app-fg)]">
                        {newFolderPreviewPath}
                      </span>{" "}
                      and opens it · Enter to create, Esc to cancel
                    </div>
                  )}
                </div>
              )}
              {directories.map(entry => (
                <Button
                  key={entry.name}
                  type="button"
                  variant="ghost"
                  onClick={() => handleEntryClick(entry)}
                  className="flex h-auto w-full items-center justify-start gap-3 rounded-none px-3 py-2.5 text-left font-normal transition-colors hover:bg-[var(--app-hover)]"
                >
                  <svg
                    className="h-5 w-5 shrink-0 text-[var(--app-hint)]"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                  </svg>
                  <span className="truncate text-sm text-[var(--app-fg)]">
                    {entry.name}
                  </span>
                </Button>
              ))}

              {directories.length === 0 && !isLoading && (
                <div className="px-4 py-8 text-center text-sm text-[var(--app-hint)]">
                  No subdirectories
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Sticky footer: current target + actions ── */}
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-[var(--app-divider)] px-3 py-2">
          <TailTruncatedPath
            path={currentPath}
            title={currentPath}
            className="min-w-0 flex-1 font-mono text-[length:var(--text-caption)] text-[var(--app-hint)]"
          />
          <div className="flex shrink-0 gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              className="h-auto rounded-md px-4 py-2 text-sm font-normal text-[var(--app-fg)] transition-colors hover:bg-[var(--app-hover)]"
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="accent"
              onClick={handleSelect}
              disabled={isLoading}
              className={`h-auto ${SELECT_ON_ACCENT_TEXT} transition-opacity`}
            >
              Select
            </Button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        isOpen={pendingRemove !== null}
        onClose={() => setPendingRemove(null)}
        title="Remove recent path"
        description={`Remove "${pendingRemove ?? ""}" from your recent directories?`}
        confirmLabel="Remove"
        confirmingLabel="Removing..."
        onConfirm={async () => {
          if (pendingRemove) onRemoveRecentPath?.(pendingRemove);
        }}
        isPending={false}
        destructive
      />
    </div>,
    document.body
  );
}
