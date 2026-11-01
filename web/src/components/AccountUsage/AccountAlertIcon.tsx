// SPDX-License-Identifier: AGPL-3.0-only
/**
 * AccountAlertIcon — the row-1 re-login alert of an account card (issue #4466,
 * R4). A red circled "!" shown while any node holds an unrefreshable record for
 * the account; hover (desktop) or tap (touch) reveals one line per node. It is
 * the only re-login signal a collapsed card carries, and on touch it is where
 * the node names live (the red-ringed node pill's text rides `title`, which a
 * touch screen never shows).
 *
 * The since-time comes from `formatSince` (`addModalDone.ts`, the "+ Add"
 * modal's own wording), so the card and the modal describe a stale record the
 * same way. A picker entry carries no `since` and renders no timestamp.
 */
import { CircleAlert } from "lucide-react";
import type { AccountHealthSinceSource } from "@hapi/protocol";
import { HoverTooltipButton } from "@/components/ui/tooltip";
import { formatSince } from "./addModalDone";

export type AlertNodeEntry = {
  /** The node's label; absent when the surface has no node in scope. */
  nodeLabel?: string;
  /** Epoch ms of the last refresh (or of the capture), from #4461's read. */
  since?: number;
  sinceSource?: AccountHealthSinceSource;
};

/** One tooltip line per node: "Re-login required on <node> (since …)". */
export function alertLine(entry: AlertNodeEntry): string {
  const where = entry.nodeLabel
    ? `Re-login required on ${entry.nodeLabel}`
    : "Re-login required";
  const since = formatSince(entry);
  return since ? `${where} (${since})` : where;
}

/** The accessible name: every node in one sentence. */
export function alertLabel(entries: AlertNodeEntry[]): string {
  const labels = entries
    .map(e => e.nodeLabel)
    .filter((l): l is string => Boolean(l));
  return labels.length > 0
    ? `Re-login required on ${labels.join(", ")}`
    : "Re-login required";
}

export function AccountAlertIcon(props: { nodes: AlertNodeEntry[] }) {
  const { nodes } = props;
  if (nodes.length === 0) return null;
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <HoverTooltipButton
      type="button"
      data-testid="account-alert-icon"
      aria-label={alertLabel(nodes)}
      content={
        <div className="flex flex-col gap-0.5">
          {nodes.map((n, i) => (
            <span key={`${n.nodeLabel ?? ""}:${i}`}>{alertLine(n)}</span>
          ))}
        </div>
      }
      // Never toggles or selects the card it sits on.
      onClick={stop}
      onPointerDown={stop}
      className="inline-flex shrink-0 items-center justify-center rounded-full text-[var(--status-hot)] hover:opacity-80"
    >
      <CircleAlert className="h-4 w-4" aria-hidden="true" />
    </HoverTooltipButton>
  );
}
