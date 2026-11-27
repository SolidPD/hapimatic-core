// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The Time Tracking group (#6780): presentation only, from the adapter's view
 * model. Laid out as the accepted mock-up (v2, 2026-11-26): the project chip on
 * the label's row, the three status pills on the toggle's row in place of the
 * on/off word, Category (3/5) and Hourly Rate (2/5) on one row, the note's row
 * only while it is needed. Off, only the toggle shows (Safe Mode's height).
 *
 * Every control carries a native `title` beside the label's info bubble, the
 * touch path (the `title` tooltip exception, `RadioRow.tsx`, `primitives.md`).
 */
import { useId } from "react";
import { TRACKING_RATE_NOTE_MAX } from "@hapi/protocol";
import { FormField } from "@/components/NewSession/FormField";
import { UiInput, UiSelect, UiToggle } from "@/components/NewSession/controls";
import { BareButton } from "@/components/ui/BareButton";
import { RadioRow } from "@/components/ui/RadioRow";
import { HoverTooltip, HoverTooltipButton } from "@/components/ui/tooltip";
import {
  categoryKey,
  defaultRemovedWords,
  TRACKING_STATUS_OPTIONS,
  type ProjectShown,
} from "./timeTracking";
import type { TimeTrackingGroupModel } from "./useTimeTrackingFields";

export const TIME_TRACKING_INFO =
  "Time Tracking records this session's time with a billing status, a category and an hourly rate. Billable: billed to the client. Pending: held, not billed until it is released. Non-billable: recorded, never billed.";

const ERROR_LINE = "mt-1 text-[length:var(--text-caption-xs)] text-destructive";
const HINT_LINE =
  "mt-1 text-[length:var(--text-caption-xs)] text-[var(--app-hint)]";

function ProjectChip({ project }: { project: ProjectShown }) {
  const tone =
    project.kind === "repo"
      ? "bg-[var(--app-link)]/10 text-[var(--app-link)]"
      : project.kind === "path"
        ? "bg-[var(--app-subtle-bg)] text-[var(--app-fg)]"
        : "bg-[var(--app-subtle-bg)] italic text-[var(--app-hint)]";
  return (
    <HoverTooltipButton
      type="button"
      content={project.title}
      // A tap here can scroll the Create page by a pixel; that must not close
      // the bubble the same tap opened (#6780, measured on the real page).
      ignoreOpeningScroll
      data-testid="time-tracking-project"
      className={`min-w-0 cursor-default truncate rounded-full px-1.5 py-0.5 text-[length:var(--text-caption-xs)] font-medium ${tone}`}
    >
      {project.text}
    </HoverTooltipButton>
  );
}

export function TimeTrackingGroup({
  model,
}: {
  model: TimeTrackingGroupModel;
}) {
  const id = useId();
  const { state, derived, lockedReason, disabled, setters, errors } = model;
  const on = state.on && lockedReason === null;
  const ids = {
    toggle: `${id}-toggle`,
    category: `${id}-category`,
    rate: `${id}-rate`,
    note: `${id}-note`,
  };
  const currency = derived.currency ?? "";
  const placeholder = model.loading
    ? "Loading categories…"
    : "Choose a category";
  // F4 (closer review): a chosen category that left the list matches no
  // option. The select then shows the placeholder, enabled, so it never names
  // a category the state does not hold, and picking any offered one is a change.
  const chosenOffered =
    state.categoryKey !== null &&
    model.offered.some(c => categoryKey(c) === state.categoryKey);

  return (
    <div className="px-3 py-1" data-testid="time-tracking-group">
      <FormField
        label="Time Tracking"
        tooltip={TIME_TRACKING_INFO}
        labelAction={on ? <ProjectChip project={model.project} /> : undefined}
      >
        <div
          className="flex min-w-0 items-center gap-3"
          data-testid="time-tracking-toggle-row"
        >
          <UiToggle
            checked={on}
            onChange={setters.setOn}
            disabled={disabled || lockedReason !== null}
            hideText={on || lockedReason !== null}
            title="Track this session's time for billing"
            aria-label="Time Tracking"
            aria-invalid={model.toggleError ? true : undefined}
            aria-describedby={model.toggleError ? ids.toggle : undefined}
          />
          {lockedReason !== null ? (
            <HoverTooltip content={lockedReason}>
              <span
                tabIndex={0}
                data-testid="time-tracking-lock-reason"
                className="min-w-0 truncate text-xs text-[var(--app-hint)]"
              >
                {lockedReason}
              </span>
            </HoverTooltip>
          ) : on ? (
            // design-system exception: RadioRow is for "no answer yet is a real
            // state", SegmentedToggle for a value that always exists; the status
            // always exists, but only RadioRow gives each option a `title` and the
            // group a `disabled` state (R5's hover meaning; primitives.md).
            <RadioRow
              options={TRACKING_STATUS_OPTIONS.map(o => ({ ...o }))}
              value={state.status}
              onChange={v => v && setters.setStatus(v)}
              ariaLabel="Billing status"
              disabled={disabled}
            />
          ) : null}
        </div>
        {model.toggleError ? (
          <p
            role="alert"
            id={ids.toggle}
            data-testid="time-tracking-toggle-error"
            className={ERROR_LINE}
          >
            {model.toggleError}
          </p>
        ) : model.toggleHint && on ? (
          <p data-testid="time-tracking-toggle-hint" className={HINT_LINE}>
            {model.toggleHint}
          </p>
        ) : null}
        {on && model.listFailed !== null ? (
          <div className="mt-1.5 flex min-w-0 items-start gap-2">
            {/* #6780 (BR-A's rework): the whole sentence wraps at 393 px, Retry beside its first row. */}
            <p
              role="alert"
              data-testid="time-tracking-list-error"
              className="min-w-0 text-[length:var(--text-caption-xs)] text-destructive"
            >
              {model.listFailed}
            </p>
            <BareButton
              type="button"
              onClick={model.retry}
              title="Read the billing categories again"
              data-testid="time-tracking-retry"
              className="shrink-0 text-xs text-[var(--app-link)] hover:underline"
            >
              Retry
            </BareButton>
          </div>
        ) : null}
      </FormField>
      {on && model.listFailed === null ? (
        <>
          <div className="mt-1.5 flex gap-2">
            <div className="min-w-0 flex-[3]">
              <FormField label="Category">
                <UiSelect
                  data-testid="time-tracking-category"
                  aria-label="Category"
                  title="The session's billing category"
                  value={chosenOffered ? (state.categoryKey ?? "") : ""}
                  disabled={disabled}
                  aria-invalid={errors.category ? true : undefined}
                  aria-describedby={errors.category ? ids.category : undefined}
                  onChange={e => {
                    const item = model.offered.find(
                      c => categoryKey(c) === e.target.value
                    );
                    if (item) setters.pickCategory(item);
                  }}
                >
                  <option value="" disabled={chosenOffered}>
                    {placeholder}
                  </option>
                  {model.offered.map(c => (
                    <option key={categoryKey(c)} value={categoryKey(c)}>
                      {c.name}
                    </option>
                  ))}
                </UiSelect>
              </FormField>
            </div>
            <div className="min-w-0 flex-[2]">
              <FormField label="Hourly Rate">
                <div className="relative">
                  <UiInput
                    data-testid="time-tracking-rate"
                    aria-label="Hourly Rate"
                    title="The session's hourly rate"
                    inputMode="decimal"
                    placeholder="0.00"
                    className="pr-12"
                    value={state.rate?.text ?? ""}
                    disabled={disabled || !derived.currencyKnown}
                    aria-invalid={errors.rate ? true : undefined}
                    aria-describedby={errors.rate ? ids.rate : undefined}
                    onChange={e => setters.typeRate(e.target.value)}
                  />
                  {currency ? (
                    <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-[var(--app-hint)]">
                      {currency}/h
                    </span>
                  ) : null}
                </div>
              </FormField>
            </div>
          </div>
          {errors.category ? (
            <div className="flex min-w-0 items-start gap-2">
              <p
                role="alert"
                id={ids.category}
                data-testid="time-tracking-category-error"
                className={`${ERROR_LINE} min-w-0`}
              >
                {errors.category}
              </p>
              {model.categoryRetry ? (
                <BareButton
                  type="button"
                  onClick={model.retry}
                  title="Read the billing categories again"
                  data-testid="time-tracking-category-retry"
                  className="mt-1 shrink-0 text-xs text-[var(--app-link)] hover:underline"
                >
                  Retry
                </BareButton>
              ) : null}
            </div>
          ) : null}
          {errors.rate ? (
            <p
              role="alert"
              id={ids.rate}
              data-testid="time-tracking-rate-error"
              className={ERROR_LINE}
            >
              {errors.rate}
            </p>
          ) : null}
          {derived.defaultMoved ? (
            <div
              className="mt-1 flex min-w-0 items-start gap-2 text-[length:var(--text-caption-xs)] text-[var(--app-hint)]"
              data-testid="time-tracking-default-moved"
            >
              {/* #6780 (BR-A's rework): the new default's amount must be readable on a touch screen. */}
              <span className="min-w-0">
                The default rate changed to {derived.defaultMoved.text}/h.
              </span>
              <BareButton
                type="button"
                onClick={setters.restoreDefault}
                title="Use the category's current default rate"
                data-testid="time-tracking-use-default"
                className="shrink-0 text-xs text-[var(--app-link)] hover:underline"
              >
                Use it
              </BareButton>
            </div>
          ) : null}
          {derived.defaultRemoved ? (
            <div
              className="mt-1 flex min-w-0 items-start gap-2 text-[length:var(--text-caption-xs)] text-[var(--app-hint)]"
              data-testid="time-tracking-default-removed"
            >
              {/* BR-A (#6780): the whole sentence shows, wrapping at 393 px, because the amount
                  it asks the person to keep must be readable on a touch screen. */}
              <span className="min-w-0">
                {defaultRemovedWords(derived.defaultRemoved)}
              </span>
              <BareButton
                type="button"
                onClick={setters.keepRate}
                title={`Keep ${derived.defaultRemoved.text} ${derived.defaultRemoved.currency}/h as this session's rate`}
                data-testid="time-tracking-keep-rate"
                className="shrink-0 text-xs text-[var(--app-link)] hover:underline"
              >
                Keep it
              </BareButton>
            </div>
          ) : null}
          {derived.noteShown ? (
            <div className="mt-1.5">
              <FormField
                label="Special Rate Note"
                inlineDescription={
                  derived.defaultRate
                    ? `differs from the default, ${derived.defaultRate.text}/h`
                    : undefined
                }
              >
                <UiInput
                  data-testid="time-tracking-note"
                  aria-label="Special Rate Note"
                  title="Why this session's rate differs from the category's default"
                  placeholder="Why the rate differs"
                  maxLength={TRACKING_RATE_NOTE_MAX}
                  value={state.note}
                  disabled={disabled}
                  aria-invalid={errors.note ? true : undefined}
                  aria-describedby={errors.note ? ids.note : undefined}
                  onChange={e => setters.setNote(e.target.value)}
                />
              </FormField>
              {errors.note ? (
                <p
                  role="alert"
                  id={ids.note}
                  data-testid="time-tracking-note-error"
                  className={ERROR_LINE}
                >
                  {errors.note}
                </p>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
