// SPDX-License-Identifier: AGPL-3.0-only
import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import EmojiPicker, {
  Theme,
  EmojiStyle,
  SuggestionMode,
} from "emoji-picker-react";
import { searchEmojis } from "@/lib/emojiSearch";
import { recordRecentEmoji } from "@/lib/emojiRecents";
import { Button } from "@/components/ui/button";
import { BareButton } from "@/components/ui/BareButton";

type EmojiPickerPopoverProps = {
  emoji: string | null | undefined;
  onEmojiSelect: (emoji: string | null) => void;
  disabled?: boolean;
};

/**
 * Track the visual viewport top position for keyboard-aware placement.
 * When the iOS keyboard opens, visualViewport.offsetTop shifts and
 * visualViewport.height shrinks. We use these to position the picker
 * within the visible area above the keyboard.
 */
function useVisualViewport() {
  const [vp, setVp] = useState({ top: 0, height: window.innerHeight });

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const update = () => {
      setVp({ top: vv.offsetTop, height: vv.height });
    };

    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  return vp;
}

export function EmojiPickerPopover({
  emoji,
  onEmojiSelect,
  disabled,
}: EmojiPickerPopoverProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const overlayRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const vp = useVisualViewport();

  // Close on escape
  useEffect(() => {
    if (!isOpen) return;
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setIsOpen(false);
      }
    }
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen]);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (
        overlayRef.current &&
        !overlayRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  // Reset the search query whenever the picker closes, keyed on isOpen so that
  // EVERY close path (emoji selection, Escape, outside mousedown, backdrop
  // click) is covered by this single reset. The trigger component never
  // unmounts, so without this the next open would reappear on a stale results
  // grid with a populated search input (R8).
  useEffect(() => {
    if (!isOpen) setSearch("");
  }, [isOpen]);

  const handleSelect = useCallback(
    (emojiValue: string | null) => {
      onEmojiSelect(emojiValue);
      setIsOpen(false);
    },
    [onEmojiSelect]
  );

  // Position the picker centered horizontally in the visible viewport,
  // and vertically centered within the visible area (above the keyboard).
  // Min top offset accounts for iOS status bar + Hapimatic header (~90px).
  const pickerHeight = 350;
  const pickerWidth = 300;
  // Height of the custom search-input row that sits above the picker/results.
  const INPUT_HEIGHT = 40;
  const searchResults = useMemo(() => searchEmojis(search, 80), [search]);
  const minTop = vp.top + 90;
  const maxTop = vp.top + vp.height - pickerHeight - 8;
  const centerTop = vp.top + (vp.height - pickerHeight) / 2;
  const clampedTop = Math.max(minTop, Math.min(centerTop, maxTop));

  return (
    <>
      <BareButton
        ref={triggerRef}
        type="button"
        onClick={e => {
          e.stopPropagation();
          if (!disabled) setIsOpen(!isOpen);
        }}
        disabled={disabled}
        // `-mx-1`: the 20px box stays the TAP target, but its layout footprint
        // shrinks to 12px so the Row-1 gap (7px) is measured from the GLYPH,
        // not from 4px of empty box on each side. Measured on the 402px
        // instance header before the change: emoji-glyph → name = 11px against
        // a 7px row gap (operator round 10, 2026-09-07: "larger than necessary").
        className="flex h-5 w-5 -mx-1 items-center justify-center shrink-0 rounded text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-hover)] transition-colors focus-visible:ring-0 disabled:opacity-50 disabled:cursor-not-allowed"
        title={emoji ? "Change emoji" : "Add emoji"}
        aria-label={emoji ? "Change session emoji" : "Add session emoji"}
      >
        {emoji ? (
          <span className="text-[length:var(--text-body)] leading-none">
            {emoji}
          </span>
        ) : (
          <svg
            className="h-3 w-3"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M8 14s1.5 2 4 2 4-2 4-2" />
            <line x1="9" y1="9" x2="9.01" y2="9" />
            <line x1="15" y1="9" x2="15.01" y2="9" />
          </svg>
        )}
      </BareButton>

      {isOpen && (
        <>
          {/* Backdrop overlay */}
          <div
            className="fixed inset-0 z-50 bg-black/30"
            onClick={() => setIsOpen(false)}
          />
          {/* Picker positioned within the visual viewport */}
          <div
            ref={overlayRef}
            className="fixed z-50 rounded-lg shadow-2xl border border-[var(--app-border)] overflow-hidden bg-[var(--app-bg)]"
            style={{
              top: `${clampedTop}px`,
              left: `calc(50% - ${pickerWidth / 2}px)`,
              width: `${pickerWidth}px`,
            }}
          >
            {/* Custom search input — replaces the picker's built-in search
                bar (searchDisabled below) so we can drive keyword-augmented
                search across the emojilib dataset. */}
            <input
              autoCapitalize="none"
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              onClick={e => e.stopPropagation()}
              placeholder="Search emoji..."
              aria-label="Search emoji"
              autoFocus
              className="w-full border-b border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-sm text-[var(--app-fg)] outline-none placeholder:text-[var(--app-hint)]"
              style={{ height: `${INPUT_HEIGHT}px` }}
            />

            {search.trim() === "" ? (
              <EmojiPicker
                theme={Theme.DARK}
                emojiStyle={EmojiStyle.NATIVE}
                width={pickerWidth}
                height={pickerHeight - INPUT_HEIGHT}
                searchDisabled={true}
                // Newest pick first. The library default (FREQUENT) sorts by
                // use count, so a fresh pick ranked behind old favorites.
                suggestedEmojisMode={SuggestionMode.RECENT}
                onEmojiClick={emojiData => handleSelect(emojiData.emoji)}
                previewConfig={{ showPreview: false }}
              />
            ) : (
              <div
                className="flex flex-wrap content-start gap-0.5 overflow-y-auto p-2"
                style={{ height: `${pickerHeight - INPUT_HEIGHT}px` }}
              >
                {searchResults.length > 0 ? (
                  searchResults.map(result => (
                    <Button
                      key={result.char}
                      type="button"
                      variant="ghost"
                      title={result.name.replace(/_/g, " ")}
                      aria-label={result.name.replace(/_/g, " ")}
                      onClick={e => {
                        e.stopPropagation();
                        // The library records picks from its own grid only,
                        // so a pick from these search results is recorded
                        // here for its Recently Used row.
                        recordRecentEmoji(result.char);
                        handleSelect(result.char);
                      }}
                      className="flex h-8 w-8 items-center justify-center rounded p-0 text-xl font-normal hover:bg-[var(--app-hover)]"
                    >
                      {result.char}
                    </Button>
                  ))
                ) : (
                  <div className="p-3 text-sm text-[var(--app-hint)]">
                    No emojis match "{search}".
                  </div>
                )}
              </div>
            )}
            {emoji && (
              <Button
                type="button"
                variant="ghost"
                onClick={e => {
                  e.stopPropagation();
                  handleSelect(null);
                }}
                className="h-auto w-full rounded-none border-t border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm font-normal text-[var(--app-hint)] hover:bg-[var(--app-hover)]"
              >
                Remove emoji
              </Button>
            )}
          </div>
        </>
      )}
    </>
  );
}
