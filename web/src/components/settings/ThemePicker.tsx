// SPDX-License-Identifier: AGPL-3.0-only
import { useThemeSelection } from "@/design/ThemeProvider";
import { DEFAULT_THEME_ID } from "@/design/themes";
import { Button } from "@/components/ui/button";

/**
 * C2 theme picker (#1987) — a settings control that lists C1's (#1986) curated
 * accent themes and switches the active one. A PURE CONSUMER of C1's engine: it
 * reads `availableThemes` + `activeThemeId` and calls `setActiveTheme(id)`; it
 * defines no palettes and writes no CSS variables itself. "Live preview" is free —
 * C1 applies the palette synchronously on selection (`useLayoutEffect(applyPalette)`),
 * so tapping an option re-themes the whole app (including this picker) instantly.
 * Persistence across reloads is C3's (#1988) job, not C2's.
 *
 * Hosted as a "Theme" section on the Preferences page (`routes/settings/preferences.tsx`).
 * Pattern: the in-file "System Health Icon" `role="radiogroup"` + `flex flex-wrap
 * gap-2` variant (scales to N themes, wraps at 393px → no horizontal scroll — R6),
 * with the Text-Scale disabled-button idiom for reset (R4).
 */
export function ThemePicker() {
  const { activeThemeId, availableThemes, setActiveTheme } =
    useThemeSelection();
  const atDefault = activeThemeId === DEFAULT_THEME_ID;

  return (
    <section className="flex flex-col gap-2">
      {/* Inlined SectionHeading class — `SectionHeading` is a private non-exported
          local in preferences.tsx, so importing/extracting would be scope creep. */}
      <h2 className="text-[length:var(--text-caption)] font-medium uppercase tracking-wide text-[var(--app-hint)]">
        Theme
      </h2>

      <div
        role="radiogroup"
        aria-label="Theme"
        className="flex flex-wrap gap-2"
      >
        {availableThemes.map(theme => {
          const selected = activeThemeId === theme.id;
          return (
            <Button
              key={theme.id}
              variant="ghost"
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={theme.label}
              onClick={() => setActiveTheme(theme.id)}
              className={`h-auto justify-start gap-2 px-3 py-2 ${
                selected
                  ? "bg-[var(--app-link)] text-[var(--app-button-text)] hover:bg-[var(--app-link)] hover:text-[var(--app-button-text)]"
                  : "bg-[var(--app-secondary-bg)] text-[var(--app-fg)] hover:bg-white/10 hover:text-[var(--app-fg)]"
              }`}
            >
              {/* Decorative accent swatch. A thin border keeps it legible even
                  when the chip background IS this accent (the selected option). */}
              <span
                aria-hidden
                className="h-4 w-4 flex-shrink-0 rounded-full border border-black/20"
                style={{ backgroundColor: theme.vars["--palette-accent"] }}
              />
              <span>{theme.label}</span>
            </Button>
          );
        })}
      </div>

      <Button
        variant="ghostStatic"
        size="bare"
        type="button"
        onClick={() => setActiveTheme(DEFAULT_THEME_ID)}
        disabled={atDefault}
        className="self-start text-xs font-medium text-[var(--app-link)] hover:text-[var(--app-link)] hover:underline disabled:cursor-default disabled:no-underline disabled:opacity-40"
      >
        Reset to default
      </Button>

      <p className="text-xs text-[var(--app-hint)]">
        Selecting a theme applies it instantly. Saving your choice across
        reloads is coming soon.
      </p>
    </section>
  );
}
