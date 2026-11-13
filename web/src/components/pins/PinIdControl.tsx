// SPDX-License-Identifier: AGPL-3.0-only
import { CopyValueChip } from "@/components/pins/CopyValueChip";
import { HoverTooltipButton } from "@/components/ui/tooltip";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";

/** The mockup's wording (`pin-id-mockup-v1.html`, variant C). */
export const PIN_ID_TOOLTIP =
  "Copy this pin's ID. Any session can read the pin by it; only its own session can change it.";

/**
 * #6574: a pin's ID, tap to copy. Two forms:
 * - `chip`, the facts line at the top of an open pin (Matt's pick C): the dense
 *   bordered copy chip, the copy icon after the ID, a check while copied;
 * - `text`, the answers message: mono hint-coloured text with no border and no icon,
 *   green while copied, so the message stays a message.
 * `copy` runs synchronously in the click handler because the iOS fallback needs the
 * gesture (`CopyValueChip.tsx`). A pin with no ID renders nothing.
 */
export function PinIdControl(props: {
  pinId: string | null | undefined;
  form: "chip" | "text";
}) {
  if (!props.pinId) return null;
  return props.form === "chip" ? (
    <CopyValueChip
      dense
      value={props.pinId}
      tooltip={PIN_ID_TOOLTIP}
      ariaLabel={`Copy pin ID ${props.pinId}`}
    />
  ) : (
    <PinIdText pinId={props.pinId} />
  );
}

function PinIdText(props: { pinId: string }) {
  const { copied, copy } = useCopyToClipboard();
  return (
    <HoverTooltipButton
      type="button"
      content={PIN_ID_TOOLTIP}
      aria-label={`Copy pin ID ${props.pinId}`}
      onClick={() => {
        void copy(props.pinId);
      }}
      data-copied={copied || undefined}
      className={`inline whitespace-nowrap font-mono text-[length:var(--text-caption)] hover:underline ${
        copied ? "text-[var(--status-ok)]" : "text-[var(--app-hint)]"
      }`}
    >
      {props.pinId}
    </HoverTooltipButton>
  );
}
