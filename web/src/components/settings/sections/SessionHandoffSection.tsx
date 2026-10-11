// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import type { WatermarkState } from "@hapi/protocol";
import type { SessionSummary } from "@/types/api";
import { useAppContext } from "@/lib/app-context";
import { useSessions } from "@/hooks/queries/useSessions";
import { getModelLabel, getSessionTitle } from "@/lib/sessionHelpers";
import { useWatermarkAdmin } from "@/hooks/useWatermarkAdmin";
import { FormField } from "@/components/ui/FormField";
import { SettingsRow } from "@/components/ui/SettingsRow";
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
 */

// Plain-language labels for the internal handoff state machine (idle → armed →
// handing_off → complete | failed). The API keeps the terse names; the UI shows these.
const HANDOFF_STATE_LABELS: Record<WatermarkState["handoffState"], string> = {
  idle: "Watching",
  armed: "Ready to hand off",
  handing_off: "Handing off…",
  complete: "Handed off",
  failed: "Handoff failed",
};

export function SessionHandoffSection() {
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

  return (
    <div data-testid="session-handoff-section" className="flex flex-col">
      <div className="flex w-full flex-col gap-6">
        <section className="flex flex-col gap-3">
          <SectionHeading>Automatic session handoff</SectionHeading>

          {/* The ONE on/off control — its checked state IS the current status. */}
          <ToggleRow
            label="Hand off a session before it runs out of context"
            checked={enabled}
            disabled={loading || !status}
            onChange={setEnabled}
            description="When a manager (PM) session's context window fills past the threshold below, Hapimatic automatically starts a fresh session to take over its work and then winds the busy one down — so a long task never stalls when a session runs out of room. Off by default, because it ends the original session once the handoff finishes. (The HAPI_CONTEXT_WATERMARK_ENABLED environment variable can force this off regardless of this switch.)"
          />

          {status ? (
            <>
              <HandoffThresholdEditor
                value={status.watermarkPercent}
                disabled={loading}
                onApply={setWatermarkPercent}
              />
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

/**
 * Server-backed handoff-threshold editor. A number input seeded from the server
 * value + an Apply button that persists via `useWatermarkAdmin.setWatermarkPercent`
 * (PUT `/api/watermark/config`). Re-seeds when the authoritative value changes.
 */
function HandoffThresholdEditor(props: {
  value: number;
  disabled?: boolean;
  onApply: (percent: number) => void;
}) {
  const [draft, setDraft] = useState<string>(String(props.value));
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(String(props.value));
  }, [props.value]);

  const parsed = Number(draft);
  const dirty = draft.trim() !== "" && parsed !== props.value;

  const handleApply = () => {
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) {
      setLocalError("Enter a percentage between 1 and 100.");
      return;
    }
    setLocalError(null);
    props.onApply(parsed);
  };

  // #3032 Sub D — migrated to the shared `FormField` composite (inline layout). The
  // input keeps its explicit aria-label so the accessible name is unchanged, and
  // gains a <label htmlFor> association + aria-describedby → the hint/error.
  return (
    <FormField
      label="Handoff threshold"
      layout="inline"
      error={localError ?? undefined}
      hint="Hand off a session once it has used this much of its context window."
    >
      {field => (
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            <input
              id={field.id}
              aria-describedby={field["aria-describedby"]}
              aria-invalid={field["aria-invalid"]}
              type="number"
              min={1}
              max={100}
              value={draft}
              disabled={props.disabled}
              onChange={e => setDraft(e.target.value)}
              className="w-16 rounded-md bg-[var(--app-secondary-bg)] px-2 py-1 text-sm tabular-nums text-[var(--app-fg)] disabled:opacity-50"
              aria-label="Handoff threshold percent"
              data-testid="watermark-percent-input"
            />
            <span className="text-sm text-[var(--app-hint)]">%</span>
          </div>
          <Button
            variant="accent"
            size="dense"
            type="button"
            onClick={handleApply}
            disabled={props.disabled || !dirty}
            data-testid="watermark-percent-apply"
            className="disabled:opacity-40"
          >
            Apply
          </Button>
        </div>
      )}
    </FormField>
  );
}

function ToggleRow(props: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  description?: string;
}) {
  // #3032 Sub D — migrated to the shared `SettingsRow` composite. `asLabel` wraps
  // the row in <label> for the native checkbox association (behavior-preserving).
  return (
    <SettingsRow
      asLabel
      disabled={props.disabled}
      label={props.label}
      description={props.description}
      control={
        <input
          type="checkbox"
          checked={props.checked}
          disabled={props.disabled}
          onChange={e => props.onChange(e.target.checked)}
          className="h-5 w-5 accent-[var(--app-link)]"
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
          <p
            className="text-xs text-[var(--app-hint)]"
            data-testid="watermark-empty"
          >
            {props.featureEnabled
              ? "No sessions are near the handoff threshold right now."
              : "Automatic handoff is off — no sessions are being watched."}
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
