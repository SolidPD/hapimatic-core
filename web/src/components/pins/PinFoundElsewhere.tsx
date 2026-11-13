// SPDX-License-Identifier: AGPL-3.0-only
import type { CSSProperties, ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { PIN_LIST_MAX_LIMIT } from "@hapi/protocol";
import { PinActionButton } from "@/components/pins/PinAnswerControls";
import { PinKindBadge } from "@/components/pins/pinsShared";
import { HoverTooltip } from "@/components/ui/tooltip";
import type { PinByIdLookup } from "@/hooks/queries/usePins";
import { ACTION_COLLAPSE_RANK } from "@/lib/pins/actionRowFit";

// Fixed pixel values sit in inline style, as the other Pins components do,
// because a new file starts at a design-token baseline of 0.
const BOX: CSSProperties = { padding: "5px 8px", minHeight: "30px" };
const CHIP: CSSProperties = {
  height: "18px",
  padding: "0 6px",
  borderRadius: "9px",
  maxWidth: "45%",
};
const GOLD_CHIP: CSSProperties = {
  ...CHIP,
  color: "var(--session-rel-spawn-text)",
  backgroundColor: "var(--session-rel-spawn-fill)",
  border: "1px solid var(--session-rel-spawn)",
};
const NEUTRAL_CHIP: CSSProperties = {
  ...CHIP,
  color: "var(--app-fg)",
  backgroundColor: "var(--app-secondary-bg)",
  border: "1px solid var(--app-border)",
};
const GO_ICON: CSSProperties = { width: "12px", height: "12px" };

/**
 * #6574 (Matt's FIND1): a pin ID pasted into the Pins search that is not in this
 * tab is looked up by ID and shown as one line, its own rounded object in the
 * results (R10-a, R18): the kind, the title, a chip naming the owning session and
 * its node (gold for a Project Manager lane, neutral otherwise), and Open, which
 * goes to that session's Pins tab and reveals the pin (`?pin=<key>`). A dashboard
 * opens the tab without revealing, and a pin of this session past the list's cap
 * says so. Every other outcome is one sentence in the same box.
 */
export function PinFoundElsewhere(props: {
  pinId: string;
  lookup: PinByIdLookup | undefined;
  loading: boolean;
  failed: boolean;
  currentSessionId: string;
  laneSessionIds: ReadonlySet<string>;
}) {
  const navigate = useNavigate();
  const { lookup } = props;
  if (props.loading) return <Line>Looking up the pin {props.pinId}…</Line>;
  if (props.failed || !lookup) {
    return <Line>The pin {props.pinId} could not be looked up; try again</Line>;
  }
  switch (lookup.kind) {
    case "unavailable":
      // A plain 404: Pins is off here, or the server predates the by-ID route. No
      // lookup ran, so it must not read as a miss.
      return (
        <Line>
          This server cannot look up pins by ID, so {props.pinId} was not
          searched.
        </Line>
      );
    case "not_found": {
      const offline = lookup.notAsked.map(node => node.nodeLabel);
      return (
        <Line>
          No pin has the ID {props.pinId} in your sessions.
          {offline.length > 0
            ? ` ${offline.join(", ")} ${offline.length === 1 ? "is" : "are"} offline, so ${offline.length === 1 ? "it was" : "they were"} not searched.`
            : null}
        </Line>
      );
    }
    case "incomplete":
      return <Line>Some nodes could not be asked; try again</Line>;
    case "rate_limited":
      return <Line>Too many lookups; try again in a minute</Line>;
    case "ambiguous":
      return (
        <Line>
          Two pins answer to {props.pinId}:{" "}
          {lookup.matches
            .map(match => `${match.key} on ${match.nodeLabel}`)
            .join(", ")}
        </Line>
      );
    case "found":
      break;
  }

  const { pin, session } = lookup;
  const here = session.id === props.currentSessionId;
  const dashboard = pin.kind === "dashboard";
  const lane = props.laneSessionIds.has(session.id);
  const who = session.name ?? session.id;
  const node = session.nodeLabel;
  const note = dashboard
    ? "A Project Manager dashboard"
    : here
      ? `In this session, past the list's ${PIN_LIST_MAX_LIMIT} pins`
      : null;

  return (
    <div
      className="pins-found-elsewhere mx-1 mt-1 flex min-w-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-[var(--app-border)] text-[length:var(--text-body-dense)]"
      style={BOX}
    >
      <PinKindBadge kind={pin.kind} armed />
      <HoverTooltip content={pin.title}>
        <span className="min-w-0 flex-1 truncate font-semibold text-[var(--app-fg)]">
          {pin.title}
        </span>
      </HoverTooltip>
      {note ? (
        <span className="shrink truncate text-[length:var(--text-caption)] text-[var(--app-hint)]">
          {note}
        </span>
      ) : null}
      <HoverTooltip
        content={
          lane
            ? `A Project Manager lane: ${who}${node ? ` on ${node}` : ""}`
            : `The session that owns this pin: ${who}${node ? ` on ${node}` : ""}`
        }
      >
        <span
          className="inline-flex min-w-0 shrink items-center truncate text-[length:var(--text-caption)]"
          style={lane ? GOLD_CHIP : NEUTRAL_CHIP}
        >
          <span className="truncate">
            {who}
            {node ? ` · ${node}` : ""}
          </span>
        </span>
      </HoverTooltip>
      {here && !dashboard ? null : (
        <PinActionButton
          rank={ACTION_COLLAPSE_RANK.inChat}
          content={
            dashboard
              ? "Open that session's Pins tab"
              : "Open the pin in its session's Pins tab"
          }
          label="Open"
          icon={<ArrowRight style={GO_ICON} aria-hidden />}
          iconAfter
          onClick={() => {
            void navigate({
              to: "/sessions/$sessionId/pins",
              params: { sessionId: session.id },
              search: { pin: dashboard ? undefined : pin.key },
            });
          }}
        />
      )}
    </div>
  );
}

function Line(props: { children: ReactNode }) {
  return (
    <div
      className="pins-found-elsewhere mx-1 mt-1 truncate rounded-md border border-[var(--app-border)] text-[length:var(--text-body-dense)] text-[var(--app-hint)]"
      style={BOX}
    >
      {props.children}
    </div>
  );
}
