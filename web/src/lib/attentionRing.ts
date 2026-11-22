// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The attention ring on an entity chip (issue #6884, design README extensions
 * 1 and 2; first drawn on `NodeBadge` by #4466 and #6161). ONE class map, so a
 * node pill and an account chip in the same state draw the same ring:
 *
 * - `alert` (red): a re-login is required.
 * - `warn` (amber): the sign-in is ending (or due).
 * - `default` (mint): the default account on its node.
 * - `held` (a grey 1 px ring, the chip at 75 % opacity): quarantined, held
 *   until a new sign-in.
 *
 * A `lib/` helper rather than a `components/ui/` file, which the #3568 catalog
 * guard reserves for catalogued components.
 */

export type AttentionRing = "alert" | "warn" | "default" | "held";

/** The Tailwind classes of one attention ring. */
export function attentionRingClass(ring: AttentionRing): string {
  switch (ring) {
    case "alert":
      return "ring-2 ring-[var(--status-hot)]";
    case "warn":
      return "ring-2 ring-[var(--status-warn)]";
    case "default":
      return "ring-2 ring-[var(--app-accent)]";
    case "held":
      return "ring-1 ring-[var(--status-sev-unknown)] opacity-75";
  }
}
