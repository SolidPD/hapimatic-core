// SPDX-License-Identifier: AGPL-3.0-only
import { useState, useEffect } from "react";

/**
 * Tracks the iOS *visual* viewport height (as a number) so an 80%-height modal
 * never overflows the screen and shrinks correctly when the keyboard opens.
 *
 * Shared by the Create-Session pickers (`DirectoryBrowser`, `PickerModal`), which
 * previously each held an identical private copy.
 *
 * NOTE: a separate, intentionally-different hook of the same name lives in
 * `components/ui/dialog.tsx` — it returns a CSS string (`"<n>px"`) and debounces
 * updates. That one is NOT consolidated here (different return type + behavior).
 */
export function useVisualViewportHeight(): number {
  const [h, setH] = useState(
    () => window.visualViewport?.height ?? window.innerHeight
  );
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setH(vv.height);
    update();
    vv.addEventListener("resize", update);
    return () => vv.removeEventListener("resize", update);
  }, []);
  return h;
}
