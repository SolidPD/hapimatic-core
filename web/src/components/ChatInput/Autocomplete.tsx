// SPDX-License-Identifier: AGPL-3.0-only
import { memo, useEffect, useRef } from "react";
import type { Suggestion } from "@/hooks/useActiveSuggestions";
import { Button } from "@/components/ui/button";

interface AutocompleteProps {
  suggestions: readonly Suggestion[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  onRemove?: (index: number) => void;
}

/**
 * Autocomplete suggestions list component
 */
export const Autocomplete = memo(function Autocomplete(
  props: AutocompleteProps
) {
  const { suggestions, selectedIndex, onSelect, onRemove } = props;
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selectedIndex < 0 || selectedIndex >= suggestions.length) return;
    const listEl = listRef.current;
    if (!listEl) return;
    const selectedEl = listEl.querySelector<HTMLButtonElement>(
      `[data-suggestion-index="${selectedIndex}"]`
    );
    selectedEl?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, suggestions]);

  if (suggestions.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col-reverse py-1" ref={listRef}>
      {suggestions.map((suggestion, index) => (
        <div
          key={suggestion.key}
          className={`flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors ${
            suggestion.disabled
              ? "cursor-default opacity-50"
              : index === selectedIndex
                ? "cursor-pointer bg-[var(--app-button)] text-[var(--app-button-text)]"
                : "cursor-pointer text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)]"
          }`}
          data-suggestion-index={index}
        >
          <button /* design-tokens-allow: bare select target; the selected/hover bg AND the contextual text color (--app-button-text when selected) are owned by the parent list-item row — a <Button> would substitute its own color/hover and break the parent-driven visual (L6 #3408) */
            type="button"
            className="flex-1 min-w-0 flex items-center gap-2 text-left"
            onClick={() => !suggestion.disabled && onSelect(index)}
            onMouseDown={e => e.preventDefault()}
          >
            <span className="font-medium truncate">{suggestion.label}</span>
            {suggestion.description && (
              <span
                className={`truncate text-xs ${
                  index === selectedIndex && !suggestion.disabled
                    ? "opacity-80"
                    : "text-[var(--app-hint)]"
                }`}
              >
                {suggestion.description}
              </span>
            )}
          </button>
          {onRemove && !suggestion.disabled && (
            <Button
              type="button"
              variant="ghost"
              className="shrink-0 h-auto rounded p-0.5"
              onClick={e => {
                e.stopPropagation();
                onRemove(index);
              }}
              onMouseDown={e => e.preventDefault()}
              title="Remove"
              aria-label="Remove suggestion"
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
            </Button>
          )}
        </div>
      ))}
    </div>
  );
});
