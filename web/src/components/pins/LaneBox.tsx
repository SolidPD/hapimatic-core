// SPDX-License-Identifier: AGPL-3.0-only
import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, Pin as PinGlyph, Timer } from "lucide-react";
import {
  isReservedPinKey,
  PIN_LANE_STAGE_EMOJI,
  type PinLaneStage,
} from "@hapi/protocol";
import type { ApiClient } from "@/api/client";
import { PinsSubmitStrip } from "@/components/AssistantChat/PinsSubmitStrip";
import { ChevronIcon } from "@/components/icons";
import { IssueInfoModal } from "@/components/IssueInfoModal";
import { NodeBadge } from "@/components/NodeBadge";
import { LaneStageTrack } from "@/components/pins/LaneStageTrack";
import { PinRow } from "@/components/pins/PinRow";
import {
  flashRow,
  PinsContext,
  stopRowToggle,
  type PinsContextValue,
} from "@/components/pins/pinsShared";
import { useArmedRows } from "@/components/pins/useArmedRows";
import { AccountChip } from "@/components/session/AccountChip";
import { HoverTooltip, HoverTooltipButton } from "@/components/ui/tooltip";
import {
  useAccountLabel,
  useAccountMonogram,
} from "@/hooks/queries/useAccountLabels";
import { useMarkPinSeen, usePins, useStarPin } from "@/hooks/queries/usePins";
import {
  formatCost,
  formatRuntime,
  modelLabel,
  queueCell,
  stageTrack,
  type DashboardIssue,
  type LaneModel,
  type LaneSessionModel,
} from "@/lib/pins/dashboards";
import {
  formatPinAge,
  formatPinTime,
  PIN_SORTS,
  toPinViewModel,
} from "@/lib/pins/ledger";
import { resolvePinZone } from "@/lib/pins/zoneTime";
import { formatRelativeTimeCompact } from "@/lib/sessionHelpers";

/**
 * #6454: one lane of a Project Manager, in its own box (B3, mockup v6
 * `.box-b3 .lanebox` :402) outlined in the lane's color. The row is the L5
 * grid (`.pins-lane-row`, index.css): letter, name with its issue and status,
 * the stage track, the queued "+N" (always present, so the row never shifts),
 * Open, and the chevron box, which only expands. Expanded: each lane session
 * with its chips and task (or the pin it waits on), that session's open pins as
 * ordinary rows answered for THAT session, its Submit, and the lane's queue.
 */

export type LaneDotStatus = "waiting" | "working" | "idle" | "stopped";

const DOT: Record<LaneDotStatus, { color: string; label: string }> = {
  waiting: { color: "var(--status-cat-attention)", label: "Waiting on you" },
  working: { color: "var(--status-cat-working)", label: "Working" },
  idle: { color: "var(--status-cat-active)", label: "Running, idle" },
  stopped: { color: "var(--status-cat-inactive)", label: "Not running" },
};

const DOT_STYLE: CSSProperties = {
  width: "6px",
  height: "6px",
  borderRadius: "50%",
  flex: "none",
};

/** A status dot with its tooltip; working pulses. */
export function StatusPip(props: { status: LaneDotStatus; label?: string }) {
  const { color, label } = DOT[props.status];
  const text = props.label ?? label;
  return (
    <HoverTooltip content={text}>
      <span
        role="img"
        aria-label={text}
        className={props.status === "working" ? "animate-pulse" : undefined}
        style={{ ...DOT_STYLE, backgroundColor: color }}
      />
    </HoverTooltip>
  );
}

function laneDot(lane: LaneModel): LaneDotStatus {
  if (lane.status === "waiting") return "waiting";
  if (lane.status === "working") return "working";
  return lane.notRunning ? "stopped" : "idle";
}

function sessionDot(session: LaneSessionModel): LaneDotStatus {
  if ((session.openPinCount ?? 0) > 0) return "waiting";
  if (!session.running) return "stopped";
  return session.thinking ? "working" : "idle";
}

const LETTER_STYLE: CSSProperties = {
  width: "18px",
  height: "18px",
  borderRadius: "5px",
  display: "grid",
  placeItems: "center",
  fontSize: "10.5px",
  fontWeight: 800,
  color: "var(--app-bg)",
};

const QUEUE_STYLE: CSSProperties = {
  justifySelf: "end",
  minWidth: "26px",
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
};

const CHEVRON_STYLE: CSSProperties = { width: "26px", height: "28px" };

/** `#N`, opening the issue viewer; never toggles the row it sits in. */
function IssueLink(props: {
  issue: DashboardIssue;
  onOpen: (issue: DashboardIssue) => void;
}) {
  const { issue } = props;
  return (
    <HoverTooltipButton
      type="button"
      content={`${issue.repo}#${issue.number}${issue.title ? `: ${issue.title}` : ""}`}
      onClick={event => {
        event.stopPropagation();
        props.onOpen(issue);
      }}
      className="shrink-0 border-b border-dotted border-[var(--app-link)] text-[length:var(--text-caption)] font-semibold text-[var(--app-link)] hover:border-solid"
    >
      #{issue.number}
    </HoverTooltipButton>
  );
}

/** One lane session's open pins, answered for that session (ruling D1). */
function LaneSessionPins(props: {
  api: ApiClient | null;
  session: LaneSessionModel & { id: string };
  enabled: boolean;
  now: number;
  scrollRoot: Element | null;
  reveal: string | null;
  onRevealed: () => void;
}) {
  const { api, session, now } = props;
  const query = usePins(api, session.id, props.enabled);
  const starPin = useStarPin(api, session.id);
  const markSeen = useMarkPinSeen(api, session.id);
  const { armed, observe } = useArmedRows(props.scrollRoot);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const pins = query.data?.kind === "ready" ? query.data.pins : null;
  // #6452: times in the lane session's own zone, as its Pins tab shows them.
  const listZone =
    query.data?.kind === "ready" ? (query.data.timeZone ?? null) : null;
  const zone = useMemo(() => resolvePinZone(listZone), [listZone]);
  const models = useMemo(
    () =>
      (pins ?? [])
        .filter(pin => pin.status === "open" && !isReservedPinKey(pin.key))
        .sort((a, b) => PIN_SORTS.priority(a, b))
        .map(toPinViewModel),
    [pins]
  );
  const context = useMemo<PinsContextValue>(
    () => ({
      api,
      sessionId: session.id,
      sessionActive: session.running,
      markSeen,
      via: "pins",
      timeZone: zone,
    }),
    [api, session.id, session.running, markSeen, zone]
  );
  const toggle = useCallback((key: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const rowId = useCallback(
    (key: string) => `pin-row-${session.id}-${key}`,
    [session.id]
  );

  // The waiting chip: open that pin, then bring it into view and flash it.
  const { reveal, onRevealed } = props;
  useLayoutEffect(() => {
    if (!reveal) return;
    if (!expanded.has(reveal)) {
      setExpanded(prev => new Set(prev).add(reveal));
      return;
    }
    const row = document.getElementById(rowId(reveal));
    if (!row) return;
    onRevealed();
    row.scrollIntoView({ block: "center", behavior: "smooth" });
    flashRow(row);
  }, [reveal, expanded, rowId, onRevealed, models]);

  if (models.length === 0) return null;
  return (
    <PinsContext.Provider value={context}>
      <div className="border-b border-[var(--app-divider)]">
        {models.map(model => (
          <PinRow
            key={model.pin.key}
            rowId={rowId(model.pin.key)}
            model={model}
            expanded={expanded.has(model.pin.key)}
            ageLabel={formatPinAge(model.pin.createdAt, now)}
            ageTooltip={`Raised ${formatPinTime(model.pin.createdAt, zone)}`}
            armed={armed.has(model.pin.key)}
            onToggle={toggle}
            onStar={starPin}
            observe={observe}
          />
        ))}
      </div>
    </PinsContext.Provider>
  );
}

/** A lane session: name and chips on the left, its task (or wait) on the right. */
function LaneSession(props: {
  api: ApiClient | null;
  session: LaneSessionModel;
  now: number;
  scrollRoot: Element | null;
  laneOpen: boolean;
}) {
  const { api, session, now } = props;
  const navigate = useNavigate();
  const accountLabel = useAccountLabel(api, session.accountEmail ?? undefined);
  const monogram = useAccountMonogram(api, session.accountEmail ?? undefined);
  const [reveal, setReveal] = useState<string | null>(null);
  const clearReveal = useCallback(() => setReveal(null), []);
  const query = usePins(
    api,
    session.id ?? "",
    props.laneOpen && session.id !== null
  );
  const firstWaiting = useMemo(() => {
    const pins = query.data?.kind === "ready" ? query.data.pins : [];
    return (
      pins
        .filter(pin => pin.status === "open" && !isReservedPinKey(pin.key))
        .sort((a, b) => PIN_SORTS.priority(a, b))[0] ?? null
    );
  }, [query.data]);
  const waiting = (session.openPinCount ?? 0) > 0;
  const runtime = session.running
    ? formatRuntime(session.createdAt, now)
    : null;
  const model = modelLabel(session.model);
  const cost = formatCost(session.cost);
  const last =
    session.activeAt !== null
      ? formatRelativeTimeCompact(session.activeAt, now)
      : null;
  const pct =
    session.progress && session.progress.total > 0
      ? Math.round((session.progress.done / session.progress.total) * 100)
      : null;

  return (
    <>
      <div className="pins-lane-session border-b border-[var(--app-divider)] px-0.5 py-1 text-[length:var(--text-caption)]">
        <span className="pins-ls-name flex min-w-0 items-center gap-1.5 text-[length:var(--text-body-dense)] font-semibold">
          <StatusPip status={sessionDot(session)} />
          <HoverTooltip content={session.name}>
            <span className="truncate">
              {session.emoji ? `${session.emoji} ` : ""}
              {session.name}
            </span>
          </HoverTooltip>
          {session.id ? (
            <HoverTooltipButton
              type="button"
              content="Go to this session"
              aria-label={`Go to ${session.name}`}
              onClick={() =>
                void navigate({
                  to: "/sessions/$sessionId",
                  params: { sessionId: session.id as string },
                })
              }
              className="ml-auto grid shrink-0 place-items-center rounded-md bg-[var(--app-secondary-bg)] text-[var(--app-hint)] hover:text-[var(--app-fg)]"
              style={{ width: "24px", height: "22px" }}
            >
              <ArrowRight className="h-3 w-3" aria-hidden />
            </HoverTooltipButton>
          ) : null}
        </span>
        <span className="pins-ls-task flex min-w-0 flex-col gap-0.5">
          {waiting ? (
            <HoverTooltipButton
              type="button"
              content="Paused until you answer its pin. Click to go to the pin"
              disabled={!firstWaiting}
              onClick={() => firstWaiting && setReveal(firstWaiting.key)}
              className="inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-left font-semibold text-[var(--status-cat-attention)]"
              style={{
                borderColor:
                  "color-mix(in srgb, var(--status-cat-attention) 50%, transparent)",
                backgroundColor:
                  "color-mix(in srgb, var(--status-cat-attention) 12%, transparent)",
              }}
            >
              <PinGlyph className="h-3 w-3 shrink-0" aria-hidden />
              <span className="line-clamp-2">
                {firstWaiting?.title ??
                  `${session.openPinCount} ${session.openPinCount === 1 ? "pin waits" : "pins wait"} on you`}
              </span>
            </HoverTooltipButton>
          ) : (
            <>
              {session.task ? (
                <HoverTooltip content={session.task}>
                  <span className="truncate text-[var(--app-fg)]">
                    {session.task}
                  </span>
                </HoverTooltip>
              ) : (
                <span className="text-[var(--app-hint)]">No task named</span>
              )}
              {session.progress && pct !== null ? (
                <HoverTooltip
                  content={`${session.progress.done} of ${session.progress.total} (${pct}%)`}
                >
                  <span className="flex items-center gap-1.5">
                    <span
                      className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--app-subtle-bg)]"
                      role="progressbar"
                      aria-valuenow={session.progress.done}
                      aria-valuemax={session.progress.total}
                    >
                      <span
                        className="block h-full bg-[var(--status-cat-working)]"
                        style={{ width: `${pct}%` }}
                      />
                    </span>
                    <span className="tabular-nums text-[var(--app-hint)]">
                      {session.progress.done}/{session.progress.total}
                    </span>
                  </span>
                </HoverTooltip>
              ) : null}
            </>
          )}
        </span>
        <span className="pins-ls-chips flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[var(--app-hint)]">
          {session.nodeLabel ? (
            <NodeBadge
              nodeId={session.nodeId ?? undefined}
              nodeLabel={session.nodeLabel}
              interactive={false}
              resourceHealth={false}
            />
          ) : null}
          {session.accountEmail ? (
            <AccountChip
              email={session.accountEmail}
              label={accountLabel}
              monogram={monogram}
              maxChars={16}
            />
          ) : null}
          {model ? (
            <HoverTooltip content={`Model: ${model}`}>
              <span>{model}</span>
            </HoverTooltip>
          ) : null}
          {runtime ? (
            <HoverTooltip content="Time this session has been running">
              <span className="inline-flex items-center gap-0.5">
                <Timer className="h-3 w-3" aria-hidden />
                {runtime}
              </span>
            </HoverTooltip>
          ) : null}
          {cost ? (
            <HoverTooltip
              content={
                session.tokens !== null
                  ? `Cost so far (${session.tokens.toLocaleString()} tokens)`
                  : "Cost so far"
              }
            >
              <span>{cost}</span>
            </HoverTooltip>
          ) : null}
          {last ? (
            <HoverTooltip content="Last activity">
              <span>{last}</span>
            </HoverTooltip>
          ) : null}
        </span>
      </div>
      {session.id !== null ? (
        <>
          <LaneSessionPins
            api={api}
            session={{ ...session, id: session.id }}
            enabled={props.laneOpen}
            now={now}
            scrollRoot={props.scrollRoot}
            reveal={reveal}
            onRevealed={clearReveal}
          />
          <PinsSubmitStrip
            api={api}
            session={{
              id: session.id,
              active: session.running,
              name: session.name,
            }}
            forName={session.name}
          />
        </>
      ) : null}
    </>
  );
}

export const LaneBox = memo(function LaneBox(props: {
  api: ApiClient | null;
  lane: LaneModel;
  open: boolean;
  onToggle: (letter: string) => void;
  /** The box's element id, for the 📌 reveal. */
  domId: string;
  now: number;
  scrollRoot: Element | null;
}) {
  const { api, lane, open, now } = props;
  const navigate = useNavigate();
  const [issueOpen, setIssueOpen] = useState<DashboardIssue | null>(null);
  // Keyed on the reached stages' contents: the array is new on every rebuild.
  const reachedKey = lane.reached?.join(",") ?? null;
  const cells = useMemo(
    () =>
      stageTrack(
        lane.stage,
        lane.activeStage,
        lane.status === "waiting",
        reachedKey === null
          ? null
          : (reachedKey.split(",").filter(Boolean) as PinLaneStage[])
      ),
    [lane.stage, lane.activeStage, lane.status, reachedKey]
  );
  const first = lane.sessions.find(session => session.id !== null);
  const toggle = () => props.onToggle(lane.letter);
  const onKey = (event: KeyboardEvent) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle();
    }
  };
  const queued = lane.queue.length;
  const queueText = queueCell(queued);

  return (
    <div
      id={props.domId}
      className="mt-1 overflow-hidden rounded-md"
      style={{
        border: `1px solid color-mix(in srgb, ${lane.color} 55%, transparent)`,
      }}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={onKey}
        className={`pins-lane-row cursor-pointer ${open ? "border-b border-[var(--app-divider)]" : ""}`}
      >
        <HoverTooltip content={`Lane ${lane.letter}`}>
          <span style={{ ...LETTER_STYLE, backgroundColor: lane.color }}>
            {lane.letter}
          </span>
        </HoverTooltip>
        <span className="flex min-w-0 items-center gap-1.5 text-[length:var(--text-body-dense)] font-semibold">
          <HoverTooltip content={lane.name}>
            <span className="truncate">{lane.name}</span>
          </HoverTooltip>
          {lane.issue ? (
            <IssueLink issue={lane.issue} onOpen={setIssueOpen} />
          ) : null}
          <StatusPip status={laneDot(lane)} />
        </span>
        <span onClick={stopRowToggle} className="flex">
          <LaneStageTrack cells={cells} />
        </span>
        {queued > 0 ? (
          <HoverTooltip
            content={`${queued} more ${queued === 1 ? "issue is" : "issues are"} queued for this lane${lane.issue ? ` after #${lane.issue.number}` : ""}`}
          >
            <span
              className="text-[length:var(--text-caption)] font-bold text-[var(--app-hint)]"
              style={QUEUE_STYLE}
            >
              {queueText}
            </span>
          </HoverTooltip>
        ) : (
          <span style={QUEUE_STYLE} aria-hidden />
        )}
        {first?.id ? (
          <HoverTooltipButton
            type="button"
            content="Go to this lane's session"
            aria-label={`Go to lane ${lane.letter}'s session`}
            onClick={event => {
              event.stopPropagation();
              void navigate({
                to: "/sessions/$sessionId",
                params: { sessionId: first.id as string },
              });
            }}
            className="grid place-items-center rounded-md bg-[var(--app-secondary-bg)] text-[var(--app-hint)] hover:text-[var(--app-fg)]"
            style={CHEVRON_STYLE}
          >
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </HoverTooltipButton>
        ) : (
          <span aria-hidden />
        )}
        <HoverTooltipButton
          type="button"
          content={open ? "Hide lane details" : "Show lane details"}
          aria-label={open ? "Hide lane details" : "Show lane details"}
          aria-expanded={open}
          onClick={event => {
            event.stopPropagation();
            toggle();
          }}
          className="grid place-items-center rounded-md bg-[var(--app-secondary-bg)] text-[var(--app-hint)] hover:text-[var(--app-fg)]"
          style={CHEVRON_STYLE}
        >
          <ChevronIcon className="h-3.5 w-3.5" collapsed={!open} />
        </HoverTooltipButton>
      </div>
      {open ? (
        <div className="pb-1 pl-2 pr-1">
          {lane.sessions.length === 0 ? (
            <div className="border-b border-[var(--app-divider)] px-0.5 py-1.5 text-[length:var(--text-caption)] text-[var(--app-hint)]">
              No session running
            </div>
          ) : (
            lane.sessions.map((session, index) => (
              <LaneSession
                key={`${session.ref}:${index}`}
                api={api}
                session={session}
                now={now}
                scrollRoot={props.scrollRoot}
                laneOpen={open}
              />
            ))
          )}
          {queued > 0 ? (
            <>
              <div className="pt-1.5 text-[length:var(--text-caption-xs)] font-bold uppercase tracking-wide text-[var(--app-hint)]">
                Up next for lane {lane.letter}
              </div>
              {lane.queue.map((issue, index) => (
                <div
                  key={`${issue.repo}#${issue.number}:${index}`}
                  className="flex min-h-6 items-center gap-1.5 border-b border-[var(--app-divider)] text-[length:var(--text-caption)]"
                >
                  <span className="w-4 shrink-0 text-right tabular-nums text-[var(--app-hint)]">
                    {index + 1}
                  </span>
                  <IssueLink issue={issue} onOpen={setIssueOpen} />
                  <span className="min-w-0 flex-1 truncate">
                    {issue.title ?? ""}
                  </span>
                  {issue.stage ? (
                    <HoverTooltip content={`Last finished: ${issue.stage}`}>
                      <span>{PIN_LANE_STAGE_EMOJI[issue.stage]}</span>
                    </HoverTooltip>
                  ) : null}
                </div>
              ))}
            </>
          ) : null}
        </div>
      ) : null}
      {issueOpen ? (
        <IssueInfoModal
          issue={{ repo: issueOpen.repo, number: issueOpen.number }}
          open
          onOpenChange={next => {
            if (!next) setIssueOpen(null);
          }}
          api={api}
        />
      ) : null}
    </div>
  );
});
