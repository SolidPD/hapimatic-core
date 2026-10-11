// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { ChevronIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { AddAccountInstructions } from "@/components/AddAccountInstructions";
import { AddAccountWizard } from "@/components/AddAccountWizard";
import { useAppContext } from "@/lib/app-context";
import { useRefreshAccountUsage } from "@/hooks/queries/useAccountUsage";

/**
 * AddAccountSection — the add-account entry point at the bottom of the Account
 * Usage page (epic #2049, Sub-Issue F / #2055; in-app wizard entry added by
 * #3452).
 *
 * Header row: an "Add account" button that opens the in-app OAuth wizard
 * (`AddAccountWizard`, #1263) — the PRIMARY path — beside the "How to add a
 * new account" chevron toggle. Expanding the toggle reveals the shared
 * `AddAccountInstructions` host-login procedure, retained as the fallback for
 * environments where the in-app flow can't be used (R4 — single source of
 * truth, also rendered by the switch modal's help panel).
 *
 * Why the button lives here (#3452): after Sub-Issue G (#2056) stripped the
 * add-account buttons from the Switch Account modal, the wizard was reachable
 * ONLY from that modal's zero-accounts empty state — so on any instance with a
 * stored account there was no way to open it at all. This section is rendered
 * unconditionally by the page (in every state, like `DeviceConnectionFooter`),
 * so the entry point is always available.
 *
 * The wizard is mounted only while open: `useAccountLogin` is a mutation hook
 * and the wizard starts a login in its open-effect, so there is no reason to
 * instantiate either on every page render. On `onAdded` the page's usage list
 * is refreshed the way the Refresh button does it (`useRefreshAccountUsage`,
 * `?force=1`): the 60s auto-poll reads the server's push-to-cache snapshot
 * (#1909), which does not contain the new account until the sampler's next
 * cycle, so a plain query invalidation re-fetched stale data and the new card
 * only appeared after a manual refresh (#3452 iteration 2). `useAccountLogin`
 * already invalidates `queryKeys.accounts`.
 */
export function AddAccountSection() {
  const [expanded, setExpanded] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const { api } = useAppContext();
  const refreshUsage = useRefreshAccountUsage(api);

  return (
    <div
      data-testid="add-account-section"
      className="mt-2 rounded-[13px] border border-[var(--app-border)] bg-[var(--app-secondary-bg)]" /* design-tokens-allow: 13px card radius — no --radius token (ladder tops at ~11px) or Tailwind utility maps to 13px (L3 #3405) */
    >
      <div className="flex items-center gap-2 px-3.5 py-1.5">
        <Button
          type="button"
          variant="ghostStatic"
          size="bare"
          onClick={() => setExpanded(e => !e)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center justify-start gap-2.5 text-left font-normal hover:text-[var(--app-fg)]"
        >
          <ChevronIcon
            className="h-3.5 w-3.5 shrink-0 text-[var(--app-hint)]"
            collapsed={!expanded}
          />
          <span className="min-w-0 truncate text-[length:var(--text-label-strong)] font-medium leading-none text-[var(--app-fg)]">
            How to add a new account
          </span>
        </Button>
        <Button
          type="button"
          size="sm"
          className="shrink-0"
          onClick={() => setWizardOpen(true)}
        >
          Add account
        </Button>
      </div>

      {expanded && (
        <div className="flex flex-col gap-3 border-t border-[var(--app-border)] px-3.5 py-2 text-sm text-[var(--app-fg)]">
          <AddAccountInstructions intro="Alternatively, add an account by logging in directly on the target machine:" />
        </div>
      )}

      {wizardOpen && (
        <AddAccountWizard
          isOpen
          onClose={() => setWizardOpen(false)}
          api={api}
          onAdded={() => {
            void refreshUsage();
          }}
        />
      )}
    </div>
  );
}
