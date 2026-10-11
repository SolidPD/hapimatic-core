// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ModelSelectorModal (issue #2882 iter AC) — replaces the nested Radix dropdown
 * (family quick-picks → "More models" submenu that flowed off-screen) with a
 * single modal, styled in the MCP-modal design language.
 *
 * Two sections:
 *  - Top (main, scrollable): the flat list of every selectable model for the CLI,
 *    ordered by release recency (newest first). No model families / no submenu —
 *    just the concrete models. Tapping one pins it (onSelectModel → raw model id).
 *  - Bottom (smaller): a horizontal slider with a discrete mark per effort level
 *    the SELECTED model supports, labelled with the chosen level under an
 *    "Effort" sub-heading.
 *
 * The modal fills 80% of the viewport height so a long catalog scrolls in the top
 * section while the effort slider stays pinned at the bottom.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  DEFAULT_EFFORT_LEVEL,
  EFFORT_LEVEL_LABELS,
  sortByReleaseDesc,
  type ClaudeModelInfo,
  type EffortLevel,
} from "@hapi/protocol";
import { UiCheckIcon } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";

// `releaseKey` / `sortByReleaseDesc` moved to `shared/src/modelCatalog.ts`
// (issue #2506 Task 6) so the flat sort here and the newest-per-family partition
// share ONE recency heuristic; imported above.

export function ModelSelectorModal(props: {
  isOpen: boolean;
  onClose: () => void;
  models: ClaudeModelInfo[];
  /** The currently-active model id (pinned raw model, else the resolved model). */
  currentModelId?: string;
  currentEffort?: EffortLevel;
  onSelectModel: (id: string) => void;
  onSelectEffort: (level: EffortLevel) => void;
}) {
  const {
    isOpen,
    onClose,
    models,
    currentModelId,
    currentEffort,
    onSelectModel,
    onSelectEffort,
  } = props;

  // Local "pending selection" — the model highlighted in the list. It drives the
  // effort section below (the user's spec: the slider shows the SELECTED model's
  // effort levels, not the session's active model's). Initialized to the active
  // model and re-synced whenever the modal (re)opens or the active model changes.
  // Hooks must run before the early return (rules of hooks).
  const [selectedId, setSelectedId] = useState(currentModelId);
  useEffect(() => {
    if (isOpen) setSelectedId(currentModelId);
  }, [isOpen, currentModelId]);

  if (!isOpen) return null;

  const sorted = sortByReleaseDesc(models);
  // The effort levels come from the currently-SELECTED model (a model may not
  // support every level — Haiku supports none, Opus 4.6 has no `xhigh`).
  const currentModel = selectedId
    ? models.find(m => m.id === selectedId || selectedId.startsWith(m.id))
    : undefined;
  const effortLevels = currentModel?.effortLevels ?? [];
  // Issue #2506 Task 8 — resolve the slider position HONESTLY. The old
  // `Math.max(0, currentEffort ? indexOf : -1)` snapped to index 0 ("Low") in
  // TWO wrong cases — no effort chosen, and an effort the model doesn't support
  // — a triple-false indication (header + slider + bold tick all read "Low").
  const setIndex = currentEffort ? effortLevels.indexOf(currentEffort) : -1;
  const isUnset = currentEffort == null;
  // Effort was chosen but this model can't do it (e.g. xhigh + a no-xhigh model).
  const isUnsupportedSelection =
    !isUnset && setIndex === -1 && effortLevels.length > 0;
  // Fallback when there is no explicit, supported pick: the Hapimatic default
  // effort if this model supports it (F2 — show the concrete default, not "Low"),
  // else the highest supported level (closest to a reasoning default).
  const defaultIndex = effortLevels.indexOf(DEFAULT_EFFORT_LEVEL);
  const fallbackIndex =
    defaultIndex >= 0 ? defaultIndex : Math.max(0, effortLevels.length - 1);
  const effortIndex = setIndex >= 0 ? setIndex : fallbackIndex;
  const activeLevel = effortLevels[effortIndex];
  // Header text — never a bare fabricated level:
  //  • no effort levels (Haiku)      → "—"
  //  • chosen but unsupported        → "Extra High · unavailable"
  //  • no explicit pick (implied)    → "Default (High)"
  //  • explicit, supported pick      → "High"
  let effortHeaderLabel: string;
  if (effortLevels.length === 0 || !activeLevel) {
    effortHeaderLabel = "—";
  } else if (isUnsupportedSelection && currentEffort) {
    effortHeaderLabel = `${EFFORT_LEVEL_LABELS[currentEffort]} · unavailable`;
  } else if (isUnset) {
    effortHeaderLabel = `Default (${EFFORT_LEVEL_LABELS[activeLevel]})`;
  } else {
    effortHeaderLabel = EFFORT_LEVEL_LABELS[activeLevel];
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex w-[min(28rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] shadow-2xl"
        style={{ height: "80vh" }}
      >
        {/* Header (MCP-modal language) */}
        <div className="flex items-center gap-2 border-b border-[var(--app-border)] px-4 py-3">
          <span className="text-sm font-semibold text-[var(--app-fg)]">
            Model Selector
          </span>
          <Button
            type="button"
            variant="ghostStatic"
            size="bare"
            onClick={onClose}
            className="ml-auto text-[var(--app-hint)] transition-colors hover:text-[var(--app-fg)]"
            aria-label="Close"
          >
            ✕
          </Button>
        </div>

        {/* Top section — scrollable flat model list, newest first. */}
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {sorted.length === 0 ? (
            <div className="px-2 py-4 text-center text-xs text-[var(--app-hint)]">
              No models available.
            </div>
          ) : (
            sorted.map(model => {
              const isCurrent =
                model.id === selectedId ||
                (selectedId?.startsWith(model.id) ?? false);
              return (
                <Button
                  key={model.id}
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    // Highlight locally (drives the effort section) AND commit the
                    // model change to the session.
                    setSelectedId(model.id);
                    onSelectModel(model.id);
                  }}
                  className={`flex h-auto w-full items-center justify-start gap-2 rounded px-2 py-2 text-left text-sm font-normal transition-colors hover:bg-[var(--app-hover)] ${
                    isCurrent
                      ? "text-[var(--app-accent)]"
                      : "text-[var(--app-fg)]"
                  }`}
                >
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                    {isCurrent ? (
                      <UiCheckIcon className="h-4 w-4 text-[var(--app-accent)]" />
                    ) : null}
                  </span>
                  <span className="flex-1 truncate">{model.displayName}</span>
                  {model.effortLevels.length === 0 ? (
                    <span className="shrink-0 rounded bg-[var(--app-secondary-bg)] px-1 text-[9px] font-semibold uppercase tracking-wide text-[var(--app-hint)]">
                      no effort
                    </span>
                  ) : null}
                </Button>
              );
            })
          )}
        </div>

        {/* Bottom section — effort slider for the selected model. */}
        <div className="border-t border-[var(--app-border)] px-4 py-3">
          <div className="mb-1 flex items-baseline justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-[var(--app-hint)]">
              Effort
            </span>
            <span className="text-sm text-[var(--app-fg)]">
              {effortHeaderLabel}
            </span>
          </div>
          {effortLevels.length > 0 ? (
            <>
              <input
                type="range"
                min={0}
                max={effortLevels.length - 1}
                step={1}
                value={effortIndex}
                list="effort-ticks"
                onChange={e => {
                  const lvl = effortLevels[Number(e.target.value)];
                  if (lvl) onSelectEffort(lvl);
                }}
                className="w-full accent-[var(--app-accent)]"
                aria-label="Effort level"
              />
              {/* Discrete markings, one per supported level. */}
              <div className="mt-1 flex justify-between">
                {effortLevels.map((lvl, i) => (
                  <Button
                    key={lvl}
                    type="button"
                    variant="ghostStatic"
                    size="bare"
                    onClick={() => onSelectEffort(lvl)}
                    className={`text-[10px] font-normal transition-colors hover:text-[var(--app-fg)] ${
                      i === effortIndex
                        ? "font-semibold text-[var(--app-fg)]"
                        : "text-[var(--app-hint)] hover:text-[var(--app-fg)]"
                    }`}
                  >
                    {EFFORT_LEVEL_LABELS[lvl]}
                  </Button>
                ))}
              </div>
            </>
          ) : (
            <p className="text-xs text-[var(--app-hint)]">
              This model has no reasoning-effort levels.
            </p>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
