// SPDX-License-Identifier: AGPL-3.0-only
import { HistoryIcon } from "@/components/icons";
import { BareButton } from "@/components/ui/BareButton";

export type AutoRecoverState = boolean | null;

interface AutoRecoverToggleProps {
  value: AutoRecoverState;
  onChange: (next: AutoRecoverState) => void;
  disabled?: boolean;
  /** Extra classes for the button — lets a caller adopt a host row's sizing. */
  className?: string;
  /** Glyph sizing. Defaults to the h-4 Row-1 size; icon rows use h-5. */
  iconClassName?: string;
}

// Tri-state cycle: null (follow global) → true (force on) → false (force off) → null
const NEXT_STATE: Record<string, AutoRecoverState> = {
  null: true,
  true: false,
  false: null,
};

function labelFor(state: AutoRecoverState): string {
  if (state === null) return "Follow global auto-recover preference";
  if (state === true) return "Auto-recover from API errors (forced ON)";
  return "Skip auto-recovery from API errors (forced OFF)";
}

function colorClassFor(state: AutoRecoverState): string {
  if (state === null) return "text-[var(--app-hint)]";
  if (state === true) return "text-[var(--app-link)]"; // mint
  return "text-[var(--app-badge-error-text)]";
}

export function AutoRecoverToggle({
  value,
  onChange,
  disabled,
  className,
  iconClassName = "h-4 w-4",
}: AutoRecoverToggleProps) {
  const handleClick = () => {
    if (disabled) return;
    const key = value === null ? "null" : value ? "true" : "false";
    onChange(NEXT_STATE[key]);
  };
  return (
    <BareButton
      type="button"
      onClick={handleClick}
      disabled={disabled}
      className={`p-1.5 rounded-full transition-colors hover:bg-[var(--app-hover)] disabled:opacity-50 ${colorClassFor(value)}${className ? ` ${className}` : ""}`}
      title={labelFor(value)}
      aria-label={labelFor(value)}
      aria-pressed={value === true}
    >
      <HistoryIcon className={iconClassName} />
    </BareButton>
  );
}
