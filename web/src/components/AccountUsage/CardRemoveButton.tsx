// SPDX-License-Identifier: AGPL-3.0-only
/**
 * CardRemoveButton — the "Remove Account" / "Remove Key" text action at the
 * lower left of an expanded card on the Accounts page (issue #4466 R8): plain
 * weight, the deep-red token, body-dense size. The account, OpenAI and key
 * cards share it so the R8 look is one class list. The click stops at the
 * button, so a card-level handler never also sees it; the caller owns the
 * confirm and the layout around it.
 */
import { Button } from "@/components/ui/button";

export function CardRemoveButton(props: {
  label: string;
  testId: string;
  onRemove: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghostStatic"
      size="bare"
      data-testid={props.testId}
      onClick={e => {
        e.stopPropagation();
        props.onRemove();
      }}
      className="font-normal text-[length:var(--text-body-dense)] text-[var(--destructive)] hover:opacity-80"
    >
      {props.label}
    </Button>
  );
}
