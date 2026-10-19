// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Workflow-state phase map (issue #1672, epic #1662 — Sub J).
 *
 * The canonical, hardcoded lock↔checkpoint↔order structure for Hapimatic's
 * issue-workflow state machine. This is the single source of truth consumed by
 * BOTH J surfaces:
 *
 *   - the per-turn workflow chip (R1) — `labelToPhase` maps a `label_added` /
 *     `label_removed` event's label to a phase + active/done indicator;
 *   - the session checkpoint badge (R2) — `highestCheckpoint` finds the
 *     highest-order checkpoint present in `v_workflow_state.active_labels_json`.
 *
 * **Why hardcoded here (Fable D8)**: `scripts/labels/canonical-labels.json` lives
 * in the rp1-home repo, NOT this one, so J cannot import it. The phase map is
 * duplicated locally and verified against the live label set (the
 * `🧠 expert-reviewed` checkpoint is confirmed present on issue #1672 itself).
 *
 * **Normalization (R3)**: lock labels carry a trailing `" ..."` (e.g.
 * `🔒 locked: 📝 researching ...`); `normalizeLockLabel` strips it (and the legacy
 * no-space `"..."` variant) so a lock event matches its bare map entry. Checkpoint
 * labels are exact and need no stripping.
 *
 * **Asymmetric rows (R3)**: `pr-reviewing` is lock-only (no paired checkpoint —
 * never participates in `highestCheckpoint`); `created` is checkpoint-only (no
 * paired lock). Both are handled by the per-side `null`.
 *
 * **Non-monotonic regression (R4)**: this module is stateless — it interprets
 * whatever label set it is given. The badge regresses automatically when
 * `v_workflow_state` drops a checkpoint (a later `label_removed` wins), because
 * `highestCheckpoint` is recomputed over the current `active_labels` each render.
 *
 * Pure module (no imports) — unit-testable in isolation and tree-shakeable
 * (`"sideEffects": false` in shared/package.json).
 */

/** One row of the workflow phase map. `order` is the workflow progression rank. */
export interface WorkflowPhase {
  /** Monotonic workflow progression rank (created=1 … closed=9). */
  readonly order: number;
  /**
   * Bare lock label WITHOUT the trailing `" ..."` suffix, or `null` for the
   * checkpoint-only `created` row. Compared against `normalizeLockLabel(input)`.
   */
  readonly lock: string | null;
  /** Exact checkpoint label, or `null` for the lock-only `pr-reviewing` row. */
  readonly checkpoint: string | null;
}

/**
 * The canonical lock↔checkpoint↔order table (Fable D8). Ordered by workflow
 * progression. `order` gaps are intentional-free — values are contiguous so
 * `highestCheckpoint` comparisons are unambiguous.
 */
export const WORKFLOW_PHASES: readonly WorkflowPhase[] = Object.freeze([
  { order: 1, lock: null, checkpoint: "✅ checkpoint: ✨ created" },
  {
    order: 2,
    lock: "🔒 locked: 📊 formatting",
    checkpoint: "✅ checkpoint: 📊 formatted",
  },
  {
    order: 3,
    lock: "🔒 locked: 📝 researching",
    checkpoint: "✅ checkpoint: 📝 researched",
  },
  {
    order: 4,
    lock: "🔒 locked: 🎓 expert-reviewing",
    checkpoint: "✅ checkpoint: 🧠 expert-reviewed",
  },
  {
    order: 5,
    lock: "🔒 locked: 🔨 working",
    checkpoint: "✅ checkpoint: 🔨 worked",
  },
  {
    order: 6,
    lock: "🔒 locked: 🧪 testing",
    checkpoint: "✅ checkpoint: 🧪 tested",
  },
  {
    order: 7,
    lock: "🔒 locked: 👁️ refactor-reflecting",
    checkpoint: "✅ checkpoint: 👁️ refactor-reflected",
  },
  { order: 8, lock: "🔒 locked: 🔎 pr-reviewing", checkpoint: null },
  {
    order: 9,
    lock: "🔒 locked: ☑️ closing",
    checkpoint: "✅ checkpoint: ☑️ closed",
  },
]);

/**
 * Strip a trailing `" ..."` (or legacy no-space `"..."`) ellipsis and surrounding
 * whitespace from a lock label so it matches the bare entries in WORKFLOW_PHASES.
 * Idempotent and safe on checkpoint labels (which have no ellipsis).
 */
export function normalizeLockLabel(label: string): string {
  // Same result as `/\s*\.{3}\s*$/` (`\s` and `trim()` strip the identical
  // character set), without that regex's quadratic backtracking on trailing
  // whitespace (CodeQL js/polynomial-redos, hapimatic-core #9).
  const end = label.trimEnd();
  return (end.endsWith("...") ? end.slice(0, -3) : end).trim();
}

/**
 * Extract the human-display portion of a workflow label — everything after the
 * `": "` separator. `"✅ checkpoint: 📝 researched"` → `"📝 researched"`;
 * `"🔒 locked: 📝 researching"` → `"📝 researching"`. Returns the input unchanged
 * if no separator is present.
 */
export function labelDisplay(label: string): string {
  const idx = label.indexOf(": ");
  return idx >= 0 ? label.slice(idx + 2) : label;
}

/** Result of mapping a single label to its phase. */
export interface PhaseMatch {
  /** Workflow progression rank. */
  readonly order: number;
  /** `"lock"` → phase ACTIVE; `"checkpoint"` → phase DONE (R1). */
  readonly kind: "lock" | "checkpoint";
  /** Display text (emoji + word) derived from the matched label. */
  readonly display: string;
}

/**
 * Map a workflow label (from a `label_added` / `label_removed` event) to its
 * phase. Returns `null` for any non-workflow label (the per-turn chip skips
 * those). Normalizes lock-label ellipsis before matching (R3).
 */
export function labelToPhase(label: string): PhaseMatch | null {
  const norm = normalizeLockLabel(label);
  for (const phase of WORKFLOW_PHASES) {
    if (phase.lock !== null && normalizeLockLabel(phase.lock) === norm) {
      return {
        order: phase.order,
        kind: "lock",
        display: labelDisplay(phase.lock),
      };
    }
    if (phase.checkpoint !== null && phase.checkpoint === norm) {
      return {
        order: phase.order,
        kind: "checkpoint",
        display: labelDisplay(phase.checkpoint),
      };
    }
  }
  return null;
}

/** Result of resolving the highest checkpoint present in an active label set. */
export interface CheckpointMatch {
  /** Workflow progression rank of the highest checkpoint present. */
  readonly order: number;
  /** The exact checkpoint label. */
  readonly label: string;
  /** Display text (emoji + word), e.g. `"📝 researched"`. */
  readonly display: string;
}

/**
 * Resolve the highest-order CHECKPOINT present in a set of active labels (R2).
 * Lock labels and non-workflow labels are ignored. Returns `null` when no
 * checkpoint is present (badge renders nothing — R7 fail-open). Honors
 * regression: it only sees the labels currently active, so a removed checkpoint
 * naturally lowers (or clears) the result (R4).
 */
export function highestCheckpoint(
  activeLabels: readonly string[]
): CheckpointMatch | null {
  let best: CheckpointMatch | null = null;
  for (const raw of activeLabels) {
    const norm = normalizeLockLabel(raw);
    for (const phase of WORKFLOW_PHASES) {
      if (phase.checkpoint !== null && phase.checkpoint === norm) {
        if (best === null || phase.order > best.order) {
          best = {
            order: phase.order,
            label: phase.checkpoint,
            display: labelDisplay(phase.checkpoint),
          };
        }
      }
    }
  }
  return best;
}

/** Result of resolving the single label a session's state badge should show. */
export interface StateBadgeMatch {
  /** Workflow progression rank of the resolved label. */
  readonly order: number;
  /** `"lock"` → an active lock (P1, gold); `"checkpoint"` → highest checkpoint (P2, green). */
  readonly kind: "lock" | "checkpoint";
  /** Full canonical label, e.g. `"🔒 locked: 🔨 working"` / `"✅ checkpoint: 📝 researched"`. */
  readonly label: string;
  /** Display text (emoji + word) after the `": "`, e.g. `"🔨 working"`. */
  readonly display: string;
}

/**
 * Resolve the single label a session's linked-issue state badge should show
 * (issue #1804). Priority: **P1** — any active `🔒 locked:` label wins (return the
 * highest-order lock present, because a running phase outranks any completed
 * checkpoint); **P2** — else the highest `✅ checkpoint:` (delegates to
 * `highestCheckpoint`). Non-workflow labels (`🤖 issue-agent:`, etc.) are ignored
 * because they match no WORKFLOW_PHASES row (R3). Returns `null` when neither a
 * lock nor a checkpoint is present so the caller falls back to the standard type
 * badge (R4). Stateless — honors non-monotonic regression like `highestCheckpoint`
 * (R4). This is the R2/P1-P2 resolver #1672's checkpoint-only `WorkflowCheckpointBadge`
 * lacked; #1804's relocated badge adds the lock priority (G3).
 */
export function resolveStateBadge(
  activeLabels: readonly string[]
): StateBadgeMatch | null {
  // P1: highest-order active lock (bare-compare after ellipsis normalization).
  let bestLock: WorkflowPhase | null = null;
  for (const raw of activeLabels) {
    const norm = normalizeLockLabel(raw);
    for (const phase of WORKFLOW_PHASES) {
      if (phase.lock !== null && phase.lock === norm) {
        if (bestLock === null || phase.order > bestLock.order) {
          bestLock = phase;
        }
      }
    }
  }
  if (bestLock !== null && bestLock.lock !== null) {
    return {
      order: bestLock.order,
      kind: "lock",
      label: bestLock.lock,
      display: labelDisplay(bestLock.lock),
    };
  }
  // P2: highest checkpoint.
  const checkpoint = highestCheckpoint(activeLabels);
  if (checkpoint !== null) {
    return {
      order: checkpoint.order,
      kind: "checkpoint",
      label: checkpoint.label,
      display: checkpoint.display,
    };
  }
  return null;
}
