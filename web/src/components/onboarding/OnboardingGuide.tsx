// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { OnboardingStep } from "./onboardingSteps";

/** How long a step looks for its control, because pages load their data first. */
export const GUIDE_TARGET_RETRY_MS = 3000;
const GUIDE_TARGET_INTERVAL_MS = 150;

/**
 * Marks the control a step points at and brings it into view. A control that never
 * appears is fine: the panel's path text and buttons still work (R21). Runs only
 * while `active`, and takes the mark off again on the way out.
 */
export function useGuideTarget(guide: string | undefined, active: boolean) {
  useEffect(() => {
    if (!guide || !active) return;
    let marked: Element | null = null;
    const started = Date.now();
    const find = () => {
      const target = document.querySelector(`[data-guide="${guide}"]`);
      if (!target) return false;
      marked = target;
      target.setAttribute("data-guide-active", "true");
      target.scrollIntoView?.({ block: "center", behavior: "smooth" });
      return true;
    };
    let timer: ReturnType<typeof setInterval> | undefined;
    if (!find()) {
      timer = setInterval(() => {
        if (find() || Date.now() - started >= GUIDE_TARGET_RETRY_MS) {
          clearInterval(timer);
        }
      }, GUIDE_TARGET_INTERVAL_MS);
    }
    return () => {
      if (timer) clearInterval(timer);
      (marked as Element | null)?.removeAttribute("data-guide-active");
    };
  }, [guide, active]);
}

export interface OnboardingGuideProps {
  step: OnboardingStep;
  /** 1-based. */
  position: number;
  total: number;
  /** The user is on this step's page. */
  onStepPage: boolean;
  /** The step reads as done, or has nothing to wait for. */
  ready: boolean;
  /** "Connected ✓" lines. Account or key names only, never key material. */
  statusLines: string[];
  /** What the primary button reads on this step's page. */
  primaryLabel?: string;
  /** Replaces the body, for the tour's cards. */
  children?: ReactNode;
  onGoToPage: () => void;
  onNext: () => void;
  onSkip: () => void;
  onClose: (opts: { dontShowAgain: boolean }) => void;
}

/**
 * The first-run wizard's panel (#6211). NON-modal, so the real page stays usable
 * beneath it: the user acts on the page, and a modal would block that. It sits at
 * the bottom on a phone and bottom-right on a desktop, below dialogs (`z-40`;
 * `Dialog` is `z-50`), so a real dialog such as Add to Anthropic opens over it. It
 * never advances by itself, so nothing jumps while the user reads. Every control is
 * `type="button"`, because `Button` has no default type and a page beneath may
 * hold a form.
 */
export function OnboardingGuide({
  step,
  position,
  total,
  onStepPage,
  ready,
  statusLines,
  primaryLabel,
  children,
  onGoToPage,
  onNext,
  onSkip,
  onClose,
}: OnboardingGuideProps) {
  const [dontShowAgain, setDontShowAgain] = useState(false);

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label="Set up Hapimatic"
      data-testid="onboarding-guide"
      className="fixed inset-x-0 bottom-0 z-40 flex max-h-[60dvh] flex-col gap-2 overflow-y-auto rounded-t-xl border-t border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] text-[var(--app-fg)] shadow-lg sm:inset-x-auto sm:bottom-4 sm:right-4 sm:w-96 sm:rounded-xl sm:border sm:pb-4"
    >
      <p
        aria-live="polite"
        data-testid="onboarding-progress"
        className="text-[length:var(--text-caption)] font-medium text-[var(--app-hint)]"
      >
        Step {position} of {total}
      </p>
      <h2 className="text-[length:var(--text-label-strong)] font-semibold">
        {step.title}
      </h2>
      {step.route !== "/sessions" && (
        <p
          data-testid="onboarding-menu-path"
          className="text-[length:var(--text-caption)] text-[var(--app-hint)]"
        >
          {step.menuPath}
        </p>
      )}
      {children ?? (
        <p className="text-[length:var(--text-body)] leading-relaxed">
          {step.body}
        </p>
      )}
      {statusLines.map(line => (
        <p
          key={line}
          role="status"
          className="text-[length:var(--text-body)] text-[var(--status-ok)]"
          data-testid="onboarding-status-line"
        >
          {line}
        </p>
      ))}
      {step.skipNote && !ready && (
        <p
          className="text-[length:var(--text-caption)] text-[var(--app-hint)]"
          data-testid="onboarding-skip-note"
        >
          {step.skipNote}
        </p>
      )}
      <div className="mt-1 flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          data-testid="onboarding-skip"
          onClick={onSkip}
        >
          Skip for now
        </Button>
        {onStepPage ? (
          <Button
            type="button"
            data-testid="onboarding-next"
            disabled={!ready}
            onClick={onNext}
          >
            {primaryLabel ?? "Next"}
          </Button>
        ) : (
          <Button
            type="button"
            data-testid="onboarding-go-to-page"
            onClick={onGoToPage}
          >
            Go to {step.pageName}
          </Button>
        )}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-[var(--app-border)] pt-2">
        <label className="flex items-center gap-2 text-[length:var(--text-caption)] text-[var(--app-hint)]">
          <input
            type="checkbox"
            data-testid="onboarding-dont-show"
            checked={dontShowAgain}
            onChange={e => setDontShowAgain(e.target.checked)}
          />
          Don&apos;t show this again
        </label>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="onboarding-close"
          onClick={() => onClose({ dontShowAgain })}
        >
          Close
        </Button>
      </div>
    </div>
  );
}
