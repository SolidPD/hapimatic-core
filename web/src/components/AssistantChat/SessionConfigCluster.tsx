// SPDX-License-Identifier: AGPL-3.0-only
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  getPermissionModeLabel,
  getPermissionModeTone,
  isPermissionModeAllowedForFlavor,
  formatModelName,
  MODEL_MODE_LABELS,
  EFFORT_LEVELS,
  DEFAULT_EFFORT_LEVEL,
  type PermissionMode,
  type PermissionModeTone,
  type ModelMode,
  type EffortLevel,
  type AccountMonogram,
} from "@hapi/protocol";
import { useMcpStatus } from "@/hooks/useMcpStatus";
import { useClaudeModels } from "@/hooks/queries/useClaudeModels";
import { effortLevelsForCurrent } from "@/components/AssistantChat/ModelModePicker";
import { shouldRefreshMcpStatus } from "@/lib/shouldRefreshMcpStatus";
import { BareButton } from "@/components/ui/BareButton";
import { AccountChip } from "@/components/session/AccountChip";
import { API_KEY_CHIP_IDENTITY } from "@/hooks/queries/useSessionAccountEmail";
import { useAppContext } from "@/lib/app-context";
import {
  useAccountLabel,
  useAccountMonogram,
} from "@/hooks/queries/useAccountLabels";

/** Compact effort labels for the Effort suffix (matches ComposerModelEffortPicker). */
const COMPACT_EFFORT_LABELS: Record<EffortLevel, string> = {
  low: "Low",
  medium: "Med",
  high: "High",
  xhigh: "Extra",
  max: "Max",
};

/**
 * SessionConfigCluster (issue #3289, S4) — the boxed chip cluster in the Prompt
 * Field's Row 3 (left): **Permission Mode · Model · Effort · Account · MCP**.
 * Per `docs/internal/architecture/ui-component-taxonomy.md` + the E6 mockup
 * (`claudedocs/design-mockups/e6/config-bar.html`).
 *
 * The chips are DISPLAY-ONLY — tapping anywhere in the cluster fires a single
 * stable `onOpenConfig` (R2). Interim contract (until #3290 lands): `onOpenConfig`
 * opens the existing `EditSessionParamsModal`, so model/effort/permission/account
 * switching is never unreachable. #3290 later rewires `onOpenConfig` to the
 * Session Configuration Modal — keep this contract stable.
 *
 * **Deviation flagged for review (#3289 handoff):** the per-server MCP toggle modal
 * (StatusBar's #989 feature) is reachable ONLY from StatusBar's old MCP text, which
 * R6 removes. To avoid an interim functionality regression (the modal migrates to
 * #3290, not yet landed), the MCP chip carries an OPTIONAL `onOpenMcpDetail` tap
 * that `stopPropagation`s so it does not also fire `onOpenConfig`. When #3290 folds
 * the MCP section into the config modal, drop `onOpenMcpDetail` and the MCP chip
 * becomes display-only like the rest.
 *
 * Overflow ladder (R3): the `.chips` track is `flex-1 min-w-0 overflow-hidden`; a
 * ResizeObserver-driven `useOverflowLadder` measures overflow and steps down:
 * - **L1**: Account chip → monogram-only AND the Model chip's effort suffix drops
 *   (together).
 * - **L2**: MCP chip → the cumulative total colored by the worst-present state.
 * - **L3**: Account chip → removed entirely. The account is duplicated in the
 *   Session Basic Info Bar's Account Badge, and the cluster tap still opens the
 *   config modal's account switcher, so nothing becomes unreachable.
 * - **L4**: MCP chip → removed entirely (iPhone SE-class widths, where L3 still
 *   overflows and the strip clipped the chip). The config modal's MCP Servers
 *   row carries the same counts and the per-server list.
 * A disconnected session renders the chips with dashed borders (staged state).
 *
 * LAYOUT ONLY — no draft/attachment sync here (owned by #3254).
 */

// ── MCP chip format (R6) ──────────────────────────────────────────────────────
// SHIM (issue #3289 / OR-2): #3287's `web/src/components/session/badgeFormat.ts`
// (`formatMcp`) is not yet on ms-dev. This local `formatMcp` implements the
// canonical taxonomy mapping (ui-component-taxonomy.md "Badge & count format
// rules"): `MCP a·b·c` = connected · needs-attention · failed, each gray at 0;
// the L2 collapse is the cumulative total colored by the worst-present state.
// RECONCILE when #3287 lands: delete this shim and import `formatMcp` from
// `@/components/session/badgeFormat`, adapting to its exact return shape.
export type McpCountTone = "ok" | "warn" | "hot" | "gray";

export interface McpChipFormat {
  /** a — connected (green): connectedCount + hostedCount. */
  connected: number;
  /** b — needs-attention (amber): needsAuthCount. */
  attention: number;
  /** c — failed (red): failedCount. */
  failed: number;
  /** a + b + c — the L2 cumulative total. */
  total: number;
  /** Tone of the L2 total = worst present state. */
  worstTone: McpCountTone;
}

/** The subset of `useMcpStatus` the MCP chip consumes. */
export type McpChipCounts = {
  connectedCount: number;
  hostedCount: number;
  needsAuthCount: number;
  failedCount: number;
};

export function formatMcp(status: McpChipCounts): McpChipFormat {
  const connected = status.connectedCount + status.hostedCount;
  const attention = status.needsAuthCount;
  const failed = status.failedCount;
  const total = connected + attention + failed;
  const worstTone: McpCountTone =
    failed > 0 ? "hot" : attention > 0 ? "warn" : connected > 0 ? "ok" : "gray";
  return { connected, attention, failed, total, worstTone };
}

const COUNT_TONE_CLS: Record<McpCountTone, string> = {
  ok: "text-green-500",
  warn: "text-amber-400",
  hot: "text-red-400",
  gray: "text-[var(--app-hint)]",
};

/** Tone of an individual a/b/c count: its status color when > 0, else gray. */
function countTone(value: number, tone: Exclude<McpCountTone, "gray">): string {
  return value > 0 ? COUNT_TONE_CLS[tone] : COUNT_TONE_CLS.gray;
}

// ── Chip styling ──────────────────────────────────────────────────────────────
const CHIP_BASE =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[length:var(--text-caption-xs)] font-medium leading-none";

/** Permission/model tone → boxed-chip color triple (text · tint bg · border). */
const TONE_BOX: Record<PermissionModeTone, string> = {
  neutral:
    "text-[var(--app-hint)] bg-[var(--app-subtle-bg)] border-[var(--app-border)]",
  info: "text-blue-400 bg-blue-500/10 border-blue-500/30",
  success:
    "text-[var(--app-success)] bg-[var(--app-success)]/10 border-[var(--app-success)]/30",
  warning: "text-amber-400 bg-amber-500/10 border-amber-500/30",
  danger: "text-red-400 bg-red-500/10 border-red-500/30",
};

const MODEL_BOX_NORMAL =
  "text-[var(--app-link)] bg-[var(--app-link)]/10 border-[var(--app-link)]/30";
const MODEL_BOX_DOWNGRADED = "text-red-400 bg-red-500/10 border-red-500/30";

// Account monogram color + short-name helpers live in the shared
// `@/components/session/AccountChip` (epic #3285 correction pass 1) so the
// composer chip and the Row-1 Account Badge can never drift apart.

export interface SessionConfigClusterProps {
  permissionMode: PermissionMode;
  agentFlavor?: string | null;
  modelMode: ModelMode;
  resolvedModel?: string;
  rawModel?: string;
  /** Issue #3348: the non-claude native model selected at spawn
   *  (metadata.nativeModel) — the display source for a gemini/codex session
   *  whose CLI does not report resolvedModel. Takes precedence in the chip label
   *  for a non-claude flavor; undefined for claude. */
  nativeModel?: string;
  effort?: EffortLevel;
  modelDowngraded?: boolean;
  /** Claude account email; undefined for non-Claude (no account chip). */
  accountEmail?: string;
  /** Issue #4568: an API-key session's key name (label, else masked) — the chip
   *  names the KEY, since the session binds no account (`accountEmail` unset). */
  apiKeyName?: string;
  /** Per-project MCP status source for the MCP chip. */
  projectDir?: string | null;
  /** Session disconnected → chips render with dashed borders (staged). */
  disconnected?: boolean;
  disabled?: boolean;
  /** Cluster tap → config modal (interim: EditSessionParamsModal). */
  onOpenConfig: () => void;
  /** MCP chip tap → the per-server MCP status modal (interim; see file docstring). */
  onOpenMcpDetail?: () => void;
}

type Level = 0 | 1 | 2 | 3 | 4;
const MAX_LEVEL: Level = 4;

/**
 * Pure, layout-free renderer for the chips at a given ladder `level` — exported so
 * the overflow ladder + disconnected states are unit-testable without real layout
 * (jsdom reports zero for scrollWidth/clientWidth).
 */
export function SessionConfigChips(props: {
  level: Level;
  permissionLabel: string;
  permissionTone: PermissionModeTone;
  modelLabel: string;
  effortLabel?: string;
  /** Issue #3769 (R5): the effort suffix is the model DEFAULT (nothing pinned) —
   *  render it muted as "High (default)" rather than a fabricated pinned "· High". */
  effortIsDefault?: boolean;
  modelDowngraded?: boolean;
  accountEmail?: string;
  /** Resolved account nickname (container: `useAccountLabel`); falls back to the
   *  email local part inside `AccountChip`. */
  accountLabel?: string;
  /** Resolved monogram override (container: `useAccountMonogram`) — issue #3621. */
  accountMonogram?: AccountMonogram;
  mcp: McpChipCounts;
  disconnected?: boolean;
  disabled?: boolean;
  onOpenMcpDetail?: () => void;
  chipsRef?: React.Ref<HTMLDivElement>;
}) {
  const {
    level,
    permissionLabel,
    permissionTone,
    modelLabel,
    effortLabel,
    effortIsDefault,
    modelDowngraded,
    accountEmail,
    accountLabel,
    accountMonogram,
    mcp,
    disconnected,
    disabled,
    onOpenMcpDetail,
    chipsRef,
  } = props;

  const dashed = disconnected ? "border-dashed" : "";
  const fmt = formatMcp(mcp);

  return (
    <div
      ref={chipsRef}
      className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden"
    >
      {/* Permission Mode */}
      <span className={`${CHIP_BASE} ${TONE_BOX[permissionTone]} ${dashed}`}>
        {permissionLabel}
      </span>

      {/* Model (+ Effort suffix, dropped at L1) */}
      <span
        className={`${CHIP_BASE} ${modelDowngraded ? MODEL_BOX_DOWNGRADED : MODEL_BOX_NORMAL} ${dashed}`}
      >
        {modelLabel}
        {effortLabel && level < 1 ? (
          // Issue #3769 (R5): a pinned effort renders "· High"; the model default
          // renders a muted "· High (default)" with an aria hint — never blank
          // (#2506 D1a), never a fabricated pinned level.
          <span
            className={effortIsDefault ? "opacity-60" : "opacity-80"}
            {...(effortIsDefault
              ? { "aria-label": `Default effort: ${effortLabel}` }
              : {})}
          >
            · {effortLabel}
            {effortIsDefault ? " (default)" : ""}
          </span>
        ) : null}
      </span>

      {/* Account (monogram + name; monogram-only at L1; gone at L3) — the SHARED
          entity chip (epic #3285 correction pass 1), byte-identical to the Row-1
          Account Badge in the Session Basic Info Bar. */}
      {accountEmail && level < 3 ? (
        // shrink-0: AccountChip is `min-w-0` (so its nickname can ellipsize in
        // the Row-1 badge's fixed cell). Here that made it the one chip that
        // could shrink, so it absorbed the overflow and squeezed its monogram
        // out over the MCP chip while the track still measured as "fits".
        // Unshrinkable, a shortfall surfaces as track overflow and the ladder
        // steps down instead.
        <AccountChip
          email={accountEmail}
          label={accountLabel}
          monogram={accountMonogram}
          compact={level >= 1}
          dashed={Boolean(disconnected)}
          className="shrink-0"
        />
      ) : null}

      {/* MCP chip — `MCP a·b·c` (L2 → worst-color total; gone at L4). Optional
          per-server detail tap (stopPropagation so the cluster tap doesn't also
          fire). */}
      {level < 4 ? (
        <BareButton
          type="button"
          disabled={disabled}
          onMouseDown={(e: ReactMouseEvent) => e.preventDefault()}
          onClick={(e: ReactMouseEvent) => {
            if (!onOpenMcpDetail) return;
            e.stopPropagation();
            onOpenMcpDetail();
          }}
          title="MCP servers"
          className={`inline-flex items-center justify-center whitespace-nowrap rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-1.5 py-0.5 text-[length:var(--text-caption-xs)] font-semibold tabular-nums text-[var(--app-hint)] ${dashed}`}
        >
          <span className="mr-1">MCP</span>
          {level < 2 ? (
            <>
              <b className={`font-bold ${countTone(fmt.connected, "ok")}`}>
                {fmt.connected}
              </b>
              <span className="text-[var(--app-hint)]">·</span>
              <b className={`font-bold ${countTone(fmt.attention, "warn")}`}>
                {fmt.attention}
              </b>
              <span className="text-[var(--app-hint)]">·</span>
              <b className={`font-bold ${countTone(fmt.failed, "hot")}`}>
                {fmt.failed}
              </b>
            </>
          ) : (
            <b className={`font-bold ${COUNT_TONE_CLS[fmt.worstTone]}`}>
              {fmt.total}
            </b>
          )}
        </BareButton>
      ) : null}
    </div>
  );
}

/**
 * True when the chips do not fit the track. Two signals:
 * - the track itself overflows (scrollWidth past clientWidth), or
 * - a chip's content overflows the chip's own box. Every chip is unshrinkable
 *   today (the Account chip via `shrink-0` above), so this is a backstop: a chip
 *   that can shrink absorbs the overflow by narrowing, the track then still
 *   "fits", and its content spills over its neighbour (the NF monogram over the
 *   MCP chip, 2026-10-06). It does not catch a squeeze that only eats the chip's
 *   end padding, which is why the chips must stay unshrinkable.
 */
export function chipsOverflow(track: HTMLElement): boolean {
  if (track.scrollWidth > track.clientWidth + 1) return true;
  for (const chip of Array.from(track.children)) {
    if (chip.scrollWidth > chip.clientWidth + 1) return true;
  }
  return false;
}

/**
 * ResizeObserver-driven overflow ladder (R3, OR-4). Measures the `.chips` track
 * (see `chipsOverflow`) and steps DOWN (0 → 1 → 2 → 3) until the chips fit; a
 * resize resets to 0 (rAF-guarded) so the ladder re-evaluates from scratch on
 * width change. Steady-state cost is a few integer reads per render; no thrash
 * while idle.
 */
function useOverflowLadder(measureKey: string): {
  chipsRef: React.RefObject<HTMLDivElement | null>;
  level: Level;
} {
  const chipsRef = useRef<HTMLDivElement | null>(null);
  const [level, setLevel] = useState<Level>(0);
  const rafRef = useRef<number | null>(null);

  // Content changed → re-evaluate from full so the ladder can expand back when
  // the content shrinks (e.g. the MCP count drops), not just collapse further.
  useLayoutEffect(() => {
    setLevel(0);
  }, [measureKey]);

  // Step down while the current level overflows. Keyed on [level, measureKey]:
  // each step-down re-runs this and either steps again or settles when it fits.
  // Cheap (a few integer reads) and convergent (bounded by MAX_LEVEL).
  useLayoutEffect(() => {
    const el = chipsRef.current;
    if (!el) return;
    if (chipsOverflow(el)) {
      setLevel(prev => (prev < MAX_LEVEL ? ((prev + 1) as Level) : prev));
    }
  }, [level, measureKey]);

  useEffect(() => {
    const el = chipsRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (rafRef.current != null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        // Reset to full; the layout effect re-collapses to the fitting level.
        setLevel(0);
      });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return { chipsRef, level };
}

export function SessionConfigCluster(props: SessionConfigClusterProps) {
  const {
    permissionMode,
    agentFlavor,
    modelMode,
    resolvedModel,
    rawModel,
    nativeModel,
    effort,
    modelDowngraded,
    accountEmail,
    apiKeyName,
    projectDir,
    disconnected,
    disabled,
    onOpenConfig,
    onOpenMcpDetail,
  } = props;
  const mcpStatus = useMcpStatus(projectDir);
  // Account nickname for the chip (nickname → displayName → local part).
  const { api } = useAppContext();
  const accountLabel = useAccountLabel(api, accountEmail);
  const accountMonogram = useAccountMonogram(api, accountEmail);
  // Issue #4568: the chip's identity — the account, else (an API-key session)
  // the key under the shared key identity. A key carries no nickname/monogram.
  const chipEmail =
    accountEmail ?? (apiKeyName ? API_KEY_CHIP_IDENTITY : undefined);
  const chipLabel = accountEmail ? accountLabel : apiKeyName;
  const chipMonogram = accountEmail ? accountMonogram : undefined;
  // Issue #2506 F2 — to show the default effort ONLY when the effective model
  // supports reasoning effort (Haiku has none), read the catalog. `enabled:false`
  // returns FALLBACK_CLAUDE_MODELS without an eager fetch; the fallback correctly
  // encodes the no-effort families, so no network round-trip is added here.
  const { models: catalogModels } = useClaudeModels(api, { enabled: false });

  // Derive display strings here (kept out of the pure chip renderer).
  const displayPermissionMode: PermissionMode =
    isPermissionModeAllowedForFlavor(permissionMode, agentFlavor)
      ? permissionMode
      : "default";
  const permissionLabel = getPermissionModeLabel(displayPermissionMode);
  const permissionTone = getPermissionModeTone(displayPermissionMode);
  const modelLabel = rawModel
    ? formatModelName(rawModel)
    : resolvedModel
      ? formatModelName(resolvedModel)
      : // #3348: a non-claude session's active model (gemini/codex) comes from
        // the recorded spawn selection; shown raw (the ids aren't claude-pattern).
        nativeModel
        ? nativeModel
        : (MODEL_MODE_LABELS[modelMode] ?? modelMode ?? "default");
  // Issue #2506 F2 — the effort suffix must never simply vanish. When no effort
  // is pinned, fall back to Hapimatic's asserted default effort (DISPLAY-ONLY,
  // D1a) so the chip reads e.g. "Opus 4.8 · High" instead of dropping the suffix
  // — BUT only when the effective model actually supports reasoning effort, so a
  // no-effort model (Haiku) shows no fabricated level.
  const modelSupportsEffort =
    effortLevelsForCurrent(modelMode, resolvedModel, rawModel, catalogModels)
      .length > 0;
  const effortLabel =
    effort && EFFORT_LEVELS.includes(effort)
      ? COMPACT_EFFORT_LABELS[effort]
      : modelSupportsEffort
        ? COMPACT_EFFORT_LABELS[DEFAULT_EFFORT_LEVEL]
        : undefined;
  // Issue #3769 (R5): the suffix is the MODEL DEFAULT (nothing pinned) when no
  // effort is pinned but the model supports effort. The chip renders it as a
  // muted "High (default)" — never a fabricated pinned "· High" (#2506 D1a binds:
  // the default must be shown, but marked AS a default).
  const effortIsDefault =
    !(effort && EFFORT_LEVELS.includes(effort)) && modelSupportsEffort;

  // Width-affecting content — the ladder re-evaluates whenever this changes. The
  // default variant renders " (default)", so include it in the measure key
  // (#3769: level 0 gets longer than the plain pinned label).
  const measureKey = `${permissionLabel}|${modelLabel}|${effortLabel ?? ""}${effortIsDefault ? " (default)" : ""}|${chipEmail ?? ""}${chipLabel ?? ""}|${mcpStatus.connectedCount}|${mcpStatus.hostedCount}|${mcpStatus.needsAuthCount}|${mcpStatus.failedCount}`;
  const { chipsRef, level } = useOverflowLadder(measureKey);

  const handleOpenMcpDetail = () => {
    // Refresh on open if the cache is stale (mirrors the old StatusBar trigger).
    if (shouldRefreshMcpStatus(mcpStatus.checkedAt)) mcpStatus.refresh();
    onOpenMcpDetail?.();
  };

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpenConfig();
    }
  };

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label="Session configuration"
      aria-disabled={disabled || undefined}
      onClick={() => {
        if (!disabled) onOpenConfig();
      }}
      onKeyDown={handleKeyDown}
      className={`flex min-w-0 flex-1 items-center gap-1 rounded-md ${
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
      } focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-link)]`}
    >
      <SessionConfigChips
        level={level}
        chipsRef={chipsRef}
        permissionLabel={permissionLabel}
        permissionTone={permissionTone}
        modelLabel={modelLabel}
        effortLabel={effortLabel}
        effortIsDefault={effortIsDefault}
        modelDowngraded={modelDowngraded}
        accountEmail={chipEmail}
        accountLabel={chipLabel}
        accountMonogram={chipMonogram}
        mcp={mcpStatus}
        disconnected={disconnected}
        disabled={disabled}
        onOpenMcpDetail={onOpenMcpDetail ? handleOpenMcpDetail : undefined}
      />
    </div>
  );
}
