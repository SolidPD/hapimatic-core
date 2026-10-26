// SPDX-License-Identifier: AGPL-3.0-only
/**
 * #4288 (folded into #4284) — the ONE source for the symlinked settings.json
 * vocabulary (#4146): the plan-time link states, the commit's 409 refusal
 * reasons, why each cannot be written through, and what replacing the link does
 * to its target. The server (`importArchiveErrors.ts`, `commitFs.ts`) and the web
 * (`types/porter.ts`, `ImportSettingsLink.tsx`) both read it, so a new reason or
 * state without its text fails the typecheck instead of shipping a web that
 * cannot read the refusal. No runtime dependencies: the web bundle imports it.
 */

/** What the `settings.json` link resolves to at plan time (`classifySettingsLink`). */
export const SETTINGS_LINK_STATES = [
  "inside",
  "outside",
  "dangling",
  "loop",
  "not-regular",
] as const;
export type SettingsLinkState = (typeof SETTINGS_LINK_STATES)[number];

/** Why a commit refused to write through a symlinked `settings.json` (the 409's `reason`). */
export const SYMLINKED_SETTINGS_REASONS = [
  "outside-root",
  "dangling",
  "loop",
  "not-regular",
] as const;
export type SymlinkedSettingsReason =
  (typeof SYMLINKED_SETTINGS_REASONS)[number];

/**
 * Why a link cannot be written through, in BOTH vocabularies: the plan's state
 * says `outside`, the 409's reason says `outside-root`. Each reads after
 * "settings.json is a symlink, and ".
 */
export const SETTINGS_LINK_REASON_TEXT: Record<
  Exclude<SettingsLinkState, "inside"> | SymlinkedSettingsReason,
  string
> = {
  outside: "it points outside the config root",
  "outside-root": "it points outside the config root",
  dangling: "it does not resolve to a file",
  loop: "it is part of a symlink loop",
  "not-regular": "it does not point at a regular file",
};

/**
 * What replacing the link does to its target, per reason. A clause that reads
 * after "…replaces the link with a regular file, and ". Only a live target
 * outside the root "stops receiving changes"; a dangling or looping link points
 * at nothing readable, so it claims no target consequence. The clause holds
 * even when a file item of the same import creates the link's target or
 * replaces a link in its chain, because the merge then starts from an empty
 * base rather than reading that file (#4281, #5534).
 */
export function settingsLinkConsequence(
  reason: SymlinkedSettingsReason,
  target: string
): string {
  switch (reason) {
    case "outside-root":
      return `${target} stops receiving changes`;
    case "not-regular":
      return `${target} is left as it is`;
    case "dangling":
    case "loop":
      return "nothing else changes, because the link does not resolve to a file";
  }
}
