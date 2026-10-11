// SPDX-License-Identifier: AGPL-3.0-only
/**
 * C1 theme registry — the named accent themes the runtime theme switcher (#1986)
 * selects from. A theme is a `{ id, label, vars }` triple where `vars` is a map of
 * A1's palette-source custom properties (`--palette-accent` / `--palette-accent-fg`)
 * to concrete values. Selecting a theme applies its `vars` via A1's `applyPalette`
 * (see `./ThemeProvider.tsx`), which flips the source vars every token-consuming
 * component resolves through — so a theme swap re-colors the whole app with ZERO
 * per-component edits (R2/R6).
 *
 * Scope is CURATED ACCENTS on the shared charcoal base, not full background
 * palettes: A1's MVP makes only the accent swappable (`--palette-accent`), not the
 * charcoal surfaces. The `{ id, label, vars }` structure generalizes to full
 * palettes for free once A1 exposes surface source-vars — that would be an A1
 * extension (PM-escalated), not a C1 patch.
 *
 * Parent epic: #1985 (Theme Customization). Consumes A1 (#1977). Feeds C2 (#1987
 * picker) + C3 (#1988 persistence).
 */

/**
 * A named theme: a palette-source var-map applied at runtime.
 * `vars` keys are `--…` custom-property names; values are concrete CSS colors.
 */
export type Theme = {
  id: string;
  label: string;
  vars: Record<`--${string}`, string>;
};

/**
 * The default theme. Its `--palette-accent` / `--palette-accent-fg` values MUST
 * equal A1's `:root` defaults in `tokens.css` (`#5ae6ab` / `#0f1f1a`) so that
 * applying it is a visual no-op — this is what guarantees zero-flash / zero
 * regression at rest (R4/R6). The registry test (`themes.test.ts`) both asserts
 * these literals AND cross-checks them against A1's shipped `tokens.css`.
 */
const MINT_THEME: Theme = {
  id: "mint",
  label: "Mint",
  vars: { "--palette-accent": "#5ae6ab", "--palette-accent-fg": "#0f1f1a" },
};

/**
 * The curated theme set. Adding a theme is purely additive — append an entry with
 * its accent + accent-foreground. Colors are tunable in review; the runtime-swap
 * architecture is the deliverable, not the specific hues.
 */
export const THEMES: readonly Theme[] = [
  MINT_THEME,
  {
    id: "sky",
    label: "Sky",
    vars: { "--palette-accent": "#38bdf8", "--palette-accent-fg": "#082f49" },
  },
  {
    id: "violet",
    label: "Violet",
    vars: { "--palette-accent": "#a78bfa", "--palette-accent-fg": "#1e1b4b" },
  },
  {
    /* Pink replaced Amber (#3354 follow-up). The amber accent was byte-identical
       to `--status-warn` (#fbbf24), so under that theme AccountUsage's UsageBar
       rendered its OK band (`var(--app-accent)`) and its WARN band
       (`var(--status-warn)`) in the SAME color — collapsing the red/amber/green
       traffic light from three states to two. A theme accent must therefore never
       occupy a status hue; pink (~329°) is the farthest curated hue from the
       status families (Δ123 from red #ef4444) that also stays distinct from the
       other three accents (Δ106 from violet). */
    id: "pink",
    label: "Pink",
    vars: { "--palette-accent": "#f472b6", "--palette-accent-fg": "#500724" },
  },
];

/** The id applied when no theme is selected (== the CSS baseline → zero-flash). */
export const DEFAULT_THEME_ID = MINT_THEME.id;

/**
 * Resolve a theme id to its `Theme`, falling back to the default (mint) when the
 * id is unknown — defensive because C3 may pass a stale persisted id after the
 * theme set changes.
 */
export function getThemeById(id: string): Theme {
  return THEMES.find(theme => theme.id === id) ?? MINT_THEME;
}
