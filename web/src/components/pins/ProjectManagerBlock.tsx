// SPDX-License-Identifier: AGPL-3.0-only
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, Pin as PinGlyph } from "lucide-react";
import type { ApiClient } from "@/api/client";
import { chipsOverflow } from "@/components/AssistantChat/SessionConfigCluster";
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
 * others recede until hovered. #6539 (Matt's NLOOK2): the gold outline is the
 * block's, so it holds the header AND every lane box (R8-c: an object's outline
 * contains every object that belongs to it). The header row expands in place; Open goes to
 * the PM's session; 📌 opens every lane with open pins and flashes them.
 */

const HEADER_GRID: CSSProperties = {
  gridTemplateColumns: "20px minmax(0,1fr) auto",
  columnGap: "6px",
  padding: "4px 4px 4px 6px",
};

/** The block's outline: solid gold when it manages this session, muted otherwise. */
function blockBorder(managing: boolean): string {
  return `1px solid ${
    managing
      ? "var(--session-rel-spawn)"
      : "color-mix(in srgb, var(--session-rel-spawn-parent) 60%, transparent)"
  }`;
}

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
  // #6574 (R17): the heading's chip row stays one line; its chips compact in a
  // fixed order as the room runs out (`ProjectManagerChips`).
  const { rowRef: chipRowRef, level: chipLevel } = useChipLadder(
    [
      pm.self,
      pm.managing,
      pm.running,
      pm.nodeLabel,
      accountLabel,
      pm.lanesRunning,
      pm.lanesTotal,
      pm.openPinCount,
    ].join("|")
  );
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
      className={`pins-pm overflow-hidden rounded-md ${pm.managing ? "" : "pins-pm-other"}`}
      data-managing={pm.managing || undefined}
      style={{ border: blockBorder(pm.managing) }}
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
          <ProjectManagerChips
            pm={pm}
            accountLabel={accountLabel}
            monogram={monogram}
            onRevealWaiting={revealWaiting}
            level={chipLevel}
            rowRef={chipRowRef}
          />
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
        // #6539 (NLOOK2): the lanes sit inside the block's outline, 4px from it
        // and 4px apart, as a section spaces its items. Measured on a 320px
        // screen, a lane's pin then has 246px for its action row; the fullest
        // row, every label given way, takes 219px.
        <div className="flex flex-col gap-1 p-1">
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

// ── The heading's chip row (#6574, R17) ─────────────────────────────────────

export type ChipLevel = 0 | 1 | 2 | 3 | 4;
const CHIP_MAX_LEVEL: ChipLevel = 4;

/**
 * The Project Manager heading's chip row at a given ladder `level`, layout-free so
 * each level is testable without real layout (jsdom reports zero widths), as the
 * composer's `SessionConfigChips` is. The row is one line that never wraps; every
 * chip is `shrink-0`, so `chipsOverflow` sees the overflow instead of a chip
 * absorbing it. Levels, lowest-value text first, each keeping its tooltip:
 * - 0: everything;
 * - 1: the account chip shows its monogram only;
 * - 2: the lane count reads `2/2` (its tooltip and aria-label keep the sentence);
 * - 3: "Manages this session" reads "Manages" ("This session" stays);
 * - 4: the badge goes: the block's solid gold outline and fill and the emoji's
 *   tooltip still say it (ruling D9, option 1).
 * The status pip, the node badge and the pin count never give way. At level 4 a
 * row that still does not fit clips; it never wraps.
 */
export function ProjectManagerChips(props: {
  pm: ProjectManagerModel;
  accountLabel: ComponentProps<typeof AccountChip>["label"];
  monogram: ComponentProps<typeof AccountChip>["monogram"];
  onRevealWaiting: () => void;
  level: ChipLevel;
  rowRef?: RefObject<HTMLSpanElement | null>;
}) {
  const { pm, level } = props;
  const lanesSentence = `${pm.lanesRunning} of ${pm.lanesTotal} lanes have a session running`;
  const badge =
    level >= 4 ? null : pm.self ? (
      <HoverTooltip content="This Project Manager is the session you are in">
        <span className="shrink-0 uppercase" style={MINE_BADGE}>
          This session
        </span>
      </HoverTooltip>
    ) : pm.managing ? (
      <HoverTooltip content="This Project Manager manages the session you are in">
        <span className="shrink-0 uppercase" style={MINE_BADGE}>
          {level >= 3 ? "Manages" : "Manages this session"}
        </span>
      </HoverTooltip>
    ) : null;
  return (
    <span
      ref={props.rowRef}
      data-chip-level={level}
      className="pins-pm-chips mt-0.5 flex min-w-0 flex-nowrap items-center gap-x-1.5 overflow-hidden whitespace-nowrap text-[length:var(--text-caption)] text-[var(--session-rel-spawn-text)]"
    >
      {badge}
      <span className="shrink-0">
        <StatusPip
          status={pm.running ? "idle" : "stopped"}
          label={pm.running ? "Running" : "Not running"}
        />
      </span>
      {pm.nodeLabel ? (
        <span className="shrink-0">
          <NodeBadge
            nodeId={pm.nodeId ?? undefined}
            nodeLabel={pm.nodeLabel}
            interactive={false}
            resourceHealth={false}
          />
        </span>
      ) : null}
      {pm.accountEmail ? (
        <span className="shrink-0">
          <AccountChip
            email={pm.accountEmail}
            label={props.accountLabel}
            monogram={props.monogram}
            maxChars={18}
            compact={level >= 1}
          />
        </span>
      ) : null}
      <HoverTooltip content={lanesSentence}>
        <span className="shrink-0" aria-label={lanesSentence}>
          {pm.lanesRunning}/{pm.lanesTotal}
          {level >= 2 ? null : " lanes"}
        </span>
      </HoverTooltip>
      {pm.openPinCount > 0 ? (
        <HoverTooltipButton
          type="button"
          content={`${pm.openPinCount} ${pm.openPinCount === 1 ? "pin" : "pins"} from this Project Manager's lanes ${pm.openPinCount === 1 ? "is" : "are"} waiting on you. Click to show them`}
          aria-label={`Show the ${pm.openPinCount} pins waiting on you`}
          onClick={event => {
            event.stopPropagation();
            props.onRevealWaiting();
          }}
          className="inline-flex shrink-0 items-center gap-0.5"
          style={PIN_COUNT}
        >
          <PinGlyph style={PIN_ICON} aria-hidden />
          {pm.openPinCount}
        </HoverTooltipButton>
      ) : null}
    </span>
  );
}

/**
 * The chip row's step-down ladder, the same shape as the composer's
 * `useOverflowLadder` (`SessionConfigCluster.tsx`): step down while the row
 * overflows, and start again from 0 on a width change (rAF-guarded) or a change to
 * what the row shows. A second copy of that shape; extract a shared hook only when
 * a third appears.
 *
 * A width change also bumps `resizes`, because `setLevel(0)` alone does nothing
 * when the level is already 0 (React skips a same-value update), so a row that
 * fit at 0 and then narrowed would keep its full chips and clip them.
 */
export function useChipLadder(measureKey: string): {
  rowRef: RefObject<HTMLSpanElement | null>;
  level: ChipLevel;
} {
  const rowRef = useRef<HTMLSpanElement | null>(null);
  const [level, setLevel] = useState<ChipLevel>(0);
  const [resizes, setResizes] = useState(0);
  const rafRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    setLevel(0);
  }, [measureKey]);

  useLayoutEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    if (chipsOverflow(el)) {
      setLevel(prev =>
        prev < CHIP_MAX_LEVEL ? ((prev + 1) as ChipLevel) : prev
      );
    }
  }, [level, measureKey, resizes]);

  useEffect(() => {
    const el = rowRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width || rafRef.current != null) return;
      width = el.clientWidth;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        setLevel(0);
        setResizes(n => n + 1);
      });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return { rowRef, level };
}
