// SPDX-License-Identifier: AGPL-3.0-only
import { memo, ReactNode } from "react";

interface FloatingOverlayProps {
  children: ReactNode;
  maxHeight?: number;
}

/**
 * A floating panel container with shadow and rounded corners
 * Used for autocomplete suggestions and settings panels
 */
export const FloatingOverlay = memo(function FloatingOverlay(
  props: FloatingOverlayProps
) {
  const { children, maxHeight = 240 } = props;

  return (
    <div
      className="overflow-hidden rounded-xl border border-[var(--app-divider)] bg-[var(--app-bg)] shadow-lg"
      style={{ maxHeight }}
    >
      <div
        className="overflow-y-auto"
        data-scrollable
        style={{ maxHeight, touchAction: "pan-y" }}
      >
        {children}
      </div>
    </div>
  );
});
