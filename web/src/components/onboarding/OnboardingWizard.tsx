// SPDX-License-Identifier: AGPL-3.0-only
import { useRef, useState, type FormEvent } from "react";
import type { OnboardingStepId } from "@hapi/protocol/schemas";
import { DialogForm } from "@/components/layouts/DialogForm";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { TOUR_CARDS, tourIndexOf } from "./tourCards";

export interface OnboardingWizardProps {
  open: boolean;
  /** The card the tour opens on (resume). Read once per mount — key the wizard per open. */
  initialStep: OnboardingStepId;
  /** The primary advanced to a new card; `step` is the card now shown (the step reached). */
  onAdvance: (step: OnboardingStepId) => void;
  /** Any close path — Skip, the ✕, Escape, a backdrop click — with the card the user was on. */
  onDismiss: (step: OnboardingStepId) => void;
  /** The primary on the last card. */
  onComplete: () => void;
}

/**
 * The in-app first-run feature tour (#3865, UX_SPEC §3/§5): cards T1–T5 in a
 * centered dialog (OQ-1) on every viewport, hosting the `DialogForm` template —
 * pinned title, the body as the single scroll owner, pinned footer.
 *
 * Controlled and presentational: no data fetching; the app-level
 * `OnboardingHost` owns persistence and when the tour is open.
 *
 * Hosting recipe (DialogForm has no other app consumer to copy):
 * - `heightVariant="threeQuarter"` gives the panel a definite height; without it
 *   DialogForm's `max-h-full` resolves against an auto-height parent, the body
 *   never scrolls and the footer is never pinned. The whole panel, footer
 *   included, sits inside the visible viewport, which is how the footer clears
 *   the home indicator (the `Dialog` primitive pads safe-area insets only on its
 *   `fullscreen` variant).
 * - DialogForm wraps its regions in a `<form>` and `Button` sets no default
 *   `type`, so the primary is an explicit `type="submit"` driven by `onSubmit`
 *   with `preventDefault()` (Enter advances, nothing reloads) and the secondary
 *   is an explicit `type="button"`.
 * - `onOpenChange(false)` — the ✕, Escape and a backdrop click — routes into the
 *   same `onDismiss(currentStep)` as the Skip control.
 */
export function OnboardingWizard({
  open,
  initialStep,
  onAdvance,
  onDismiss,
  onComplete,
}: OnboardingWizardProps) {
  const [index, setIndex] = useState(() => tourIndexOf(initialStep));
  const primaryRef = useRef<HTMLButtonElement>(null);
  const card = TOUR_CARDS[index];
  const isLast = index === TOUR_CARDS.length - 1;
  const Illustration = card.Illustration;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isLast) {
      onComplete();
      return;
    }
    const next = index + 1;
    setIndex(next);
    onAdvance(TOUR_CARDS[next].id);
  };

  const dismiss = () => onDismiss(card.id);

  return (
    <Dialog
      open={open}
      onOpenChange={nextOpen => {
        if (!nextOpen) dismiss();
      }}
    >
      <DialogContent
        heightVariant="threeQuarter"
        className="flex flex-col"
        data-testid="onboarding-wizard"
        description="A five-card tour of Hapimatic. You can skip it at any time and reopen it from Settings, Preferences, Getting started."
        onOpenAutoFocus={event => {
          // Focus the primary so Enter advances; the first tabbable element in
          // the DOM is the Skip control, and Enter there would dismiss.
          event.preventDefault();
          primaryRef.current?.focus();
        }}
      >
        <DialogForm
          className="h-full"
          onSubmit={handleSubmit}
          title={
            // pr-8 keeps the caption and title clear of the app-wide ✕ (#2057),
            // which sits absolutely in the panel's top-right corner.
            <div className="flex flex-col gap-1 pb-3 pr-8">
              <p
                aria-live="polite"
                data-testid="onboarding-progress"
                className="text-[length:var(--text-caption)] font-medium text-[var(--app-hint)]"
              >
                Step {index + 1} of {TOUR_CARDS.length}
              </p>
              <DialogTitle className="text-[length:var(--text-label-strong)] font-semibold leading-snug tracking-normal text-[var(--app-fg)]">
                {card.title}
              </DialogTitle>
            </div>
          }
          footer={
            <div className="flex items-center justify-between gap-3 border-t border-[var(--app-border)] pt-3">
              <Button
                type="button"
                variant="ghost"
                data-testid="onboarding-skip"
                onClick={dismiss}
              >
                Skip / Do this later
              </Button>
              <Button
                ref={primaryRef}
                type="submit"
                size="lg"
                data-testid="onboarding-next"
              >
                {isLast ? "Finish" : "Next"}
              </Button>
            </div>
          }
        >
          <div className="flex flex-col items-center gap-4 py-2">
            <Illustration />
            <p className="w-full text-[length:var(--text-body)] leading-relaxed text-[var(--app-fg)]">
              {card.body}
            </p>
          </div>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}
