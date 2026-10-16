// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState, type ReactNode } from "react";
import type {
  ChatSectionDefaultState,
  SearchFilterPreferences,
} from "@hapi/protocol/schemas";
import {
  CHAT_SECTION_DEFAULT_STATES,
  CHAT_SECTIONS_NARRATION_PROMOTE_THRESHOLD_MAX,
  ChatSectionsPreferenceSchema,
  DefaultOutputStylePreferenceSchema,
  MAX_CONCURRENCY_FLOOR,
  MAX_CONCURRENCY_HARD_CEILING,
} from "@hapi/protocol/schemas";
import type { ApiClient } from "@/api/client";
import { useAppContext } from "@/lib/app-context";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useEmojiFavicon } from "@/hooks/useEmojiFavicon";
import useDensity, { DENSITY_LABELS } from "@/hooks/useDensity";
import { useTextScale } from "@/hooks/useTextScale";
import { useSearchFilterPreferences } from "@/hooks/useSearchFilterPreferences";
import {
  useAdminPreferences,
  type ControlBarPosition,
  type DensityMode,
} from "@/hooks/useAdminPreferences";
import { useAutoRecoverPreference } from "@/hooks/useAutoRecoverPreference";
import { useAutoSelectOptimalAccountPreference } from "@/hooks/useAutoSelectOptimalAccountPreference";
import { useAutoSwitchOnRateLimitPreference } from "@/hooks/useAutoSwitchOnRateLimitPreference";
import { useChatSectionPrefs } from "@/hooks/useChatSectionPrefs";
import { useDefaultOutputStyle } from "@/hooks/useDefaultOutputStyle";
import { useFederationSettings } from "@/hooks/useFederationSettings";
import { OutputStyleManager } from "@/components/settings/OutputStyleManager";
import { GlobalInheritToggle } from "@/components/settings/GlobalInheritToggle";
import { TimezoneSelect } from "@/components/NewSession/TimezoneSelect";
import {
  API_ERROR_CLASSES,
  type ApiErrorRecoveryPolicy,
} from "@hapi/protocol/apiErrorClasses";
import {
  COMPOSER_SUBMIT_LABELS,
  COMPOSER_SUBMIT_ORDER,
  type ComposerSubmitBehavior,
} from "@/lib/composerSubmitBehavior";
import {
  CLAUDE_PERMISSION_MODES,
  getPermissionModeLabel,
  type PermissionMode,
} from "@hapi/protocol/modes";
import { useFederatedSessions } from "@/hooks/queries/useFederatedSessions";
import { useNodeMaxConcurrency } from "@/hooks/queries/useNodeMaxConcurrency";
import { useSetNodeMaxConcurrency } from "@/hooks/mutations/useSetNodeMaxConcurrency";
import {
  SettingsSectionHeader,
  TitleChip,
} from "@/components/settings/SettingsSectionHeader";
import { SettingsPage } from "@/components/layouts/SettingsPage";
import { IconSectionHeading } from "@/components/settings/IconSectionHeading";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Input } from "@/components/ui/Input";
import { tokens } from "@/design/tokens";
import { ThemePicker } from "@/components/settings/ThemePicker";
import { NotificationsSection } from "@/components/settings/sections/NotificationsSection";
import { SessionHandoffSection } from "@/components/settings/sections/SessionHandoffSection";
import { GettingStartedSection } from "@/components/settings/sections/GettingStartedSection";
import { OnboardingSection } from "@/components/settings/sections/OnboardingSection";
import { VoiceInputSection } from "@/components/settings/sections/VoiceInputSection";
import { useScrollToLocationHash } from "@/hooks/useScrollToLocationHash";
import { Bell, ArrowRightLeft, Sliders } from "lucide-react";

// Copied verbatim from SearchFilterBar.tsx (not exported there — see directive
// Convention Patterns; copy-verbatim avoids cross-module coupling).
const STATUS_LABELS: Record<
  SearchFilterPreferences["filters"]["status"],
  string
> = {
  all: "All",
  active: "Active",
  inactive: "Inactive",
};
const SORT_LABELS: Record<SearchFilterPreferences["sort"], string> = {
  updated: "Last active",
  created: "Created",
  name: "Name",
  timeLogged: "Time logged",
};

const DENSITY_ORDER: DensityMode[] = ["normal", "compact", "ultra"];

const STATUS_ORDER: SearchFilterPreferences["filters"]["status"][] = [
  "all",
  "active",
  "inactive",
];
const SORT_ORDER: SearchFilterPreferences["sort"][] = [
  "updated",
  "created",
  "name",
  "timeLogged",
];

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-[length:var(--text-caption)] font-medium uppercase tracking-wide text-[var(--app-hint)]">
      {children}
    </h2>
  );
}

// design-system gap (#3038): this hand-rolled radio-row shares SegmentedToggle's
// exact ARIA contract (radiogroup/radio/aria-checked) but an accent-filled,
// full-width visual that SegmentedToggle has no variant for — and it lacks the
// primitive's roving-tabindex arrow-key semantics. Sub C follow-up #3339
// (accent-filled SegmentedToggle variant). D2 (#3358) adopts the shared Button
// primitive here (and in the System Health radiogroup below) with variant='accent'
// — presentation- and ARIA-preserving; full SegmentedToggle adoption (its
// roving-tabindex arrow-key semantics) stays a separate behavior-changing follow-up.
function RadioGroup<T extends string>(props: {
  label: string;
  options: readonly T[];
  labelFor: (value: T) => string;
  value: T;
  onChange: (value: T) => void;
  description?: string;
  /** #2624 (B): optional control rendered beside the heading (the 🌐 toggle). */
  labelAdornment?: ReactNode;
  /**
   * #3399: content-width wrapping layout (the System Health Icon block). Enables
   * `flex-wrap` on the radiogroup container AND drops the per-button `flex-1`, so
   * buttons size to their content and wrap onto a new line instead of stretching
   * equally across one row. Unset (the default) preserves the 8 existing
   * equal-stretch call sites byte-for-byte.
   */
  wrap?: boolean;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <SectionHeading>{props.label}</SectionHeading>
        {props.labelAdornment}
      </div>
      <div
        role="radiogroup"
        aria-label={props.label}
        className={props.wrap ? "flex flex-wrap gap-2" : "flex gap-2"}
      >
        {props.options.map(option => {
          const selected = props.value === option;
          return (
            <Button
              key={option}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => props.onChange(option)}
              variant={selected ? "accent" : "secondary"}
              className={`h-auto ${props.wrap ? "" : "flex-1 "}px-3 py-2 hover:opacity-100 ${
                selected ? "" : "hover:bg-white/10"
              }`}
            >
              {props.labelFor(option)}
            </Button>
          );
        })}
      </div>
      {props.description && (
        <p className="text-xs text-[var(--app-hint)]">{props.description}</p>
      )}
    </section>
  );
}

function ToggleRow(props: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  description?: string;
}) {
  // #3038: the checkbox is the shared Checkbox primitive (h-5 w-5 preserves this
  // surface's size; the accent tint is the same --app-accent ≡ --app-link chain).
  // Adopting the SettingsRow composite for the row itself is BLOCKED by the inert
  // type-token defect (`text-[var(--text-*)]` compiles to color:, not font-size:,
  // so SettingsRow's label renders at inherited 16px vs this row's 14px) — defect
  // #3330; swap the row onto SettingsRow when the fix lands.
  return (
    <section className="flex flex-col gap-1">
      <label className="flex cursor-pointer items-center justify-between gap-3">
        <span className="text-sm font-medium text-[var(--app-fg)]">
          {props.label}
        </span>
        <Checkbox
          className="h-5 w-5"
          checked={props.checked}
          onChange={e => props.onChange(e.target.checked)}
        />
      </label>
      {props.description && (
        <p className="text-xs text-[var(--app-hint)]">{props.description}</p>
      )}
    </section>
  );
}

/**
 * #4936: whether a class row's toggle reads ON — exhaustive over the policy
 * union, so a new policy cannot silently render as an ON recover toggle.
 */
function classToggleChecked(
  policy: ApiErrorRecoveryPolicy,
  override: boolean | undefined
): boolean {
  switch (policy) {
    case "recover":
      return override !== false; // ON unless explicitly opted out
    case "notify-only":
      return override === true; // OFF unless force-enabled
    case "terminal":
      return false; // never listed: a terminal class is not force-enableable
    default: {
      const unhandled: never = policy;
      return unhandled;
    }
  }
}

/**
 * Per-class auto-recover overrides (#2487 Sub-Issue D). One checkbox per API-
 * error class from the shared taxonomy, beneath the master toggle. Server-
 * authoritative (no localStorage) — a loading state shows until the class map
 * has been read. A recover-by-default class is ON unless explicitly opted out; a
 * notify-only class (auth / invalid-request / billing) is OFF (notify-only)
 * unless force-enabled. A terminal class (#4936: an API spend cap / spend
 * limit) gets no row — it is never auto-recovered and cannot be force-enabled.
 * The whole list is disabled when the master is off.
 */
function ApiErrorClassOverrides(props: {
  masterEnabled: boolean;
  classOverrides: Record<string, boolean>;
  classesLoaded: boolean;
  onChange: (canonicalClass: string, value: boolean) => void;
}) {
  const { masterEnabled, classOverrides, classesLoaded, onChange } = props;
  return (
    <div className="ml-1 flex flex-col gap-2 border-l border-[var(--app-border)] pl-3">
      <p className="text-xs text-[var(--app-hint)]">
        Choose which API-error classes auto-recover. Deterministic classes only
        notify by default — a resume prompt can&apos;t fix them — but you can
        force-enable recovery per class.
      </p>
      {!classesLoaded ? (
        <p className="text-xs text-[var(--app-hint)]">Loading classes…</p>
      ) : (
        // #4936: terminal classes (an API spend cap / spend limit) are never
        // auto-recovered and cannot be force-enabled, so they have no toggle.
        API_ERROR_CLASSES.filter(cls => cls.defaultPolicy !== "terminal").map(
          cls => {
            const override = classOverrides[cls.canonical];
            const notifyOnly = cls.defaultPolicy === "notify-only";
            const checked = classToggleChecked(cls.defaultPolicy, override);
            return (
              <label
                key={cls.canonical}
                className={`flex items-center justify-between gap-3 ${
                  masterEnabled ? "cursor-pointer" : "opacity-50"
                }`}
              >
                <span className="text-sm text-[var(--app-fg)]">
                  {cls.label}
                  {cls.httpHint ? (
                    <span className="text-[var(--app-hint)]">
                      {" "}
                      ({cls.httpHint})
                    </span>
                  ) : null}
                  {notifyOnly ? (
                    <span className="ml-1 text-xs text-[var(--app-hint)]">
                      · notify only
                    </span>
                  ) : null}
                </span>
                {/* #3338 Sub C — the shared Checkbox primitive with the composable
                  disabled-dim opted OUT: the parent <label> already dims to
                  opacity-50 when !masterEnabled, so the primitive's own
                  disabled:opacity-50 would double-dim (25% effective). `--app-accent`
                  resolves through the same chain as the former --app-link tint. */}
                <Checkbox
                  className="h-5 w-5"
                  disabledDim={false}
                  checked={checked}
                  disabled={!masterEnabled}
                  onChange={e => onChange(cls.canonical, e.target.checked)}
                />
              </label>
            );
          }
        )
      )}
    </div>
  );
}

/**
 * Per-node max-concurrency control (issue #1805, R6/R7/R10). Server-backed
 * (NOT localStorage) — the cap is a daemon-enforced operational setting. Each
 * row owns its own read/write hooks so the rules-of-hooks hold when the parent
 * maps over a variable node list.
 */
export function MaxConcurrencyRow(props: {
  api: ApiClient | null;
  nodeId: string;
  nodeLabel: string;
}) {
  const capQuery = useNodeMaxConcurrency(props.api, props.nodeId);
  const setCap = useSetNodeMaxConcurrency(props.api);
  const [draft, setDraft] = useState<string>("");
  const [localError, setLocalError] = useState<string | null>(null);

  const serverValue = capQuery.data?.value ?? null;
  const effective = capQuery.data?.effective ?? null;
  const recommended = capQuery.data?.recommended ?? null;
  const source = capQuery.data?.source ?? "unknown";
  const envOverride = source === "env";
  // #4417: "Use automatic" clears an explicit settings cap back to the daemon's
  // tier/derived/default resolution — only meaningful when a settings value is in effect.
  const canClearToAuto = source === "settings";

  // Seed the input from the persisted value (or the daemon-enforced value when
  // nothing is persisted) once it loads. Keyed on both so an external change
  // (e.g. another client) re-seeds when not actively editing.
  useEffect(() => {
    if (serverValue !== null) setDraft(String(serverValue));
    else if (effective !== null) setDraft(String(effective));
  }, [serverValue, effective]);

  const handleSave = () => {
    const n = Number(draft);
    if (
      !Number.isInteger(n) ||
      n < MAX_CONCURRENCY_FLOOR ||
      n > MAX_CONCURRENCY_HARD_CEILING
    ) {
      setLocalError(
        `Enter a whole number between ${MAX_CONCURRENCY_FLOOR} and ${MAX_CONCURRENCY_HARD_CEILING}.`
      );
      return;
    }
    setLocalError(null);
    setCap.mutate({ nodeId: props.nodeId, value: n });
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-[var(--app-fg)]">
          {props.nodeLabel}
        </span>
        <div className="flex items-center gap-2">
          <Input
            variant="borderlessDense"
            type="number"
            min={MAX_CONCURRENCY_FLOOR}
            max={MAX_CONCURRENCY_HARD_CEILING}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            className="w-16 tabular-nums"
            aria-label={`Max concurrent sessions for ${props.nodeLabel}`}
          />
          <Button
            type="button"
            variant="accent"
            size="dense"
            onClick={handleSave}
            disabled={setCap.isPending}
          >
            {setCap.isPending ? "Saving…" : "Save"}
          </Button>
          {canClearToAuto ? (
            <Button
              type="button"
              variant="ghost"
              size="dense"
              onClick={() => {
                setLocalError(null);
                setCap.mutate({ nodeId: props.nodeId, value: null });
              }}
              disabled={setCap.isPending}
            >
              Use automatic
            </Button>
          ) : null}
        </div>
      </div>
      {localError ? (
        <p className="text-xs text-red-400">{localError}</p>
      ) : setCap.isError ? (
        <p className="text-xs text-red-400">
          {setCap.error instanceof Error
            ? setCap.error.message
            : "Failed to save"}
        </p>
      ) : effective !== null ? (
        <p className="text-xs text-[var(--app-hint)]">
          Enforced cap: {effective}
          {recommended !== null ? ` · recommended ${recommended}` : ""}
          {` · source: ${source}`}
          {envOverride
            ? " — set by the HAPI_MAX_CONCURRENT_SESSIONS env override; this control is a no-op until it is unset"
            : ""}
          {!envOverride &&
          recommended !== null &&
          serverValue !== null &&
          serverValue > recommended
            ? ` — your cap (${serverValue}) exceeds the recommended ${recommended}`
            : ""}
        </p>
      ) : (
        <p className="text-xs text-[var(--app-hint)]">
          Capacity unknown (daemon may be unreachable).
        </p>
      )}
    </div>
  );
}

export default function AdminPreferencesPage() {
  const { api } = useAppContext();
  useDocumentTitle("Preferences - Hapimatic");
  useEmojiFavicon(null);
  useScrollToLocationHash();

  const { density, setDensity } = useDensity();
  const {
    scaleLabel,
    incrementScale,
    decrementScale,
    canIncrement,
    canDecrement,
  } = useTextScale();
  const {
    prefs: searchPrefs,
    setSort,
    setFilterStatus,
  } = useSearchFilterPreferences(api);
  const {
    prefs,
    setAutoExpandRepoGroups,
    setSessionListControlBarPosition,
    setComposerSubmitBehavior,
    setDefaultSpawnPermissionMode,
    setTerminalComposeEnterAfterSend,
  } = useAdminPreferences();
  const {
    enabled: autoRecoverEnabled,
    setEnabled: setAutoRecover,
    classOverrides: autoRecoverClassOverrides,
    classesLoaded: autoRecoverClassesLoaded,
    setClassOverride: setAutoRecoverClass,
  } = useAutoRecoverPreference(api);
  const { enabled: autoSwitchEnabled, setEnabled: setAutoSwitch } =
    useAutoSwitchOnRateLimitPreference(api);
  // #3611: the SAME toggle now also governs the daemon's un-pinned optimal-pick, so
  // it is server-mirrored (write-through + reconcile) rather than localStorage-only.
  const {
    enabled: autoSelectOptimalEnabled,
    setEnabled: setAutoSelectOptimal,
  } = useAutoSelectOptimalAccountPreference(api);
  // #2988 (epic #2987 S1): per-category chat-sections matrix (server-
  // authoritative). The default output style + upload/manage UI live in
  // <OutputStyleManager /> (#2627, E).
  const {
    prefs: chatSections,
    setPrefs: setChatSections,
    adopt: adoptChatSections,
  } = useChatSectionPrefs(api);
  // #2624 (B): the default-output-style hook is LIFTED here from
  // OutputStyleManager so 🌐 re-adoption updates the ONE instance its select
  // renders from (a second in-component instance would stay stale).
  const {
    style: defaultOutputStyle,
    setStyle: setDefaultOutputStyle,
    adopt: adoptDefaultOutputStyle,
  } = useDefaultOutputStyle(api);
  // #2624 (B): the 🌐 engine — per-key inherit flags + provenance.
  const fedSettings = useFederationSettings(api);
  const { localNode, remoteNodes } = useFederatedSessions(api);

  // #2624 (B): whenever the 🌐 view refreshes (mount hydrate or a toggle
  // response), push the federated effective values into the value hooks via
  // their non-writing `adopt` — so toggling 🌐 back ON re-adopts the current
  // federation-global in the visible controls WITHOUT re-publishing it as a
  // fresh global write (LWW safety).
  const fedView = fedSettings.view;
  useEffect(() => {
    if (!fedView) return;
    const sec = ChatSectionsPreferenceSchema.safeParse(
      fedView.values.chatSections
    );
    if (sec.success) adoptChatSections(sec.data);
    const sty = DefaultOutputStylePreferenceSchema.safeParse(
      fedView.values.defaultOutputStyle
    );
    if (sty.success) adoptDefaultOutputStyle(sty.data.style);
  }, [fedView, adoptChatSections, adoptDefaultOutputStyle]);

  const healthNodes = [...(localNode ? [localNode] : []), ...remoteNodes];

  // #1805: nodes for the per-node capacity control. On a non-federated instance
  // (no localNode) the server treats any nodeId as local, so a synthetic
  // "local" entry keeps the local cap settable without federation.
  const capacityNodes: Array<{ nodeId: string; nodeLabel: string }> =
    healthNodes.length > 0
      ? healthNodes.map(n => ({ nodeId: n.nodeId, nodeLabel: n.nodeLabel }))
      : [{ nodeId: "local", nodeLabel: "This machine" }];

  return (
    // #3038: page scaffold adopted from the SettingsPage layout template (Sub E) —
    // it owns the single `h-full overflow-y-auto` scroll container (#2830
    // invariant); `flex flex-col` merges on so the rendered class set is unchanged.
    // The scroll lint resolves via SCROLL_OWNER_OVERRIDES delegation.
    <SettingsPage
      data-testid="settings-preferences-root"
      className="flex flex-col"
      header={
        // design-system gap (#3038): the decorative section hues (the teal
        // TitleChip accent here, the amber Notifications tile below) have no
        // token — only the cyan was named (--accent-cyan). Sub B follow-up
        // #3335 (decorative section-accent family).
        <SettingsSectionHeader
          icon={<TitleChip icon={Sliders} accent="var(--accent-teal-400)" />}
          title="Preferences"
        />
      }
    >
      {/* #2331: body shares the header's `max-w-content` cap so the page reads as
          one column. `w-full` keeps it full-bleed below 1024px (no mobile gutters). */}
      <div className="mx-auto flex w-full max-w-content flex-col gap-6 p-4">
        {/* Density (R2) */}
        <RadioGroup
          label="Row Density"
          options={DENSITY_ORDER}
          labelFor={d => DENSITY_LABELS[d]}
          value={density}
          onChange={setDensity}
        />

        {/* Theme accent picker (#1987 C2 — a pure consumer of C1's engine) */}
        <ThemePicker />

        {/* Text Scale (R5) */}
        <section className="flex flex-col gap-2">
          <SectionHeading>Text Scale</SectionHeading>
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="secondary"
              size="denseSquare"
              onClick={decrementScale}
              disabled={!canDecrement}
              aria-label="Decrease text size"
            >
              A−
            </Button>
            <span className="min-w-14 text-center text-sm tabular-nums text-[var(--app-fg)]">
              {scaleLabel}
            </span>
            <Button
              type="button"
              variant="secondary"
              size="denseSquare"
              onClick={incrementScale}
              disabled={!canIncrement}
              aria-label="Increase text size"
            >
              A+
            </Button>
          </div>
        </section>

        {/* Composer Send Key (#1525 — R1, R2, R7) */}
        <RadioGroup<ComposerSubmitBehavior>
          label="Send Message With"
          options={COMPOSER_SUBMIT_ORDER}
          labelFor={b => COMPOSER_SUBMIT_LABELS[b]}
          value={prefs.composerSubmitBehavior}
          onChange={setComposerSubmitBehavior}
          description="Which keystroke sends a chat message. 'Shift+Enter' (default): a plain Enter inserts a newline. 'Enter': a plain Enter sends and Shift+Enter inserts a newline. Ctrl/Cmd+Enter always sends."
        />

        {/* Terminal compose-line auto-press-Enter (#4550 — R1, R4; operator
            ruling R2-2). Sits next to Send-Message-With; names the Terminal tab
            on touch devices because the dock only renders on a coarse pointer
            (#4516 R14), so on desktop the toggle is stored but has no effect. */}
        <ToggleRow
          label="Auto-press Enter after Send (Terminal)"
          checked={prefs.terminalComposeEnterAfterSend}
          onChange={setTerminalComposeEnterAfterSend}
          description="Terminal tab compose line on touch devices. Off: Send puts the text at the prompt so you can edit it, then press Enter. On: Send runs it immediately."
        />

        {/* Default Spawn Permission Mode (#1951 A4) */}
        <RadioGroup<PermissionMode>
          label="Default Spawn Permission Mode"
          options={CLAUDE_PERMISSION_MODES}
          labelFor={m => getPermissionModeLabel(m)}
          value={prefs.defaultSpawnPermissionMode}
          onChange={setDefaultSpawnPermissionMode}
          description="The permission posture pre-selected on the Create-Session form. 'YOLO' bypasses approval prompts and sandboxing. Per-session and per-agent overridable — codex/gemini fall back to an equivalent mode."
        />

        {/* Chat & Verbosity (#2623 — epic #2622 Sub-Issue A): two NEW
            server-authoritative preferences. B #2624 globalizes them, C #2625
            consumes chat detail level, D #2626 consumes default output style. */}
        <section className="flex flex-col gap-4">
          <SectionHeading>Chat &amp; Verbosity</SectionHeading>
          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <SectionHeading>Chat sections</SectionHeading>
              <GlobalInheritToggle
                settingLabel="Chat Sections"
                inherit={fedSettings.inheritFor("chatSections")}
                onToggle={next => fedSettings.setInherit("chatSections", next)}
                disabled={!api}
                nodeCount={remoteNodes.length}
              />
            </div>
            <p className="text-xs text-[var(--app-hint)]">
              Per-category control over how each assistant turn renders in the
              chat transcript — hide a section entirely, or choose whether it
              starts expanded or collapsed.
            </p>
            {/* Tool runs category */}
            <div className="flex flex-col gap-2 rounded-md bg-[var(--app-secondary-bg)]/40 p-3">
              <ToggleRow
                label="Show tool runs"
                checked={chatSections.toolRuns.visible}
                onChange={next =>
                  setChatSections({
                    ...chatSections,
                    toolRuns: { ...chatSections.toolRuns, visible: next },
                  })
                }
              />
              <RadioGroup<ChatSectionDefaultState>
                label="Tool runs default state"
                options={CHAT_SECTION_DEFAULT_STATES}
                labelFor={s => (s === "expanded" ? "Expanded" : "Collapsed")}
                value={chatSections.toolRuns.defaultState}
                onChange={next =>
                  setChatSections({
                    ...chatSections,
                    toolRuns: { ...chatSections.toolRuns, defaultState: next },
                  })
                }
              />
            </div>
            {/* Reasoning category */}
            <div className="flex flex-col gap-2 rounded-md bg-[var(--app-secondary-bg)]/40 p-3">
              <ToggleRow
                label="Show reasoning"
                checked={chatSections.reasoning.visible}
                onChange={next =>
                  setChatSections({
                    ...chatSections,
                    reasoning: { ...chatSections.reasoning, visible: next },
                  })
                }
              />
              <RadioGroup<ChatSectionDefaultState>
                label="Reasoning default state"
                options={CHAT_SECTION_DEFAULT_STATES}
                labelFor={s => (s === "expanded" ? "Expanded" : "Collapsed")}
                value={chatSections.reasoning.defaultState}
                onChange={next =>
                  setChatSections({
                    ...chatSections,
                    reasoning: {
                      ...chatSections.reasoning,
                      defaultState: next,
                    },
                  })
                }
              />
              <label className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium text-[var(--app-fg)]">
                  Collapsed reasoning preview lines
                </span>
                <Input
                  variant="borderlessDense"
                  type="number"
                  min={0}
                  max={100}
                  aria-label="Collapsed reasoning preview lines"
                  value={chatSections.reasoning.previewLines}
                  onChange={e => {
                    const n = Number.parseInt(e.target.value, 10);
                    // #3003 F5: mirror the schema's clamp-on-read bound of [0, 100]
                    // on the input (defense-in-depth; the schema transform is the
                    // authoritative bound on read).
                    setChatSections({
                      ...chatSections,
                      reasoning: {
                        ...chatSections.reasoning,
                        previewLines: Number.isFinite(n)
                          ? Math.min(100, Math.max(0, n))
                          : 0,
                      },
                    });
                  }}
                  className="w-20"
                />
              </label>
            </div>
            {/* Narration category (#3154) — mirrors reasoning. Interstitial
                assistant text (a text block whose turn continues into tool runs)
                is narration; the task-final response stays uncategorized. */}
            <div className="flex flex-col gap-2 rounded-md bg-[var(--app-secondary-bg)]/40 p-3">
              <ToggleRow
                label="Show narration"
                checked={chatSections.narration.visible}
                onChange={next =>
                  setChatSections({
                    ...chatSections,
                    narration: { ...chatSections.narration, visible: next },
                  })
                }
              />
              {/* #3154 KD6: turning narration off is a SOFT-COLLAPSE (a closed
                  collapsible, mirroring reasoning), never a removal — narration
                  stays reachable via its own chevron. */}
              <p className="text-xs text-[var(--app-hint)]">
                Interstitial narration — assistant text before a tool run.
                Hiding it starts each narration section collapsed; it is never
                removed.
              </p>
              <RadioGroup<ChatSectionDefaultState>
                label="Narration default state"
                options={CHAT_SECTION_DEFAULT_STATES}
                labelFor={s => (s === "expanded" ? "Expanded" : "Collapsed")}
                value={chatSections.narration.defaultState}
                onChange={next =>
                  setChatSections({
                    ...chatSections,
                    narration: {
                      ...chatSections.narration,
                      defaultState: next,
                    },
                  })
                }
              />
              <label className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium text-[var(--app-fg)]">
                  Collapsed narration preview lines
                </span>
                <Input
                  variant="borderlessDense"
                  type="number"
                  min={0}
                  max={100}
                  aria-label="Collapsed narration preview lines"
                  value={chatSections.narration.previewLines}
                  onChange={e => {
                    const n = Number.parseInt(e.target.value, 10);
                    // #3154: mirror the schema's clamp-on-read bound of [0, 100]
                    // on the input (defense-in-depth; the schema transform is the
                    // authoritative bound on read).
                    setChatSections({
                      ...chatSections,
                      narration: {
                        ...chatSections.narration,
                        previewLines: Number.isFinite(n)
                          ? Math.min(100, Math.max(0, n))
                          : 0,
                      },
                    });
                  }}
                  className="w-20"
                />
              </label>
              <label className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium text-[var(--app-fg)]">
                  Promote narration longer than (lines)
                </span>
                <Input
                  variant="borderlessDense"
                  type="number"
                  min={0}
                  max={CHAT_SECTIONS_NARRATION_PROMOTE_THRESHOLD_MAX}
                  aria-label="Promote narration longer than (lines)"
                  value={chatSections.narration.promoteThresholdLines}
                  onChange={e => {
                    const n = Number.parseInt(e.target.value, 10);
                    // #3879: clamp to [0, MAX] on the input (defense-in-depth; the
                    // schema transform is the authoritative bound on read, bound to
                    // the exported clamp constant — never a hardcoded literal). A
                    // cleared / non-finite field maps to 0 = never promote, so it
                    // fails CLOSED toward today's collapse-everything behaviour.
                    setChatSections({
                      ...chatSections,
                      narration: {
                        ...chatSections.narration,
                        promoteThresholdLines: Number.isFinite(n)
                          ? Math.min(
                              CHAT_SECTIONS_NARRATION_PROMOTE_THRESHOLD_MAX,
                              Math.max(0, n)
                            )
                          : 0,
                      },
                    });
                  }}
                  className="w-20"
                />
              </label>
              <p className="text-xs text-[var(--app-hint)]">
                A mid-turn interstitial with more non-empty lines than this
                renders as a full response instead of collapsing. 0 = never
                promote.
              </p>
            </div>
          </section>
          <OutputStyleManager
            api={api}
            defaultStyle={defaultOutputStyle}
            setDefaultStyle={setDefaultOutputStyle}
            headingAdornment={
              <GlobalInheritToggle
                settingLabel="Default Output Style"
                inherit={fedSettings.inheritFor("defaultOutputStyle")}
                onToggle={next =>
                  fedSettings.setInherit("defaultOutputStyle", next)
                }
                disabled={!api}
                nodeCount={remoteNodes.length}
              />
            }
          />
        </section>

        {/* Time Log timezone (#4613): the ONE federation-wide IANA zone every node
            uses for day bucketing + the midnight reset, so a Time Log view reads
            identically from any node (ms1's UTC-host case included). Pure
            federation setting — no dedicated A-value hook, so the value write goes
            through fedSettings.setValue → PUT /preferences/federation-settings. */}
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <SectionHeading>Time Log timezone</SectionHeading>
            <GlobalInheritToggle
              settingLabel="Time Log Timezone"
              inherit={fedSettings.inheritFor("timeLogTimezone")}
              onToggle={next => fedSettings.setInherit("timeLogTimezone", next)}
              disabled={!api}
              nodeCount={remoteNodes.length}
            />
          </div>
          <p className="text-xs text-[var(--app-hint)]">
            The one IANA timezone every federation node uses to bucket Time Log
            activity by day and to fire the midnight reset — so a Time Log view
            reads identically from any node. Leave 🌐 on to share one value
            across the federation; toggle it off to pin a node-local zone.
          </p>
          <TimezoneSelect
            value={
              (fedView?.values.timeLogTimezone as string | undefined) ||
              Intl.DateTimeFormat().resolvedOptions().timeZone ||
              "UTC"
            }
            onChange={tz => fedSettings.setValue("timeLogTimezone", tz)}
            disabled={!api}
          />
        </section>

        {/* Auto-select optimal account (#2042 A4 create page; #3611 un-pinned spawns) */}
        <ToggleRow
          label="Auto-select optimal account"
          checked={autoSelectOptimalEnabled}
          onChange={setAutoSelectOptimal}
          description="Bind the most-underutilized healthy account (lowest utilization score). On the Create form this pre-selects it (you can still pick another); for un-pinned CLI/scheduler spawns the daemon binds it automatically."
        />

        {/* Default Session Filter (R6 — server-synced filters.status) */}
        <RadioGroup
          label="Default Session Filter"
          options={STATUS_ORDER}
          labelFor={s => STATUS_LABELS[s]}
          value={searchPrefs.filters.status}
          onChange={setFilterStatus}
        />

        {/* Default Sort (R7 — server-synced) */}
        <RadioGroup
          label="Default Sort"
          options={SORT_ORDER}
          labelFor={s => SORT_LABELS[s]}
          value={searchPrefs.sort}
          onChange={setSort}
        />

        {/* Auto-Expand Repo Groups (R8) */}
        <ToggleRow
          label="Auto-expand repo groups"
          checked={prefs.autoExpandRepoGroups}
          onChange={setAutoExpandRepoGroups}
        />

        {/* Session List Control Bar position (#3276) — layout-only; the bar keeps
            all of its controls, only its position on screen changes. */}
        <RadioGroup<ControlBarPosition>
          label="Session List Control Bar"
          options={["top", "bottom"]}
          labelFor={p => (p === "top" ? "Top" : "Bottom")}
          value={prefs.sessionListControlBarPosition}
          onChange={setSessionListControlBarPosition}
          description="Where the session-list control bar (timer, status counts, search/filter/sort) sits. 'Bottom' places it just above the footer — thumb-friendly on mobile. The bar keeps all its controls in either position."
        />

        {/* Auto-Recover From API Errors (R9 master toggle; server-authoritative
            for the autoRecoveryService, epic #1231 / #2486) + per-class overrides
            (#2487 Sub-Issue D — catch-all recovery with per-class opt-out) */}
        <ToggleRow
          label="Auto-recover from API errors"
          checked={autoRecoverEnabled}
          onChange={setAutoRecover}
          description="When Claude Code exhausts its internal retries on a recoverable API error (overload, rate-limit, 5xx, or a dropped connection), automatically resume the session after a cooldown instead of leaving it idle."
        />
        <ApiErrorClassOverrides
          masterEnabled={autoRecoverEnabled}
          classOverrides={autoRecoverClassOverrides}
          classesLoaded={autoRecoverClassesLoaded}
          onChange={setAutoRecoverClass}
        />

        {/* Auto-switch account on rate limit (#3618) — server-authoritative for
            the AutoSwitchOnRateLimitService. OFF by default; the toggle is an
            instant kill-switch (the service reads it fresh per decision). */}
        <ToggleRow
          label="Auto-switch account on rate limit"
          checked={autoSwitchEnabled}
          onChange={setAutoSwitch}
          description="OFF by default. When a session's bound account hits a session or weekly limit, automatically switch the live session to the lowest-utilization healthy account before it dies. Turn this off to instantly stop all auto-switching."
        />

        {/* Session Capacity — per-node max-concurrency (#1805 R6/R7/R10) */}
        <section className="flex flex-col gap-2">
          <SectionHeading>Session Capacity</SectionHeading>
          <p className="text-xs text-[var(--app-hint)]">
            Maximum concurrent sessions each node will spawn. Changes apply on
            the next spawn — no daemon restart. The daemon clamps the value to [
            {MAX_CONCURRENCY_FLOOR}, {MAX_CONCURRENCY_HARD_CEILING}] regardless.
          </p>
          <div className="flex flex-col gap-3">
            {capacityNodes.map(node => (
              <MaxConcurrencyRow
                key={node.nodeId}
                api={api}
                nodeId={node.nodeId}
                nodeLabel={node.nodeLabel}
              />
            ))}
          </div>
        </section>

        {/* Notifications (folded from /settings/notifications — Settings reorg).
            The sidebar's nested "Notifications" row deep-links here via #notifications. */}
        <section
          id="notifications"
          aria-label="Notifications"
          className="flex scroll-mt-2 flex-col gap-3 border-t border-[var(--app-border)] pt-6"
        >
          <IconSectionHeading
            icon={Bell}
            accent="var(--accent-amber-400)"
            title="Notifications"
          />
          <NotificationsSection />
        </section>

        {/* Session Handoff (folded from /settings/watermark — Settings reorg).
            The sidebar's nested "Session Handoff" row deep-links here via #session-handoff. */}
        <section
          id="session-handoff"
          aria-label="Session Handoff"
          className="flex scroll-mt-2 flex-col gap-3 border-t border-[var(--app-border)] pt-6"
        >
          <IconSectionHeading
            icon={ArrowRightLeft}
            accent={tokens.cyan}
            title="Session Handoff"
          />
          <SessionHandoffSection />
        </section>

        {/* Voice input (#4707) — installs and configures the on-node speech
            engine. Self-contained: owns <section id="voice-input"> (deep-linked
            from the composer's "not installed" message) and renders nothing when
            the builtin.voice-input extension is disabled. */}
        <VoiceInputSection api={api} />

        {/* Getting started (#3865) — re-entry to the IN-APP first-run tour
            (node-local state, every instance). Distinct from the gateway
            Onboarding section below. Self-contained: owns its own
            <section id="getting-started">, deep-linked from the drawer's
            "Getting started" sub-row. */}
        <GettingStartedSection />

        {/* Onboarding (#2711) — "Restart onboarding" re-entry to the gateway
            /setup wizard. Self-contained + ssoEnabled-gated: it owns its own
            <section id="onboarding"> and renders nothing on a non-gateway
            instance (an ungated control would link to hapimatic.com/setup, a
            gateway that never provisioned self-hosted / .ts.net / localhost
            instances). Deep-linkable here via #onboarding. */}
        <OnboardingSection />
      </div>
    </SettingsPage>
  );
}
