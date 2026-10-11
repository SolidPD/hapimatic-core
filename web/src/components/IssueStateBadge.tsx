// SPDX-License-Identifier: AGPL-3.0-only
import { useLayoutEffect, useRef, useState } from "react";
import type { SessionWorkflowBadge } from "@hapi/protocol";
import { resolveStateBadge } from "@hapi/protocol/workflowPhases";

/**
 * Kind → GitHub label color: gold locks (P1), green checkpoints (P2).
 *
 * KEPT AS DATA (#3434 · epic #3354, owner ruling D2(a)): these two hexes are
 * behavior-coupled data colors that MIRROR the GitHub label colors rendered
 * verbatim by `IssueInfoModal.tsx`'s `LabelBadge` (`#${label.color}`) — external
 * data a theme must never re-tint, so a semantic `--issue-kind-*` app token would
 * have no legitimate value of its own. Recorded as a permanent inline exception on
 * each literal line below (so the `IssueStateBadge.tsx` entry is removed from
 * `scripts/design-tokens-baseline.json`, not left as a grandfathered count).
 * FileIcon's extension colors remain a separate pending decision.
 */
const KIND_COLOR: Record<"lock" | "checkpoint", string> = {
  lock: "#d4a017", // design-tokens-allow: behavior-coupled data color mirroring the GitHub label color (matches IssueInfoModal LabelBadge); no semantic app token (#3434 keep decision D2(a))
  checkpoint: "#2ea44f", // design-tokens-allow: behavior-coupled data color mirroring the GitHub label color (matches IssueInfoModal LabelBadge); no semantic app token (#3434 keep decision D2(a))
};

/** Leading emoji token of a label part (first whitespace-delimited token). */
function leadingEmoji(part: string): string {
  return part.trim().split(/\s+/)[0] ?? "";
}

/**
 * The four rungs of the state badge's truncation ladder (E9, operator round 11,
 * 2026-09-06). Each rung drops the least load-bearing token of the one above:
 *
 *   L1 `full`       — `✅ checkpoint: 🔨 worked`   (the canonical label)
 *   L2 `emojiPhase` — `✅ 🔨 worked`               (kind WORD + colon dropped)
 *   L3 `wordOnly`   — `✅ worked`                  (phase EMOJI dropped too)
 *   L4 `emojiOnly`  — `✅ 🔨`                      (phase word dropped; emoji only)
 *
 * The kind emoji (✅ / 🔒) survives every rung because it is what distinguishes
 * a checkpoint from a lock at a glance; the phase WORD outranks the phase emoji
 * because "worked"/"working" is legible where 🔨 alone is ambiguous.
 */
export type StateBadgeLadder = {
  full: string;
  emojiPhase: string;
  wordOnly: string;
  emojiOnly: string;
};

/**
 * Build the truncation ladder for a canonical lock/checkpoint label. Any trailing
 * `" ..."` is already stripped by `resolveStateBadge` (it returns the bare
 * canonical label). A label with no `:` separator has no kind/phase split, so
 * L1–L3 are the label itself and L4 is its leading emoji.
 */
export function checkpointLadder(label: string): StateBadgeLadder {
  const idx = label.indexOf(":");
  if (idx < 0) {
    return {
      full: label,
      emojiPhase: label,
      wordOnly: label,
      emojiOnly: leadingEmoji(label),
    };
  }
  const kindEmoji = leadingEmoji(label.slice(0, idx));
  const phaseTokens = label
    .slice(idx + 1)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const phaseEmoji = phaseTokens[0] ?? "";
  const phaseWords = phaseTokens.slice(1).join(" ");
  const join = (parts: string[]) => parts.filter(Boolean).join(" ");
  return {
    full: label,
    emojiPhase: join([kindEmoji, phaseEmoji, phaseWords]),
    wordOnly: join([kindEmoji, phaseWords]),
    emojiOnly: join([kindEmoji, phaseEmoji]),
  };
}

/** The ladder as an array, longest rung first — the order the fit-picker walks. */
export function ladderRungs(ladder: StateBadgeLadder): readonly string[] {
  return [ladder.full, ladder.emojiPhase, ladder.wordOnly, ladder.emojiOnly];
}

/**
 * Sub-pixel tolerance for the fit test. `getBoundingClientRect` widths are
 * fractional, and a rung that fits EXACTLY (e.g. 90.2 + 14 vs 104.2) can miss
 * on float noise (104.19999… > 104.2) and drop a rung for no visible reason.
 * 0.01px can never admit a real overflow (layout rounds to device pixels).
 */
const FIT_EPSILON_PX = 0.01;

/**
 * Pick the LONGEST rung that fits: the first index whose rendered text width
 * plus the badge's chrome (horizontal padding + border) is ≤ the width left in
 * the row. Falls back to the shortest rung when none fits. With no layout
 * engine (jsdom) every width is 0, so 0 ≤ 0 selects L1 — the full label is the
 * default wherever nothing can be measured.
 */
export function pickRung(
  available: number,
  chrome: number,
  rungWidths: readonly number[]
): number {
  for (let i = 0; i < rungWidths.length; i++) {
    if (rungWidths[i] + chrome <= available + FIT_EPSILON_PX) return i;
  }
  return Math.max(0, rungWidths.length - 1);
}

/**
 * Issue #1804: the per-session workflow-state badge that replaces the standard
 * `👤 standard` type badge when a session's linked issue has a resolvable
 * lock/checkpoint state (now the Row-2 Session Status Badge, epic #3285).
 *
 * - **Selection (R2 / P1-P2 / G3)**: `resolveStateBadge` — an active `🔒 locked:`
 *   label wins over any checkpoint; else the highest `✅ checkpoint:`.
 * - **Color by KIND (R5)**: gold lock `#d4a017` / green checkpoint `#2ea44f` via
 *   `color-mix`, matching `IssueInfoModal`'s `LabelBadge`. These mirror external
 *   GitHub label colors (behavior-coupled data, not a themeable app color), kept
 *   as literals under a permanent inline exception (#3434 · epic #3354).
 * - **Responsive form (R6 / G2, E9 ladder)**: the badge renders the LONGEST rung
 *   of `checkpointLadder` that fits the room left in its row —
 *   `✅ checkpoint: 🔨 worked` → `✅ 🔨 worked` → `✅ worked` → `✅ 🔨` — so a
 *   narrow card (mobile / a narrow split-view pane) degrades one token at a time
 *   instead of jumping straight to emoji. The fit is MEASURED, not a container
 *   query: rung-1 widths span ~110–172px across the workflow phases (`🔒 locked:
 *   🔨 working` vs `✅ checkpoint: 👁️ refactor-reflected`, measured 2026-09-06)
 *   while a 393px phone leaves the badge ~118px, so no single set of width
 *   thresholds fits every label — a threshold tuned for "worked" wraps
 *   "refactor-reflected". Instead a `ResizeObserver` on the badge's row measures
 *   the space from the badge's left edge to the row's right edge and all four
 *   rungs' text widths (the inactive rungs stay in the DOM, absolutely
 *   positioned + invisible, so they are measurable), and `pickRung` chooses.
 *   Both surfaces (`SessionItem` / `SessionHeader`) render the badge as the
 *   last member of a `flex-wrap` row after the fixed time block, so "the room
 *   left in the row" is exactly the width that decides wrap-vs-fit. CONTRACT:
 *   that row must SPAN its column (`flex-1`), not size to its content — a
 *   content-sized row's right edge moves with the badge's own width, which
 *   turns the measurement into a feedback loop (observed 2026-09-06: a rung
 *   that fit exactly was re-measured against its own width and dropped one
 *   more rung). Without a layout engine (jsdom) the full label is the default.
 * - **Non-clickable (R7)** with a `title`/`aria-label` tooltip of the full label.
 *
 * Returns `null` when the badge has no resolvable state so the caller renders the
 * standard type badge (R4).
 */
export function IssueStateBadge({ badge }: { badge: SessionWorkflowBadge }) {
  const state = resolveStateBadge(badge.activeLabels);
  const full = state?.label ?? ""; // e.g. "🔒 locked: 🔨 working"
  const ref = useRef<HTMLSpanElement>(null);
  const [active, setActive] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !full) return;
    const row = el.parentElement;
    if (!row) return;
    const measure = () => {
      const rowRect = row.getBoundingClientRect();
      const prev = el.previousElementSibling;
      const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
      // Room from where the badge starts (after its preceding sibling + the
      // row gap) to the row's right edge. Reading the SIBLING (not the badge's
      // own left, which moves if the badge has wrapped) keeps this stable.
      const left = prev
        ? prev.getBoundingClientRect().right + gap
        : rowRect.left;
      const available = rowRect.right - left;
      const cs = getComputedStyle(el);
      const chrome =
        (parseFloat(cs.paddingLeft) || 0) +
        (parseFloat(cs.paddingRight) || 0) +
        (parseFloat(cs.borderLeftWidth) || 0) +
        (parseFloat(cs.borderRightWidth) || 0);
      const widths = Array.from(
        el.querySelectorAll<HTMLElement>("[data-rung]")
      ).map(s => s.getBoundingClientRect().width);
      setActive(pickRung(available, chrome, widths));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(row);
    return () => ro.disconnect();
  }, [full]);

  if (!state) return null;

  const color = KIND_COLOR[state.kind];
  const rungs = ladderRungs(checkpointLadder(full));

  return (
    <span
      ref={ref}
      title={full}
      aria-label={full}
      data-testid="issue-state-badge"
      data-active-rung={active + 1}
      className="relative inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-[length:var(--text-caption-xs)] font-medium leading-none whitespace-nowrap"
      style={{
        color,
        backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`,
        borderColor: `color-mix(in srgb, ${color} 30%, transparent)`,
      }}
    >
      {/* E9 ladder: all four rungs are in the DOM so their widths can be
          measured; only the picked rung takes part in layout, the rest are
          absolutely positioned + invisible (see `pickRung`). */}
      {rungs.map((text, i) => (
        <span
          key={i}
          data-rung={i + 1}
          aria-hidden={i === active ? undefined : true}
          className={
            i === active
              ? undefined
              : "invisible absolute left-0 top-0 whitespace-nowrap"
          }
        >
          {text}
        </span>
      ))}
    </span>
  );
}
