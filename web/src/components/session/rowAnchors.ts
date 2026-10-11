// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Session Basic Info Bar anchor geometry (#3287 S2 + epic #3285 correction pass
 * 1 + E9). ONE place for the Row-2 Status Icon Cluster slot widths so the Row-1
 * right cluster is sized to the SAME width, making the right cluster TWO aligned
 * BLOCKS (E9, operator round 11, 2026-09-06):
 *
 *   LEFT BLOCK  — Account Chip (Row 1) over Loop-Cron Chip (Row 2): one width
 *                 (`LOOP_CRON_SLOT_PX`), one shared left edge.
 *   RIGHT BLOCK — Node Badge (Row 1) over [Message Count · Bell] (Row 2): one
 *                 shared right edge (both rows are right-aligned in the same
 *                 `items-end` column).
 *
 * Row 2 (right → left): [Bell 16] gap [Message Count 31 + r] gap [Loop-Cron 76],
 * where `r` is the Node Badge's corner radius (`NODE_BADGE_RADIUS_CSS`): the
 * count slot is padded left by `r` so the bubble starts where the badge's
 * straight edge begins (round 10). E9 removed the reserved conditional-icon
 * slot that used to lead the row (the waiting `?` was dropped; the queued
 * signal is now the count bubble turning yellow), so Row 2 is exactly
 * (76 + 4 + 31 + 4 + 16) px + r = the Row-1 cluster.
 *
 * The left block is 76px — the E9 mockup's `--chip-w` — not the E7 68px: the
 * Account Chip's fixed chrome (monogram + gaps + padding + border) measures
 * 28px, so a 68px cell leaves 40px for the nickname and ellipsizes "Matt [NF]"
 * (42px) and "739-Emily" (46px); 76px leaves 48px and fits every operator
 * nickname with ≥2px to spare (measured on the deployed 393px card, 2026-09-06).
 *
 * The Tailwind classes on the slots stay literal (`w-[76px]`, `w-[31px]`,
 * `gap-1`, bell `p-0.5` + `h-3`) because Tailwind's JIT needs literal strings;
 * `rowAnchors.test.ts` pins these constants to those literals so they cannot
 * drift apart silently.
 */
export const LOOP_CRON_SLOT_PX = 76;
export const MESSAGE_COUNT_SLOT_PX = 31;
/** Bell button: `p-0.5` (2px) × 2 + `h-3 w-3` (12px) glyph. */
export const BELL_PX = 16;
/** `gap-1` between cluster members. */
export const CLUSTER_GAP_PX = 4;

/** The RIGHT block: the Node Badge is a fixed cell exactly as wide as the Row-2
 *  [Message Count · gap · Bell] span beneath it, label centered (E8: "node badge
 *  … centered"; E9: "one width, one right edge"). Integer part only — see
 *  `plusNodeBadgeRadius` for the rendered width. */
export const NODE_BADGE_CELL_PX =
  MESSAGE_COUNT_SLOT_PX + CLUSTER_GAP_PX + BELL_PX;

/** Width of the Row-1 right cluster [Account Chip … Node Badge] — equal to the
 *  Row-2 cluster, so the two rows share BOTH edges (the E9 two-block layout).
 *  Integer part only — see `plusNodeBadgeRadius` for the rendered width. */
export const ROW1_RIGHT_CLUSTER_PX =
  LOOP_CRON_SLOT_PX +
  CLUSTER_GAP_PX +
  MESSAGE_COUNT_SLOT_PX +
  CLUSTER_GAP_PX +
  BELL_PX;

/**
 * The Node Badge's corner radius — Tailwind `rounded-md` = `--radius-md`, which
 * `web/src/design/tokens.css` defines as `calc(var(--radius) * 0.8)` (6.4px at
 * the default `--radius: 0.5rem`). `--radius-md` is inlined at build time, so
 * the runtime expression below is the same formula over the runtime `--radius`.
 *
 * Operator ruling (round 10, 2026-09-07): the Message Count bubble's LEFT edge
 * sits where the Node Badge's top/bottom edges become STRAIGHT — i.e. one
 * corner radius in from the badge's left edge — not on the badge's left edge
 * (a bubble flush with a rounded corner reads as misaligned). So the count
 * slot carries this much left padding, and the Node Badge cell + the Row-1
 * cluster grow by the same amount so both blocks keep their shared edges.
 */
export const NODE_BADGE_RADIUS_CSS = "calc(var(--radius) * 0.8)";

/** A px anchor width plus the Node Badge radius, as a CSS length — for the
 *  Row-1 cluster, the Node Badge cell, and the Row-2 message-count slot. */
export function plusNodeBadgeRadius(px: number): string {
  return `calc(${px}px + ${NODE_BADGE_RADIUS_CSS})`;
}

// ── E6 pixel seating (#3574, folded into the #3285 correction pass) ──────────
// Values read straight off the mockups (`session-list.html` / `session-instance.html`):
// `.row1 { gap: 7px }`, `.cluster { gap: 5px }` (Account Chip ↔ Node Badge),
// `.row2 { margin-top: 5px }` on the list card and `6px` on the instance header.
// Applied as inline `style` so the exact values need no arbitrary Tailwind class.
/** Gap between the Row-1 left members (dot · emoji · name · pencil). */
export const ROW1_GAP_PX = 7;
/** Gap inside the Row-1 right cluster (Account Chip ↔ Node Badge). MUST equal
 *  the Row-2 `CLUSTER_GAP_PX`: the cluster is `ROW1_RIGHT_CLUSTER_PX` wide
 *  (76 + 4 + 51), so a 5px gap (the E6 `.cluster` seating) overflowed it by 1px
 *  and pushed the Node Badge cell 1px right of the [count · bell] span beneath
 *  it — both block edges must coincide (measured 2026-09-07: 299 vs 298). */
export const ROW1_CLUSTER_GAP_PX = CLUSTER_GAP_PX;
/** Vertical gap between Row 1 and Row 2 — list card. */
export const ROW_GAP_LIST_PX = 5;
/** Vertical gap between Row 1 and Row 2 — instance header. */
export const ROW_GAP_INSTANCE_PX = 6;
