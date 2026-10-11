// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shared session metadata utility functions.
 * Used by SessionList, SessionHeader, and router to avoid duplicated logic.
 */
import {
  formatModelName,
  MODEL_MODE_LABELS,
  HARNESS_MANIFESTS,
  NATIVE_SESSION_ID_ABSENT,
  resolveNativeSessionIdAxis,
} from "@hapi/protocol";
import type {
  EffortLevel,
  HarnessManifest,
  ModelMode,
  NativeSessionIdAxis,
} from "@hapi/protocol";
import type { RecoveryStatus } from "@/types/api";
import { computeStaleness } from "@/hooks/useSessionStaleness";

/**
 * Minimal session shape accepted by utility functions.
 * Both `Session` and `SessionSummary` satisfy this interface.
 */
export type SessionLike = {
  id: string;
  modelMode?: ModelMode;
  resolvedModel?: string;
  /** Issue #2456: live reasoning-effort level + pinned raw model id. */
  effort?: EffortLevel;
  rawModel?: string;
  /** Issue #1509: resolved context window (from get_context_usage); used by isModelDowngraded. */
  contextWindowTokens?: number;
  metadata: {
    name?: string;
    path: string;
    summary?: { text: string };
    flavor?: string | null;
    /** #3811: the per-flavor native session ids. The `nativeSessionId` manifest
     *  descriptor names WHICH of these the flavor's id lives in (claude →
     *  claudeSessionId, codex → codexSessionId, gemini/opencode/ACP tier-2 →
     *  acpSessionId). Both `Session.metadata` (raw) and the list card's
     *  `SessionSummaryMetadata` carry these after the Task-2 projection. */
    claudeSessionId?: string;
    codexSessionId?: string;
    acpSessionId?: string;
    claudeAccount?: {
      email?: string;
      planLabel?: string;
      /** Issue #1509: Hapimatic-recorded entitlement ("max" | "pro" | ""). */
      subscriptionType?: string;
    };
    source?: "scheduler" | "heartbeat";
    scheduleKind?: "at" | "cron" | "every";
    scheduleId?: string;
    /** Durable effort / raw-model pins (Issue #2456) — the fallback the live
     *  `effort` / `rawModel` fields resolve to when the server's ephemeral
     *  record has been rebuilt without them (composer-chip pin integrity). */
    effort?: EffortLevel;
    rawModel?: string;
  } | null;
};

/**
 * Composer-chip pin integrity: the effective reasoning effort for display — the
 * live keepAlive value, else the durable metadata pin. The Session Configuration
 * modal already resolves effort this way (`session.effort ?? metadata.effort`);
 * the composer chip read only the live field, so the two disagreed whenever the
 * server rebuilt its ephemeral record (every store write) and the chip showed
 * the "High" display default for up to one keepAlive tick.
 */
export function getEffectiveEffort(
  session: SessionLike
): EffortLevel | undefined {
  return session.effort ?? session.metadata?.effort ?? undefined;
}

/**
 * Composer-chip pin integrity: the effective pinned raw model id — the live
 * keepAlive value, else the durable metadata pin. Same modal/chip asymmetry as
 * `getEffectiveEffort`: a create-page pin never populated the live field at
 * all, and an in-session pin survived only until the first record rebuild, so
 * the chip fell through to the PREVIOUS turn's `resolvedModel`.
 */
export function getEffectiveRawModel(session: SessionLike): string | undefined {
  return session.rawModel || session.metadata?.rawModel || undefined;
}

/**
 * Get the display title for a session.
 * Priority: name > summary text > last path segment > truncated ID
 */
export function getSessionTitle(session: SessionLike): string {
  if (session.metadata?.name) {
    return session.metadata.name;
  }
  if (session.metadata?.summary?.text) {
    return session.metadata.summary.text;
  }
  if (session.metadata?.path) {
    const parts = session.metadata.path.split("/").filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : session.id.slice(0, 8);
  }
  return session.id.slice(0, 8);
}

/**
 * Get the canonical HAPI short ID for a session.
 * Format: hapi-XXXXXXXX (first 8 chars of session ID)
 */
export function getHapiShortId(sessionId: string): string {
  return `hapi-${sessionId.slice(0, 8)}`;
}

/**
 * Resolve a session's harness-neutral native session id + its manifest descriptor
 * (issue #3811). Looks up the flavor's `nativeSessionId` descriptor (short label,
 * long description, and WHICH metadata field carries the id) via the browser-safe
 * static `HARNESS_MANIFESTS` import — no `api` plumbing, no loading state, because
 * the descriptor is static label data — then reads that field off the session's
 * metadata.
 *
 * A flavor that is NOT a key of the stock-4 map (a tier-2 CLI, e.g. `"cursor"`, or
 * an absent/unknown flavor) resolves to `NATIVE_SESSION_ID_ABSENT`, which the UI
 * renders as "Hapimatic short id only, no toggle" (R4). The single lookup is
 * `metadata[descriptor.field]`, so the component needs no per-flavor conditionals.
 */
export function resolveNativeSessionId(session: SessionLike): {
  descriptor: NativeSessionIdAxis;
  nativeId: string | undefined;
} {
  const flavor = session.metadata?.flavor?.trim()?.toLowerCase();
  // `HARNESS_MANIFESTS` is keyed by the stock-4 AgentFlavor; `flavor` may be a
  // tier-2 id absent from the map. The cast makes the runtime `undefined` explicit
  // (noUncheckedIndexedAccess is off, so a bare index would be mistyped non-null).
  const manifest = flavor
    ? (HARNESS_MANIFESTS as Record<string, HarnessManifest | undefined>)[flavor]
    : undefined;
  // Explicit annotation: NATIVE_SESSION_ID_ABSENT is `{ mode: "absent" }` (no
  // `field`), so without this the inferred union would reject `descriptor.field`.
  const descriptor: NativeSessionIdAxis = manifest
    ? resolveNativeSessionIdAxis(manifest)
    : NATIVE_SESSION_ID_ABSENT;
  const nativeId =
    descriptor.mode === "native" && descriptor.field
      ? session.metadata?.[descriptor.field]
      : undefined;
  return { descriptor, nativeId };
}

/**
 * Format a timestamp as relative time (e.g., "5m ago", "2h ago", "3d ago").
 * Handles both seconds and milliseconds timestamps.
 */
export function formatRelativeTime(value: number): string | null {
  const ms = value < 1_000_000_000_000 ? value * 1000 : value;
  if (!Number.isFinite(ms)) return null;
  const delta = Date.now() - ms;
  if (delta < 60_000) return "just now";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

/**
 * Compact relative time for the Session Basic Info Bar (issue #3287, R5) — the
 * "no ago" sibling of `formatRelativeTime`. Boundary spec: `<1m → "now"`,
 * minutes `12m`, hours `5h`, days `3d`, `≥7d →` short locale date (mirroring the
 * existing helper's `>7d` locale-date branch). Kept as a distinct helper (not a
 * rewrite of `formatRelativeTime`) because the verbose "…ago" form still has live
 * consumers (`SessionItem.tsx`), so the two forms must coexist.
 */
export function formatRelativeTimeCompact(value: number): string | null {
  const ms = value < 1_000_000_000_000 ? value * 1000 : value;
  if (!Number.isFinite(ms)) return null;
  const delta = Date.now() - ms;
  if (delta < 60_000) return "now";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(ms).toLocaleDateString();
}

/**
 * Get agent label from session metadata (e.g., "claude", "codex", "gemini").
 */
export function getAgentLabel(session: SessionLike): string {
  const flavor = session.metadata?.flavor?.trim();
  if (flavor) return flavor;
  return "unknown";
}

/**
 * Get a display-capitalized agent label (e.g. "Claude", "Codex", "Gemini",
 * "Unknown"). Issue #2455: the session-detail block renders the capitalized
 * form ("Claude:"), while `getAgentLabel` stays lowercase for any non-display
 * consumers (comparisons, keys) — a display-only sibling avoids mutating the
 * raw helper.
 */
export function getAgentDisplayLabel(session: SessionLike): string {
  const label = getAgentLabel(session);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * Full CLI product name for a session's agent flavor (e.g. "Claude Code",
 * "Codex", "Gemini", "OpenCode"). Issue #2882: the session-detail block's first
 * line renders `<CLI> <launcher>` (e.g. "Claude Code SDK"), so it needs the
 * full product name rather than the bare capitalized flavor ("Claude") that
 * `getAgentDisplayLabel` returns.
 *
 * The mapping mirrors `HARNESS_LABELS` in `routes/settings/about.tsx` (the About
 * page's harness enumeration) — kept as the single source of truth for these
 * strings. An unknown flavor falls back to `getAgentDisplayLabel` (capitalized
 * flavor) so a new harness still renders a sensible label.
 */
const CLI_DISPLAY_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini",
  opencode: "OpenCode",
};

export function getCliDisplayName(session: SessionLike): string {
  const flavor = session.metadata?.flavor?.trim()?.toLowerCase();
  if (flavor && CLI_DISPLAY_NAMES[flavor]) {
    return CLI_DISPLAY_NAMES[flavor];
  }
  return getAgentDisplayLabel(session);
}

/**
 * Display label for a session's launcher kind (e.g. "sdk" → "SDK", "pty" →
 * "PTY", "tmux" → "Tmux"). Issue #2882: the session-detail block's `CLI |
 * launcher` line renders this. Mirrors `LAUNCHER_OPTIONS` in
 * `NewSession/LauncherSelector.tsx`. An unknown/absent kind returns the raw
 * value (or `undefined` when absent) so a future launcher still renders.
 */
const LAUNCHER_DISPLAY_LABELS: Record<string, string> = {
  sdk: "SDK",
  pty: "PTY",
  tmux: "Tmux",
};

export function getLauncherDisplayLabel(kind?: string): string | undefined {
  if (!kind) return undefined;
  const normalized = kind.trim().toLowerCase();
  return LAUNCHER_DISPLAY_LABELS[normalized] ?? kind;
}

/**
 * Get model display label from session.
 * Prefers resolved model name via formatModelName(), falls back to mode label.
 */
export function getModelLabel(session: SessionLike): string {
  // Issue #2506 F1 — prefer the spawn-time pin (rawModel) so a full-catalog
  // selection is shown pre-resolution, matching the in-session composer chip
  // (SessionConfigCluster) and the model modal. Mirrors that surface's
  // rawModel → resolvedModel → mode-label order; the only live consumer is
  // SessionHandoffSection (a handoff-surface consistency fix).
  const rawModel = getEffectiveRawModel(session);
  if (rawModel) {
    return formatModelName(rawModel);
  }
  if (session.resolvedModel) {
    return formatModelName(session.resolvedModel);
  }
  return (
    MODEL_MODE_LABELS[session.modelMode ?? "default"] ??
    session.modelMode ??
    "default"
  );
}

/**
 * Issue #2455: the model picker's "Default" row shows what "default" currently
 * resolves to (e.g. "Default (Opus 4.6)") when a resolvedModel is known, so the
 * user sees the concrete model behind the default rather than a blind "Default".
 * Falls back to a bare "Default" before the first turn resolves a model.
 *
 * This is a PICKER-ROW concern only — `getModelLabel` (the collapsed display
 * label) is intentionally left unchanged.
 */
export function getDefaultModelResolutionLabel(session: SessionLike): string {
  if (session.resolvedModel) {
    return `Default (${formatModelName(session.resolvedModel)})`;
  }
  return "Default";
}

/**
 * Issue #1509 (G1) — detect a session silently running a downgraded /
 * below-entitlement model.
 *
 * The reliable signal is a TWO-SOURCE mismatch: Hapimatic's own recorded
 * entitlement (`claudeAccount.subscriptionType === "max"`) vs. the model Claude
 * actually resolved. We trust Hapimatic's record — NOT Claude's own
 * subscriptionType, which the #1446 OAuth-token-injection path hardcodes to
 * null, causing Max sessions to silently fall back to Sonnet/200k (see #1506).
 *
 * A deliberate Sonnet selection (`modelMode === "sonnet"`) is NOT a downgrade:
 * this issue targets *silent* downgrades, so an explicit user choice is excluded
 * to avoid a permanent false-positive warning.
 *
 * 🔁 Mirror predicate (server side): `isSessionModelDowngraded()` in
 * `server/src/sync/syncEngine.ts`. Keep the two in sync.
 */
export function isModelDowngraded(session: SessionLike): boolean {
  // Only Max accounts are entitled above Sonnet/200k — Pro/empty are not.
  if (session.metadata?.claudeAccount?.subscriptionType !== "max") {
    return false;
  }
  // Explicit Sonnet selection is intentional, not a silent downgrade.
  if (session.modelMode === "sonnet") {
    return false;
  }
  // Explicit Fable selection is likewise intentional (issue #1633) — and a
  // bare-fable 200k window must not flag a deliberate choice as a downgrade.
  if (session.modelMode === "fable") {
    return false;
  }
  const resolved = session.resolvedModel?.toLowerCase() ?? "";

  // #2882 iter AD — a PINNED model (rawModel, chosen via the model modal) is the
  // user's DELIBERATE choice, never a *silent* downgrade. This also removes the
  // red→green flash on model switch: when a switch is pending, resolvedModel /
  // contextWindowTokens still describe the PREVIOUS model (stale), so we default to
  // mint until the running model has SETTLED onto the pinned one — only then are the
  // resolved/window signals trustworthy (and still catch a genuinely capped window).
  const raw = getEffectiveRawModel(session)?.toLowerCase() ?? "";
  if (raw) {
    // An explicit sonnet/fable/haiku pin is a deliberate lower-tier choice (mirrors
    // the modelMode exclusions above) → never flagged as a silent downgrade.
    if (
      raw.includes("sonnet") ||
      raw.includes("fable") ||
      raw.includes("haiku")
    ) {
      return false;
    }
    // Higher-tier pin: evaluate only once the running model has settled onto it.
    const settled =
      resolved !== "" && (resolved.startsWith(raw) || raw.startsWith(resolved));
    if (!settled) return false;
  }

  const isSonnetFamily = resolved.includes("sonnet");
  const ctx = session.contextWindowTokens;
  const isBelowEntitlementWindow = ctx != null && ctx <= 200_000;
  return isSonnetFamily || isBelowEntitlementWindow;
}

/**
 * Get provider/plan label for display based on agent type.
 * - Claude: Shows plan from credentials (e.g., "Max 20X", "Claude Pro")
 * - Codex: Shows "OpenAI API"
 * - Gemini: Shows "Google AI"
 *
 * NOTE (issue #2455): this helper is currently UNUSED by production code — the
 * session-detail block dropped the plan/provider line (account info now lives in
 * the account modal). Retained (with its tests) as a ready display helper should
 * a future surface want the provider/plan label again.
 */
export function getProviderLabel(session: SessionLike): string | undefined {
  const flavor = session.metadata?.flavor?.trim()?.toLowerCase();

  if (flavor === "claude" || !flavor) {
    return session.metadata?.claudeAccount?.planLabel;
  }
  if (flavor === "codex") {
    return "OpenAI API";
  }
  if (flavor === "gemini") {
    return "Google AI";
  }
  return undefined;
}

/**
 * The account email RECORDED on a Claude session at spawn (undefined for
 * Codex/Gemini, and for a Claude session that recorded none).
 *
 * This is the raw recorded value, NOT what the UI should display. Every account
 * DISPLAY surface (list badge, header badge, Session Configuration modal, and
 * the prompt-box Session Config Cluster) reads `useSessionAccountEmail`
 * (`@/hooks/queries/useSessionAccountEmail`), which falls back to the
 * session's node's active account when nothing was recorded (epic #3285
 * round 15). Reach for this helper only when you specifically need the
 * recorded value (e.g. grouping sessions by the account they are bound to).
 */
export function getAccountEmail(session: SessionLike): string | undefined {
  const flavor = session.metadata?.flavor?.trim()?.toLowerCase();

  if (flavor === "claude" || !flavor) {
    return session.metadata?.claudeAccount?.email;
  }
  return undefined;
}

/**
 * Extract owner/repo from a GitHub URL.
 * e.g., "https://github.com/MattStarfield/genai-playground" -> "MattStarfield/genai-playground"
 */
export function extractOwnerRepo(githubUrl: string): string | null {
  const match = githubUrl.match(/github\.com\/([^/]+\/[^/]+)/);
  return match ? match[1] : null;
}

// ── Session Type Categorization ─────────────────────────────────────

export type SessionTypeKey = "standard" | "scheduled" | "manager" | "schedule";

export type SessionTypeInfo = {
  key: SessionTypeKey;
  label: string;
  emoji: string;
  /** Tailwind badge text color class */
  badgeTextClass: string;
  /** Tailwind badge background class (with opacity) */
  badgeBgClass: string;
  /** Tailwind background tint for session header bar (very subtle) */
  headerTintClass: string;
  /** Tailwind left border accent class */
  borderLeftClass: string;
  /** CSS color value for hover background */
  hoverBg: string;
};

const SESSION_TYPES: Record<SessionTypeKey, SessionTypeInfo> = {
  standard: {
    key: "standard",
    label: "standard",
    emoji: "👤",
    badgeTextClass: "text-gray-400",
    // Round 14 follow-up: type pills mix against `--chip-base` (tokens.css) so they
    // are opaque inside the session list and a tinted row cannot bleed through.
    badgeBgClass:
      "bg-[color-mix(in_srgb,var(--color-gray-500)_20%,var(--chip-base))]",
    headerTintClass: "", // no tint for standard
    borderLeftClass: "border-l-gray-500/40",
    hoverBg: "var(--app-subtle-bg)",
  },
  scheduled: {
    key: "scheduled",
    label: "scheduled",
    emoji: "📅",
    badgeTextClass: "text-blue-400",
    badgeBgClass:
      "bg-[color-mix(in_srgb,var(--color-blue-400)_20%,var(--chip-base))]",
    headerTintClass: "bg-blue-900/20",
    borderLeftClass: "border-l-blue-400",
    hoverBg: "rgba(96, 165, 250, 0.15)",
  },
  manager: {
    key: "manager",
    label: "manager",
    emoji: "👑",
    badgeTextClass: "text-amber-400",
    badgeBgClass:
      "bg-[color-mix(in_srgb,var(--color-amber-500)_20%,var(--chip-base))]",
    headerTintClass: "bg-amber-950/20",
    borderLeftClass: "border-l-amber-500/60",
    hoverBg: "rgba(245, 158, 11, 0.15)",
  },
  schedule: {
    key: "schedule",
    label: "schedule",
    emoji: "📅",
    badgeTextClass: "text-blue-300",
    badgeBgClass:
      "bg-[color-mix(in_srgb,var(--color-blue-800)_20%,var(--chip-base))]",
    headerTintClass: "bg-blue-950/20",
    borderLeftClass: "border-l-blue-800",
    hoverBg: "rgba(30, 64, 175, 0.15)",
  },
};

/**
 * Determine the session type category from metadata.
 * Returns visual info (label, emoji, colors) for badge + header tint.
 * Both "scheduler" and "heartbeat" sources map to the unified "scheduled" badge.
 */
export function getSessionTypeInfo(session: SessionLike): SessionTypeInfo {
  const source = session.metadata?.source;
  if (source === "heartbeat" || source === "scheduler") {
    return SESSION_TYPES.scheduled;
  }
  return SESSION_TYPES.standard;
}

/** Scheduled type info constant — for sessions spawned by schedules (blue badge). */
export const SCHEDULED_TYPE_INFO: SessionTypeInfo = SESSION_TYPES.scheduled;

/** Schedule list-item type info — for schedule entries in the unified list (violet badge). */
export const SCHEDULE_LIST_ITEM_TYPE_INFO: SessionTypeInfo =
  SESSION_TYPES.schedule;

// ── Status Category Aggregation ─────────────────────────────────────

export type StatusCategory = "green" | "blue" | "orange" | "gray";

/**
 * Categorize a session into a status color bucket for toolbar aggregation.
 * Priority matches getStatusDotClass() in RecoveryStatusBadge.tsx.
 */
export function getSessionStatusCategory(
  session: {
    active: boolean;
    thinking: boolean;
    activeAt: number;
    recoveryStatus?: RecoveryStatus;
    isWaitingForUserQuestion: boolean;
    // Issue #1647: rate-limited (429 session limit) — present when the session
    // is waiting for the quota window to reset.
    rateLimited?: {
      resetText: string;
      resetAt: number | null;
      since: number;
    } | null;
  },
  needsReview: boolean
): StatusCategory {
  if (
    session.recoveryStatus === "recovering" ||
    session.recoveryStatus === "failed"
  )
    return "orange";
  if (!session.active) return "gray";
  // Issue #1647: rate-limited ranks above thinking (matches getStatusDotClass).
  // Bucketed as "orange" (attention) for toolbar aggregation; the per-session
  // dot renders a distinct violet via getStatusDotClass.
  if (session.rateLimited) return "orange";
  if (session.isWaitingForUserQuestion) return "orange";
  if (session.thinking) {
    const staleness = computeStaleness(
      session.thinking,
      session.activeAt,
      session.active
    );
    if (staleness === "unresponsive") return "gray";
    if (staleness === "stale") return "orange";
    return "blue";
  }
  if (needsReview) return "orange";
  return "green";
}

/**
 * Per-status-category counts (the toolbar's orange / blue / green / gray
 * buckets). Issue #2900.
 */
export type StatusBreakdown = Record<StatusCategory, number>;

/**
 * Issue #2900: aggregate a set of sessions into the four toolbar status buckets.
 *
 * This is the SINGLE categorization path shared by the toolbar total
 * (`router.tsx` `statusCounts`) and every per-surface `SessionCountBadge`
 * (always-on, #3133; on project groups, branch clusters, managed-peer clusters,
 * and scheduler-spawned sections). Because both derive from
 * `getSessionStatusCategory` with the same `needsReview` input, a badge and the
 * toolbar can never diverge — the reconciliation invariant (R4) holds by
 * construction.
 *
 * `needsReviewFor` supplies the per-session review flag (the toolbar threads
 * `checkNeedsReview(...)` through here); it is a callback so this helper stays
 * pure and side-effect-free.
 */
export function getStatusBreakdown<
  S extends Parameters<typeof getSessionStatusCategory>[0],
>(
  sessions: readonly S[],
  needsReviewFor: (session: S) => boolean
): StatusBreakdown {
  const counts: StatusBreakdown = { green: 0, blue: 0, orange: 0, gray: 0 };
  for (const s of sessions) {
    counts[getSessionStatusCategory(s, needsReviewFor(s))]++;
  }
  return counts;
}
