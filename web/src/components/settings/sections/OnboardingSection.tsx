// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useVersion } from "@/hooks/useVersion";
import { buildGatewaySetupUrl } from "@/lib/ssoStartUrl";
import { Button } from "@/components/ui/button";
import { IconSectionHeading } from "@/components/settings/IconSectionHeading";

/**
 * OnboardingSection — the Admin → Preferences "Onboarding" section (#2711).
 *
 * A single "Restart onboarding" control that REOPENS the gateway setup wizard.
 * Re-entry already works by URL (the gateway `/setup` wizard renders current state
 * and honors `?step=X`), so this is a navigation affordance — it clears NO state,
 * client- or server-side. All onboarding state is gateway-side SQLite and untouched
 * (reopen-only, ruled 2026-08-12; a clean "start over" is a separate gateway
 * follow-up, sequenced after #2633/#2844).
 *
 * ssoEnabled-gated (#2312, R4): renders NOTHING unless the server reports
 * `ssoEnabled === true` on /api/version. `buildGatewaySetupUrl` always resolves to
 * the apex gateway (`hapimatic.com`) and CANNOT tell that a self-hosted / `.ts.net` /
 * localhost host has no gateway — so an ungated control would send such a user to a
 * gateway that never provisioned them. Where there is no provisioning gateway, the
 * section does not exist.
 *
 * Unlike its sibling sections (whose <section> wrapper lives in preferences.tsx),
 * this component owns its own <section id="onboarding"> so the ssoEnabled gate can
 * hide the ENTIRE section (heading included) with a single `return null` — the
 * directive-preferred "do not render the section at all". The rendered DOM is
 * otherwise identical to the sibling sections (same anchored <section> + icon-chip
 * <h2>). Rendered inside routes/settings/preferences.tsx after the #session-handoff
 * section; deep-linkable via /settings/preferences#onboarding (useScrollToLocationHash
 * is wired globally on that page).
 *
 * Expect a sign-in interstitial: `GET /setup` 302-redirects to the gateway sign-in
 * when there is no live gateway session, so the confirm copy anticipates it.
 */
export function OnboardingSection() {
  const { data: versionInfo } = useVersion();
  const ssoEnabled = versionInfo?.ssoEnabled === true;
  const [confirmOpen, setConfirmOpen] = useState(false);

  // R4: no provisioning gateway → no control. Hiding the whole section (not just
  // disabling the button) avoids ever showing an affordance that would link to a
  // gateway which never provisioned this instance.
  if (!ssoEnabled) return null;

  return (
    <section
      id="onboarding"
      aria-label="Onboarding"
      className="flex scroll-mt-2 flex-col gap-3 border-t border-[var(--app-border)] pt-6"
    >
      <IconSectionHeading
        icon={RotateCcw}
        accent="var(--accent-emerald-400)"
        title="Onboarding"
      />

      <div className="flex flex-col gap-3">
        <p className="text-sm text-[var(--app-hint)]">
          Reopen the setup wizard to revisit your connection steps (Claude
          accounts, VM, and more). This takes you back to onboarding without
          changing anything you have already set up.
        </p>
        <div>
          <Button
            variant="outline"
            type="button"
            data-testid="restart-onboarding-button"
            onClick={() => setConfirmOpen(true)}
            className="h-auto gap-2 rounded-lg bg-[var(--app-bg)] px-4 py-2.5 text-[var(--app-fg)] transition-all hover:border-[var(--brand-accent)] hover:bg-[var(--app-bg)]"
          >
            <RotateCcw className="h-4 w-4" />
            Restart onboarding
          </Button>
        </div>
      </div>

      <ConfirmDialog
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Reopen onboarding?"
        description="You'll be taken to hapimatic.com to revisit the setup wizard — you may be asked to sign in. Your existing setup is kept; nothing is reset."
        confirmLabel="Reopen setup"
        confirmingLabel="Opening…"
        isPending={false}
        onConfirm={async () => {
          // REOPEN ONLY — navigate to the gateway wizard, clearing no state.
          window.location.href = buildGatewaySetupUrl(
            window.location.hostname,
            "claude"
          );
        }}
      />
    </section>
  );
}
