// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/button";

/**
 * PercentApplyField — one labelled percentage editor with an Apply button, shared
 * by the Compact-at and Session Handoff sections (issue #6570, FX22). It is
 * `FormField` (inline: label left, control right) + `Input variant="borderlessDense"`
 * + `Button variant="accent" size="dense"`, the `MaxConcurrencyRow` precedent in
 * `routes/settings/preferences.tsx`.
 *
 * The draft is seeded from `value` and re-seeded when the server value changes. A
 * draft outside the range (or a fraction when `wholeNumber`) shows one error line on
 * Apply and sends nothing. `onDraftChange` reports each edit, so a section can
 * preview the draft before it is applied.
 */
export interface PercentApplyFieldProps {
  label: string;
  /** The stored value the draft is seeded from; `null` (no value read yet) leaves it empty. */
  value: number | null;
  min: number;
  max: number;
  /** `min` itself is out of range ("above 0"). */
  minExclusive?: boolean;
  /** Fractions are out of range. */
  wholeNumber?: boolean;
  /** The one error line for a bad draft. */
  rangeMessage: string;
  onApply: (value: number) => void;
  disabled?: boolean;
  /** Apply stays available while the draft equals `value` (repairing a stored value). */
  allowApplyUnchanged?: boolean;
  onDraftChange?: (draft: string) => void;
  /** Hint under the row; none at rest by default. */
  hint?: string;
  inputTitle?: string;
  applyTitle?: string;
  inputAriaLabel?: string;
  /** `data-testid` prefix: `<prefix>-input`, `<prefix>-apply`. */
  testIdPrefix?: string;
}

/** Whether `draft` parses to a number inside the field's range. */
export function isPercentDraftValid(
  draft: string,
  rules: Pick<
    PercentApplyFieldProps,
    "min" | "max" | "minExclusive" | "wholeNumber"
  >
): boolean {
  if (draft.trim() === "") return false;
  const n = Number(draft);
  if (!Number.isFinite(n)) return false;
  if (rules.wholeNumber && !Number.isInteger(n)) return false;
  if (rules.minExclusive ? n <= rules.min : n < rules.min) return false;
  return n <= rules.max;
}

export function PercentApplyField(props: PercentApplyFieldProps) {
  const [draft, setDraft] = useState<string>(String(props.value ?? ""));
  const [showError, setShowError] = useState(false);

  useEffect(() => {
    setDraft(String(props.value ?? ""));
    setShowError(false);
  }, [props.value]);

  const parsed = Number(draft);
  const dirty =
    draft.trim() !== "" &&
    (props.allowApplyUnchanged === true || parsed !== props.value);

  const handleChange = (next: string) => {
    setDraft(next);
    setShowError(false);
    props.onDraftChange?.(next);
  };

  const handleApply = () => {
    if (!isPercentDraftValid(draft, props)) {
      setShowError(true);
      return;
    }
    setShowError(false);
    props.onApply(parsed);
  };

  const prefix = props.testIdPrefix;
  return (
    <FormField
      label={props.label}
      layout="inline"
      error={showError ? props.rangeMessage : undefined}
      hint={props.hint}
    >
      {field => (
        <div className="flex shrink-0 items-center gap-2">
          <div className="flex items-center gap-1">
            <Input
              id={field.id}
              aria-describedby={field["aria-describedby"]}
              aria-invalid={field["aria-invalid"]}
              variant="borderlessDense"
              type="number"
              inputMode={props.wholeNumber ? "numeric" : "decimal"}
              min={props.min}
              max={props.max}
              step={props.wholeNumber ? 1 : "any"}
              value={draft}
              disabled={props.disabled}
              onChange={e => handleChange(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && dirty && !props.disabled) {
                  handleApply();
                }
              }}
              className="w-16 tabular-nums"
              title={props.inputTitle}
              aria-label={props.inputAriaLabel}
              data-testid={prefix ? `${prefix}-input` : undefined}
            />
            <span className="text-sm text-[var(--app-hint)]">%</span>
          </div>
          <Button
            variant="accent"
            size="dense"
            type="button"
            onClick={handleApply}
            disabled={props.disabled || !dirty}
            title={props.applyTitle}
            data-testid={prefix ? `${prefix}-apply` : undefined}
            className="disabled:opacity-40"
          >
            Apply
          </Button>
        </div>
      )}
    </FormField>
  );
}
