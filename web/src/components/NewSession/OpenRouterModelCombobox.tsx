// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { Check, ChevronsUpDown, Star } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppContext } from "@/lib/app-context";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useOpenRouterModels } from "@/hooks/queries/useOpenRouterModels";
import { useOpenRouterFavorites } from "@/hooks/queries/useOpenRouterFavorites";
import { useSetOpenRouterFavorites } from "@/hooks/mutations/useSetOpenRouterFavorites";

/** Minimal model shape the rows need — satisfied by catalog entries AND the
 *  raw-id fallback used for a favorited/selected id that isn't in the catalog. */
type ModelLike = { id: string; name: string };

function ModelRow(props: {
  model: ModelLike;
  selected: boolean;
  isFavorite: boolean;
  onSelect: () => void;
  onToggleFavorite: () => void;
}) {
  const { model, selected, isFavorite, onSelect, onToggleFavorite } = props;
  return (
    <CommandItem
      value={model.id}
      keywords={[model.name]}
      onSelect={onSelect}
      className="gap-2"
      data-testid={`openrouter-model-row-${model.id}`}
    >
      <Check
        className={cn(
          "h-4 w-4 shrink-0",
          selected ? "opacity-100" : "opacity-0"
        )}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[length:var(--text-body)] text-[var(--app-fg)]">
          {model.name || model.id}
        </span>
        <span className="truncate text-[length:var(--text-caption)] text-[var(--app-hint)]">
          {model.id}
        </span>
      </div>
      <Button
        type="button"
        variant="ghost"
        aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
        data-testid={`openrouter-model-fav-${model.id}`}
        // Stop the click/pointer from reaching the cmdk item (which would select
        // the model) so the star toggles the favorite instead.
        onMouseDown={e => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onClick={e => {
          e.preventDefault();
          e.stopPropagation();
          onToggleFavorite();
        }}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded p-0 hover:bg-[var(--app-secondary-bg)]"
      >
        <Star
          className={cn(
            "h-4 w-4",
            isFavorite
              ? "fill-[var(--app-link)] text-[var(--app-link)]"
              : "text-[var(--app-hint)] opacity-60"
          )}
        />
      </Button>
    </CommandItem>
  );
}

/**
 * Searchable OpenRouter model picker (issue #1975) — the full live catalog
 * (hundreds of models) backed by `/api/openrouter/models`, with:
 *  - type-to-filter search (by model id OR name),
 *  - favorites pinned to the top (star toggle, persisted server-side),
 *  - a free-text fallback so ANY OpenRouter model id can be entered even if the
 *    catalog fetch is down or the model is brand-new.
 *
 * Replaces the hardcoded 6-model `<select>` (#1733's curated MVP list).
 */
export function OpenRouterModelCombobox(props: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const { value, onChange, disabled, placeholder } = props;
  const { api } = useAppContext();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const { data: models = [] } = useOpenRouterModels(api, { enabled: open });
  const { data: favorites = [] } = useOpenRouterFavorites(api, {
    enabled: open,
  });
  const setFavorites = useSetOpenRouterFavorites(api);

  const favoriteSet = new Set(favorites);
  const favoriteEntries: ModelLike[] = favorites.map(
    id => models.find(m => m.id === id) ?? { id, name: id }
  );
  const nonFavorites = models.filter(m => !favoriteSet.has(m.id));

  const selectedModel = models.find(m => m.id === value);
  const triggerLabel = value
    ? selectedModel?.name || value
    : (placeholder ?? "Select a model…");

  const toggleFavorite = (id: string) => {
    const next = favoriteSet.has(id)
      ? favorites.filter(f => f !== id)
      : [...favorites, id];
    setFavorites.mutate(next);
  };

  const select = (id: string) => {
    onChange(id);
    setSearch("");
    setOpen(false);
  };

  const trimmedSearch = search.trim();
  const showFreeText =
    trimmedSearch.length > 0 && !models.some(m => m.id === trimmedSearch);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button /* design-tokens-allow: Radix PopoverTrigger asChild trigger — the Slot forwards ref/props to this element; a Button here re-styles the trigger + risks the asChild ref-forwarding contract (precedent: account-usage.tsx) */
          type="button"
          disabled={disabled}
          data-testid="openrouter-model-trigger"
          className="flex w-full items-center justify-between rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-sm text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)] disabled:opacity-50"
        >
          <span className={cn("truncate", !value && "text-[var(--app-hint)]")}>
            {triggerLabel}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] p-0"
      >
        <Command shouldFilter>
          <CommandInput
            placeholder="Search models or paste a model id…"
            value={search}
            onValueChange={setSearch}
            data-testid="openrouter-model-search"
          />
          <CommandList>
            <CommandEmpty>
              {showFreeText ? (
                <Button
                  type="button"
                  variant="ghostStatic"
                  onClick={() => select(trimmedSearch)}
                  data-testid="openrouter-model-freetext"
                  className="mx-auto block h-auto rounded-md px-3 py-1.5 text-[length:var(--text-body)] font-normal text-[var(--app-link)] hover:text-[var(--app-fg)] hover:underline"
                >
                  Use &quot;{trimmedSearch}&quot;
                </Button>
              ) : (
                "No models found."
              )}
            </CommandEmpty>
            {favoriteEntries.length > 0 && (
              <CommandGroup heading="Favorites">
                {favoriteEntries.map(m => (
                  <ModelRow
                    key={`fav-${m.id}`}
                    model={m}
                    selected={m.id === value}
                    isFavorite
                    onSelect={() => select(m.id)}
                    onToggleFavorite={() => toggleFavorite(m.id)}
                  />
                ))}
              </CommandGroup>
            )}
            <CommandGroup
              heading={favoriteEntries.length > 0 ? "All models" : undefined}
            >
              {nonFavorites.map(m => (
                <ModelRow
                  key={m.id}
                  model={m}
                  selected={m.id === value}
                  isFavorite={false}
                  onSelect={() => select(m.id)}
                  onToggleFavorite={() => toggleFavorite(m.id)}
                />
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
