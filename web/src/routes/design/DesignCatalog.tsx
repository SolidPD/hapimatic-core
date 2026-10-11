// SPDX-License-Identifier: AGPL-3.0-only
import { useThemeSelection } from "@/design/ThemeProvider";
import useDensity from "@/hooks/useDensity";
import type { DensityMode } from "@/hooks/useAdminPreferences";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";
import { PrimitiveEntries } from "./primitiveEntries";
import { CompositeEntries } from "./compositeEntries";
import { SettingsPageExample } from "./compositions/SettingsPageExample";
import { DenseListExample } from "./compositions/DenseListExample";

/**
 * DesignCatalog — the dev-only `/design` component catalog / pattern lab (Interface
 * Design System Sub-Issue H, #3036; epic #3028). Renders every primitive + composite
 * across variants/sizes/states, plus template-level composition pages, with live theme
 * and density controls wired to the real runtime hooks.
 *
 * This module is the default export loaded via `lazy(() => import("./DesignCatalog"))`
 * inside the `import.meta.env.DEV`-gated route factory (`designRoute.tsx`), so it is
 * code-split into a chunk that is never emitted in a production build. Option
 * evaluation + coverage contract: `docs/design/design-system/catalog.md`.
 */

const DENSITY_OPTIONS: { value: DensityMode; label: string }[] = [
  { value: "normal", label: "Normal" },
  { value: "compact", label: "Compact" },
  { value: "ultra", label: "Ultra" },
];

const SECTIONS = [
  { id: "primitives", label: "Primitives" },
  { id: "composites", label: "Composites" },
  { id: "compositions", label: "Compositions" },
];

function ThemeControl() {
  const { activeThemeId, availableThemes, setActiveTheme } =
    useThemeSelection();
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="flex flex-wrap items-center gap-1.5"
    >
      {availableThemes.map(theme => {
        const selected = activeThemeId === theme.id;
        return (
          <button /* design-tokens-allow: dev-only /design catalog theme-swatch radio (role="radio" + inline color swatch) — a specimen-catalog control, not shipped UI; keep raw */
            key={theme.id}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={theme.label}
            onClick={() => setActiveTheme(theme.id)}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
              selected
                ? "bg-[var(--app-link)] text-[var(--app-button-text)]"
                : "bg-[var(--app-secondary-bg)] text-[var(--app-fg)] hover:opacity-90"
            }`}
          >
            <span
              aria-hidden
              className="h-3.5 w-3.5 flex-shrink-0 rounded-full border border-black/20"
              style={{ backgroundColor: theme.vars["--palette-accent"] }}
            />
            <span>{theme.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function SectionHeading({ id, title }: { id: string; title: string }) {
  return (
    <h2
      id={id}
      className="scroll-mt-20 border-b border-[var(--app-border)] pb-2 text-lg font-semibold text-[var(--app-fg)]"
    >
      {title}
    </h2>
  );
}

export default function DesignCatalog() {
  const { density, setDensity } = useDensity();

  return (
    <div className="h-full overflow-y-auto bg-[var(--app-bg)]">
      {/* Header — global theme + density controls (R3). */}
      <header className="sticky top-0 z-20 border-b border-[var(--app-border)] bg-[var(--app-bg)]/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h1 className="text-xl font-bold text-[var(--app-fg)]">
              Component Catalog
            </h1>
            <span className="text-xs text-[var(--app-hint)]">
              Dev-only · <code className="text-[var(--app-fg)]">/design</code> ·
              Interface Design System (H)
            </span>
          </div>
          <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
            <div className="flex flex-col gap-1.5">
              <span className="text-[length:var(--text-caption)] font-medium uppercase tracking-wide text-[var(--app-hint)]">
                Theme
              </span>
              <ThemeControl />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-[length:var(--text-caption)] font-medium uppercase tracking-wide text-[var(--app-hint)]">
                Density
              </span>
              <SegmentedToggle<DensityMode>
                ariaLabel="Density"
                value={density}
                onChange={setDensity}
                options={DENSITY_OPTIONS}
              />
            </div>
          </div>
          <nav aria-label="Catalog sections" className="flex flex-wrap gap-2">
            {SECTIONS.map(s => (
              <a
                key={s.id}
                href={`#${s.id}`}
                className="rounded-md bg-[var(--app-secondary-bg)] px-2.5 py-1 text-xs font-medium text-[var(--app-fg)] hover:opacity-90"
              >
                {s.label}
              </a>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-6">
        <section className="flex flex-col gap-4">
          <SectionHeading id="primitives" title="Primitives" />
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <PrimitiveEntries />
          </div>
        </section>

        <section className="flex flex-col gap-4">
          <SectionHeading id="composites" title="Composites" />
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <CompositeEntries />
          </div>
        </section>

        <section className="flex flex-col gap-4">
          <SectionHeading
            id="compositions"
            title="Compositions (template pages)"
          />
          <p className="text-sm text-[var(--app-hint)]">
            Full pages assembled purely from shared system parts — a settings
            page and a dense list/detail surface.
          </p>
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-[var(--app-fg)]">
                Settings page (SettingsPage template)
              </h3>
              <SettingsPageExample />
            </div>
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-[var(--app-fg)]">
                Dense list / detail (ListDetail template)
              </h3>
              <DenseListExample />
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
