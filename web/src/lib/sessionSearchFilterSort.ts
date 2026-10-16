// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Pure session search / filter / sort helpers (issue #942).
 *
 * React-free and dependency-light by design: this module only knows how to
 * narrow a flat `SessionSummary[]` by the user's search/filter preferences and
 * how to build a root-ordering comparator. Grouping and tree-nesting stay in
 * `SessionList.tsx` (see `groupSessionsByProject` / `treeSortSessions`); keeping
 * this module pure makes it trivially unit-testable and keeps the router wiring
 * thin.
 */
import { LOCAL_NODE_ID } from "@hapi/protocol";
import type { SessionSummary } from "@hapi/protocol";
import type { SearchFilterPreferences } from "@hapi/protocol/schemas";
import { isClaudeFlavor } from "@/hooks/queries/useSessionAccountEmail";
import type { HeartbeatConfig, ScheduledTask } from "@/types/api";

/** Stable empty resolved-account map so the default 2-arg call keeps a stable
 *  identity (avoids re-running the memoized filter on every render). */
const EMPTY_RESOLVED: ReadonlyMap<string, string | undefined> = new Map();

/**
 * Normalize one side of a search comparison: case-fold, and drop U+FE0F
 * (VARIATION SELECTOR-16). An emoji picker may store "☀️" (with the selector)
 * while a keyboard types "☀" (without it), or the reverse; the selector carries
 * no meaning for matching, so stripping it on BOTH sides makes an emoji typed
 * into the search box find the session that carries it. Other sequence
 * joiners (U+200D) are kept: "👨‍💻" must not match a bare "👨".
 */
export function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/️/g, "");
}

/** True when any string in `haystacks` contains the (already normalized) query. */
function anyIncludes(
  haystacks: ReadonlyArray<string | null | undefined>,
  query: string
): boolean {
  return haystacks.some(
    v => typeof v === "string" && normalizeSearchText(v).includes(query)
  );
}

/**
 * Classify a session into its bound-account bucket for the Account filter
 * (#3810 Phase A). Exported so the option-derivation hook
 * (`useSessionFilterOptions`) and the predicate below use the IDENTICAL rule —
 * a stored `filters.account = <email>` then matches node-default rows too.
 *
 * Resolution order mirrors `useSessionAccountEmail` (the ONE account rule,
 * epic #3285 round 15) so the four account surfaces cannot disagree:
 *   1. non-Claude flavor (`!isClaudeFlavor`) → `"unassigned"`. `claudeAccount`
 *      is stamped for EVERY flavor by `buildSessionMetadata`, so an ungated read
 *      would file a codex/gemini session under an Anthropic email — the flavor
 *      gate is mandatory until Phase B (#3351). [ER 2026-09-19: 3810-3]
 *   2. a recorded `claudeAccount.email` → that email.
 *   3. else a node-default row → the node's active account
 *      (`resolved.get(s.nodeId ?? LOCAL_NODE_ID)`). [ER 2026-09-19: 3810-4]
 *   4. still unresolved → `"unassigned"`.
 *
 * `resolved` maps a session's node id → the node's active-account email; the
 * predicate stays pure by taking it as an argument (never resolving async
 * inside). [ER 2026-09-19: NEW-3810-10]
 */
export function classifyAccount(
  s: SessionSummary,
  resolved: ReadonlyMap<string, string | undefined>
): string {
  // Phase B (#3810 Task 5): once #3351's per-session auth binding is present it
  // is the identity for EVERY flavor — the account email (subscription-account),
  // the #1955 vault-key LABEL (api-key/gateway-key, which have no email), or the
  // literal "Host default" (inherited). [ER 2026-09-19: 3810-5]
  const binding = s.metadata?.authBinding;
  if (binding) return binding.displayIdentity;
  // Phase A fallback for legacy rows WITHOUT an auth binding: the flavor-gated,
  // node-resolved Claude classification. [ER 2026-09-19: 3810-3 / 3810-4]
  if (!isClaudeFlavor(s.metadata?.flavor)) return "unassigned";
  const recorded = s.metadata?.claudeAccount?.email;
  if (recorded) return recorded;
  const nodeEmail = resolved.get(s.nodeId ?? LOCAL_NODE_ID);
  if (nodeEmail) return nodeEmail;
  return "unassigned";
}

/**
 * Filter a flat session list by the active search text + filter selections.
 *
 * - Search is a case-insensitive substring match across session name, linked
 *   issue title, branch label, project path, session tag, and the session's
 *   emoji (OR logic — any field matching keeps the session). The emoji field
 *   is what makes "drop the emoji into the search box" work: an operator marks
 *   sessions with an emoji as a status note, then types that emoji to find
 *   them. Comparison goes through `normalizeSearchText` (variation-selector
 *   insensitive) on both sides.
 * - Each filter category narrows conjunctively (AND across categories). A
 *   category set to "all" is a no-op.
 *
 * Order-independent — safe to run BEFORE grouping (empty groups vanish because
 * `groupSessionsByProject` only emits groups that contain sessions).
 *
 * `resolvedNodeAccounts` (#3810) is the nodeId → active-account-email map the
 * Account predicate needs; it is passed IN so the function stays pure (the async
 * per-node resolution lives in `useNodeActiveAccounts`). Defaults to an empty
 * map so the account filter is a no-op unless the caller supplies it.
 */
export function applySessionSearchFilter(
  sessions: SessionSummary[],
  prefs: SearchFilterPreferences,
  resolvedNodeAccounts: ReadonlyMap<string, string | undefined> = EMPTY_RESOLVED
): SessionSummary[] {
  const query = normalizeSearchText(prefs.searchText.trim());
  const f = prefs.filters;

  return sessions.filter(s => {
    // Search (OR across fields)
    if (query) {
      const matches = anyIncludes(
        [
          s.metadata?.name,
          s.linkedIssue?.title,
          s.branchLabel,
          s.metadata?.path,
          s.tag,
          s.emoji,
        ],
        query
      );
      if (!matches) return false;
    }

    // Status
    if (f.status === "active" && !s.active) return false;
    if (f.status === "inactive" && s.active) return false;

    // Type (scheduler-origin sessions carry source "scheduler" | "heartbeat")
    const isScheduler =
      s.metadata?.source === "scheduler" || s.metadata?.source === "heartbeat";
    if (f.type === "scheduler" && !isScheduler) return false;
    if (f.type === "standard" && isScheduler) return false;

    // Project (repo identity present = repo, absent = directory-only)
    const isRepo = Boolean(s.metadata?.repoIdentity);
    if (f.project === "repo" && !isRepo) return false;
    if (f.project === "directory" && isRepo) return false;

    // Node (exact nodeId match; "all" is a no-op)
    if (f.node !== "all" && s.nodeId !== f.node) return false;

    // Harness (session flavor; "all" is a no-op) — #3810 Phase A. Options come
    // from the flavors PRESENT in the list, so a tier-2 flavor is its own option
    // and this never filters against "unknown".
    if (f.harness !== "all" && s.metadata?.flavor !== f.harness) return false;

    // Account (bound-account bucket; "all" is a no-op) — #3810 Phase A. Uses the
    // SAME classifyAccount as the option list, so the stored value matches
    // node-default rows too.
    if (
      f.account !== "all" &&
      classifyAccount(s, resolvedNodeAccounts) !== f.account
    )
      return false;

    // Provider (auth-binding provider id; "all" is a no-op) — #3810 Phase B.
    // Options come from the providerIds PRESENT in the list.
    if (
      f.provider !== "all" &&
      s.metadata?.authBinding?.providerId !== f.provider
    )
      return false;

    // Review (needsReviewOverride: "unread" = needs review, "read" = read)
    if (f.review === "needsReview" && s.needsReviewOverride !== "unread")
      return false;
    if (f.review === "read" && s.needsReviewOverride !== "read") return false;

    // Linked issue
    const hasIssue = Boolean(s.linkedIssue);
    if (f.linkedIssue === "hasIssue" && !hasIssue) return false;
    if (f.linkedIssue === "noIssue" && hasIssue) return false;

    return true;
  });
}

/** The scheduler-spawned session's schedule id, or undefined for any other session. */
function nestedScheduleId(s: SessionSummary): string | undefined {
  const sid = s.metadata?.scheduleId;
  return s.metadata?.source === "scheduler" && sid ? sid : undefined;
}

/**
 * Narrow the schedule rows that ride under the project headers by the active
 * search text. A schedule stays when the query matches its own name, emoji,
 * project directory, or cron expression, OR when one of `matchedSessions` (the
 * sessions that already passed `applySessionSearchFilter`) is a scheduled peer
 * nested under it — so an emoji typed to find a scheduled peer still reaches
 * that peer's row. The prompt text is deliberately NOT searched (sessions do
 * not search theirs either, and a long prompt would match almost any word).
 *
 * With no query the input array is returned as-is (same identity), so the
 * list's memoized grouping is undisturbed. Before this filter existed every
 * hub-local schedule attached to the list regardless of the query — unmatched
 * ones even spawned a synthetic project group — so any search surfaced the
 * schedulers instead of the sessions it matched.
 */
export function applyScheduleSearchFilter(
  schedules: ScheduledTask[] | undefined,
  prefs: SearchFilterPreferences,
  matchedSessions: ReadonlyArray<SessionSummary>
): ScheduledTask[] {
  const list = schedules ?? [];
  const query = normalizeSearchText(prefs.searchText.trim());
  if (!query) return list;
  const nestedIds = new Set<string>();
  for (const s of matchedSessions) {
    const sid = nestedScheduleId(s);
    if (sid) nestedIds.add(sid);
  }
  return list.filter(
    t =>
      nestedIds.has(t.id) ||
      anyIncludes(
        [t.name, t.emoji, t.projectDirectory, t.cronExpression],
        query
      )
  );
}

/**
 * Whether the heartbeat row should render under the active search text: with
 * no query always (when a config exists); with a query only when it matches
 * the literal word "heartbeat" or the heartbeat's session name, emoji, or
 * directory. Same motivation as `applyScheduleSearchFilter` — the heartbeat
 * row used to attach (and synthesize its project group) for any query.
 */
export function heartbeatMatchesSearch(
  config: HeartbeatConfig | null | undefined,
  prefs: SearchFilterPreferences
): boolean {
  if (!config) return false;
  const query = normalizeSearchText(prefs.searchText.trim());
  if (!query) return true;
  return anyIncludes(
    [
      "heartbeat",
      config.sessionName,
      config.sessionEmoji,
      config.sessionDirectory,
    ],
    query
  );
}

/**
 * Build a root-ordering comparator for the given sort field + direction.
 *
 * Used as the injected `rootComparator` for `treeSortSessions` /
 * `groupSessionsByProject` (issue #942 KD-2). The DEFAULT sort
 * (`updated` + `desc`) deliberately does NOT use this — the caller passes no
 * comparator so the existing `sessionPriorityCompare` (active/pending-first)
 * is preserved. Any non-default sort uses this pure comparator so e.g.
 * "Name A→Z" is purely alphabetical, not active-first-then-alphabetical.
 */
export function makeSessionComparator(
  sort: SearchFilterPreferences["sort"],
  direction: SearchFilterPreferences["sortDirection"]
): (a: SessionSummary, b: SessionSummary) => number {
  const dir = direction === "asc" ? 1 : -1;

  return (a, b) => {
    let cmp = 0;
    switch (sort) {
      case "updated":
        cmp = a.updatedAt - b.updatedAt;
        break;
      case "created":
        cmp = (a.createdAt ?? 0) - (b.createdAt ?? 0);
        break;
      case "name": {
        const an = (a.metadata?.name ?? "").toLowerCase();
        const bn = (b.metadata?.name ?? "").toLowerCase();
        cmp = an.localeCompare(bn);
        break;
      }
      case "timeLogged":
        cmp = (a.serverAccumulatedMs ?? 0) - (b.serverAccumulatedMs ?? 0);
        break;
    }
    return cmp * dir;
  };
}
