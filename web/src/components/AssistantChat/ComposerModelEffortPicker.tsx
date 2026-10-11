// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ComposerModelEffortPicker (issue #2882) — the model + effort trigger in the
 * prompt composer's bottom-left row. Reads e.g. "Opus 4.8 Extra" next to the
 * permission-mode label; tapping it opens the `ModelSelectorModal` (iter AC —
 * replacing the old nested Radix dropdown that flowed off-screen).
 *
 * Flat props (NOT a session object) because it mounts inside ComposerButtons,
 * which is a presentational component with flat props.
 *
 * Iter AE:
 * - The trigger text is `text-xs` (matches the MCP indicator) and MUTED-semantic:
 *   a muted mint (`--app-link`/70) for a normally-resolved model, a muted red
 *   (`red-500`/70) when the session is running a downgraded model (#1509) —
 *   replacing the removed "⚠ Downgraded model" banner. The effort suffix follows
 *   the model's color (rendered as one "Opus 4.8 Extra" unit).
 * - The downgrade predicate is optimistic across a model switch (see
 *   isModelDowngraded), so the text no longer flashes red→mint when switching to
 *   an entitled model.
 * - Selecting a model pins a specific raw model id (onRawModelChange); the
 *   effort slider applies onEffortChange. Both go through the session mutations
 *   (which 409 on an offline session — the toast surfaces that).
 *
 * Flavors without model modes (codex/gemini/opencode) render display-only text.
 */
import { useState } from "react";
import {
  EFFORT_LEVELS,
  formatModelName,
  getModelModesForFlavor,
  MODEL_MODE_LABELS,
  type EffortLevel,
  type ModelMode,
} from "@hapi/protocol";
import { useAppContext } from "@/lib/app-context";
import { useClaudeModels } from "@/hooks/queries/useClaudeModels";
import { ModelSelectorModal } from "@/components/AssistantChat/ModelSelectorModal";

/**
 * Compact effort labels for the collapsed composer trigger (issue #2882 mockup
 * reads "Extra", not the modal's full "Extra High"). The modal's effort slider
 * keeps the full `EFFORT_LEVEL_LABELS`; this shorter form only labels the
 * collapsed trigger so the bottom row stays tight at 393px.
 */
const COMPACT_EFFORT_LABELS: Record<EffortLevel, string> = {
  low: "Low",
  medium: "Med",
  high: "High",
  xhigh: "Extra",
  max: "Max",
};

export function ComposerModelEffortPicker(props: {
  modelMode: ModelMode;
  resolvedModel?: string;
  effort?: EffortLevel;
  rawModel?: string;
  flavor?: string | null;
  disabled?: boolean;
  /** #1509: the session is running a below-entitlement model → render red. */
  downgraded?: boolean;
  onEffortChange?: (level: EffortLevel) => void;
  onRawModelChange?: (rawModel: string) => void;
}) {
  const {
    modelMode,
    resolvedModel,
    effort,
    rawModel,
    flavor,
    disabled,
    downgraded,
    onEffortChange,
    onRawModelChange,
  } = props;

  const { api } = useAppContext();
  const [open, setOpen] = useState(false);
  // Fetch the live catalog only when the modal is opened (falls back to the
  // static catalog until then, so the modal is never empty).
  const { models } = useClaudeModels(api, { enabled: open });

  // Collapsed label: a pinned raw model, else the running resolved model, else
  // the mode label.
  const modelLabel = rawModel
    ? formatModelName(rawModel)
    : resolvedModel
      ? formatModelName(resolvedModel)
      : (MODEL_MODE_LABELS[modelMode] ?? modelMode ?? "default");

  const effortLabel =
    effort && EFFORT_LEVELS.includes(effort)
      ? COMPACT_EFFORT_LABELS[effort]
      : undefined;

  // Flavors without model modes (codex/gemini/opencode) → display-only text.
  if (getModelModesForFlavor(flavor).length === 0) {
    return (
      <span className="min-w-0 truncate text-xs text-[var(--app-hint)]">
        {modelLabel}
        {effortLabel ? <span className="ml-1">{effortLabel}</span> : null}
      </span>
    );
  }

  return (
    <>
      <button /* design-tokens-allow: bare inline composer trigger (text-xs hover:underline) - Button box breaks the tight composer row - D2 exception (#3357) */
        type="button"
        onPointerDown={e => e.stopPropagation()}
        onClick={() => setOpen(true)}
        disabled={disabled}
        aria-haspopup="dialog"
        className={`min-w-0 cursor-pointer truncate text-xs hover:underline disabled:cursor-not-allowed disabled:opacity-50 ${
          downgraded ? "text-red-500/70" : "text-[var(--app-link)]/70"
        }`}
      >
        {modelLabel}
        {effortLabel ? <span className="ml-1">{effortLabel}</span> : null}
      </button>
      <ModelSelectorModal
        isOpen={open}
        onClose={() => setOpen(false)}
        models={models}
        currentModelId={rawModel ?? resolvedModel}
        currentEffort={effort}
        onSelectModel={id => onRawModelChange?.(id)}
        onSelectEffort={lvl => onEffortChange?.(lvl)}
      />
    </>
  );
}
