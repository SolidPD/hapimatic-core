// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo, type ReactElement } from "react";
import EmojiPicker, {
  Theme,
  EmojiStyle,
  SuggestionMode,
} from "emoji-picker-react";
import { searchEmojis } from "@/lib/emojiSearch";
import { recordRecentEmoji } from "@/lib/emojiRecents";
import { Button } from "@/components/ui/button";

type EmojiPickerBodyProps = {
  search: string;
  width: number;
  height: number;
  onSelect: (emoji: string) => void;
};

/**
 * The open emoji picker's grid: the library picker, or our search results while
 * a query is typed. EmojiPickerPopover loads it on demand (#3098), because the
 * library and the emojilib search index would otherwise ship in the main bundle
 * for a trigger rendered on every session row. The search input, the Remove
 * button and the outside-click shell stay in EmojiPickerPopover, so the input
 * still mounts in the tap's own commit (the iOS keyboard needs that).
 */
export default function EmojiPickerBody({
  search,
  width,
  height,
  onSelect,
}: EmojiPickerBodyProps): ReactElement {
  const searchResults = useMemo(() => searchEmojis(search, 80), [search]);

  if (search.trim() === "") {
    return (
      <EmojiPicker
        theme={Theme.DARK}
        emojiStyle={EmojiStyle.NATIVE}
        width={width}
        height={height}
        searchDisabled={true}
        // Newest pick first. The library default (FREQUENT) sorts by
        // use count, so a fresh pick ranked behind old favorites.
        suggestedEmojisMode={SuggestionMode.RECENT}
        onEmojiClick={emojiData => onSelect(emojiData.emoji)}
        previewConfig={{ showPreview: false }}
      />
    );
  }

  return (
    <div
      className="flex flex-wrap content-start gap-0.5 overflow-y-auto p-2"
      style={{ height: `${height}px` }}
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
              onSelect(result.char);
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
  );
}
