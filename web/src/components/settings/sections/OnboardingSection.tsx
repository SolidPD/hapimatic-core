// SPDX-License-Identifier: AGPL-3.0-only
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconSectionHeading } from "@/components/settings/IconSectionHeading";
import { requestRestartOnboarding } from "@/hooks/useOnboardingState";
import { useVersion } from "@/hooks/useVersion";
import { buildGatewaySetupUrl } from "@/lib/ssoStartUrl";

/**
 * OnboardingSection — the one "Restart onboarding" control (#6211 R16), on every
 * install type, with no hapimatic.com round trip. It replaces both the
 * "Getting started" section and the button to the gateway's `/setup` wizard.
 *
 * It only asks: the app-level `OnboardingHost` is the one writer of the onboarding
 * state, because that state's hook reads once per consumer and a second writer would
 * leave the host stale. It resets nothing but progress, so it needs no confirm.
 *
 * On a gateway-backed instance a plain link stays, because this section is the only
 * in-app route to what still lives on hapimatic.com (Wrike and other agent
 * connectors). `buildGatewaySetupUrl` cannot tell that a self-hosted, `.ts.net` or
 * localhost host has no gateway, so the link is gated on `ssoEnabled` (#2312).
 *
 * It owns its own `<section id="onboarding">`, deep-linked from the Settings menu's
 * sub-row and from `/settings/preferences#onboarding`.
 */
export function OnboardingSection() {
  const { data: versionInfo } = useVersion();
  const ssoEnabled = versionInfo?.ssoEnabled === true;

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
          Walk through setup again from the first step: connecting a model, then
          the rest. It changes nothing you have already set up.
        </p>
        <div>
          <Button
            variant="outline"
            type="button"
            data-testid="restart-onboarding-button"
            onClick={requestRestartOnboarding}
            className="h-auto gap-2 rounded-lg bg-[var(--app-bg)] px-4 py-2.5 text-[var(--app-fg)]"
          >
            <RotateCcw className="h-4 w-4" />
            Restart onboarding
          </Button>
        </div>
        {ssoEnabled && (
          <a
            href={buildGatewaySetupUrl(window.location.hostname, "providers")}
            data-testid="onboarding-gateway-link"
            className="self-start text-sm text-[var(--app-link)] underline"
          >
            More on hapimatic.com
          </a>
        )}
      </div>
    </section>
  );
}
