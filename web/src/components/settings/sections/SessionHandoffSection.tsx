// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import type { WatermarkState } from "@hapi/protocol";
import type { SessionSummary } from "@/types/api";
import { useAppContext } from "@/lib/app-context";
import { useSessions } from "@/hooks/queries/useSessions";
import { getModelLabel, getSessionTitle } from "@/lib/sessionHelpers";
import { useWatermarkAdmin } from "@/hooks/useWatermarkAdmin";
import type { UseCompactAtPreference } from "@/hooks/useCompactAtPreference";
import { InfoIcon } from "@/components/icons";
import { PercentApplyField } from "@/components/settings/PercentApplyField";
import { Checkbox } from "@/components/ui/Checkbox";
import { SettingsRow } from "@/components/ui/SettingsRow";
import { HoverTooltipButton } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";

/**
 * SessionHandoffSection — the "Session Handoff" section of Settings → Preferences
 * (issue #2587, epic #2586 Sub C; folded from the former `/settings/watermark` page
 * by the Settings sidebar reorganization).
 *
 * Operator surface for "Session Handoff": when a manager (PM) session's context
 * window fills past the handoff threshold, the server automatically starts a fresh
 * session to continue its work and winds the busy one down (the #2158 successor-
 * handoff feature). This page is ONE on/off switch, the threshold editor, and a
 * collapsible, bounded, scrollable list of the watched sessions — each row showing
 * the session's own emoji + name + model + linked issue, clickable through to the
 * session view, with a "keep it running" override.
 *
 * The user-facing copy deliberately avoids the internal "watermark"/"armed"/"disarm"
 * vocabulary — those stay the wire/protocol names (GET/PUT `/api/watermark`,
 * `WatermarkState.handoffState`, the disarm endpoint) but are shown here in plain
 * language ("handoff threshold", "ready to hand off", "keep this session").
 *
 * Rendered inside `routes/settings/preferences.tsx` under the `#session-handoff`
 * anchor; the sidebar's nested "Session Handoff" row deep-links there via URL hash.
 *
 * #6570 (R11, reviewer D's layout): the switch row says this is not the compaction
 * point (that is the Compact at section) in one truncating line, with the long
 * explanation behind an info button; when `HAPI_CONTEXT_WATERMARK_ENABLED` decides
 * (`enabledSource: "env"`), the line says so and the switch is disabled. The
 * threshold uses the shared `PercentApplyField` with this editor's own rule (above
 * 0, up to 100, fractions allowed). `compactAt` is the page's one Compact-at read,
 * so the "at or above Compact at" warning compares against the value that section
 * shows.
 */

// #6570: the switch row's info text and its one-line summary.
const HANDOFF_INFO =
  "When a Project Manager session passes the threshold below, Hapimatic starts a fresh session to take over its work, then winds the busy one down. Off by default, because it ends the original session. This is not when a session compacts; that is Compact at. HAPI_CONTEXT_WATERMARK_ENABLED, when set to 1, true or yes, turns this on, and 0, false or no turns it off, whatever this switch says";
const HANDOFF_INFO_ENV_SUFFIX =
  ". It is set now, so it decides; this switch takes over once it is unset";
const HANDOFF_SUMMARY = "Not the compaction point · ends the original session";
const HANDOFF_SUMMARY_ENV = "Set by HAPI_CONTEXT_WATERMARK_ENABLED";

// Plain-language labels for the internal handoff state machine (idle → armed →
// handing_off → complete | failed). The API keeps the terse names; the UI shows these.
const HANDOFF_STATE_LABELS: Record<WatermarkState["handoffState"], string> = {
  idle: "Watching",
  armed: "Ready to hand off",
  handing_off: "Handing off…",
  complete: "Handed off",
  failed: "Handoff failed",
};

export function SessionHandoffSection(
  props: { compactAt?: UseCompactAtPreference } = {}
) {
  const { api } = useAppContext();
  const { status, loading, error, setEnabled, setWatermarkPercent, disarm } =
    useWatermarkAdmin(api);
  const { sessions } = useSessions(api);
  const navigate = useNavigate();

  // Join each watched session (watermark state carries only its id) to the real
  // session record so we can show its name, emoji, model, node, and linked issue.
  const sessionById = useMemo(() => {
    const map = new Map<string, SessionSummary>();
    for (const s of sessions) map.set(s.id, s);
    return map;
  }, [sessions]);

  const enabled = status?.enabled ?? false;
  const envDecided = status?.enabledSource === "env";
  // #6570: the Compact-at percentage sessions use, when Compact at is on.
  const compactAtData = props.compactAt?.data;
  const compactAtPercent =
    compactAtData &&
    compactAtData.enabled &&
    (compactAtData.source === "stored" ||
      compactAtData.source === "legacy-watermark" ||
      compactAtData.source === "default")
      ? compactAtData.percent
      : null;
  const compactsFirst =
    enabled &&
    status != null &&
    compactAtPercent !== null &&
    status.watermarkPercent >= compactAtPercent;

  return (
    <div data-testid="session-handoff-section" className="flex flex-col">
      <div className="flex w-full flex-col gap-6">
        <section className="flex flex-col gap-3">
          <SectionHeading>Automatic session handoff</SectionHeading>

          {/* The ONE on/off control — its checked state IS the current status. */}
          <ToggleRow
            label="Hand off a session before it runs out of context"
            checked={enabled}
            disabled={loading || !status || envDecided}
            onChange={setEnabled}
            info={
              envDecided ? HANDOFF_INFO + HANDOFF_INFO_ENV_SUFFIX : HANDOFF_INFO
            }
            description={envDecided ? HANDOFF_SUMMARY_ENV : HANDOFF_SUMMARY}
          />

          {status ? (
            <>
              <PercentApplyField
                label="Handoff threshold"
                value={status.watermarkPercent}
                min={0}
                minExclusive
                max={100}
                rangeMessage="Enter a percentage above 0, up to 100"
                disabled={loading}
                onApply={setWatermarkPercent}
                inputTitle="Share of a Project Manager session's context window that starts a handoff"
                applyTitle="Save this threshold"
                inputAriaLabel="Handoff threshold percent"
                testIdPrefix="watermark-percent"
              />
              {compactsFirst ? (
                <p
                  className="truncate text-xs text-warn"
                  data-testid="watermark-compacts-first"
                >
                  At or above Compact at ({compactAtPercent}%): sessions compact
                  first
                </p>
              ) : null}
              <p className="text-xs text-[var(--app-hint)]">
                Applies to:{" "}
                {status.roles.length > 0
                  ? `${status.roles.join(", ")} (manager) sessions`
                  : "no session types"}
              </p>
            </>
          ) : loading ? (
            <p className="text-xs text-[var(--app-hint)]">Loading…</p>
          ) : (
            <p className="text-xs text-[var(--app-hint)]">
              Settings unavailable.
            </p>
          )}

          {error && (
            <p
              className="text-xs text-[var(--app-badge-error-text)]"
              data-testid="watermark-error"
            >
              {error}
            </p>
          )}
        </section>

        <WatchedSessions
          states={status?.states ?? []}
          sessionById={sessionById}
          featureEnabled={enabled}
          loading={loading && !status}
          hasStatus={!!status}
          onKeep={disarm}
          onOpen={sessionId =>
            navigate({ to: "/sessions/$sessionId", params: { sessionId } })
          }
        />
      </div>
    </div>
  );
}

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-[length:var(--text-caption)] font-medium uppercase tracking-wide text-[var(--app-hint)]">
      {children}
    </h2>
  );
}

function ToggleRow(props: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  /** #6570: the long explanation, behind one info button beside the label. */
  info: string;
  /** #6570: one line that truncates rather than wraps. */
  description: string;
}) {
  // #3032 Sub D — migrated to the shared `SettingsRow` composite. `asLabel` wraps
  // the row in <label> for the native checkbox association (behavior-preserving).
  // #6570: the checkbox is `ui/Checkbox.tsx` (the interaction rule), named by its
  // own aria-label so the info button's name stays out of it. The label names the
  // checkbox by id, because it also holds the info button, which a `<label>` with
  // no `for` would name instead.
  const switchId = useId();
  return (
    <SettingsRow
      asLabel
      htmlFor={switchId}
      disabled={props.disabled}
      label={
        <span className="inline-flex max-w-full items-center gap-1">
          {/* #6570: the row never wraps; the label truncates before it would
              (the full label stays in its title). */}
          <span className="min-w-0 truncate" title={props.label}>
            {props.label}
          </span>
          <HoverTooltipButton
            type="button"
            content={props.info}
            aria-label="More info"
            data-testid="watermark-info"
            className="inline-flex cursor-help items-center p-0.5 text-[var(--app-hint)]/60 hover:text-[var(--app-fg)]"
          >
            <InfoIcon className="h-3 w-3" />
          </HoverTooltipButton>
        </span>
      }
      description={
        <span className="block truncate" data-testid="watermark-summary">
          {props.description}
        </span>
      }
      control={
        <Checkbox
          id={switchId}
          checked={props.checked}
          disabled={props.disabled}
          disabledDim={false}
          onChange={e => props.onChange(e.target.checked)}
          aria-label={props.label}
          title="Turn Session Handoff on or off"
          data-testid="watermark-enabled-toggle"
        />
      }
    />
  );
}

/**
 * Collapsible, height-bounded, scrollable list of the sessions the handoff
 * watcher is tracking. Collapse via the header chevron; when expanded and the
 * list overflows `max-h-80`, the inner container scrolls rather than growing the
 * page indefinitely.
 */
function WatchedSessions(props: {
  states: WatermarkState[];
  sessionById: Map<string, SessionSummary>;
  featureEnabled: boolean;
  loading: boolean;
  hasStatus: boolean;
  onKeep: (sessionId: string) => void;
  onOpen: (sessionId: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const count = props.states.length;
  const emptyText = props.featureEnabled
    ? "No sessions are near the handoff threshold right now."
    : "Automatic handoff is off — no sessions are being watched.";

  return (
    <section className="flex flex-col gap-2">
      <Button
        variant="ghostStatic"
        size="bare"
        type="button"
        onClick={() => setExpanded(v => !v)}
        aria-expanded={expanded}
        data-testid="watermark-watched-toggle"
        className="justify-start gap-1.5 text-[length:var(--text-caption)] font-medium uppercase tracking-wide hover:text-[var(--app-fg)]"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        Watched sessions{count > 0 ? ` (${count})` : ""}
      </Button>

      {expanded &&
        (props.loading ? (
          <p className="text-xs text-[var(--app-hint)]">Loading…</p>
        ) : !props.hasStatus || count === 0 ? (
          // #6570: one line at 320 px too; the hint truncates rather than wraps.
          <p
            className="truncate text-xs text-[var(--app-hint)]"
            data-testid="watermark-empty"
            title={emptyText}
          >
            {emptyText}
          </p>
        ) : (
          <div
            className="max-h-80 overflow-y-auto rounded-md border border-[var(--app-border)]"
            data-testid="watermark-watched-scroll"
          >
            <ul
              className="flex flex-col divide-y divide-[var(--app-border)]"
              role="list"
              data-testid="watermark-states"
            >
              {props.states.map(s => (
                <WatchedSessionRow
                  key={s.sessionId}
                  state={s}
                  session={props.sessionById.get(s.sessionId)}
                  featureEnabled={props.featureEnabled}
                  onKeep={() => props.onKeep(s.sessionId)}
                  onOpen={() => props.onOpen(s.sessionId)}
                />
              ))}
            </ul>
          </div>
        ))}
    </section>
  );
}

function WatchedSessionRow(props: {
  state: WatermarkState;
  session: SessionSummary | undefined;
  featureEnabled: boolean;
  onKeep: () => void;
  onOpen: () => void;
}) {
  const { state, session, featureEnabled, onKeep, onOpen } = props;
  // When handoff is off, the watcher is stopped, so any leftover entry is stale.
  const stale = !featureEnabled;
  const pending =
    state.armed ||
    state.handoffState === "armed" ||
    state.handoffState === "handing_off";
  const canKeep = pending && !stale;
  const stateLabel = stale
    ? "Inactive (handoff off)"
    : state.suppressed
      ? "Kept running"
      : (HANDOFF_STATE_LABELS[state.handoffState] ?? state.handoffState);

  const title = session
    ? getSessionTitle(session)
    : state.sessionId.slice(0, 8);
  const emoji = session?.emoji ?? null;
  const model = session ? getModelLabel(session) : null;
  const nodeLabel = session?.nodeLabel;
  const issueNumber = session?.linkedIssue?.number;

  // The whole row navigates to the session; the Keep button is a sibling (never
  // nested) and stops propagation so it doesn't also trigger navigation.
  return (
    <li className="flex items-center gap-2 transition-colors hover:bg-[var(--app-hover)]">
      <Button
        variant="ghostStatic"
        type="button"
        onClick={onOpen}
        data-testid={`watermark-session-${state.sessionId}`}
        className="h-auto min-w-0 flex-1 flex-col items-stretch justify-start gap-0.5 px-3 py-2 text-left font-normal hover:text-[var(--app-fg)]"
        title="Open this session"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex-shrink-0 text-base leading-none">
            {emoji ?? (
              <span className="text-[var(--app-hint)]" aria-hidden="true">
                •
              </span>
            )}
          </span>
          <span className="truncate text-sm font-medium text-[var(--app-fg)]">
            {title}
          </span>
          <span
            className={`ml-auto flex-shrink-0 rounded px-1.5 py-0.5 text-[length:var(--text-caption)] font-medium ${
              !stale && pending
                ? "text-[var(--app-link)]"
                : "text-[var(--app-hint)]"
            }`}
            data-testid={`watermark-handoff-state-${state.sessionId}`}
          >
            {stateLabel}
          </span>
        </div>
        <p className="truncate text-xs text-[var(--app-hint)]">
          {Math.round(state.contextPercentage)}% of context used
          {model ? ` · ${model}` : ""}
          {nodeLabel ? ` · ${nodeLabel}` : ""}
          {issueNumber ? ` · #${issueNumber}` : ""}
          {state.generation > 0 ? ` · handoff #${state.generation}` : ""}
        </p>
      </Button>
      {canKeep && (
        <Button
          variant="accent"
          size="dense"
          type="button"
          onClick={e => {
            e.stopPropagation();
            onKeep();
          }}
          data-testid={`watermark-disarm-${state.sessionId}`}
          className="mr-3 shrink-0"
        >
          Keep this session
        </Button>
      )}
    </li>
  );
}
