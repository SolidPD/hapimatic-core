// SPDX-License-Identifier: AGPL-3.0-only
import { useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ApiClient, OutputStyleInfo } from "@/api/client";
import { useOutputStyles } from "@/hooks/queries/useOutputStyles";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";

/**
 * Issue #2627 (Sub-Issue E, Task 6) — the Preferences output-style manager.
 *
 * Replaces the #2623 hardcoded three-built-in `<select>` (see the comment in
 * `preferences.tsx`) with the full `GET /api/output-styles` catalog, and adds
 * the upload / view / delete affordances for custom `.md` styles:
 *
 *  - **Default selector** — driven by the full catalog (built-ins + uploaded
 *    customs), wired to A's (#2623) server-authoritative `defaultOutputStyle`.
 *  - **Upload** — a `.md` file input; a rejection surfaces the server's
 *    `{ error, details }` inline. On success the catalog query is invalidated,
 *    so the uploaded style appears here AND in the Create-page dropdown (both
 *    read `useOutputStyles`).
 *  - **List + view + delete** — custom (deletable) styles render with a "View"
 *    (content modal) and "Delete" affordance. Deleting the current default
 *    reflects the server's degrade-to-`default` in the UI.
 *
 * #2624 (B): the `useDefaultOutputStyle` instance is LIFTED to the Preferences
 * page and threaded in as `defaultStyle`/`setDefaultStyle`, so the 🌐 inherit
 * toggle's re-adoption (`adopt`) updates the ONE hook instance this select
 * renders from. `headingAdornment` hosts that toggle next to the heading.
 */
export function OutputStyleManager({
  api,
  defaultStyle,
  setDefaultStyle,
  headingAdornment,
}: {
  api: ApiClient | null;
  defaultStyle: string;
  setDefaultStyle: (value: string) => void;
  headingAdornment?: ReactNode;
}) {
  const { styles } = useOutputStyles(api);
  const queryClient = useQueryClient();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [viewing, setViewing] = useState<OutputStyleInfo | null>(null);

  const customStyles = styles.filter(s => s.deletable);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset so re-selecting the same file re-fires onChange.
    e.target.value = "";
    if (!file || !api) return;
    setUploadError(null);
    setUploading(true);
    try {
      const result = await api.uploadOutputStyle(file);
      if (!result.success) {
        setUploadError(
          result.details ? `${result.error}: ${result.details}` : result.error
        );
        return;
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.outputStyles });
    } catch {
      setUploadError("Upload failed. Please try again.");
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(name: string) {
    if (!api) return;
    try {
      const res = await api.deleteOutputStyle(name);
      // The delete path degrades the default server-side; mirror it in the UI.
      if (res.defaultReset) setDefaultStyle("default");
      await queryClient.invalidateQueries({ queryKey: queryKeys.outputStyles });
    } catch {
      // Best-effort; a failed delete leaves the list unchanged.
    }
  }

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[length:var(--text-caption)] font-medium uppercase tracking-wide text-[var(--app-hint)]">
          Default Output Style
        </h2>
        {headingAdornment}
      </div>
      <select
        aria-label="Default Output Style"
        value={defaultStyle}
        onChange={e => setDefaultStyle(e.target.value)}
        className="self-start rounded-md bg-[var(--app-secondary-bg)] px-3 py-2 text-sm text-[var(--app-fg)]"
      >
        {styles.map(s => (
          <option key={s.name} value={s.name}>
            {s.name}
          </option>
        ))}
      </select>
      <p className="text-xs text-[var(--app-hint)]">
        The assistant output style pre-selected for new sessions. Upload your
        own below — a "Concise" style (frontmatter <code>name: Concise</code>)
        instructing final-answer-only prose is a good starter.
      </p>

      <div className="mt-1 flex flex-col gap-1">
        <label className="text-xs font-medium text-[var(--app-fg)]">
          Upload a custom style (.md)
        </label>
        <input
          ref={fileInputRef}
          type="file"
          accept=".md"
          aria-label="Upload output style"
          disabled={uploading || !api}
          onChange={handleUpload}
          className="text-xs text-[var(--app-hint)] file:mr-2 file:rounded-md file:border-0 file:bg-[var(--app-secondary-bg)] file:px-3 file:py-1.5 file:text-sm file:text-[var(--app-fg)]"
        />
        {uploadError && (
          <p role="alert" className="text-xs text-[var(--accent-red-500)]">
            {uploadError}
          </p>
        )}
      </div>

      {customStyles.length > 0 && (
        <ul className="mt-1 flex flex-col gap-1">
          {customStyles.map(s => (
            <li
              key={s.name}
              className="flex items-center gap-2 rounded-md bg-[var(--app-secondary-bg)] px-3 py-2"
            >
              <span className="min-w-0 flex-1">
                <span className="text-sm font-medium text-[var(--app-fg)]">
                  {s.name}
                </span>
                {s.description && (
                  <span className="ml-2 truncate text-xs text-[var(--app-hint)]">
                    {s.description}
                  </span>
                )}
              </span>
              <Button
                variant="ghost"
                type="button"
                onClick={() => setViewing(s)}
                className="h-auto rounded px-2 py-1 text-xs font-normal text-[var(--app-link)] hover:bg-white/10 hover:text-[var(--app-link)]"
              >
                View
              </Button>
              <Button
                variant="ghost"
                type="button"
                aria-label={`Delete ${s.name}`}
                onClick={() => handleDelete(s.name)}
                className="h-auto rounded px-2 py-1 text-xs font-normal text-[var(--accent-red-500)] hover:bg-white/10 hover:text-[var(--accent-red-500)]"
              >
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}

      {viewing && (
        <div
          role="dialog"
          aria-label={`${viewing.name} definition`}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setViewing(null)}
        >
          <div
            className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-[var(--app-bg)] p-4"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2">
              <h3 className="truncate text-sm font-bold text-[var(--app-fg)]">
                {viewing.name}
              </h3>
              <Button
                variant="ghost"
                size="icon"
                type="button"
                aria-label="Close"
                onClick={() => setViewing(null)}
                className="text-[var(--app-hint)] hover:bg-white/10 hover:text-[var(--app-hint)]"
              >
                ✕
              </Button>
            </div>
            <pre className="mt-2 overflow-auto whitespace-pre-wrap break-words text-xs text-[var(--app-fg)]">
              {viewing.content ?? ""}
            </pre>
          </div>
        </div>
      )}
    </section>
  );
}
