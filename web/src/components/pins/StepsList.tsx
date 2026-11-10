// SPDX-License-Identifier: AGPL-3.0-only
import type { PinStep, PinStepPart } from "@hapi/protocol";
import { Checkbox } from "@/components/ui/Checkbox";
import { HoverTooltip } from "@/components/ui/tooltip";
import { CopyValueChip } from "@/components/pins/CopyValueChip";

// ── Rendering ───────────────────────────────────────────────────────────────

function linkHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * The host is shown unless the label IS the host or the URL: a label that
 * merely contains a host ("github.com/evil.co" for https://evil.co) must not
 * hide where the link goes.
 */
function labelNamesDestination(label: string, url: string, host: string) {
  const normalized = label.trim().toLowerCase();
  return normalized === host.toLowerCase() || normalized === url.toLowerCase();
}

function StepPart(props: { part: PinStepPart }) {
  const { part } = props;
  if ("text" in part) return <span>{part.text}</span>;
  if ("link" in part) {
    const host = linkHost(part.link);
    return (
      <HoverTooltip
        content={`${part.link}. Opens in a new tab; in the iPhone app press and hold to open in Safari`}
      >
        <a
          href={part.link}
          target="_blank"
          rel="noopener noreferrer"
          className="underline decoration-dotted underline-offset-2"
          style={{ color: "var(--view-accent-terminal)" }}
        >
          {part.label}
          {labelNamesDestination(part.label, part.link, host) ? null : (
            <span className="ml-1 text-[var(--app-hint)] no-underline">
              ({host})
            </span>
          )}
        </a>
      </HoverTooltip>
    );
  }
  return <CopyValueChip value={part.copy} label={part.label} />;
}

/**
 * #6449: a steps pin's checklist (mockup v6 :730-733): "n of N done", then each
 * step with its native checkbox, number, place, and parts. A link shows its
 * host beside its label and a copy value shows itself, so a label cannot hide
 * where a tap goes or what is copied. Read-only without `onToggle`.
 */
export function StepsList(props: {
  steps: readonly PinStep[];
  checked: ReadonlySet<string>;
  onToggle?: (stepId: string) => void;
}) {
  const { steps, checked, onToggle } = props;
  const done = steps.filter(step => checked.has(step.id)).length;
  return (
    <div className="mt-1">
      <div className="text-[length:var(--text-caption)] text-[var(--app-hint)]">
        {done} of {steps.length} done
      </div>
      <ol className="mt-1 border-t border-[var(--app-divider)]">
        {steps.map((step, index) => (
          <li
            key={step.id}
            className="grid items-start gap-x-1.5 border-b border-[var(--app-divider)] py-1.5"
            style={{ gridTemplateColumns: "18px 16px minmax(0, 1fr)" }}
          >
            {/* The label widens the tap target to the number; the parts stay
                outside it, because a label may not contain a button. */}
            <label
              className="col-span-2 grid items-start gap-x-1.5"
              style={{ gridTemplateColumns: "18px 16px" }}
            >
              <span className="flex justify-center pt-0.5">
                <Checkbox
                  checked={checked.has(step.id)}
                  disabled={!onToggle}
                  disabledDim={false}
                  aria-label={`Step ${index + 1}: done`}
                  onChange={() => onToggle?.(step.id)}
                />
              </span>
              <span className="pt-px text-[length:var(--text-body-dense)] font-bold text-[var(--app-hint)]">
                {index + 1}
              </span>
            </label>
            <span className="min-w-0">
              <span
                className="block font-bold uppercase tracking-wide text-[var(--app-hint)]"
                style={{ fontSize: "10px" }}
              >
                {step.where}
              </span>
              <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[length:var(--text-body)] text-[var(--app-fg)]">
                {step.parts.map((part, partIndex) => (
                  <StepPart key={partIndex} part={part} />
                ))}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
