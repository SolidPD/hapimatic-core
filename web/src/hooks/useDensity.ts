// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect } from "react";
import { useAdminPreferences, type DensityMode } from "./useAdminPreferences";

// Maps each density mode to the vertical row padding (in px) applied via the
// global --row-padding-y CSS variable. `normal` matches the prior `py-1.5`
// Tailwind utility (6px); `compact` is half; `ultra` is near-minimal (1px
// keeps a non-zero gap so rows do not visually merge).
const DENSITY_TO_PADDING_Y_PX: Record<DensityMode, number> = {
  normal: 6,
  compact: 3,
  ultra: 1,
};

export const DENSITY_LABELS: Record<DensityMode, string> = {
  normal: "Normal",
  compact: "Compact",
  ultra: "Ultra",
};

export default function useDensity(): {
  density: DensityMode;
  setDensity: (density: DensityMode) => void;
  DENSITY_TO_PADDING_Y_PX: Record<DensityMode, number>;
} {
  const { prefs, setDensity } = useAdminPreferences();

  useEffect(() => {
    const px = DENSITY_TO_PADDING_Y_PX[prefs.density];
    document.documentElement.style.setProperty("--row-padding-y", `${px}px`);
  }, [prefs.density]);

  return { density: prefs.density, setDensity, DENSITY_TO_PADDING_Y_PX };
}
