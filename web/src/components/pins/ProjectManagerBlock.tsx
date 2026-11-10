// SPDX-License-Identifier: AGPL-3.0-only
import {
  memo,
  useCallback,
  useLayoutEffect,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, Pin as PinGlyph } from "lucide-react";
import type { ApiClient } from "@/api/client";
import { ChevronIcon } from "@/components/icons";
import { NodeBadge } from "@/components/NodeBadge";
import { LaneBox, StatusPip } from "@/components/pins/LaneBox";
import { flashRow } from "@/components/pins/pinsShared";
import { AccountChip } from "@/components/session/AccountChip";
import { HoverTooltip, HoverTooltipButton } from "@/components/ui/tooltip";
import {
  useAccountLabel,
  useAccountMonogram,
} from "@/hooks/queries/useAccountLabels";
import type { ProjectManagerModel } from "@/lib/pins/dashboards";

/**
 * #6454: one Project Manager (mockup v6 `pmBlock()` :756-763, CSS :183-205): a
 * gold header (the `--session-rel-spawn` family), then its lanes in boxes. The
 * one managing the open session is outlined and filled and starts expanded; the
 * others recede until hovered. The header row expands in place; Open goes to
 * the PM's session; 📌 opens every lane with open pins and flashes them.
 */

const HEADER_GRID: CSSProperties = {
  gridTemplateColumns: "20px minmax(0,1fr) auto",
  columnGap: "6px",
  padding: "4px 4px 4px 6px",
  borderRadius: "4px",
};

const MINE_BADGE: CSSProperties = {
  fontSize: "9.5px",
  fontWeight: 800,
  letterSpacing: "0.03em",
  padding: "0 5px",
  borderRadius: "4px",
  color: "var(--app-bg)",
  backgroundColor: "var(--session-rel-spawn)",
};

const PIN_COUNT: CSSProperties = {
  height: "18px",
  padding: "0 6px",
  borderRadius: "9px",
  backgroundColor:
    "color-mix(in srgb, var(--view-accent-pins) 22%, transparent)",
  color: "var(--view-accent-pins)",
  fontWeight: 700,
  fontSize: "11px",
};

const PIN_ICON: CSSProperties = { width: "11px", height: "11px" };

const CIRCLE: CSSProperties = {
  width: "22px",
  height: "22px",
  borderRadius: "50%",
  backgroundColor: "var(--app-secondary-bg)",
};

function laneDomId(pm: ProjectManagerModel, letter: string): string {
  return `pm-lane-${pm.key.replace(/[^A-Za-z0-9_-]/g, "_")}-${letter}`;
}

export const ProjectManagerBlock = memo(function ProjectManagerBlock(props: {
  api: ApiClient | null;
  pm: ProjectManagerModel;
  now: number;
  scrollRoot: Element | null;
}) {
  const { api, pm, now } = props;
  const navigate = useNavigate();
  const accountLabel = useAccountLabel(api, pm.accountEmail ?? undefined);
  const monogram = useAccountMonogram(api, pm.accountEmail ?? undefined);
  const [expanded, setExpanded] = useState(pm.managing);
  const [openLanes, setOpenLanes] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [flash, setFlash] = useState<readonly string[] | null>(null);

  const toggleLane = useCallback((letter: string) => {
    setOpenLanes(prev => {
      const next = new Set(prev);
      if (next.has(letter)) next.delete(letter);
      else next.add(letter);
      return next;
    });
  }, []);

  const revealWaiting = () => {
    const waiting = pm.lanes
      .filter(lane => lane.openPinCount > 0)
      .map(lane => lane.letter);
    setExpanded(true);
    setOpenLanes(prev => new Set([...prev, ...waiting]));
    setFlash(waiting);
  };

  // Once the waiting lanes are open, bring the first into view and flash each.
  useLayoutEffect(() => {
    if (!flash) return;
    const boxes = flash
      .map(letter => document.getElementById(laneDomId(pm, letter)))
      .filter((box): box is HTMLElement => box !== null);
    setFlash(null);
    boxes[0]?.scrollIntoView({ block: "center", behavior: "smooth" });
    boxes.forEach(flashRow);
  }, [flash, pm]);

  const onKey = (event: KeyboardEvent) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setExpanded(open => !open);
    }
  };

  return (
    <div
      className={`pins-pm ${pm.managing ? "" : "pins-pm-other"}`}
      data-managing={pm.managing || undefined}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={() => setExpanded(open => !open)}
        onKeyDown={onKey}
        className="grid w-full cursor-pointer items-center text-left"
        style={{
          ...HEADER_GRID,
          backgroundColor: pm.managing
            ? "color-mix(in srgb, var(--session-rel-spawn) 16%, transparent)"
            : "var(--session-rel-spawn-fill)",
          border: `1px solid ${
            pm.managing
              ? "var(--session-rel-spawn)"
              : "color-mix(in srgb, var(--session-rel-spawn-parent) 60%, transparent)"
          }`,
        }}
      >
        <HoverTooltip
          content={
            pm.self
              ? "This session"
              : pm.managing
                ? "Manages this session"
                : "Does not manage this session"
          }
        >
          <span className="text-center" style={{ fontSize: "15px" }}>
            {pm.emoji ?? "🧭"}
          </span>
        </HoverTooltip>
        <span className="min-w-0">
          <HoverTooltip content={pm.name}>
            <span className="block truncate text-[length:var(--text-body)] font-bold">
              {pm.name}
            </span>
          </HoverTooltip>
          <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 whitespace-nowrap text-[length:var(--text-caption)] text-[var(--session-rel-spawn-text)]">
            {pm.self ? (
              <HoverTooltip content="This Project Manager is the session you are in">
                <span className="uppercase" style={MINE_BADGE}>
                  This session
                </span>
              </HoverTooltip>
            ) : pm.managing ? (
              <HoverTooltip content="This Project Manager manages the session you are in">
                <span className="uppercase" style={MINE_BADGE}>
                  Manages this session
                </span>
              </HoverTooltip>
            ) : null}
            <StatusPip
              status={pm.running ? "idle" : "stopped"}
              label={pm.running ? "Running" : "Not running"}
            />
            {pm.nodeLabel ? (
              <NodeBadge
                nodeId={pm.nodeId ?? undefined}
                nodeLabel={pm.nodeLabel}
                interactive={false}
                resourceHealth={false}
              />
            ) : null}
            {pm.accountEmail ? (
              <span className="min-w-0 shrink">
                <AccountChip
                  email={pm.accountEmail}
                  label={accountLabel}
                  monogram={monogram}
                  maxChars={18}
                />
              </span>
            ) : null}
            <HoverTooltip
              content={`${pm.lanesRunning} of ${pm.lanesTotal} lanes have a session running`}
            >
              <span>
                {pm.lanesRunning}/{pm.lanesTotal} lanes
              </span>
            </HoverTooltip>
            {pm.openPinCount > 0 ? (
              <HoverTooltipButton
                type="button"
                content={`${pm.openPinCount} ${pm.openPinCount === 1 ? "pin" : "pins"} from this Project Manager's lanes ${pm.openPinCount === 1 ? "is" : "are"} waiting on you. Click to show them`}
                aria-label={`Show the ${pm.openPinCount} pins waiting on you`}
                onClick={event => {
                  event.stopPropagation();
                  revealWaiting();
                }}
                className="inline-flex items-center gap-0.5"
                style={PIN_COUNT}
              >
                <PinGlyph style={PIN_ICON} aria-hidden />
                {pm.openPinCount}
              </HoverTooltipButton>
            ) : null}
          </span>
        </span>
        <span className="flex items-center gap-1.5">
          <HoverTooltipButton
            type="button"
            content="Go to this Project Manager's session"
            aria-label={`Go to ${pm.name}`}
            onClick={event => {
              event.stopPropagation();
              void navigate({
                to: "/sessions/$sessionId",
                params: { sessionId: pm.sessionId },
              });
            }}
            className="inline-flex h-7 items-center gap-1 rounded-md bg-[var(--app-secondary-bg)] px-2 text-[length:var(--text-caption)] font-semibold text-[var(--app-fg)] hover:opacity-90"
          >
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            <span className="pins-pm-open-label">Open</span>
          </HoverTooltipButton>
          <HoverTooltip content={expanded ? "Collapse" : "Expand"}>
            <span className="grid place-items-center" style={CIRCLE}>
              <ChevronIcon className="h-3.5 w-3.5" collapsed={!expanded} />
            </span>
          </HoverTooltip>
        </span>
      </div>
      {expanded ? (
        <div className="pb-1 pl-2">
          {pm.degraded ? (
            <div className="py-1 text-[length:var(--text-caption)] text-[var(--app-hint)]">
              A lane on this dashboard could not be read, so it is not shown
            </div>
          ) : null}
          {pm.lanes.length === 0 ? (
            <div className="py-1 text-[length:var(--text-caption)] text-[var(--app-hint)]">
              No lanes published yet
            </div>
          ) : (
            pm.lanes.map(lane => (
              <LaneBox
                key={lane.letter}
                api={api}
                lane={lane}
                open={openLanes.has(lane.letter)}
                onToggle={toggleLane}
                domId={laneDomId(pm, lane.letter)}
                now={now}
                scrollRoot={props.scrollRoot}
              />
            ))
          )}
        </div>
      ) : null}
    </div>
  );
});
