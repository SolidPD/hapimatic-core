// SPDX-License-Identifier: AGPL-3.0-only
import type { Attachment } from "@/lib/attachment-store";
import { BareButton } from "@/components/ui/BareButton";

/**
 * Compact, horizontally-scrollable strip of notes attachment chips (issue #1075,
 * Task 9). Each chip shows a file-type icon, the (truncated) name, a status badge
 * (uploading spinner / error warning), and an inline remove button. Renders
 * nothing when there are no attachments. Metadata-only — it never dereferences
 * `attachment.file`, so it works for both freshly-added and server-hydrated
 * attachments.
 */
export function NotesAttachmentChips(props: {
  attachments: Attachment[];
  onRemove: (id: string) => void;
  disabled?: boolean;
}) {
  const { attachments, onRemove, disabled = false } = props;
  if (attachments.length === 0) return null;

  return (
    <div
      className="flex gap-1.5 overflow-x-auto py-1"
      role="list"
      aria-label="Notes attachments"
    >
      {attachments.map(att => (
        <div
          key={att.id}
          role="listitem"
          className={
            /* design-tokens-allow: chip truncation max-width, no spacing token (L8 #3410) */ `flex flex-shrink-0 items-center gap-1 rounded-md border px-1.5 py-1 text-xs max-w-[140px] ${
              att.status === "error"
                ? "border-amber-500/40 bg-amber-500/10 text-amber-600"
                : "border-[var(--app-divider)] bg-[var(--app-secondary-bg)] text-[var(--app-fg)]"
            }`
          }
          title={att.error ? `${att.name} — ${att.error}` : att.name}
        >
          <ChipIcon status={att.status} name={att.name} />
          <span className="truncate">{att.name}</span>
          <BareButton
            type="button"
            onClick={() => onRemove(att.id)}
            disabled={disabled || att.status === "uploading"}
            className="flex-shrink-0 rounded-full p-0.5 text-[var(--app-hint)] hover:text-red-500 hover:bg-red-500/10 transition-colors focus-visible:ring-0 disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label={`Remove ${att.name}`}
            title="Remove"
          >
            <CloseGlyph />
          </BareButton>
        </div>
      ))}
    </div>
  );
}

function ChipIcon({ status, name }: { status: string; name: string }) {
  if (status === "uploading") {
    return (
      <svg
        className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-[var(--app-hint)]"
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </svg>
    );
  }
  if (status === "error") {
    return (
      <svg
        className="h-3.5 w-3.5 flex-shrink-0"
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    );
  }
  const isImage = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(name);
  if (isImage) {
    return (
      <svg
        className="h-3.5 w-3.5 flex-shrink-0 text-[var(--app-hint)]"
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <polyline points="21 15 16 10 5 21" />
      </svg>
    );
  }
  return (
    <svg
      className="h-3.5 w-3.5 flex-shrink-0 text-[var(--app-hint)]"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg
      className="h-3 w-3"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
