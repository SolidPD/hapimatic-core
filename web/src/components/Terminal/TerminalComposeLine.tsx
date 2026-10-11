// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Compose line for the Terminal tab (#4516, Task 4; revised per operator ruling
 * R2-2).
 *
 * A compact native multi-line <textarea> — autocorrect, dictation and native
 * long-press Paste all work because the browser defaults are left on — plus a
 * Send button. Send hands the text to the page's `onSend`, which delivers it
 * through the paste path; whether Enter follows is the page's decision (R2-2,
 * today: no Enter, with #4550 adding a Preferences setting), never this
 * component's. The field is cleared only when `onSend` reports a real send (R8).
 * The Send button's pointerdown `preventDefault()`s so the press never blurs
 * the field (R5).
 *
 * A ⏎ key sits beside Send (T11, operator ruling 2026-10-03: placement V1) so a
 * touch user can run the pasted command with one tap. It only calls `onEnter`
 * — the page writes the Enter byte; the field's text is untouched (Send owns
 * the text), and the compose line still never decides or stores whether Send
 * presses Enter (T2).
 */
import { useCallback, useRef, useState } from "react";
import { BareButton } from "@/components/ui/BareButton";

export interface TerminalComposeLineProps {
  disabled: boolean;
  /** Deliver the text to the terminal. Returns true if sent (clears the field). */
  onSend: (text: string) => boolean;
  /** Press Enter in the terminal (the ⏎ key). Does not read or clear the field. */
  onEnter: () => void;
  /** The page holds this ref to focus the field for the Paste fallback (R7). */
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}

export function TerminalComposeLine(props: TerminalComposeLineProps) {
  const { disabled, onSend, onEnter, inputRef } = props;
  const [text, setText] = useState("");
  const internalRef = useRef<HTMLTextAreaElement | null>(null);

  const setRefs = useCallback(
    (el: HTMLTextAreaElement | null) => {
      internalRef.current = el;
      if (inputRef) inputRef.current = el;
    },
    [inputRef]
  );

  // Auto-grow 1–4 rows. Guarded so jsdom (no layout, scrollHeight 0) is a no-op.
  const autoGrow = useCallback(() => {
    const el = internalRef.current;
    if (!el || !el.scrollHeight) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  const handleSend = useCallback(() => {
    const ok = onSend(text);
    if (ok) {
      setText("");
      const el = internalRef.current;
      if (el) el.style.height = "auto";
    }
  }, [onSend, text]);

  return (
    <div className="flex items-end gap-2 px-3 py-2">
      <textarea
        ref={setRefs}
        rows={1}
        value={text}
        onChange={e => {
          setText(e.target.value);
          autoGrow();
        }}
        enterKeyHint="enter"
        placeholder="Type or paste…"
        style={{ maxHeight: "6rem" }}
        className="min-h-8 flex-1 resize-none overflow-y-auto rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 py-1.5 text-sm text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-button)] focus-visible:ring-inset"
      />
      <BareButton
        type="button"
        disabled={disabled}
        onPointerDown={e => e.preventDefault()}
        onClick={handleSend}
        aria-label="Send"
        className="min-h-8 shrink-0 touch-manipulation rounded-md border border-[var(--app-button)] bg-[var(--app-button)] px-4 text-sm font-medium text-[var(--app-button-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-button)] focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-50"
      >
        Send
      </BareButton>
      <BareButton
        type="button"
        disabled={disabled}
        onPointerDown={e => e.preventDefault()}
        onClick={onEnter}
        aria-label="Enter"
        className="min-h-8 shrink-0 touch-manipulation rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3.5 text-sm font-medium text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-button)] focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-50"
      >
        ⏎
      </BareButton>
    </div>
  );
}
