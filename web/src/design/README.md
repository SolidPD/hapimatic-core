# Hapimatic Design Tokens

The single source of truth for Hapimatic's color / surface / border / shadow /
status / spacing / radii vocabulary. Every shared component (A2/A3) and every
admin page reads from here, and this is the seam **Epic C (#1985/#1986)** plugs
its runtime theme switcher into.

**Parent epic**: [#1976 — Design System](https://github.com/MattStarfield/hapimatic-private/issues/1976) · **Foundation sub-issue**: #1977 (A1)

**Primitive contracts**: the shared `web/src/components/ui/` primitives that consume
these tokens are catalogued in
[`docs/design/design-system/primitives.md`](../../../docs/design/design-system/primitives.md)
(anatomy · props · variants · sizes · states · a11y · tokens) — #3031, Sub C.

**Layout templates**: the reusable page/app-shell scaffolds in
[`web/src/components/layouts/`](../components/layouts/) that compose those primitives into
whole-surface layouts — with their region, scroll-ownership, safe-area, virtual-keyboard, and
pane-adaptation contracts, and the two binding adaptation rules (capability + window-dimension,
never device categories) — are catalogued in
[`docs/design/design-system/layouts.md`](../../../docs/design/design-system/layouts.md) — #3033, Sub E.

**Authoring guide**: before building interface-bearing work, read the
[design-system authoring guide](../../../docs/design/design-system/authoring-guide.md)
— which component/variant/template/tokens to use, when to extend a component, and
how to record an exception — Sub G, #3035.

## Files

| File             | Role                                                                                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tokens.css`     | The value catalog (`:root` custom properties) + the Tailwind `@theme inline` mapping. Imported from `web/src/index.css`.                             |
| `tokens.ts`      | Typed TS accessor: the `tokens` map (`var(--…)` references), `applyAccent` / `applyPalette` / `resolveToken`, and the dev-only `__applyAccent` hook. |
| `tokens.test.ts` | Swap-chain + no-hex-leak unit tests.                                                                                                                 |

## 🔴 The one load-bearing mechanism

Runtime accent/palette swapping works **only** because Tailwind utilities
reference a CSS variable _by reference_ rather than baking the resolved hex at
build time. Tailwind 4 gives this via **`@theme inline`**:

```css
@theme inline {
  --color-accent: var(--accent);
}
/*  → .bg-accent { background: var(--accent) }   live reference ✅ swappable */

@theme {
  --color-accent: #5ae6ab;
}
/*  → .bg-accent { background: #5ae6ab }          frozen hex   ❌ NOT swappable */
```

Override the source variable at runtime and every consumer re-resolves at once —
no per-usage-site edit.

## Usage decision tree

Pick the **lowest** applicable row:

| You are styling…                                                               | Use                                        | Example                                                                  |
| ------------------------------------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------ |
| A DOM element via className, and a utility exists                              | The Tailwind **utility**                   | `className="bg-accent text-ok border-hot"`                               |
| A DOM element, no named utility for the token                                  | An **arbitrary value** referencing the var | `className="bg-[var(--app-bg)] text-[var(--app-hint)]"`                  |
| A color passed to **JS/TS** (recharts `fill`/`stroke`, inline `style`, canvas) | The `tokens` **TS map**                    | `import { tokens } from "@/design/tokens"; <Bar fill={tokens.accent} />` |
| You genuinely need the **computed** value (rare — e.g. canvas math)            | `resolveToken()`                           | `resolveToken("accent")` → `"#5ae6ab"`                                   |

**Never pass a raw hex to a JS-consumed color** (recharts, inline style). Hex
freezes the color and breaks runtime swapping — always use `tokens.<name>`,
which is a `var(--…)` reference the browser resolves at paint time.

## Runtime-swap contract (Epic C)

The accent is unified under one source variable, `--palette-accent`. Both the
Hapimatic vocabulary (`--app-link` → `--app-accent`) and the shadcn vocabulary
(`--accent`, `--ring`) reference it, so a single flip propagates everywhere:

```ts
import { applyAccent, applyPalette } from "@/design/tokens";

applyAccent("#ff8800"); // re-color every accent consumer
applyPalette({ "--app-bg": "#101014" }); // override arbitrary tokens
```

- **Source var**: `--palette-accent` (mint `#5ae6ab` by default).
- **Override points**: `document.documentElement.style.setProperty(...)` (what
  `applyAccent` does), or a `[data-theme]` / `[data-accent]` attribute selector
  (the app already sets `data-theme="dark"` on the root via `useTheme.ts`).
- **Dev demo**: in a dev build, `window.__applyAccent("#ff8800")` flips the
  accent from the console (guarded by `import.meta.env.DEV`; never ships).

Epic C's theme switcher drives exactly this `applyAccent` / `--palette-accent`
seam — do **not** rename these without coordinating via the orchestrating
project-manager-role session (the token names are a public API consumed by
7 downstream issues: #1978/#1979/#1980 + Epic C #1986/#1987/#1988).

## 🔴 Never put swappable tokens in `tailwind.config.ts`

`theme.extend.colors` (like plain `@theme`) **bakes the hex at build time**,
which breaks the Epic C runtime-swap contract. Swappable tokens live ONLY as
CSS custom properties in `tokens.css`, exposed to Tailwind via `@theme inline`.

## Token catalog

### Palette (swap source)

| Token                 | Purpose                                              | Default   |
| --------------------- | ---------------------------------------------------- | --------- |
| `--palette-accent`    | The single mint-accent source var (override to swap) | `#5ae6ab` |
| `--palette-accent-fg` | Dark ink/text on mint surfaces                       | `#0f1f1a` |

### Surfaces

| Token                                             | Purpose                                       | Default                                                                               |
| ------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------- |
| `--app-bg`                                        | App background                                | `#1c1c1e`                                                                             |
| `--app-fg` (`--app-text`)                         | Primary text                                  | `#ffffff`                                                                             |
| `--app-hint` (`--app-muted`)                      | Muted / secondary text                        | `#8e8e93`                                                                             |
| `--app-secondary-bg` (`--app-surface`)            | Panel / surface background                    | `#2c2c2e`                                                                             |
| `--app-hover` (`--app-bg-hover`)                  | Subtle elevated hover surface                 | `rgba(255,255,255,0.08)`                                                              |
| `--app-button` / `--app-button-text`              | Button surface / label                        | `#ffffff` / `#111827`                                                                 |
| `--app-banner-bg` / `--app-banner-text`           | Banner surface / text                         | `#3a3a3c` / `#ffffff`                                                                 |
| `--header-icon-disc` / `--header-icon-disc-hover` | Project-header icon disc rest / hover (#4538) | `var(--app-banner-bg)` / `color-mix(in srgb, var(--app-fg) 6%, var(--app-banner-bg))` |

### Accent (all resolve to `--palette-accent`)

| Token                 | Purpose                               | Resolves to             |
| --------------------- | ------------------------------------- | ----------------------- |
| `--app-link`          | Hapimatic accent (links, focus rings) | `var(--palette-accent)` |
| `--app-accent`        | Accent alias (second vocabulary)      | `var(--app-link)`       |
| `--accent` / `--ring` | shadcn accent / focus ring            | `var(--palette-accent)` |

### Borders / dividers

| Token             | Purpose                                                                                                                                                                                                                                                                                                                                                             | Default                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `--app-border`    | Standard border                                                                                                                                                                                                                                                                                                                                                     | `rgba(255,255,255,0.1)`                         |
| `--app-divider`   | Divider / hairline                                                                                                                                                                                                                                                                                                                                                  | `rgba(255,255,255,0.08)`                        |
| `--chip-base`     | Compositing base for translucent chip surfaces — `transparent` by default; the session list's `.chip-scope` wrapper sets it to `var(--app-bg)` so its chips render opaque and a tinted row cannot bleed through them (epic #3285 round 14). The chip tokens below are declared on `:root, .chip-scope` so they resolve against the list's opaque base there (#4553) | `transparent`                                   |
| `--app-subtle-bg` | Subtle inset background (5 % white over `--chip-base`)                                                                                                                                                                                                                                                                                                              | `color-mix(in srgb, #fff 5%, var(--chip-base))` |
| `--app-badge-bg`  | Node-badge hub/local surface (8 % white over `--chip-base`)                                                                                                                                                                                                                                                                                                         | `color-mix(in srgb, #fff 8%, var(--chip-base))` |

### Status triad

| Token           | Utility                   | Purpose                        | Default   |
| --------------- | ------------------------- | ------------------------------ | --------- |
| `--status-ok`   | `bg-ok` / `text-ok` …     | Success / healthy              | `#4ade80` |
| `--status-warn` | `bg-warn` / `text-warn` … | Warning / degraded             | `#fbbf24` |
| `--status-hot`  | `bg-hot` / `text-hot` …   | Error / critical (family base) | `#f87171` |

> **Note**: `--status-hot` is the error-family _base_ (`= --toast-error`); the
> badge error _text_ (`#fca5a5`) is intentionally different. Batch C2 (#3356)
> migrated the one exact-value match (`SystemHealthModal`'s `#f87171` →
> `--status-hot`) onto this triad; the remaining no-token status hexes stay as
> documented exceptions (token-gap follow-up #3393), and `RecoveryStatusBadge`
> maps onto the session-status category quad, not this triad. A1 only
> _defines_ the triad.

### Shadows (semantic)

| Token              | Utility          | Purpose                   | Default                      |
| ------------------ | ---------------- | ------------------------- | ---------------------------- |
| `--shadow-card`    | `shadow-card`    | Card / panel elevation    | `0 1px 3px rgba(0,0,0,0.4)`  |
| `--shadow-overlay` | `shadow-overlay` | Modal / overlay elevation | `0 8px 24px rgba(0,0,0,0.5)` |

> Named to avoid clashing with Tailwind's built-in `shadow-sm/md/lg/xl`, which
> remain unchanged.

### Spacing & radii

| Token                     | Purpose                                                      | Default            |
| ------------------------- | ------------------------------------------------------------ | ------------------ |
| `--space-1` … `--space-6` | Semantic spacing steps (mirror Tailwind's default scale 1:1) | `0.25rem` … `2rem` |
| `--radius`                | Base radius (`--radius-sm/md/lg/xl` derive from it)          | `0.5rem`           |

> Tailwind 4's default spacing scale (`p-2`, `gap-4`, …) remains the canonical
> spacing source; the `--space-*` tokens exist for the rare arbitrary-value or
> JS case where a semantic name reads clearer than a magic number.

## #3030 token vocabulary (type scale · control sizes · z-index · motion · icon sizes · content width · cyan)

Epic #3028 Sub B (#3030) completes the token vocabulary by naming Sub A's
(#3029) Matt-approved [decision records](../../../docs/design/design-system/)
plus the audited census values. Every family below is **additive** and
**`:root`-only**: each token names an EXISTING audited value with a real consumer
(no speculative tokens — R6), and **no consumer site is migrated in this issue**
(that is later subs, e.g. Sub K) — so rendering is unchanged at rest (R4). Because
none of these are colors they are **not** theme-swappable, and are consumed via
**arbitrary values** (`text-[length:var(--text-body)]`, `z-[var(--z-overlay)]`) rather
than `@theme inline` utilities — the same pattern as `--space-*` above. The one
exception is the named cyan accent, which additionally has a `tokens.ts` accessor
(it is JS-consumed).

### Type scale — dense 10–14px family

Source: [decision-typography.md](../../../docs/design/design-system/decision-typography.md).
Each size pairs with a bundled line-height (A's line-height decision — arbitrary
`text-[Npx]` utilities set font-size only and leak vertical-rhythm drift). Use as
`text-[length:var(--text-body)] leading-[var(--leading-body)]`.

| Size token / line-height token                   | Style        | Size   | Line-height | Audited usage                            |
| ------------------------------------------------ | ------------ | ------ | ----------- | ---------------------------------------- |
| `--text-caption-xs` / `--leading-caption-xs`     | caption-xs   | `10px` | `1`         | badge counts, micro-labels (103)         |
| `--text-caption` / `--leading-caption`           | caption      | `11px` | `1`         | dense captions, section labels (147)     |
| `--text-body-dense` / `--leading-body-dense`     | body-dense   | `12px` | `1.25`      | dense body, list-row secondary (100)     |
| `--text-body` / `--leading-body`                 | body         | `13px` | `1.25`      | primary dense body, control labels (117) |
| `--text-label-strong` / `--leading-label-strong` | label-strong | `14px` | `1.25`      | row titles, small headers (32)           |

Weight axis (independent of size; the default is `--weight-medium`):

| Token               | Weight | Audited usage                         |
| ------------------- | ------ | ------------------------------------- |
| `--weight-regular`  | `400`  | long-form prose only — rare (5)       |
| `--weight-medium`   | `500`  | **the default UI weight** (264)       |
| `--weight-semibold` | `600`  | emphasis, headers, active states (93) |
| `--weight-bold`     | `700`  | strong emphasis — rare (24)           |

### Control sizes

Source: [decision-density-sizing.md](../../../docs/design/design-system/decision-density-sizing.md).
The control-height ladder maps to `button.tsx` cva sizes. Use as `h-[var(--control-sm)]`.

| Token             | Value  | Maps to                         | Consumer                       |
| ----------------- | ------ | ------------------------------- | ------------------------------ |
| `--control-sm`    | `32px` | `button` size="sm" (`h-8`)      | dense toolbars, inline actions |
| `--control-md`    | `36px` | `button` size="default" (`h-9`) | standard button height         |
| `--control-lg`    | `40px` | `button` size="lg" (`h-10`)     | prominent / primary actions    |
| `--control-chip`  | `24px` | Filter/Sort chip (desktop)      | secondary segmented actions    |
| `--control-touch` | `44px` | composer actions, message-nav   | generous touch targets         |

> **Referenced, not redefined**: the icon-button vars (`--icon-btn-size` 32px /
> `--icon-slot` 34px, in `web/src/index.css`) and the row-density var
> (`--row-padding-y` 6/3/1px, driven by `useDensity`) are part of the same
> control-size vocabulary but remain in their existing homes — B references and
> documents them here rather than duplicating a divergent value.
>
> **`--control-chip` WCAG note**: 24px is the SC 2.5.8 floor; the chip collapses
> to 22px at width 393 (a flagged deviation in `wcag-258-evaluation.md`). Holding
> it at ≥24px is a component change owned by a later sub, not this vocabulary task.

### Z-index

The audited stacking layers, so consumers reference a layer instead of a bare
`z-N`. Use as `z-[var(--z-overlay)]`.

| Token          | Value  | Layer                       | Consumer                        |
| -------------- | ------ | --------------------------- | ------------------------------- |
| `--z-sticky`   | `10`   | sticky / pinned headers     | 13 uses                         |
| `--z-raised`   | `20`   | locally-raised controls     | session-metadata, account-usage |
| `--z-dropdown` | `30`   | anchored floating panels    | router overlay, LinkIssueField  |
| `--z-drawer`   | `40`   | side drawer                 | SettingsDrawer                  |
| `--z-overlay`  | `50`   | modals / dialogs / popovers | dominant float layer (38 uses)  |
| `--z-toast`    | `9999` | toast stack — always on top | Toast                           |

### Motion (duration + easing)

Audited transition durations + easing curves (`transition-colors` is the default
transition, 129 files). Use as `duration-[var(--duration-base)] ease-[var(--ease-out)]`.
Durations are zeroed under `prefers-reduced-motion` by a `@media` guard in
`tokens.css` (dormant until sites migrate onto the tokens).

| Token               | Value                          | Purpose                       |
| ------------------- | ------------------------------ | ----------------------------- |
| `--duration-fast`   | `150ms`                        | quick feedback (9)            |
| `--duration-base`   | `200ms`                        | **default** transition (17)   |
| `--duration-slow`   | `300ms`                        | deliberate transitions (2)    |
| `--duration-slower` | `500ms`                        | slow reveals / long fades (9) |
| `--ease-out`        | `cubic-bezier(0, 0, 0.2, 1)`   | decelerate — enter (17)       |
| `--ease-in-out`     | `cubic-bezier(0.4, 0, 0.2, 1)` | both ends — move (12)         |
| `--ease-in`         | `cubic-bezier(0.4, 0, 1, 1)`   | accelerate — exit (1)         |

### Icon glyph sizes

The lucide icon px scale (square `h-N w-N`). **Distinct** from the icon-BUTTON
container size (`--icon-btn-size` 32 / `--icon-slot` 34 in `index.css`). Use as
`h-[var(--icon-sm)] w-[var(--icon-sm)]`.

| Token        | Value  | Tailwind  | Audited usage     |
| ------------ | ------ | --------- | ----------------- |
| `--icon-2xs` | `8px`  | `h-2 w-2` | 33                |
| `--icon-xs`  | `12px` | `h-3 w-3` | 67                |
| `--icon-sm`  | `16px` | `h-4 w-4` | **default** (155) |
| `--icon-md`  | `20px` | `h-5 w-5` | 57                |
| `--icon-lg`  | `24px` | `h-6 w-6` | 9                 |
| `--icon-xl`  | `32px` | `h-8 w-8` | 58                |

### Content width

Source: [decision-layout-adaptation.md](../../../docs/design/design-system/decision-layout-adaptation.md).

| Token             | Value   | Purpose                 |
| ----------------- | ------- | ----------------------- |
| `--content-width` | `720px` | readable content column |

> Mirrors `tailwind.config.ts` `maxWidth.content` (720px), consumed as the
> `max-w-content` utility (router, `SplitPaneContentView`). **The Tailwind config
> stays authoritative** for the `max-w-content` utility; this var exposes the same
> audited value for the rare JS / arbitrary-value case. Content width is not
> theme-swappable, so config residence does not violate the swap contract.

### Named cyan accent

| Token           | Value     | Consumers                                                        | Accessor      |
| --------------- | --------- | ---------------------------------------------------------------- | ------------- |
| `--accent-cyan` | `#22d3ee` | account-usage TitleChip, settings accents, porter "Hosted" label | `tokens.cyan` |

> One name for the audited `#22d3ee` decorative cyan that 5 sites inline today.
> Named `--accent-cyan` (not `--status-info`) because every consumer is a
> decorative section/chip/label accent, not a health signal in the
> `--status-ok/warn/hot` family. This token **only defines** the vocabulary;
> migrating the 5 sites onto it is Sub K's sweep. 🔴 It is a **distinct var** from
> `--palette-cat-reasoning` (same `#22d3ee` hue, but the #3147-governed
> chat-reasoning chevron) — that token is deliberately left byte-identical.

### Session-status category quad

| Token                    | Value                           | Consumers                                   |
| ------------------------ | ------------------------------- | ------------------------------------------- |
| `--status-cat-attention` | `#ff9500`                       | toolbar status cluster, `SessionCountBadge` |
| `--status-cat-working`   | `#007aff`                       | toolbar status cluster, `SessionCountBadge` |
| `--status-cat-active`    | `var(--app-badge-success-text)` | toolbar status cluster, `SessionCountBadge` |
| `--status-cat-inactive`  | `var(--app-hint)`               | toolbar status cluster, `SessionCountBadge` |

> The four-way SESSION-ACTIVITY category (needs-attention / working / active /
> inactive), rendered by the `router.tsx` toolbar cluster and its byte-identical
> mirror `SessionCountBadge`. A **distinct vocabulary** from the
> `--status-ok/warn/hot` health triad (instrument/system health) and the `--cat-*`
> chat-section accents. `attention`/`working` name the previously-unnamed #3038 gap
> hexes; `active`/`inactive` alias the existing badge-success / hint tokens so the
> quad reads as one named family (zero value duplication). Consumed via arbitrary
> values (`text-[var(--status-cat-attention)]`); `:root`-only, no `@theme inline`,
> no `tokens.ts` accessor (never JS-consumed) — following the `--accent-cyan`
> precedent. Other consumers of the same orange/blue semantic —
> `RecoveryStatusBadge`, `AssistantChat/StatusBar` — are Sub K's (#3039) sweep, not
> this issue.

### Decorative section-hue accents

Epic #3028 Sub B (#3335) names the family of DECORATIVE per-section accent hues the
settings surfaces inline as raw hex — the same class of value `--accent-cyan` was
created for. **Additive and `:root`-only**: each token names an EXISTING audited
value with a real consumer (no speculative tokens — R7), and **no consumer site is
migrated in this issue** (that is Sub K, #3039) — rendering is unchanged at rest (R6).
Consumed via arbitrary values (`border-[var(--accent-violet-600)]`) or the
`tokens.section.*` accessor (the JS-consumed ones); **not** `@theme inline`, and
**not** routed through a `--palette-*` swap seam (decorative section branding is
stable, not theme-swappable) — the `--accent-cyan` precedent. Named by **hue +
Tailwind shade** so a value maps unambiguously — the set has two teals, three ambers,
two blues, and three green-family hues, which a flat `--accent-teal` could not
disambiguate.

| Token                  | Value     | Consumer section(s)          | `tokens.section.*` |
| ---------------------- | --------- | ---------------------------- | ------------------ |
| `--accent-teal-400`    | `#2dd4bf` | Preferences                  | `teal400`          |
| `--accent-teal-200`    | `#5eead4` | Configuration                | `teal200`          |
| `--accent-purple-400`  | `#c084fc` | Time Log                     | `purple400`        |
| `--accent-amber-300`   | `#fcd34d` | Keys                         | `amber300`         |
| `--accent-amber-400`   | `#fbbf24` | Notifications tile           | `amber400`         |
| `--accent-amber-500`   | `#f59e0b` | About                        | `amber500`         |
| `--accent-emerald-400` | `#34d399` | Federation                   | `emerald400`       |
| `--accent-sky-400`     | `#38bdf8` | VMs, Session Metadata        | `sky400`           |
| `--accent-indigo-400`  | `#818cf8` | Extensions                   | `indigo400`        |
| `--accent-violet-400`  | `#a78bfa` | System Jobs                  | `violet400`        |
| `--accent-violet-600`  | `#7c3aed` | project-group header rail    | — (className)      |
| `--accent-green-400`   | `#4ade80` | Harness Updates, Keys backup | `green400`         |
| `--accent-blue-400`    | `#60a5fa` | Analytics                    | `blue400`          |
| `--accent-mint`        | `#5ae6ab` | Harness Scorecard            | `mint`             |
| `--accent-orange-400`  | `#fb923c` | File Conflicts               | `orange400`        |
| `--accent-rose-400`    | `#fb7185` | Error Log                    | `rose400`          |
| `--accent-pink-400`    | `#f472b6` | Feedback                     | `pink400`          |
| `--accent-red-500`     | `#ef4444` | Sign-Out tile                | `red500`           |

> **Byte-identical collisions (kept DISTINCT on purpose)**: `--accent-amber-400` ≡
> `--status-warn`, `--accent-amber-500` ≡ `--app-git-unstaged-color`,
> `--accent-green-400` ≡ `--status-ok`, `--accent-blue-400` ≡
> `--session-rel-schedule`, `--accent-mint` ≡ `--palette-accent` (Mint theme), and
> `--accent-pink-400` ≡ the Pink theme accent (#3354 follow-up — Pink replaced
> Amber, whose accent collided byte-identically with `--status-warn`). Decorative
> section branding is a **separate vocabulary** from the health / accent /
> session-rel palettes — reusing (e.g.) `--status-warn` for a section tile would
> couple branding to the health signal. This generalizes the issue's amber-vs-warn
> guidance and mirrors `--accent-cyan` ≡ `--palette-cat-reasoning`. `--accent-mint`
> is a **frozen** hex (NOT `var(--palette-accent)`), so section branding does not
> swap with the runtime accent.
>
> **`--accent-violet-600`** (`#7c3aed`) is the frozen **v3** hex, intentionally
> distinct from Tailwind **v4**'s oklch `violet-600` (a different color) — a
> `border-violet-600` utility swap would change the hue, so a named custom property
> is required. It is the ONE className-only consumer, so it has a CSS var but no
> `tokens.ts` accessor.
>
> **Tile 15%-alpha variants** (the Notifications amber tile `#fbbf2426`, the
> Sign-Out red tile `#ef444426`) get **no** separate alpha token — Sub K computes
> the tile via `color-mix(in srgb, var(--accent-amber-400) 15%, transparent)`, the
> pattern the cyan Session-Handoff tile already uses.
>
> **`--accent-red-500`** (`#ef4444`, Sign-Out) is a destructive-**action** tile, not
> a section-identity accent — the one debatable inclusion (`≠ --destructive`
> #dc2626, so genuinely unnamed today). Named here for census completeness; a later
> sub could rename it to a destructive-decorative variant.

### Chart data-series (#3434 · epic #3354)

| Token       | Value     | Consumers                                   | Accessor          |
| ----------- | --------- | ------------------------------------------- | ----------------- |
| `--chart-1` | `#3b82f6` | `TokenUsageWidget` bar/legend — cache-read  | `tokens.chart[1]` |
| `--chart-2` | `#8b5cf6` | `TokenUsageWidget` bar/legend — cache-write | `tokens.chart[2]` |
| `--chart-3` | `#f59e0b` | `TokenUsageWidget` bar/legend — output      | `tokens.chart[3]` |

> A reusable **ORDINAL** data-viz series vocabulary (the shadcn `--chart-N`
> convention) — not widget-private constants. First consumer: `TokenUsageWidget`'s
> token-usage StackedBar + legend, read through the `tokens.chart[1..3]` accessor
> (a JS / inline-`style` value, so `:root`-only, no `@theme inline` — the
> `--accent-cyan` precedent). Candidate later consumers: the `extensions/analytics/`
> charts (currently outside the checker's `SCAN_ROOTS`). 🔴 `--chart-3` (`#f59e0b`)
> coincides by **value only** with `--accent-amber-500` (the About-section accent)
> and `--app-git-unstaged-color` — a distinct semantic (a data-series color), kept a
> **literal DISTINCT** on purpose, never an alias (the separate-vocabulary rule
> above).

### Cost display (#3353 · epic #3345)

| Token               | Value     | Consumers                                                                                                                       | Accessor             |
| ------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `--cost-equivalent` | `#818cf8` | `AssistantMessage` per-turn footer + `TokenUsageWidget` cumulative row — the EQUIVALENT-cost (subscription) tint + "EQ." marker | — (CSS `var()` only) |

> The real-vs-EQUIVALENT API-cost display keys on `metadata.authBinding.kind`
> (#3351): `api-key`/`gateway-key` = REAL cost → mint (`--app-accent`);
> `subscription-account` has no marginal API charge, so the cost is the EQUIVALENT
> at API rates → this token + an "EQ." marker; `inherited`/absent → neutral
> (`--app-hint` "—"). Consumed via `text-[var(--cost-equivalent)]` only (no raw hex
> at a usage site, R5); no `tokens.ts` accessor (CSS-only, never passed to JS).
> Operator-approved hue (mockup gate 2026-09-21): periwinkle **#818cf8**, distinct
> from the reserved blues rendered near cost (the hardcoded cache-read `#3b82f6` in
> the SAME widget, `--status-cat-working` `#007aff`, `--accent-sky-400` `#38bdf8`,
> `--accent-blue-400`/`--session-rel-schedule` `#60a5fa`). 🔴 Coincides by **value
> only** with `--accent-indigo-400` (`#818cf8`, the Extensions decorative accent) —
> a distinct semantic that never co-renders with cost; **literal, do NOT alias**
> (the same convention as `--chart-3` ≡ `--accent-amber-500`).

> **Dual treatment (#4824 · epic #4822).** The treatment is decided PER TURN by
> the binding the turn ledger recorded when that turn opened, not by the
> session's current binding — so a session that switches between a key and a
> subscription never re-colours an earlier turn. The per-turn footer takes each
> turn's own treatment (a row with no recorded binding falls back to the
> session's, but never as REAL). The `TokenUsageWidget` cumulative row shows TWO
> figures side by side when the session has both: a mint "API cost" (real
> charges) and a `--cost-equivalent` "API value … EQ." (the equivalent value);
> the "EQ." marker stays on the equivalent figure only. In the collapsed dock
> heading they read `$real · $equivalent EQ.`; when the row is too narrow even
> without the context fraction, the EQ figure leaves the collapsed heading and the
> mint figure stays (the expanded view always shows both). A session with one
> kind renders exactly the single #3353 figure. Same two tokens — no new color.

## Token-change policy

The token vocabulary is a public API (consumed across the Design System epics and
migrated onto by later sub-issues). Change it deliberately:

- **Add** — additive is the default. A new token MUST name a real audited value
  AND list a real (or explicitly named) consumer — no speculative tokens. Add the
  `:root` var in `tokens.css`, a catalog row here, and (only if JS-consumed) a
  `var(--…)` accessor in `tokens.ts`. If it is a swappable color, expose it via
  `@theme inline` and route it through the `--palette-*` seam; if it is not a
  color (size, z-index, motion), keep it `:root`-only and consume it via arbitrary
  values.
- **Change** — changing a token's VALUE re-colors / re-sizes every consumer at
  once. Requires: a migration check of all consumers, a cross-check against the
  #2111 palette/font-family epics (never redefine a palette value or font family
  here), and the swap-chain + no-hex-leak tests in `tokens.test.ts` staying green.
  Never bake a swappable token into `tailwind.config.ts` (it freezes the hex and
  breaks the runtime-swap contract).
- **Deprecate** — alias-then-remove. Point the old name at the new token
  (`--old: var(--new);`), migrate consumers, then remove the alias in a later
  change once no consumer references it. Never hard-delete a token that still has
  consumers.
