// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ModelModePicker (issue #2455, wired live by #2456) — the hierarchical
 * in-session model menu, opened from the session-detail model text
 * (SessionModelInfo) and the fullscreen prompt editor.
 *
 * Design (KD-5, OR-1): built on the Radix `dropdown-menu` primitives (free
 * positioning / portal / focus / outside-click / Escape), styled Hapimatic-dark.
 * This component is TRIGGER-OWNING — the caller passes the model text as
 * `children`, which becomes the `DropdownMenuTrigger asChild`.
 *
 * Top level = family quick-picks from `getModelModesForFlavor(flavor)` with a
 * mint check on the current mode and a `Default (X)` row. The **Effort** and
 * **More models** rows (#2455 rendered them disabled) are now live submenus
 * (#2456) whenever the caller provides `onSelectEffort` / `onSelectRawModel`:
 *  - Effort — the reasoning-effort levels the CURRENT model supports (gated by
 *    the live catalog's per-model `effortLevels`; unsupported levels disabled).
 *  - More models — the full LIVE Claude catalog (Anthropic `/v1/models`, fetched
 *    via `useClaudeModels`), so a specific pinned version can be selected. New
 *    Anthropic models appear automatically. Falls back to the disabled "soon"
 *    row for a caller that doesn't wire the handlers.
 */
import type { ReactNode } from "react";
import {
  EFFORT_LEVELS,
  EFFORT_LEVEL_LABELS,
  formatModelName,
  getEffortLevelsForModel,
  getModelModesForFlavor,
  MODEL_MODE_LABELS,
  type ClaudeModelInfo,
  type EffortLevel,
  type ModelMode,
} from "@hapi/protocol";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronIcon } from "@/components/icons";
import { useAppContext } from "@/lib/app-context";
import { useClaudeModels } from "@/hooks/queries/useClaudeModels";

/** Short per-family descriptor. The Default row's descriptor is its resolved
 *  model, carried in the row label ("Default (Opus 4.6)"), so it has none. */
const MODEL_MODE_DESCRIPTORS: Partial<Record<ModelMode, string>> = {
  sonnet: "Balanced speed & capability",
  opus: "Most capable",
  fable: "1M-token context",
};

/** A disabled forward-compat menu row (used when a submenu handler is absent). */
function SoonRow(props: { label: string }) {
  return (
    <DropdownMenuItem disabled className="opacity-50">
      <span className="w-4 shrink-0" />
      <span className="flex flex-1 items-center justify-between gap-2">
        <span>{props.label}</span>
        <span className="rounded bg-[var(--app-secondary-bg)] px-1 text-[9px] font-semibold uppercase tracking-wide text-[var(--app-hint)]">
          soon
        </span>
      </span>
      <ChevronIcon className="h-3 w-3 text-[var(--app-hint)]" collapsed />
    </DropdownMenuItem>
  );
}

/**
 * The reasoning-effort levels the currently-effective model supports, from the
 * LIVE catalog. Effective model = a specific pinned rawModel, else the running
 * resolvedModel, else the family mode resolved via the catalog; falls back to
 * the shared static heuristic when the catalog has no match (offline / unknown).
 */
export function effortLevelsForCurrent(
  current: ModelMode,
  resolvedModel: string | undefined,
  currentRawModel: string | undefined,
  models: ClaudeModelInfo[]
): readonly EffortLevel[] {
  const id = currentRawModel ?? resolvedModel;
  if (id) {
    const exact = models.find(m => m.id === id || id.startsWith(m.id));
    if (exact) return exact.effortLevels;
  }
  if (current !== "default") {
    const fam = models.find(m => m.id.includes(current));
    if (fam) return fam.effortLevels;
  }
  return getEffortLevelsForModel(id ?? current);
}

export function ModelModePicker(props: {
  current: ModelMode;
  resolvedModel?: string;
  /** Precomputed `Default (X)` label; falls back to a resolvedModel-derived
   *  label, then a bare "Default". */
  defaultResolutionLabel?: string;
  flavor?: string | null;
  disabled?: boolean;
  onSelect: (mode: ModelMode) => void;
  /** Issue #2456: the session's live reasoning-effort level (for the check + tag). */
  currentEffort?: EffortLevel;
  /** Issue #2456: the session's pinned specific raw model id (for the check). */
  currentRawModel?: string;
  /** Issue #2456: wire the Effort submenu live. Absent → disabled "soon" row. */
  onSelectEffort?: (level: EffortLevel) => void;
  /** Issue #2456: wire the More-models submenu live. Absent → disabled "soon" row. */
  onSelectRawModel?: (id: string) => void;
  children: ReactNode;
}) {
  const {
    current,
    resolvedModel,
    defaultResolutionLabel,
    flavor,
    disabled,
    onSelect,
    currentEffort,
    currentRawModel,
    onSelectEffort,
    onSelectRawModel,
    children,
  } = props;

  const { api } = useAppContext();
  // Fetch the live catalog only when a submenu that needs it is wired.
  const { models } = useClaudeModels(api, {
    enabled: Boolean(onSelectEffort || onSelectRawModel),
  });

  const modes = getModelModesForFlavor(flavor);
  // Flavors without model modes (codex/gemini/opencode) get no menu.
  if (modes.length === 0) {
    return <>{children}</>;
  }

  const defaultLabel =
    defaultResolutionLabel ??
    (resolvedModel ? `Default (${formatModelName(resolvedModel)})` : "Default");

  const effortLevels = effortLevelsForCurrent(
    current,
    resolvedModel,
    currentRawModel,
    models
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        {children}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[13rem]">
        <DropdownMenuLabel className="text-xs text-[var(--app-hint)]">
          Model
        </DropdownMenuLabel>
        {modes.map(mode => {
          const isCurrent = mode === current && !currentRawModel;
          const label =
            mode === "default" ? defaultLabel : MODEL_MODE_LABELS[mode];
          const descriptor = MODEL_MODE_DESCRIPTORS[mode];
          return (
            <DropdownMenuItem
              key={mode}
              onSelect={() => onSelect(mode)}
              className={isCurrent ? "text-[var(--app-accent)]" : ""}
            >
              <span
                className="w-4 shrink-0 text-center text-[var(--app-accent)]"
                aria-hidden
              >
                {isCurrent ? "✓" : ""}
              </span>
              <span className="flex flex-1 flex-col">
                <span>{label}</span>
                {descriptor && (
                  <span className="text-[10px] opacity-60">{descriptor}</span>
                )}
              </span>
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />

        {/* Effort — live submenu (#2456), gated by the model's real capabilities. */}
        {onSelectEffort ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={effortLevels.length === 0}>
              <span className="w-4 shrink-0" />
              <span className="flex flex-1 items-center justify-between gap-2">
                <span>Effort</span>
                {currentEffort && (
                  <span className="text-[10px] opacity-60">
                    {EFFORT_LEVEL_LABELS[currentEffort]}
                  </span>
                )}
              </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {EFFORT_LEVELS.map(level => {
                const supported = effortLevels.includes(level);
                const isCurrent = level === currentEffort;
                return (
                  <DropdownMenuItem
                    key={level}
                    disabled={!supported}
                    onSelect={() => onSelectEffort(level)}
                    className={isCurrent ? "text-[var(--app-accent)]" : ""}
                  >
                    <span
                      className="w-4 shrink-0 text-center text-[var(--app-accent)]"
                      aria-hidden
                    >
                      {isCurrent ? "✓" : ""}
                    </span>
                    <span>{EFFORT_LEVEL_LABELS[level]}</span>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : (
          <SoonRow label="Effort" />
        )}

        {/* More models — live full catalog (#2456), specific pinned versions. */}
        {onSelectRawModel ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <span className="w-4 shrink-0" />
              <span className="flex-1">More models</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-[60vh] overflow-y-auto">
              {models.map(model => {
                const isCurrent = model.id === currentRawModel;
                return (
                  <DropdownMenuItem
                    key={model.id}
                    onSelect={() => onSelectRawModel(model.id)}
                    className={isCurrent ? "text-[var(--app-accent)]" : ""}
                  >
                    <span
                      className="w-4 shrink-0 text-center text-[var(--app-accent)]"
                      aria-hidden
                    >
                      {isCurrent ? "✓" : ""}
                    </span>
                    <span>{model.displayName}</span>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : (
          <SoonRow label="More models" />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
