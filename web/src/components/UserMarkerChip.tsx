// SPDX-License-Identifier: AGPL-3.0-only
import { Badge } from "@/components/ui/badge";
import type { LeadingHtmlCommentMarker } from "@/lib/htmlCommentMarker";

/**
 * The label chip shown in place of a leading machine marker on a user turn (a
 * loop-cron tick, a PM relay, a peer-session report, or any other leading
 * HTML-comment marker). Rendered by BOTH live chat (`UserMessage`) and the
 * transcript reader (`TranscriptReader`) from this one component, so the two
 * views cannot drift (#4150). The friendly `label` shows in place of the
 * stripped marker; the verbatim marker is on hover via `title`.
 *
 * Kept OUTSIDE `components/ui/` so it is not a design-catalog atom
 * (`check-design-catalog-completeness.ts`): it is a composition of `Badge`, not
 * a new primitive.
 */
export function UserMarkerChip({
  marker,
}: {
  marker: LeadingHtmlCommentMarker;
}) {
  return (
    <Badge
      variant="subscription"
      title={marker.raw}
      data-testid="user-marker-chip"
      className="mb-1 px-2 text-[length:var(--text-caption)] font-medium leading-[var(--leading-caption)]"
    >
      {marker.label}
    </Badge>
  );
}
