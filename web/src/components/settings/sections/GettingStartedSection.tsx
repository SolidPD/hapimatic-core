// SPDX-License-Identifier: AGPL-3.0-only
import { Compass } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconSectionHeading } from "@/components/settings/IconSectionHeading";
import { useAppContext } from "@/lib/app-context";
import {
  requestOpenOnboarding,
  useOnboardingState,
  type OnboardingStateView,
} from "@/hooks/useOnboardingState";

function buttonLabel(state: OnboardingStateView): string {
  if (state !== "unknown" && state.status === "dismissed")
    return "Finish setup";
  if (state !== "unknown" && state.status === "completed")
    return "Re-run setup";
  // `pending`, and `unknown` (the read is in flight or failed).
  return "Start the tour";
}

/**
 * GettingStartedSection — the Settings → Preferences "Getting started" re-entry
 * to the in-app first-run tour (#3865, UX_SPEC §2/§5).
 *
 * ⚠️ DISTINCT from `OnboardingSection` (#2711), which reopens the GATEWAY signup
 * wizard (gateway-side state, `ssoEnabled`-gated). This section re-opens the
 * IN-APP tour, whose state is node-local, so it renders on every instance — a
 * self-hoster with no gateway gets the tour too. Its anchor is
 * `#getting-started`; `#onboarding` stays the gateway section's deep link.
 *
 * The button asks the app-level `OnboardingHost` to open the tour (the
 * `hapi:onboarding-open` window event) over the current page, at the first
 * incomplete step. It is enabled in every state, because this entry is the way
 * in whenever the state cannot be determined. Its label follows the state read
 * on mount: "Finish setup" after a dismissal, "Re-run setup" after completion,
 * "Start the tour" otherwise.
 *
 * Owns its own `<section>` (like `OnboardingSection`) so it renders identically
 * wherever it is placed; rendered in `routes/settings/preferences.tsx` directly
 * above `OnboardingSection`, deep-linked from the drawer's "Getting started"
 * sub-row.
 */
export function GettingStartedSection() {
  const { api } = useAppContext();
  const { state } = useOnboardingState(api);

  return (
    <section
      id="getting-started"
      aria-label="Getting started"
      className="flex scroll-mt-2 flex-col gap-3 border-t border-[var(--app-border)] pt-6"
    >
      <IconSectionHeading
        icon={Compass}
        accent="var(--accent-sky-400)"
        title="Getting started"
      />

      <div className="flex flex-col gap-3">
        <p className="text-sm text-[var(--app-hint)]">
          A five-card tour of where your sessions live, how to start one, and
          where to watch your usage and connect your model providers. It changes
          nothing — skip it whenever you like.
        </p>
        <div>
          <Button
            variant="outline"
            type="button"
            data-testid="getting-started-button"
            onClick={requestOpenOnboarding}
            className="h-auto gap-2 rounded-lg bg-[var(--app-bg)] px-4 py-2.5 text-[var(--app-fg)] transition-all hover:border-[var(--brand-accent)] hover:bg-[var(--app-bg)]"
          >
            <Compass className="h-4 w-4" />
            {buttonLabel(state)}
          </Button>
        </div>
      </div>
    </section>
  );
}
