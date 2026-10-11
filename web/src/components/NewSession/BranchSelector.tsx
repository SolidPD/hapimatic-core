// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { Check, ChevronsUpDown, GitBranch, Plus } from "lucide-react";
import type {
  GitBranchEntry,
  GitBranchListing,
} from "@hapi/protocol/gitBranches";
import { cn } from "@/lib/utils";
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
import { FormField } from "./FormField";
import {
  branchOptionState,
  currentRefLabel,
  sameBranch,
  worktreeSwitchNote,
  type BranchChoice,
} from "./branchSelection";
import type { SessionMode } from "./types";

const NEW_BRANCH_VALUE = "\u0000new-branch";
const CURRENT_VALUE = "\u0000current";

function triggerLabel(choice: BranchChoice, listing: GitBranchListing): string {
  if (choice.kind === "current")
    return `${currentRefLabel(listing.current) ?? "Current branch"} (current)`;
  if (choice.kind === "new") return "New branch…";
  return choice.branch.remote
    ? `origin/${choice.branch.name}`
    : choice.branch.name;
}

function BranchRow(props: {
  entry: GitBranchEntry;
  selected: boolean;
  sessionMode: SessionMode;
  onSelect: () => void;
}) {
  const { entry } = props;
  const state = branchOptionState(entry, { sessionMode: props.sessionMode });
  return (
    <CommandItem
      value={`${entry.source}:${entry.name}`}
      keywords={[entry.name]}
      disabled={state.disabled}
      onSelect={props.onSelect}
      className="gap-2"
      data-testid={`branch-row-${entry.source}-${entry.name}`}
    >
      <Check
        className={cn(
          "h-4 w-4 shrink-0",
          props.selected ? "opacity-100" : "opacity-0"
        )}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[length:var(--text-body)] text-[var(--app-fg)]">
          {entry.name}
          {entry.source === "remote" ? (
            <span className="ml-1.5 text-[length:var(--text-caption)] text-[var(--app-hint)]">
              origin
            </span>
          ) : null}
        </span>
        {state.reason ? (
          <span className="truncate text-[length:var(--text-caption)] text-[var(--app-hint)]">
            {state.reason}
          </span>
        ) : null}
      </div>
    </CommandItem>
  );
}

/**
 * hapimatic-private#4481 — the Create page's Branch control (both Git Types).
 *
 * Searchable list ordered: the directory's current branch "(current)" → other
 * local + remote-only branches (most recent first, held-elsewhere disabled) →
 * "New branch…". Picking anything but the current branch makes the caller
 * switch Git Type to Worktree (ruling D5b) — this component only reports the
 * choice; the coupling lives in `useBranchSelection` / `branchSelection.ts`.
 */
export function BranchSelector(props: {
  listing: GitBranchListing;
  choice: BranchChoice;
  directory: string;
  sessionMode: SessionMode;
  isDisabled: boolean;
  onChoose: (choice: BranchChoice) => void;
}) {
  const { listing, choice } = props;
  const [open, setOpen] = useState(false);

  const choose = (next: BranchChoice) => {
    setOpen(false);
    props.onChoose(next);
  };

  const current = listing.current;
  return (
    <div className="px-3 py-1">
      <FormField
        label="Branch"
        tooltip="The git branch the session runs on. The current branch runs in place (Basic). Any other branch — existing or new — opens in its own worktree so this directory stays on its current branch for other sessions."
        bookmarkId="branch"
      >
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button /* design-tokens-allow: Radix PopoverTrigger asChild trigger — the Slot forwards ref/props to this element (precedent: OpenRouterModelCombobox.tsx) */
              type="button"
              disabled={props.isDisabled}
              data-testid="branch-selector-trigger"
              className="flex h-9 w-full items-center justify-between rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 text-sm text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)] disabled:opacity-50"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <GitBranch className="h-3.5 w-3.5 shrink-0 opacity-60" />
                <span className="truncate">
                  {triggerLabel(choice, listing)}
                </span>
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
                placeholder="Search branches…"
                data-testid="branch-selector-search"
              />
              <CommandList>
                <CommandEmpty>No matching branches.</CommandEmpty>
                {current ? (
                  <CommandGroup heading="Current">
                    <CommandItem
                      value={CURRENT_VALUE}
                      keywords={[currentRefLabel(current) ?? "current"]}
                      onSelect={() => choose({ kind: "current" })}
                      className="gap-2"
                      data-testid="branch-row-current"
                    >
                      <Check
                        className={cn(
                          "h-4 w-4 shrink-0",
                          choice.kind === "current"
                            ? "opacity-100"
                            : "opacity-0"
                        )}
                      />
                      <span className="truncate text-[length:var(--text-body)] text-[var(--app-fg)]">
                        {currentRefLabel(current)}{" "}
                        <span className="text-[var(--app-hint)]">
                          (current)
                        </span>
                      </span>
                    </CommandItem>
                  </CommandGroup>
                ) : null}
                {listing.branches.length > 0 ? (
                  <CommandGroup heading="Branches">
                    {listing.branches.map(entry => (
                      <BranchRow
                        key={`${entry.source}:${entry.name}`}
                        entry={entry}
                        sessionMode={props.sessionMode}
                        selected={
                          choice.kind === "existing" &&
                          sameBranch(choice.branch, {
                            name: entry.name,
                            remote: entry.source === "remote",
                          })
                        }
                        onSelect={() =>
                          choose({
                            kind: "existing",
                            branch: {
                              name: entry.name,
                              remote: entry.source === "remote",
                            },
                          })
                        }
                      />
                    ))}
                  </CommandGroup>
                ) : null}
                <CommandGroup>
                  <CommandItem
                    value={NEW_BRANCH_VALUE}
                    keywords={["new branch"]}
                    onSelect={() => choose({ kind: "new" })}
                    className="gap-2"
                    data-testid="branch-row-new"
                  >
                    <Plus
                      className={cn(
                        "h-4 w-4 shrink-0",
                        choice.kind === "new" ? "" : "opacity-60"
                      )}
                    />
                    <span className="text-[length:var(--text-body)] text-[var(--app-fg)]">
                      New branch…
                    </span>
                  </CommandItem>
                </CommandGroup>
              </CommandList>
              {listing.truncated ? (
                <p className="border-t border-[var(--app-border)] px-2 py-1.5 text-[length:var(--text-caption-xs)] text-[var(--app-hint)]">
                  Showing the 500 most recently updated branches — older
                  branches aren&apos;t listed.
                </p>
              ) : null}
            </Command>
          </PopoverContent>
        </Popover>
        {choice.kind !== "current" ? (
          <p
            className="mt-1 text-[length:var(--text-caption-xs)] text-[var(--app-hint)] italic"
            data-testid="branch-worktree-note"
          >
            {worktreeSwitchNote(props.directory, current)}
          </p>
        ) : null}
      </FormField>
    </div>
  );
}

/**
 * hapimatic-private#4481: clone-on-spawn repos (the directory does not exist yet
 * and Worktree is disabled) show the branch the clone lands on, read-only.
 */
export function BranchReadOnly(props: {
  defaultBranch: string | null | undefined;
}) {
  return (
    <div className="px-3 py-1">
      <FormField
        label="Branch"
        tooltip="A first-time clone checks out the repository's default branch and runs as Basic."
      >
        <p
          className="flex h-9 items-center gap-1.5 text-sm text-[var(--app-fg)]"
          data-testid="branch-readonly"
        >
          <GitBranch className="h-3.5 w-3.5 shrink-0 opacity-60" />
          {props.defaultBranch ? (
            <code>{props.defaultBranch}</code>
          ) : (
            <span className="text-[var(--app-hint)]">
              the repository's default branch
            </span>
          )}
        </p>
      </FormField>
    </div>
  );
}
