// SPDX-License-Identifier: AGPL-3.0-only
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/Spinner";

export function ActionButtons(props: {
  isPending: boolean;
  canCreate: boolean;
  isDisabled: boolean;
  onCancel: () => void;
  onCreate: () => void;
}) {
  return (
    <div className="flex justify-end gap-2 px-3 py-1.5">
      <Button
        variant="secondary"
        onClick={props.onCancel}
        disabled={props.isDisabled}
      >
        Cancel
      </Button>
      <Button
        onClick={props.onCreate}
        // #3149: suppress the focused-field blur on tap so a first tap with the
        // iOS virtual keyboard open registers. Without this, the tap blurs the
        // field → the keyboard dismisses → the visual viewport resizes and this
        // pinned footer relayouts → WebKit's synthesized click misses the moved
        // button and only the second tap fires. preventDefault on pointerdown
        // keeps the field focused (no dismiss, no relayout) while leaving onClick
        // intact for desktop mouse + keyboard (Enter/Space) activation. Same
        // blur-suppression idiom as SessionNotes / LinkIssueField / Autocomplete.
        onPointerDown={e => e.preventDefault()}
        disabled={!props.canCreate}
        aria-busy={props.isPending}
        className="gap-2"
      >
        {props.isPending ? (
          <>
            <Spinner
              size="sm"
              label={null}
              className="text-[var(--app-button-text)]"
            />
            Creating...
          </>
        ) : (
          "Create"
        )}
      </Button>
    </div>
  );
}
