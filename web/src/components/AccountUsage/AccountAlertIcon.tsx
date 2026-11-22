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
 *
 * Issue #6161 (R13): the icon also lists the nodes whose sign-in is ENDING
 * ("Sign-in on <node> ends in N days"), from the card's node items. It reads the
 * minute clock itself, so it never lags the token, and it is amber when every
 * line is an ending line, red when any node needs a re-login. Its accessible
 * name uses the ending wording for ending nodes, never "Re-login required".
 *
 * Issue #6161 NP-1 (extension 3): an account can be on 25 nodes, so the tooltip
 * is bounded too: at most {@link ALERT_TOOLTIP_MAX_LINES} lines, worst first
 * (re-login, then due, then the fewest days left), then "and N more". The
 * accessible name still names every node.
 */
import { CircleAlert } from "lucide-react";
import {
  computeSignInEnding,
  type AccountHealthSinceSource,
  type SignInAgeInput,
} from "@hapi/protocol";
import { HoverTooltipButton } from "@/components/ui/tooltip";
import { daysLeftPhrase } from "@/lib/signInAge";
import { useMinuteNow } from "@/lib/pins/useMinuteNow";
import { formatSince } from "./addModalDone";

export type AlertNodeEntry = {
  /** The node's label; absent when the surface has no node in scope. */
  nodeLabel?: string;
  /** Epoch ms of the last refresh (or of the capture), from #4461's read. */
  since?: number;
  sinceSource?: AccountHealthSinceSource;
  /** Issue #6161: `ending` for a sign-in inside its warning window. */
  kind?: "relogin" | "ending";
  /** Issue #6161: whole days left (`kind: "ending"`). */
  daysLeft?: number;
  /** Issue #6161: the deadline has passed (`kind: "ending"`). */
  due?: boolean;
  /** Issue #6161: the deadline is an estimate ("about"). */
  estimated?: boolean;
};

/** Issue #6161 (R13): a card node the icon may list as ending. */
export type EndingCandidate = {
  nodeLabel: string;
  needsRelogin: boolean;
  signIn?: SignInAgeInput;
};

/** "Sign-in on <node> ends in N days" / "… reached its end date". */
function endingLine(entry: AlertNodeEntry): string {
  const where = `Sign-in on ${entry.nodeLabel ?? "this node"}`;
  if (entry.due) return `${where} reached its end date`;
  return `${where} ends in ${daysLeftPhrase(entry.daysLeft ?? 0, entry.estimated === true)}`;
}

/** One tooltip line per node: "Re-login required on <node> (since …)". */
export function alertLine(entry: AlertNodeEntry): string {
  if (entry.kind === "ending") return endingLine(entry);
  const where = entry.nodeLabel
    ? `Re-login required on ${entry.nodeLabel}`
    : "Re-login required";
  const since = formatSince(entry);
  return since ? `${where} (${since})` : where;
}

/** The accessible name: every node in one sentence. */
export function alertLabel(entries: AlertNodeEntry[]): string {
  const relogin = entries.filter(e => e.kind !== "ending");
  const ending = entries.filter(e => e.kind === "ending");
  const parts: string[] = [];
  if (relogin.length > 0) {
    const labels = relogin
      .map(e => e.nodeLabel)
      .filter((l): l is string => Boolean(l));
    parts.push(
      labels.length > 0
        ? `Re-login required on ${labels.join(", ")}`
        : "Re-login required"
    );
  }
  parts.push(...ending.map(endingLine));
  return parts.join("; ");
}

/**
 * Issue #6161 (R13): the ending entries among a card's node items at `now` — a
 * node that needs a re-login is the red line's, never an ending one.
 */
export function endingAlertEntries(
  candidates: EndingCandidate[],
  now: number
): AlertNodeEntry[] {
  const out: AlertNodeEntry[] = [];
  for (const c of candidates) {
    if (c.needsRelogin || !c.signIn) continue;
    const ending = computeSignInEnding(c.signIn, now);
    if (!ending) continue;
    out.push({
      nodeLabel: c.nodeLabel,
      kind: "ending",
      daysLeft: ending.daysLeft,
      due: ending.state === "due",
      estimated: ending.estimated,
    });
  }
  return out;
}

/** Issue #6161 NP-1 (extension 3): the tooltip's line cap. */
export const ALERT_TOOLTIP_MAX_LINES = 5;

/**
 * The tooltip's lines: worst first (re-login, then due, then the fewest days
 * left), at most {@link ALERT_TOOLTIP_MAX_LINES}, then "and N more".
 */
export function alertTooltipLines(entries: AlertNodeEntry[]): {
  lines: string[];
  more: number;
} {
  const rank = (e: AlertNodeEntry) => (e.kind !== "ending" ? 0 : e.due ? 1 : 2);
  const sorted = entries
    .map((e, i) => ({ e, i }))
    .sort(
      (a, b) =>
        rank(a.e) - rank(b.e) ||
        (rank(a.e) === 2 ? (a.e.daysLeft ?? 0) - (b.e.daysLeft ?? 0) : 0) ||
        a.i - b.i
    )
    .map(x => x.e);
  const shown = sorted.slice(0, ALERT_TOOLTIP_MAX_LINES);
  return {
    lines: shown.map(alertLine),
    more: sorted.length - shown.length,
  };
}

export function AccountAlertIcon(props: {
  nodes: AlertNodeEntry[];
  /** Issue #6161: the card's node items, checked for an ending sign-in. */
  endingCandidates?: EndingCandidate[];
}) {
  const now = useMinuteNow();
  const nodes = [
    ...props.nodes,
    ...endingAlertEntries(props.endingCandidates ?? [], now),
  ];
  if (nodes.length === 0) return null;
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const anyRelogin = nodes.some(n => n.kind !== "ending");
  const tip = alertTooltipLines(nodes);
  return (
    <HoverTooltipButton
      type="button"
      data-testid="account-alert-icon"
      data-tone={anyRelogin ? "hot" : "warn"}
      aria-label={alertLabel(nodes)}
      content={
        <div className="flex flex-col gap-0.5">
          {tip.lines.map((line, i) => (
            <span key={`${i}:${line}`}>{line}</span>
          ))}
          {tip.more > 0 ? (
            <span
              data-testid="account-alert-more"
              className="text-[var(--app-hint)]"
            >
              and {tip.more} more
            </span>
          ) : null}
        </div>
      }
      // Never toggles or selects the card it sits on.
      onClick={stop}
      onPointerDown={stop}
      className={`inline-flex shrink-0 items-center justify-center rounded-full hover:opacity-80 ${anyRelogin ? "text-[var(--status-hot)]" : "text-[var(--status-warn)]"}`}
    >
      <CircleAlert className="h-4 w-4" aria-hidden="true" />
    </HoverTooltipButton>
  );
}
