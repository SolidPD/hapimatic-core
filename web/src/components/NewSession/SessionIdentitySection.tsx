// SPDX-License-Identifier: AGPL-3.0-only
import { validateSessionName, SESSION_NAME_MAX_LENGTH } from "@hapi/protocol";
import { EmojiPickerPopover } from "@/components/EmojiPickerPopover";
import { FormField } from "./FormField";
import { BareButton } from "@/components/ui/BareButton";

type SessionIdentitySectionProps = {
  emoji: string | null;
  name: string;
  isDisabled: boolean;
  onEmojiChange: (emoji: string | null) => void;
  onNameChange: (name: string) => void;
};

export function SessionIdentitySection({
  emoji,
  name,
  isDisabled,
  onEmojiChange,
  onNameChange,
}: SessionIdentitySectionProps) {
  const hasText = name.length > 0;
  const trimmed = name.trim();
  const validationError =
    trimmed.length > 0 ? validateSessionName(trimmed) : null;

  return (
    <div className="px-3 py-1.5">
      <FormField
        label="Session Name"
        tooltip="A human-friendly display name (plus optional emoji) for finding this session in your list. Auto-filled when you link an issue. Optional — an unnamed session falls back to its generated id."
        bookmarkId="sessionName"
      >
        <div className="flex items-center gap-2">
          <EmojiPickerPopover
            emoji={emoji}
            onEmojiSelect={onEmojiChange}
            disabled={isDisabled}
          />
          <div className="relative flex-1 min-w-0">
            <input
              autoCapitalize="none"
              type="text"
              value={name}
              onChange={e => onNameChange(e.target.value)}
              placeholder="Session name (optional)"
              disabled={isDisabled}
              maxLength={SESSION_NAME_MAX_LENGTH}
              className={`h-9 w-full rounded-md border bg-[var(--app-bg)] px-2.5 pr-8 text-sm text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-1 disabled:opacity-50 ${
                validationError
                  ? "border-red-500 focus:ring-red-500"
                  : "border-[var(--app-border)] focus:ring-[var(--app-link)]"
              }`}
              aria-invalid={validationError !== null}
              aria-describedby={
                validationError ? "session-name-error" : undefined
              }
            />
            <BareButton
              type="button"
              onClick={() => hasText && onNameChange("")}
              disabled={isDisabled}
              className={`absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded text-[var(--app-hint)] transition-colors focus-visible:ring-0 ${
                hasText
                  ? "hover:text-[var(--app-fg)] hover:bg-[var(--app-hover)] disabled:opacity-100"
                  : "opacity-30 disabled:opacity-30 pointer-events-none disabled:pointer-events-none"
              }`}
              title="Clear"
              aria-label="Clear session name"
            >
              <svg
                className="w-3.5 h-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </BareButton>
          </div>
        </div>
        {validationError && (
          <p
            id="session-name-error"
            className="mt-1 text-[length:var(--text-caption)] text-red-400"
          >
            {validationError}
          </p>
        )}
      </FormField>
    </div>
  );
}
