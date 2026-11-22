// SPDX-License-Identifier: AGPL-3.0-only
/**
 * SignInAgainButton — the "Sign in again" button on a node that needs a new
 * sign-in (issue #6161): the account card's attention tiles and the "Ending
 * soon" list's node rows. It opens the existing re-login for that node
 * (`requestRelogin`, the "+ Add" modal on the node). The look is the card's
 * subtle button (the Retry button in `AccountUsageCard.tsx`), so a row of them
 * keeps the 34 px row pitch. A tap never reaches the card or row it sits in.
 */
import { Button } from "@/components/ui/button";
import { requestRelogin } from "@/lib/reloginLink";

export function SignInAgainButton(props: {
  nodeId: string;
  nodeLabel: string;
  accountUuid: string;
  /** Names the account in the tooltip ("Sign in again to Work on RP1"). */
  accountLabel: string;
  "data-testid"?: string;
}) {
  const { nodeId, nodeLabel, accountUuid, accountLabel } = props;
  return (
    <Button
      type="button"
      variant="outline"
      data-testid={props["data-testid"] ?? "sign-in-again"}
      title={`Sign in again to ${accountLabel} on ${nodeLabel}`}
      onPointerDown={e => e.stopPropagation()}
      onClick={e => {
        e.stopPropagation();
        requestRelogin({ provider: "anthropic", nodeId, accountUuid });
      }}
      className="h-auto shrink-0 whitespace-nowrap rounded-md bg-[var(--app-subtle-bg)] px-2 py-0.5 text-[length:var(--text-body-dense)] text-[var(--app-fg)] hover:bg-[var(--app-hover)]"
    >
      Sign in again
    </Button>
  );
}
