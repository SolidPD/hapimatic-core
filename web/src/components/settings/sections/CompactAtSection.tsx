// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useId, useState } from "react";
import { Shrink } from "lucide-react";
import {
  COMPACT_AT_MAX_PERCENT,
  COMPACT_AT_MIN_PERCENT,
  claudeCompactMaxPoint,
  compactAtEffectivePoints,
  type CompactAtEffectivePoint,
} from "@hapi/protocol";
import { InfoIcon } from "@/components/icons";
import { IconSectionHeading } from "@/components/settings/IconSectionHeading";
import {
  PercentApplyField,
  isPercentDraftValid,
} from "@/components/settings/PercentApplyField";
import { Checkbox } from "@/components/ui/Checkbox";
import { SettingsRow } from "@/components/ui/SettingsRow";
import { HoverTooltip, HoverTooltipButton } from "@/components/ui/tooltip";
import type { UseCompactAtPreference } from "@/hooks/useCompactAtPreference";

/**
 * CompactAtSection — Settings → Preferences → "Compact at" (issue #6570 R10).
 *
 * When every Claude session this machine starts compacts its context: a switch,
 * the percentage with Apply, and one outlined box with one key-value line per
 * window giving the token point. The points come from the shared
 * `compactAtEffectivePoints` (the same arithmetic the server and the session use),
 * computed from the stored value, or from the draft while it is a whole number from
 * 50 to 95. The value is per machine and reaches sessions started after a change.
 *
 * Layout is reviewer D's (#6570 FX18): rows on the dense pitch, the long
 * explanation behind one info button, secondary text truncated before it wraps
 * (brand-visual-language §10, R10-a and R10-b). The preference is read ONCE by the
 * page and passed in, so Session Handoff compares against the same value.
 */
const INFO_TEXT =
  "Hapimatic sets when every Claude session this machine starts compacts its context. A running session keeps the point it started with. Each machine has its own setting";
const SUMMARY = "Sessions started after a change · this machine only";
const RANGE_MESSAGE = `Enter a whole number from ${COMPACT_AT_MIN_PERCENT} to ${COMPACT_AT_MAX_PERCENT}`;

const RULES = {
  min: COMPACT_AT_MIN_PERCENT,
  max: COMPACT_AT_MAX_PERCENT,
  wholeNumber: true,
} as const;

function formatTokens(n: number): string {
  return n.toLocaleString("en-US");
}

/** "1M window" / "200K window". */
export function windowLabel(windowTokens: number): string {
  return windowTokens >= 1_000_000
    ? `${windowTokens / 1_000_000}M window`
    : `${windowTokens / 1_000}K window`;
}

/** Whether `percent` of this window is past the latest point it can compact at. */
function outOfReach(point: CompactAtEffectivePoint, percent: number): boolean {
  return (
    (point.windowTokens * percent) / 100 >
    claudeCompactMaxPoint(point.windowTokens)
  );
}

/** The value cell: "900,032 tokens · 90.0%", plus "(max 167,000)" out of reach. */
export function compactAtLineValue(
  point: CompactAtEffectivePoint,
  percent: number
): string {
  const base = `${formatTokens(point.firingTokens)} tokens · ${point.percentOfWindow.toFixed(1)}%`;
  return outOfReach(point, percent)
    ? `${base} (max ${formatTokens(claudeCompactMaxPoint(point.windowTokens))})`
    : base;
}

function compactAtLineTooltip(
  point: CompactAtEffectivePoint,
  percent: number
): string {
  const tokens = formatTokens(point.firingTokens);
  if (point.windowTokens >= 1_000_000) {
    return `A session with a ${formatTokens(point.windowTokens)}-token window compacts at about ${tokens} tokens`;
  }
  const head = `A ${formatTokens(point.windowTokens)}-token window compacts at about ${tokens} tokens`;
  return outOfReach(point, percent)
    ? `${head}. It cannot compact later than ${formatTokens(claudeCompactMaxPoint(point.windowTokens))}, so ${percent}% is out of reach there`
    : head;
}

type BoxState =
  | { kind: "points"; percent: number; points: CompactAtEffectivePoint[] }
  | { kind: "line"; text: string; tone: "hint" | "error" };

export function CompactAtSection(props: { compactAt: UseCompactAtPreference }) {
  const { data, loading, failed, apply, applying, applyError } =
    props.compactAt;
  const [draft, setDraft] = useState<string | null>(null);
  // The label names the switch by id: it also holds the info button, which a
  // `<label>` with no `for` would name instead (review M2).
  const switchId = useId();
  const storedPercent = data?.percent;
  // The field re-seeds from the stored value when it changes (an Apply, another
  // client); drop the preview draft with it so the rows follow the stored value.
  useEffect(() => {
    setDraft(null);
  }, [storedPercent]);

  const unreadable = data?.source === "unreadable";
  const invalid = data?.source === "invalid";
  const controlsDisabled = !data || unreadable || applying;

  // The draft is a preview only while it is a whole number from 50 to 95.
  const draftPercent =
    draft !== null && isPercentDraftValid(draft, RULES) ? Number(draft) : null;

  let box: BoxState;
  if (!data) {
    box = failed
      ? { kind: "line", text: "Settings unavailable", tone: "hint" }
      : {
          kind: "line",
          text: loading ? "Loading…" : "Settings unavailable",
          tone: "hint",
        };
  } else if (unreadable) {
    box = {
      kind: "line",
      text: "Off · this machine's settings file can't be read",
      tone: "error",
    };
  } else if (invalid) {
    box = {
      kind: "line",
      text: "Off · the saved value is invalid; Apply one to fix it",
      tone: "error",
    };
  } else if (!data.enabled) {
    box = {
      kind: "line",
      text: "Off · Claude Code's own setting decides",
      tone: "hint",
    };
  } else {
    const percent = draftPercent ?? data.percent;
    box = {
      kind: "points",
      percent,
      points:
        draftPercent === null
          ? data.effective
          : compactAtEffectivePoints(draftPercent),
    };
  }

  const setEnabled = (enabled: boolean) => {
    if (!data) return;
    // An invalid stored value is repaired by sending both fields.
    apply(invalid ? { enabled, percent: data.percent } : { enabled });
  };

  return (
    <section
      id="compact-at"
      aria-label="Compact at"
      data-testid="compact-at-section"
      className="flex scroll-mt-2 flex-col gap-3 border-t border-[var(--app-border)] pt-6"
    >
      <IconSectionHeading
        icon={Shrink}
        accent="var(--accent-sky-400)"
        title="Compact at"
      />

      <SettingsRow
        asLabel
        htmlFor={switchId}
        disabled={controlsDisabled}
        label={
          <span className="inline-flex max-w-full items-center gap-1">
            {/* The row never wraps: the label truncates before it would. */}
            <span
              className="min-w-0 truncate"
              title="Set when sessions compact"
            >
              Set when sessions compact
            </span>
            <HoverTooltipButton
              type="button"
              content={INFO_TEXT}
              aria-label="More info"
              data-testid="compact-at-info"
              className="inline-flex cursor-help items-center p-0.5 text-[var(--app-hint)]/60 hover:text-[var(--app-fg)]"
            >
              <InfoIcon className="h-3 w-3" />
            </HoverTooltipButton>
          </span>
        }
        description={
          <span className="block truncate" data-testid="compact-at-summary">
            {SUMMARY}
          </span>
        }
        control={
          <Checkbox
            id={switchId}
            checked={data?.enabled ?? false}
            disabled={controlsDisabled}
            disabledDim={false}
            onChange={e => setEnabled(e.target.checked)}
            aria-label="Set when sessions compact"
            title="Turn Compact at on or off"
            data-testid="compact-at-enabled-toggle"
          />
        }
      />

      <PercentApplyField
        label="Percentage"
        value={data?.percent ?? null}
        min={COMPACT_AT_MIN_PERCENT}
        max={COMPACT_AT_MAX_PERCENT}
        wholeNumber
        rangeMessage={RANGE_MESSAGE}
        disabled={controlsDisabled}
        allowApplyUnchanged={invalid}
        onDraftChange={setDraft}
        onApply={percent =>
          apply(invalid ? { percent, enabled: true } : { percent })
        }
        inputTitle={`A whole number from ${COMPACT_AT_MIN_PERCENT} to ${COMPACT_AT_MAX_PERCENT}`}
        applyTitle="Save this percentage"
        inputAriaLabel="Compact at percentage"
        testIdPrefix="compact-at-percent"
      />

      <div
        className="rounded-md border border-[var(--app-border)]"
        data-testid="compact-at-box"
      >
        {box.kind === "points" ? (
          <dl className="flex flex-col divide-y divide-[var(--app-divider)]">
            {box.points.map(point => (
              <div
                key={point.windowTokens}
                className="flex min-w-0 items-center gap-3 px-2 py-[var(--row-padding-y)] text-[length:var(--text-body-dense)]"
                data-testid={`compact-at-line-${point.windowTokens}`}
              >
                <dt className="shrink-0 text-[var(--app-hint)]">
                  {windowLabel(point.windowTokens)}
                </dt>
                <HoverTooltip
                  content={compactAtLineTooltip(point, box.percent)}
                >
                  <dd className="min-w-0 flex-1 truncate text-right tabular-nums text-[var(--app-fg)]">
                    {compactAtLineValue(point, box.percent)}
                  </dd>
                </HoverTooltip>
              </div>
            ))}
          </dl>
        ) : (
          <p
            className={`truncate px-2 py-[var(--row-padding-y)] text-[length:var(--text-body-dense)] ${
              box.tone === "error"
                ? "text-[var(--app-badge-error-text)]"
                : "text-[var(--app-hint)]"
            }`}
            data-testid="compact-at-state"
          >
            {box.text}
          </p>
        )}
      </div>

      {applyError ? (
        <p
          className="text-xs text-[var(--app-badge-error-text)]"
          data-testid="compact-at-error"
        >
          {applyError}
        </p>
      ) : null}
    </section>
  );
}
