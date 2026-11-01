// SPDX-License-Identifier: AGPL-3.0-only
/**
 * OtherWaysToAddPopover — the dotted "Other ways to add an account" link at the
 * lower right of each provider section on the Accounts page (issue #4466 R10).
 * It opens a popover with that provider's host-side add procedure
 * (`AddAccountInstructions`); the in-app add is the section header's "+ Add".
 * The "+ Add" modal shows the OpenAI steps too, as its fallback on a node where
 * in-app sign-in is unavailable.
 */
import type { ProviderId } from "@hapi/protocol";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { AddAccountInstructions } from "@/components/AddAccountInstructions";

export function OtherWaysToAddPopover(props: { provider: ProviderId }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghostStatic"
          size="bare"
          data-testid={`other-ways-to-add-${props.provider}`}
          className="text-[length:var(--text-caption)] font-normal text-[var(--app-hint)] underline decoration-dotted underline-offset-2 hover:text-[var(--app-fg)]"
        >
          Other ways to add an account
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        data-testid={`other-ways-to-add-${props.provider}-content`}
        className="flex w-80 flex-col gap-2 text-[length:var(--text-body)]"
      >
        <AddAccountInstructions provider={props.provider} />
      </PopoverContent>
    </Popover>
  );
}
