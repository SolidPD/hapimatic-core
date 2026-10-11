// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Hapimatic design tokens — typed TypeScript accessor.
 *
 * Companion to `./tokens.css` (the value catalog) and `./README.md` (usage
 * guide). Import this ONLY when a color must be passed to JS/TS — e.g. recharts
 * `fill`/`stroke`, inline `style`, or a canvas. For DOM styling prefer the
 * Tailwind utility (`bg-accent`, `text-ok`) or an arbitrary value
 * (`bg-[var(--app-bg)]`); those are already runtime-swappable.
 *
 * 🔴 Every value here is a CSS-variable *reference* (`var(--…)`), never a raw
 * hex. This is load-bearing: passing hex to recharts would FREEZE the color and
 * break runtime accent swapping (R2 / R4). The browser resolves the `var()`
 * chain at paint time, so a runtime `applyAccent()` re-colors every consumer.
 *
 * Parent epic: #1976 (Design System). Foundation sub-issue: #1977 (A1).
 * Epic C (#1985/#1986) plugs its runtime theme switcher into `applyAccent` /
 * `applyPalette` and the `--palette-accent` seam.
 */

/**
 * The design-token map. Keys are semantic names; values are CSS-variable
 * references that resolve (through the `--palette-accent` chain where relevant)
 * to the catalog values in `tokens.css`. Add an entry here when B/C need a new
 * JS-consumable token — keep it a `var(--…)` string.
 */
export const tokens = {
  // Accent — resolves --app-accent → --app-link → --palette-accent (the swap source)
  accent: "var(--app-accent)",
  accentFg: "var(--palette-accent-fg)",

  // Named cyan accent (#3030) — the audited #22d3ee decorative cyan, ONE token
  // for the 5 sites that inline it in JS/inline-style today (Sub K migrates them;
  // B only names the vocabulary). The sole JS-consumable #3030 token: the size /
  // z-index / motion families are consumed via Tailwind arbitrary values, not JS,
  // so per R2 they get no accessor here.
  cyan: "var(--accent-cyan)",

  // Surfaces
  bg: "var(--app-bg)",
  fg: "var(--app-fg)",
  surface: "var(--app-surface)",
  hint: "var(--app-hint)",

  // Borders / dividers
  border: "var(--app-border)",
  divider: "var(--app-divider)",

  // Status triad
  ok: "var(--status-ok)",
  warn: "var(--status-warn)",
  hot: "var(--status-hot)",

  // Shadows (semantic)
  shadowCard: "var(--shadow-card)",
  shadowOverlay: "var(--shadow-overlay)",

  // Category accents (#2991, S4) — per chat-section visual identity. A NESTED
  // group (not flat keys) so consumers read `tokens.cat.tools`; each value is a
  // `var(--cat-*)` reference (the :10-13 discipline), runtime-swappable via the
  // `--palette-cat-*` seam. Excluded from `DesignToken` below (object-valued) so
  // `resolveToken` stays string-only.
  cat: {
    tools: "var(--cat-tools)",
    reasoning: "var(--cat-reasoning)",
    response: "var(--cat-response)",
    user: "var(--cat-user)",
    narration: "var(--cat-narration)",
  },

  // Per-view accents (#3286 · epic #3028 Sub A) — the View Picker folder-tab
  // accents. A NESTED group like `cat` above; each value is a
  // `var(--view-accent-*)` reference behind the `--palette-view-*` swap seam
  // (tokens.css). Chat = mint (reuses the accent swap source);
  // Terminal/Desktop/Files are the E6 operator hues. Excluded from `DesignToken`
  // (object-valued) so `resolveToken` stays string-only, and auto-covered by the
  // "no raw hex leak" test's nested-group recursion.
  view: {
    chat: "var(--view-accent-chat)",
    terminal: "var(--view-accent-terminal)",
    desktop: "var(--view-accent-desktop)",
    files: "var(--view-accent-files)",
  },

  // Decorative section-hue accents (#3335) — one accessor per JS-consumed
  // decorative section accent named in tokens.css. A NESTED group (like `cat`
  // above) so consumers read `tokens.section.teal400`; each value is a
  // `var(--accent-*)` reference. Excluded from `DesignToken` (object-valued) so
  // `resolveToken` stays string-only, and auto-covered by the "no raw hex leak"
  // test's nested-group recursion. `--accent-violet-600` (#7c3aed) is
  // deliberately ABSENT: it is consumed ONLY as a className arbitrary value
  // (`border-[var(--accent-violet-600)]`), never in JS, so per the AC it gets a
  // CSS var but no accessor. Consumer migration is Sub K (#3039); B only names.
  section: {
    teal400: "var(--accent-teal-400)",
    teal200: "var(--accent-teal-200)",
    purple400: "var(--accent-purple-400)",
    amber300: "var(--accent-amber-300)",
    amber400: "var(--accent-amber-400)",
    amber500: "var(--accent-amber-500)",
    emerald400: "var(--accent-emerald-400)",
    sky400: "var(--accent-sky-400)",
    indigo400: "var(--accent-indigo-400)",
    violet400: "var(--accent-violet-400)",
    green400: "var(--accent-green-400)",
    blue400: "var(--accent-blue-400)",
    mint: "var(--accent-mint)",
    orange400: "var(--accent-orange-400)",
    rose400: "var(--accent-rose-400)",
    pink400: "var(--accent-pink-400)",
    red500: "var(--accent-red-500)",
  },

  // Chart data-series accents (#3434 · epic #3354) — an ORDINAL data-viz series
  // vocabulary (the shadcn `--chart-N` convention), consumed via an inline
  // `style` value. A NESTED group (like `cat` / `section` above) so consumers
  // read `tokens.chart[1]`; each value is a `var(--chart-N)` reference. Excluded
  // from `DesignToken` below (object-valued) so `resolveToken` stays string-only,
  // and auto-covered by the "no raw hex leak" test's nested-group recursion.
  // First consumer: TokenUsageWidget (series 1 = cache-read, 2 = cache-write,
  // 3 = output); candidate later consumers: the extensions/analytics/ charts.
  chart: {
    1: "var(--chart-1)",
    2: "var(--chart-2)",
    3: "var(--chart-3)",
  },
} as const;

/**
 * Union of valid token keys — use for typed lookups. Filtered to STRING-valued
 * keys only, so nested groups like `cat` are excluded (`resolveToken` indexes
 * `tokens[name]` expecting a `var(--…)` string).
 */
export type DesignToken = {
  [K in keyof typeof tokens]: (typeof tokens)[K] extends string ? K : never;
}[keyof typeof tokens];

/**
 * Override the app accent at runtime. Sets the single `--palette-accent` source
 * variable, so every accent-consuming Tailwind utility AND every `tokens.accent`
 * reference re-resolves instantly — no per-usage-site edit (R2). Mirrors the
 * `useDensity` hook's `--row-padding-y` setProperty precedent. This is the seam
 * Epic C's theme switcher drives.
 *
 * @param hex Any valid CSS color (hex, rgb(), a `var(--…)` ref, etc.).
 */
export function applyAccent(hex: string): void {
  document.documentElement.style.setProperty("--palette-accent", hex);
}

/**
 * Override an arbitrary set of palette/design custom properties at runtime.
 * Minimal by design; Epic C (C1) extends this for full theme objects.
 *
 * @param vars Map of CSS custom-property names (`--…`) to values.
 */
export function applyPalette(
  vars: Partial<Record<`--${string}`, string>>
): void {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(vars)) {
    if (value != null) root.style.setProperty(name, value);
  }
}

/**
 * Resolve a token to its *computed* value (the concrete color/length the browser
 * currently paints). Use ONLY when a raw resolved value is genuinely required
 * (e.g. canvas drawing); for DOM styling pass the `var(--…)` reference instead so
 * the value stays swappable.
 *
 * @param name A `DesignToken` key.
 * @returns The trimmed computed value, or "" if unresolved.
 */
export function resolveToken(name: DesignToken): string {
  const ref = tokens[name];
  // Char class includes digits: CSS custom-property idents permit them (e.g. the
  // #3335 --accent-teal-400 family). Section tokens are object-valued (excluded
  // from DesignToken), so resolveToken never receives one today — but keeping the
  // ident pattern correct future-proofs any digit-named flat token.
  const match = ref.match(/^var\((--[a-z0-9-]+)\)$/);
  const varName = match ? match[1] : ref;
  return getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
}

/**
 * Dev-only escape hatch so the tester (and Epic-C prototyping) can flip the
 * accent from the browser console and watch it propagate:
 *   > __applyAccent("#ff8800")
 * Guarded by `import.meta.env.DEV` — never shipped in a production build.
 */
if (import.meta.env.DEV) {
  (window as unknown as { __applyAccent?: typeof applyAccent }).__applyAccent =
    applyAccent;
}
