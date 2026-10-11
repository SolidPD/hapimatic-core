// SPDX-License-Identifier: AGPL-3.0-only
// Issue #1079: merge contiguous COLLAPSED dock sections (Prompt / Notes / Token
// Usage) into a single horizontal row, while any EXPANDED section breaks out to
// its own full-width row. This pure helper computes the row layout from the
// three collapse booleans; SessionChat's dock maps the result to JSX.
//
// The walk is over the fixed source order prompt -> notes -> tokenUsage (R5:
// source order is preserved left-to-right in a merged row). Contiguous collapsed
// sections accumulate into a `merged` group; an expanded section flushes the
// current run and emits its own `expanded` group (R2). When Token Usage has no
// stats to show it is omitted from the walk entirely (R8) — no empty slot.

export type MergeSection = "prompt" | "notes" | "tokenUsage";

export type MergeGroup =
  | { kind: "merged"; sections: MergeSection[] }
  | { kind: "expanded"; section: MergeSection };

export interface ComputeMergeGroupsInput {
  promptCollapsed: boolean;
  notesCollapsed: boolean;
  tokenUsageCollapsed: boolean;
  /** R8: when false, Token Usage is omitted entirely (no merged/expanded slot). */
  hasTokenStats: boolean;
}

export function computeMergeGroups(
  input: ComputeMergeGroupsInput
): MergeGroup[] {
  // Source order (R5). `present` gates Token Usage on hasTokenStats (R8); Prompt
  // and Notes are always present.
  const order: Array<{
    section: MergeSection;
    collapsed: boolean;
    present: boolean;
  }> = [
    { section: "prompt", collapsed: input.promptCollapsed, present: true },
    { section: "notes", collapsed: input.notesCollapsed, present: true },
    {
      section: "tokenUsage",
      collapsed: input.tokenUsageCollapsed,
      present: input.hasTokenStats,
    },
  ];

  const groups: MergeGroup[] = [];
  let run: MergeSection[] = [];

  const flushRun = () => {
    if (run.length > 0) {
      groups.push({ kind: "merged", sections: run });
      run = [];
    }
  };

  for (const item of order) {
    if (!item.present) continue;
    if (item.collapsed) {
      run.push(item.section);
    } else {
      flushRun();
      groups.push({ kind: "expanded", section: item.section });
    }
  }
  flushRun();

  return groups;
}
