// SPDX-License-Identifier: AGPL-3.0-only
type ColorScheme = "light" | "dark";

function isIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}

/**
 * Hapimatic always uses dark mode — no system preference detection needed.
 */
export function useTheme(): { colorScheme: ColorScheme; isDark: boolean } {
  return { colorScheme: "dark", isDark: true };
}

/**
 * Apply dark theme and platform class at app startup.
 */
export function initializeTheme(): void {
  document.documentElement.setAttribute("data-theme", "dark");
  if (isIOS()) {
    document.documentElement.classList.add("ios");
  }
}
