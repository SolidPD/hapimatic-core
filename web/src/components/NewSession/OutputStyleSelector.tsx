// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { FormField } from "./FormField";
import { UiSelect } from "./controls";
import { PickerModal } from "./PickerModal";
import { Button } from "@/components/ui/button";
import type { OutputStyleInfo } from "@/api/client";

/**
 * Issue #2626 (D): per-session output-style selector for the Create-session page.
 *
 * The output style modifies how Claude WRITES its responses (Explanatory adds
 * educational insights, Learning asks the user to write small code pieces,
 * Default is standard) — it is injected into the spawned session's `--settings`
 * file (the choke point every launcher delivers). Pre-selected from the user's
 * saved default (#2623 `useDefaultOutputStyle`); applies to ONE session.
 *
 * Presentational (mirrors {@link LauncherSelector}): the parent fetches the
 * catalog via `useOutputStyles` and owns the selected value. Selecting "default"
 * makes the parent OMIT the spawn field (R2 byte-identical), so this component is
 * value-agnostic. Custom styles (from `~/.claude/output-styles/*.md`) render a
 * "View definition" affordance opening a modal with the `.md` content.
 */
export function OutputStyleSelector(props: {
  styles: OutputStyleInfo[];
  value: string;
  isDisabled: boolean;
  onChange: (value: string) => void;
}) {
  const [viewing, setViewing] = useState<OutputStyleInfo | null>(null);
  const selected = props.styles.find(s => s.name === props.value);

  return (
    <FormField
      label="Output style"
      tooltip="How Claude writes its responses for this session — Explanatory adds educational insights, Learning asks you to write small code pieces, Default is standard. Pre-selected from your saved default; applies to this one session. Custom styles come from ~/.claude/output-styles/."
      bookmarkId="outputStyle"
    >
      <UiSelect
        value={props.value}
        onChange={e => props.onChange(e.target.value)}
        disabled={props.isDisabled}
        data-testid="output-style-select"
      >
        {props.styles.map(style => (
          <option key={style.name} value={style.name}>
            {style.name}
            {style.builtin ? "" : " (custom)"}
          </option>
        ))}
      </UiSelect>

      {selected?.description && (
        <p className="mt-1 text-[length:var(--text-caption-xs)] leading-tight text-[var(--app-hint)]">
          {selected.description}
        </p>
      )}

      {selected && !selected.builtin && selected.content && (
        <Button
          type="button"
          variant="ghostStatic"
          size="bare"
          onClick={() => setViewing(selected)}
          className="mt-1 text-[length:var(--text-caption-xs)] font-normal text-[var(--app-link)] hover:text-[var(--app-fg)] hover:opacity-80"
          data-testid="output-style-view-definition"
        >
          View definition
        </Button>
      )}

      {viewing && (
        <PickerModal title={viewing.name} onClose={() => setViewing(null)}>
          <pre className="whitespace-pre-wrap break-words px-3 py-2 text-xs text-[var(--app-fg)]">
            {viewing.content}
          </pre>
        </PickerModal>
      )}
    </FormField>
  );
}
