// SPDX-License-Identifier: AGPL-3.0-only
import { useState, useMemo, useCallback, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  RefreshCw,
  ChevronsDownUp,
  ChevronsUpDown,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { BareButton } from "@/components/ui/BareButton";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import {
  MenuHeader,
  MenuRadioSection,
  MenuTrigger,
} from "@/components/ui/menuPrimitives";
import { SortIcon, FilterIcon } from "@/components/icons";
import {
  SORT_MODES,
  DEFAULT_SORT_MODE,
  compareByMode,
  orderByCustom,
  getStoredSortMode,
  persistSortMode,
  getStoredSortDirection,
  persistSortDirection,
  getStoredCustomOrder,
  getStoredManualActive,
  persistManualActive,
  type SortMode,
  type SortDirection,
} from "@/lib/accountSort";
import {
  DEFAULT_FILTERS,
  CAPACITY_OPTIONS,
  filtersActive,
  matchesFilters,
  nodeOptions,
  getStoredFilters,
  persistFilters,
  type AccountFilters,
} from "@/lib/accountFilter";
import { AccountUsageCard } from "@/components/AccountUsage/AccountUsageCard";
import { AccountSelectorEmptyState } from "@/components/AccountSelectorEmptyState";
import { AddAccountWizard } from "@/components/AddAccountWizard";
import { useVisualViewportHeight } from "@/hooks/useVisualViewportHeight";
import { useAccounts } from "@/hooks/queries/useAccounts";
import { useAccountActions } from "@/hooks/mutations/useAccountActions";
import {
  useAccountUsage,
  useRefreshAccountUsage,
} from "@/hooks/queries/useAccountUsage";
import { queryKeys } from "@/lib/query-keys";
import { formatRelativeTime } from "@/lib/sessionHelpers";
import type { ApiClient } from "@/api/client";
import type { RedactedAccount } from "@/types/api";
import type { AccountUsage, ProviderId } from "@hapi/protocol";
import type { RedactedApiKey } from "@hapi/protocol/schemas";
import { API_KEY_STATUS_META, apiKeyDisplayName } from "@/lib/apiKeyStatus";

export type AccountSelectorModalProps = {
  isOpen: boolean;
  onClose: () => void;
  api: ApiClient | null;
  /**
   * "per-session" (default) targets the session; "per-node" targets the node
   * (Sub-Issue G); "spawn" is selection-only for the create page (#1496);
   * "stage" (epic #3285 round 14) is selection-only for an EXISTING session —
   * the Session Configuration Modal stages the pick in its draft and performs
   * the switch on "Apply changes", so no mutation and no confirm happen here.
   */
  scope?: "per-session" | "per-node" | "spawn" | "stage";
  /** Required when scope is "per-session". */
  sessionId?: string;
  /** Required when scope is "per-node". */
  nodeId?: string;
  /** per-session active account email — marks R12. Callers pass the RESOLVED
   *  email (`useSessionAccountEmail`, epic #3285 round 15), never the raw
   *  recorded value, so "Current" lands on the account the session runs on. */
  currentAccountEmail?: string;
  /**
   * #3290 (S5, R4): the session's CLI flavor. When non-Claude, EVERY account is
   * listed but greyed + unselectable (every stored account is a Claude account,
   * so none is compatible). Undefined / "claude" → normal selectable list.
   */
  sessionFlavor?: string | null;
  /**
   * Spawn scope (#1496): the create-form's currently-selected account uuid,
   * used to mark the "Current" row. The selection is local form state — no
   * session/node exists yet.
   */
  selectedAccountUuid?: string | null;
  /**
   * #3808 (R7 / Task 5): restrict the listed accounts to ONE provider. `GET
   * /api/accounts` now spans providers (anthropic | openai | google), so the modal
   * must offer only the accounts of the relevant provider — Anthropic for a switch,
   * and (Task 5) the chosen harness's provider for a spawn. Defaults to
   * `"anthropic"` (R7-safe: the modal historically only ever listed Claude
   * accounts). A row whose `provider` is absent reads as anthropic.
   */
  providerScope?: ProviderId;
  /**
   * Spawn scope (#1496): fired with the chosen account uuid when a row is
   * selected. The modal closes immediately and performs NO network mutation
   * (never setSessionAccount / setNodeActiveAccount).
   */
  onSelect?: (accountUuid: string) => void;
  /**
   * Issue #4568: the node's vault API keys (redacted view) offered in an
   * "API keys" section beside the Anthropic accounts. Rendered only when
   * `onSelectApiKey` is set and the scope's provider is anthropic; non-anthropic
   * keys are ignored. Keys never join the account list, so no account sort,
   * filter, score or auto-pick can ever reach one.
   */
  apiKeys?: RedactedApiKey[];
  /** Issue #4568: the key currently chosen as the credential ("Current" row). */
  selectedApiKeyId?: string | null;
  /**
   * Issue #4568: fired with the chosen key's vault id (never the key). Selection
   * only — the modal closes and performs no mutation. Its presence enables the
   * section (the create page today; #4823 adds the session-switch scope).
   */
  onSelectApiKey?: (apiKeyId: string) => void;
  /**
   * Issue #4823: when set, the "API keys" section still renders (so the operator
   * sees the keys exist) but EVERY key row is unselectable and this reason is
   * shown as the section's note — e.g. a PTY/tmux, remote or local-mode session,
   * which the server would refuse anyway.
   */
  apiKeysDisabledReason?: string;
};

/**
 * Issue #4568: the "API keys" section — one row per Anthropic vault key, named by
 * its label (else its masked form), with its validation status. A key whose last
 * probe was a definitive rejection (`invalid`) is greyed + unselectable, like an
 * `unrefreshable` account. Label-only by construction (redacted view).
 */
function ApiKeyRows({
  apiKeys,
  selectedApiKeyId,
  onSelect,
  disabledReason,
}: {
  apiKeys: RedactedApiKey[];
  selectedApiKeyId: string | null;
  onSelect: (apiKeyId: string) => void;
  /** #4823: every row unselectable, with this reason as the section note. */
  disabledReason?: string;
}) {
  return (
    <section
      data-testid="account-selector-api-keys"
      className="mt-3 flex shrink-0 flex-col gap-1.5 border-t border-[var(--app-border)] pt-3"
    >
      <h3 className="text-xs font-semibold text-[var(--app-fg)]">API keys</h3>
      <p className="text-[length:var(--text-caption-xs)] leading-snug text-[var(--app-hint)]">
        Billed per token to the key&apos;s owner. Claude Code only, on the SDK
        launcher. Use a workspace-scoped key — an organization-level Console key
        is rejected with &ldquo;not scoped to a workspace&rdquo;.
      </p>
      {disabledReason && (
        <p
          data-testid="account-selector-api-keys-disabled"
          className="text-[length:var(--text-caption-xs)] font-medium leading-snug text-[var(--app-fg)]"
        >
          {disabledReason}
        </p>
      )}
      {apiKeys.map(key => {
        const status =
          API_KEY_STATUS_META[key.status] ?? API_KEY_STATUS_META.none;
        const unselectable =
          key.status === "invalid" || Boolean(disabledReason);
        const isCurrent = key.id === selectedApiKeyId;
        const name = apiKeyDisplayName(key);
        return (
          <BareButton
            key={key.id}
            type="button"
            data-testid="account-selector-api-key-row"
            data-api-key-id={key.id}
            disabled={unselectable}
            onClick={() => onSelect(key.id)}
            aria-label={`API key ${name} (${key.maskedKey}) — ${status.label}${isCurrent ? " — current" : ""}`}
            className={`flex w-full min-w-0 items-center gap-2 rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 py-2 text-left text-sm text-[var(--app-fg)] hover:bg-[var(--app-hover)] disabled:cursor-not-allowed ${unselectable ? "opacity-50" : ""}`}
          >
            <span className="min-w-0 flex-1 truncate">{name}</span>
            <span className="shrink-0 font-mono text-xs text-[var(--app-hint)]">
              {key.maskedKey}
            </span>
            <span className="flex shrink-0 items-center gap-1 text-[length:var(--text-caption-xs)] text-[var(--app-hint)]">
              <span
                aria-hidden="true"
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: status.color }}
              />
              {status.label}
            </span>
            {isCurrent && (
              <span className="shrink-0 text-[length:var(--text-caption-xs)] font-medium text-[var(--app-accent)]">
                Current
              </span>
            )}
          </BareButton>
        );
      })}
    </section>
  );
}

/** Issue #4568 (D-4568-3 A): the kind tag on an OpenAI row in the picker. */
function openAiKindLabel(account: RedactedAccount): string | null {
  if ((account.provider ?? "anthropic") !== "openai") return null;
  if (account.authMode === "api-key") return "API key";
  if (account.authMode === "chatgpt") return "ChatGPT";
  return null;
}

type PendingAction =
  | { kind: "select"; account: RedactedAccount }
  // #1707: spawn-scope hard-confirm for an expired-but-not-yet-`unrefreshable`
  // ("stale") account. Selectable (unlike unrefreshable, which is
  // isUnselectable) but routed through a confirm so the user is warned the
  // spawn may fail. Hard-confirm (not hard-disable) preserves #1658's
  // deliberate keep-selectable behavior for the non-authoritative snapshot.
  | { kind: "confirm-stale-spawn"; account: RedactedAccount }
  | null;

/**
 * Account-switching modal (epic #1446, Sub-Issue H). Three states modelled as
 * the list (always rendered while open) plus two `ConfirmDialog` overlays driven
 * by a single `pendingAction` (D2). Scope-parameterized (D3) so Sub-Issue G
 * (#1453) reuses it with `scope="per-node"`. Focus trap / ESC / click-outside
 * come free from the Radix `Dialog` primitive (R10).
 */
export function AccountSelectorModal({
  isOpen,
  onClose,
  api,
  scope = "per-session",
  sessionId,
  nodeId,
  currentAccountEmail,
  sessionFlavor,
  selectedAccountUuid,
  providerScope,
  onSelect,
  apiKeys,
  selectedApiKeyId,
  onSelectApiKey,
  apiKeysDisabledReason,
}: AccountSelectorModalProps) {
  const { accounts: allAccounts, isLoading, error } = useAccounts(api, isOpen);

  // #3808 (R7): restrict the list to the target provider (default anthropic).
  // Every derived value below (the sorted list, the empty state, hasCards, the
  // spawn "Current" resolution) reads THIS scoped set, so a codex/gemini account
  // is never offered where an Anthropic account is expected. (absent ⇒ anthropic.)
  const targetProvider: ProviderId = providerScope ?? "anthropic";
  const accounts = useMemo(
    () =>
      allAccounts.filter(a => (a.provider ?? "anthropic") === targetProvider),
    [allAccounts, targetProvider]
  );

  // Issue #4568: the Anthropic vault keys this scope offers (only when a select
  // callback is wired and the target provider is anthropic).
  const offeredKeys = useMemo(
    () =>
      onSelectApiKey && targetProvider === "anthropic"
        ? (apiKeys ?? []).filter(k => k.provider === "anthropic")
        : [],
    [apiKeys, onSelectApiKey, targetProvider]
  );

  // #3290 (S5, R4): CLI-incompat greying. Every stored account is a Claude
  // account (RedactedAccount has no CLI/provider field), so a non-Claude session
  // can select NONE — the whole list renders greyed + unselectable.
  const cliIncompatible =
    sessionFlavor != null && sessionFlavor.toLowerCase() !== "claude";

  // #2134: visual-viewport-aware height cap. Radix ScrollArea never scrolled
  // under a `max-h-*` cap (its Root had no definite height, so the `h-full`
  // Viewport resolved to content height and clipped), and non-fullscreen
  // DialogContent has no height cap — together the list clipped at ~3 rows on
  // iPhone 16 with no way to reach the rest. DialogContent merges the caller's
  // `style`/`className`, so the cap + flex-column layout live here (native
  // `overflow-y-auto` on the list gives iOS momentum scrolling), keeping the
  // shared dialog/scroll-area primitives untouched.
  const vvHeight = useVisualViewportHeight();
  const { selectAccount, isPending } = useAccountActions(api, {
    sessionId: scope === "per-session" ? sessionId : undefined,
    nodeId: scope === "per-node" ? nodeId : undefined,
  });

  // #1896: per-account usage (epic #1855), joined to the account list by
  // accountUuid. `enabled = isOpen` mirrors useAccounts; a loading/errored
  // usage fetch is decorative and never blocks the select action below.
  const { usage, dataUpdatedAt } = useAccountUsage(api, isOpen);
  const usageByUuid = useMemo(() => {
    const m = new Map<string, AccountUsage>();
    for (const u of usage) m.set(u.accountUuid, u);
    return m;
  }, [usage]);

  // #1961: authoritative staleness signal. The store snapshot's `expiresAt`
  // (formerly read via isAccountExpired) is non-authoritative for non-host
  // accounts — it rots by design (#1635/#1658). The live usage probe, by
  // contrast, resolves the isolated-dir token FIRST (UsageService.resolveToken,
  // server/src/accounts/usageService.ts) — the SAME token the spawn uses — so
  // `usage.status` is authoritative: "ok" ⇒ the upstream endpoint accepted the
  // spawn token (demonstrably usable), "expired" ⇒ the spawn token is genuinely
  // expired/401-rejected (real staleness). An account is "stale" ONLY when its
  // live status is "expired" AND it is not already unrefreshable.
  //
  // #2281: this guarantee — the badge + spawn-confirm being structurally
  // incapable of firing on a USABLE account — is load-bearing on classify()
  // emitting "refreshing" (NOT "expired") for a refreshable token inside the
  // 5-min expiry buffer. Before #2281 classify() returned "expired" for that
  // transient case, so this predicate false-fired on a self-healing account (the
  // #1961 residual this issue fixed). If a future change re-conflates the
  // near-expiry-refreshable case back into "expired" at the source, this gate
  // silently regresses — keep "refreshing" and "expired" distinct there.
  const isStaleAccount = (account: RedactedAccount): boolean =>
    account.unrefreshable !== true &&
    usageByUuid.get(account.accountUuid)?.status === "expired";

  // #2056 (Sub-Issue G, R8 / D-G5): the reused AccountUsageCard renders from an
  // `AccountUsage` envelope, but the modal's authoritative list is the local-node
  // `RedactedAccount[]` from useAccounts — the two are not a guaranteed 1:1 set.
  // Join usage by uuid; when an account has no envelope (loading / errored /
  // absent) synthesize a minimal, type-valid DEGRADED envelope so the account
  // still lists and stays selectable. NEVER status:"expired" (it would trip the
  // #1961/#1707 stale hard-confirm if gating ever read it) — gating keys off the
  // RAW usageByUuid map above (isStaleAccount), never this synthesized object.
  const buildCardUsage = useCallback(
    (account: RedactedAccount): AccountUsage =>
      usageByUuid.get(account.accountUuid) ?? {
        accountUuid: account.accountUuid,
        email: account.emailAddress,
        displayLabel: account.displayName || account.emailAddress,
        machines: [],
        utilization: {},
        status: "error",
        fetchedAt: Date.now(),
        score: null,
      },
    [usageByUuid]
  );

  // Account sorting (2026-07-20): the modal shares the account-usage page's sort
  // preference — SAME port-scoped localStorage keys — so "Switch account" lists in
  // the order the user arranged on the Account Usage page, and a change made here
  // carries back to that page. Re-read on every open: this component stays mounted
  // across opens, so the useState initializers alone would go stale if the page
  // changed the preference in between. Custom applies the page's stored drag order
  // READ-ONLY (no dragging in the modal); other modes sort a COPY by each account's
  // usage envelope — accounts without one get the synthesized degraded envelope,
  // whose null sort keys land them at the end, in either direction.
  const [sortMode, setSortMode] = useState<SortMode>(() => getStoredSortMode());
  const [sortDirection, setSortDirection] = useState<SortDirection>(() =>
    getStoredSortDirection()
  );
  const [customOrder, setCustomOrder] = useState<string[]>(() =>
    getStoredCustomOrder()
  );
  // #3537: the shared device-local Manual flag. Read-only here (no dragging in the
  // modal) — when set, apply the page's stored drag order. Re-read on every open (this
  // component stays mounted across opens) so a Manual state entered on /account-usage
  // between opens is picked up, and a migrated pre-#3537 "custom" mode resolves to
  // Manual, not Pace (R10).
  const [manualActive, setManualActive] = useState(() =>
    getStoredManualActive()
  );
  // #3880: account filters — shared with /account-usage via the same port-scoped
  // localStorage key. Re-read on every open (this component stays mounted across opens)
  // so a filter set on that page between opens is picked up.
  const [filters, setFilters] = useState<AccountFilters>(() =>
    getStoredFilters()
  );
  useEffect(() => {
    if (isOpen) {
      setSortMode(getStoredSortMode());
      setSortDirection(getStoredSortDirection());
      setCustomOrder(getStoredCustomOrder());
      setManualActive(getStoredManualActive());
      setFilters(getStoredFilters());
    }
  }, [isOpen]);

  const onSortChange = useCallback((mode: SortMode) => {
    // #3537: picking a mode in the modal EXITS Manual on both surfaces (R8), so the
    // Manual ordering branch below can't silently override the chosen mode.
    setSortMode(mode);
    persistSortMode(mode);
    setManualActive(false);
    persistManualActive(false);
  }, []);

  const toggleSortDirection = useCallback(() => {
    const next: SortDirection = sortDirection === "asc" ? "desc" : "asc";
    setSortDirection(next);
    persistSortDirection(next);
  }, [sortDirection]);

  // #3880: set one filter dimension (merged), persisting the whole object.
  const onFilterChange = useCallback((patch: Partial<AccountFilters>) => {
    setFilters(prev => {
      const next = { ...prev, ...patch };
      persistFilters(next);
      return next;
    });
  }, []);
  const onClearFilters = useCallback(() => {
    setFilters({ ...DEFAULT_FILTERS });
    persistFilters({ ...DEFAULT_FILTERS });
  }, []);

  const sortedAccounts = useMemo(() => {
    // #3880: filter first (composes with sort), then order. matchesFilters reads the
    // same envelope buildCardUsage feeds the sort; a no-usage account's synthesized
    // degraded envelope is HIDDEN under an active capacity filter (R4).
    const filtered = accounts.filter(a =>
      matchesFilters(buildCardUsage(a), filters)
    );
    if (manualActive) {
      return orderByCustom(filtered, customOrder, a => a.accountUuid);
    }
    const cmp = compareByMode(sortMode, sortDirection);
    return [...filtered].sort((a, b) =>
      cmp(buildCardUsage(a), buildCardUsage(b))
    );
  }, [
    accounts,
    manualActive,
    sortMode,
    sortDirection,
    customOrder,
    buildCardUsage,
    filters,
  ]);

  // #1961 (Bug 1b): manual usage refresh. Reuses useRefreshAccountUsage
  // (`?force=1` real upstream refresh per #1909) and seeds the shared
  // accountUsage cache, so the usage bars AND the authoritative staleness signal
  // above both re-evaluate on completion.
  const refreshUsage = useRefreshAccountUsage(api);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const handleRefreshUsage = useCallback(async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      await refreshUsage();
    } finally {
      setIsRefreshing(false);
    }
  }, [isRefreshing, refreshUsage]);

  // "Updated Xs ago" for the header's refresh cluster — same indicator as the
  // account-usage page header (this modal mirrors that page's anatomy).
  const relUpdated =
    dataUpdatedAt > 0 ? formatRelativeTime(dataUpdatedAt) : null;

  // R12 (per-node): resolve the node's active account. The endpoint is owned by
  // Sub-Issue F (#1452) and 404s/501s until it ships — degrade to "none".
  const nodeActiveQuery = useQuery({
    queryKey: queryKeys.nodeActiveAccount(nodeId ?? "none"),
    queryFn: async () => {
      if (!api || !nodeId) {
        return { activeAccount: null };
      }
      try {
        return await api.getNodeActiveAccount(nodeId);
      } catch {
        return { activeAccount: null };
      }
    },
    enabled: Boolean(api && isOpen && scope === "per-node" && nodeId),
  });

  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [showHelp, setShowHelp] = useState(false);
  // Issue #1263: in-app web OAuth login wizard ("Add account").
  const [showAddWizard, setShowAddWizard] = useState(false);

  // Master expand/collapse-all for the account cards — mirrors the
  // account-usage page's header chevron. Each card owns its expanded state
  // internally (useState(defaultExpanded)), so toggling all is a remount via a
  // bumped key: the cards re-mount and read the new defaultExpanded.
  const [allExpanded, setAllExpanded] = useState(false);
  const [genId, setGenId] = useState(0);
  const toggleAll = useCallback(() => {
    setAllExpanded(v => !v);
    setGenId(g => g + 1);
  }, []);
  // The chevron is meaningful only when account cards are actually on screen.
  const hasCards = !isLoading && !error && !showHelp && accounts.length > 0;

  const activeEmail =
    scope === "per-node"
      ? (nodeActiveQuery.data?.activeAccount?.emailAddress ?? null)
      : scope === "spawn"
        ? (accounts.find(a => a.accountUuid === selectedAccountUuid)
            ?.emailAddress ?? null)
        : (currentAccountEmail ?? null);

  const handleClose = () => {
    setPendingAction(null);
    setShowHelp(false);
    setShowAddWizard(false);
    onClose();
  };

  const handleConfirmSelect = async () => {
    if (pendingAction?.kind !== "select") return;
    const accountUuid = pendingAction.account.accountUuid;
    // R4 + issue #1902: close the whole modal IMMEDIATELY (non-blocking), then
    // run the switch in the background. A spinner shows on the session's account
    // badge (SessionHeader) until the switch settles. selectMutation.onError
    // surfaces failures via Toast.
    handleClose();
    await selectAccount(accountUuid);
  };

  // #1707: spawn-scope stale-account confirm. Synchronous — spawn selection
  // performs NO network mutation (unlike handleConfirmSelect); it fires the
  // create-form onSelect and closes, mirroring the immediate spawn path.
  const handleConfirmStaleSpawn = () => {
    if (pendingAction?.kind !== "confirm-stale-spawn") return;
    onSelect?.(pendingAction.account.accountUuid);
    handleClose();
  };

  // #2056 (Sub-Issue G / KD3): the scope-specific select logic that used to live
  // inline on the retired row's `onSelect` prop. Kept in the modal (not the
  // reused card) so every accreted gate survives the rewire. The reused card fires
  // its `onSelect(uuid)` — we ignore the uuid and act on the RedactedAccount in
  // closure (the `unrefreshable` flag lives on RedactedAccount, not AccountUsage).
  const handleRowSelect = (account: RedactedAccount) => {
    // #3290 (S5): defense-in-depth — a CLI-incompatible session can select no
    // account (every row is greyed with no onSelect); guard anyway.
    if (cliIncompatible) return;
    // Spawn scope (#1496): selection-only — fire onSelect into create-form state
    // and close. Never enter selectAccount (it throws with no session/node target)
    // or the "select" confirm (its "restarts your session" copy is false pre-spawn).
    if (scope === "spawn") {
      // Defense-in-depth (D-G6): unrefreshable rows never receive `onSelect` (the
      // card renders opacity-50 with no select handler), but guard anyway so a
      // future caller change can't select a dead account.
      if (account.unrefreshable === true) return;
      // #1707 + #1961: hard-confirm before selecting an account whose live token
      // is genuinely expired. The AUTHORITATIVE signal is usage.status (via
      // isStaleAccount, keyed off the RAW usage map) — a usable account (status
      // "ok") is never confirmed. Keeps #1658's keep-selectable intent
      // (hard-confirm, not hard-disable).
      if (isStaleAccount(account)) {
        setPendingAction({ kind: "confirm-stale-spawn", account });
        return;
      }
      onSelect?.(account.accountUuid);
      handleClose();
      return;
    }
    // Stage scope (epic #3285 round 14, item 7): the Session Configuration
    // Modal owns the commit — it stages this pick in its draft and performs the
    // switch on "Apply changes" (its R8 impact copy carries the "relaunches the
    // session" warning the "select" confirm used to). So: onSelect + close, NO
    // mutation, NO confirm. Dead accounts stay unselectable (D-G6).
    if (scope === "stage") {
      if (account.unrefreshable === true) return;
      onSelect?.(account.accountUuid);
      handleClose();
      return;
    }
    setPendingAction({ kind: "select", account });
  };

  // Issue #4568: a key row is selection-only in every scope — fire the callback
  // with the vault id and close; no mutation, no confirm (the caller commits).
  const handleApiKeySelect = (apiKeyId: string) => {
    // #4823: a disabled keys group is unselectable even if a click slips through.
    if (cliIncompatible || apiKeysDisabledReason) return;
    onSelectApiKey?.(apiKeyId);
    handleClose();
  };

  const apiKeySection =
    offeredKeys.length > 0 && !showHelp ? (
      <ApiKeyRows
        apiKeys={offeredKeys}
        selectedApiKeyId={selectedApiKeyId ?? null}
        onSelect={handleApiKeySelect}
        disabledReason={apiKeysDisabledReason}
      />
    ) : null;

  const renderBody = () => {
    if (showHelp) {
      return (
        <AccountSelectorEmptyState
          showHelp
          onShowHelp={() => setShowHelp(true)}
          onHideHelp={() => setShowHelp(false)}
          onAddAccount={() => setShowAddWizard(true)}
        />
      );
    }
    if (isLoading) {
      return (
        <div className="p-6 text-center text-sm text-[var(--app-hint)]">
          Loading accounts…
        </div>
      );
    }
    if (error) {
      return (
        <div className="m-2 rounded-md bg-red-900/20 p-3 text-sm text-red-400">
          {error}
        </div>
      );
    }
    if (accounts.length === 0) {
      // Issue #4568: a key-only node still lists its keys under the empty state.
      return (
        <>
          <AccountSelectorEmptyState
            showHelp={false}
            onShowHelp={() => setShowHelp(true)}
            onHideHelp={() => setShowHelp(false)}
            onAddAccount={() => setShowAddWizard(true)}
          />
          {apiKeySection}
        </>
      );
    }
    return (
      <>
        {/* #3290 (S5): explain why every row is greyed for a non-Claude session. */}
        {cliIncompatible && (
          <div className="mx-2 mb-1 rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 py-2 text-xs text-[var(--app-hint)]">
            This CLI does not use switchable Claude accounts.
          </div>
        )}
        {/* #2134: native overflow-y-auto (iOS momentum) instead of Radix
            ScrollArea (its custom scrollbar is touch-none, poor on mobile).
            `min-h-0 flex-1` lets the list fill the remaining capped-dialog
            height and shrink below content so it actually scrolls; the header
            and footer stay pinned via `shrink-0`. */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col gap-2 pr-2">
            {sortedAccounts.map(account => {
              // #1658 / D-G6: unselectable only in spawn scope (spawn has no
              // server-side gate; switch's owning-node gate is authoritative).
              // An unselectable row gets NO select handler + opacity-50 —
              // expand/collapse is retained because the card's email button
              // falls back to its toggle role when `onSelect` is absent.
              const isUnselectable =
                ((scope === "spawn" || scope === "stage") &&
                  account.unrefreshable === true) ||
                cliIncompatible;
              // Issue #4568 (D-4568-3 A): name each Codex credential's kind.
              const kindLabel = openAiKindLabel(account);
              const card = (
                <AccountUsageCard
                  key={`${account.accountUuid}:${genId}`}
                  account={buildCardUsage(account)}
                  defaultExpanded={allExpanded}
                  disableSetActive
                  currentMarker={
                    Boolean(activeEmail) &&
                    !selectedApiKeyId &&
                    account.emailAddress === activeEmail
                  }
                  onSelect={
                    isUnselectable ? undefined : () => handleRowSelect(account)
                  }
                  className={isUnselectable ? "opacity-50" : undefined}
                />
              );
              if (!kindLabel) return card;
              return (
                <div
                  key={`${account.accountUuid}:${genId}`}
                  className="flex flex-col gap-0.5"
                >
                  <span
                    data-testid="account-kind-label"
                    className="px-1 text-[length:var(--text-caption-xs)] font-medium text-[var(--app-hint)]"
                  >
                    {kindLabel}
                  </span>
                  {card}
                </div>
              );
            })}
          </div>
          {apiKeySection}
        </div>
      </>
    );
  };

  return (
    <>
      <Dialog open={isOpen} onOpenChange={open => !open && handleClose()}>
        <DialogContent
          // The modal mirrors the account-usage page's anatomy: PAGE background
          // (--app-bg) so the --app-secondary-bg account cards contrast the same
          // way they do on that page (both were secondary-bg before — the cards
          // visually vanished into the modal), and an ~80%-viewport height cap
          // so the top edge (and the ✕) clears the iOS status bar / Dynamic
          // Island instead of riding up under it.
          // outline-none: with auto-focus prevented (below) Radix focuses the
          // container div itself, and the UA outline would ring the whole modal.
          className="flex flex-col overflow-hidden bg-[var(--app-bg)] outline-none"
          style={{ maxHeight: Math.round(vvHeight * 0.8) }}
          // The top-right ✕ is dropped in favor of the expand/collapse-all
          // chevron in that corner; the user dismisses via the bottom Cancel
          // button, a tap outside, or ESC (all → onOpenChange(false)).
          hideCloseButton
          // Radix auto-focuses the first focusable element on open — now the
          // header's refresh button, which paints a focus ring on every open.
          // Focus the dialog container instead; Tab still reaches all controls.
          onOpenAutoFocus={e => e.preventDefault()}
          {...(scope === "spawn" ? {} : { "aria-describedby": undefined })}
        >
          <DialogHeader className="shrink-0">
            <div className="flex items-center justify-between gap-2">
              <DialogTitle>
                {scope === "spawn" ? "Select account" : "Switch account"}
              </DialogTitle>
              {/* Right cluster — mirrors the account-usage page header:
                  "Updated Xs ago" + a manual usage refresh (#1961 Bug 1b) +
                  the master expand/collapse-all chevron in the corner (which
                  replaces the removed ✕). */}
              <div className="flex shrink-0 items-center gap-1">
                {relUpdated != null && (
                  <span className="hidden truncate text-[length:var(--text-caption)] font-normal text-[var(--app-hint)] sm:inline">
                    Updated {relUpdated}
                  </span>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={handleRefreshUsage}
                  disabled={isRefreshing}
                  aria-label="Refresh usage"
                  data-testid="account-selector-refresh"
                  className="h-7 w-7 text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)] disabled:opacity-60"
                >
                  <RefreshCw
                    className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`}
                    aria-hidden="true"
                  />
                </Button>
                {/* #3880: Filter menu — four independent, "all"-defaulted radio
                    dimensions (remaining 5h / weekly / Fable capacity + node), backed by
                    the AccountUsage envelope the modal already fetches. Built on the
                    shared menuPrimitives (SearchFilterBar's radio-per-dimension shape),
                    NOT a SearchFilterBar reuse. Icon-only < sm to fit the h-7 cluster. */}
                {hasCards && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <MenuTrigger
                        active={filtersActive(filters)}
                        data-testid="account-selector-filter"
                        title="Filter accounts"
                      >
                        <FilterIcon className="h-3.5 w-3.5" />
                        <span className="hidden sm:inline">Filter</span>
                      </MenuTrigger>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="end"
                      className="max-h-[85vh] overflow-y-auto p-0.5"
                    >
                      <MenuHeader
                        title="Filter"
                        clearLabel="Clear filters"
                        showClear={filtersActive(filters)}
                        onClear={onClearFilters}
                      />
                      <DropdownMenuSeparator className="my-0.5" />
                      <MenuRadioSection
                        label="5-hour"
                        value={filters.fiveHour}
                        options={CAPACITY_OPTIONS}
                        onChange={v => onFilterChange({ fiveHour: v })}
                      />
                      <DropdownMenuSeparator className="my-0.5" />
                      <MenuRadioSection
                        label="Weekly"
                        value={filters.weekly}
                        options={CAPACITY_OPTIONS}
                        onChange={v => onFilterChange({ weekly: v })}
                      />
                      <DropdownMenuSeparator className="my-0.5" />
                      <MenuRadioSection
                        label="Fable"
                        value={filters.fable}
                        options={CAPACITY_OPTIONS}
                        onChange={v => onFilterChange({ fable: v })}
                      />
                      <DropdownMenuSeparator className="my-0.5" />
                      <MenuRadioSection
                        label="Node"
                        value={filters.node}
                        options={[
                          { value: "all", label: "All" },
                          ...nodeOptions(usage).map(l => ({
                            value: l,
                            label: l,
                          })),
                        ]}
                        onChange={v => onFilterChange({ node: v })}
                      />
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                {/* Sort control — #3880 adopts the shared MenuTrigger so the ACTIVE
                    sort is named on the trigger (full label ≥ sm, two-letter abbr < sm,
                    "Manual"/"Mn" while the device-local drag order governs), matching
                    /account-usage (#3537). Shares the same persisted sort preference. */}
                {hasCards && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <MenuTrigger
                        active={sortMode !== DEFAULT_SORT_MODE || manualActive}
                        data-testid="account-selector-sort"
                        title="Sort accounts"
                      >
                        <SortIcon className="h-3.5 w-3.5" />
                        <span className="hidden sm:inline">
                          {manualActive
                            ? "Manual"
                            : (SORT_MODES.find(m => m.id === sortMode)?.label ??
                              "Sort")}
                        </span>
                        <span className="sm:hidden">
                          {manualActive
                            ? "Mn"
                            : (SORT_MODES.find(m => m.id === sortMode)?.abbr ??
                              "")}
                        </span>
                      </MenuTrigger>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="p-0.5">
                      <MenuHeader
                        title="Sort"
                        clearLabel="Clear sort"
                        showClear={
                          sortMode !== DEFAULT_SORT_MODE || manualActive
                        }
                        onClear={() => onSortChange(DEFAULT_SORT_MODE)}
                      />
                      <DropdownMenuSeparator className="my-0.5" />
                      {/* Manual (read-only in the modal) is surfaced so the menu agrees
                          with the "Manual" trigger label; picking any mode exits Manual
                          via onSortChange. Mirrors /account-usage. */}
                      {manualActive && (
                        <>
                          <DropdownMenuLabel className="py-0.5 text-[var(--app-accent)]">
                            Manual (drag order)
                          </DropdownMenuLabel>
                          <DropdownMenuSeparator className="my-0.5" />
                        </>
                      )}
                      <MenuRadioSection
                        value={manualActive ? "__manual__" : sortMode}
                        options={SORT_MODES.map(m => ({
                          value: m.id,
                          label: m.label,
                        }))}
                        onChange={mode => onSortChange(mode)}
                      />
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                {hasCards && (
                  <BareButton
                    type="button"
                    onClick={toggleSortDirection}
                    disabled={manualActive}
                    aria-label={
                      sortDirection === "asc"
                        ? "Sort direction: ascending (tap to reverse)"
                        : "Sort direction: descending (tap to reverse)"
                    }
                    title={
                      manualActive
                        ? "Direction doesn't apply to the manual drag order"
                        : sortDirection === "asc"
                          ? "Ascending — tap to reverse"
                          : "Descending — tap to reverse"
                    }
                    data-testid="account-selector-sort-direction"
                    data-sort-direction={sortDirection}
                    className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)] disabled:opacity-40"
                  >
                    {/* Plain up/down arrow — matches the account-usage page's
                        direction toggle (user feedback 2026-07-20). */}
                    {sortDirection === "asc" ? (
                      <ArrowUp className="h-4 w-4" />
                    ) : (
                      <ArrowDown className="h-4 w-4" />
                    )}
                  </BareButton>
                )}
                {hasCards && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={toggleAll}
                    aria-label={allExpanded ? "Collapse all" : "Expand all"}
                    data-testid="account-selector-expand-toggle"
                    className="h-7 w-7 text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                  >
                    {allExpanded ? (
                      <ChevronsDownUp className="h-4 w-4" />
                    ) : (
                      <ChevronsUpDown className="h-4 w-4" />
                    )}
                  </Button>
                )}
              </div>
            </div>
            {/* The switch-scope subtitle was dropped as superfluous; the spawn
                scope keeps its line — pre-spawn context is genuinely ambiguous. */}
            {scope === "spawn" && (
              <DialogDescription>
                Choose which stored{" "}
                {targetProvider === "openai"
                  ? "OpenAI"
                  : targetProvider === "google"
                    ? "Google"
                    : "Anthropic"}{" "}
                account
                {offeredKeys.length > 0 ? " or API key" : ""} the new session
                will use.
              </DialogDescription>
            )}
          </DialogHeader>
          {renderBody()}
          {/* Cancel — the explicit dismiss now that the header ✕ is gone (the
              expand/collapse chevron took its corner). Tap-outside and ESC
              still close too. Hidden while the Add-account wizard overlay is up
              (its own Dialog owns dismissal then). */}
          {!showAddWizard && (
            <div className="mt-3 flex shrink-0 items-center gap-2 border-t border-[var(--app-border)] pt-3">
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                onClick={handleClose}
              >
                Cancel
              </Button>
              {/* #3465: compact "Add account" convenience trigger, populated
                  branch only (hasCards). Reuses the already-mounted wizard
                  (setShowAddWizard) — no second wizard. The empty state has its
                  own CTA, so this is gated OUT of it (R5). data-testid because
                  the wizard's submit button shares the visible label. */}
              {hasCards && (
                <Button
                  type="button"
                  size="sm"
                  className="shrink-0"
                  data-testid="account-selector-add-account"
                  onClick={() => setShowAddWizard(true)}
                >
                  Add account
                </Button>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        isOpen={pendingAction?.kind === "select"}
        onClose={() => setPendingAction(null)}
        title="Switch account?"
        description="Switching restarts your Claude session — your conversation is preserved via --resume."
        confirmLabel="Switch account"
        confirmingLabel="Switching…"
        onConfirm={handleConfirmSelect}
        isPending={isPending}
        nonBlocking
      />

      {/* #1707: spawn-scope stale-account hard-confirm. Distinct kind from
          "select" so the copy is spawn-correct (the "select" dialog's
          "restarts your Claude session" copy is false pre-spawn). */}
      <ConfirmDialog
        isOpen={pendingAction?.kind === "confirm-stale-spawn"}
        onClose={() => setPendingAction(null)}
        title="This account looks expired"
        description="This account's stored credentials appear expired. The new session may fail to start if they can't be refreshed automatically. Continue anyway?"
        confirmLabel="Use anyway"
        confirmingLabel="Selecting…"
        onConfirm={async () => handleConfirmStaleSpawn()}
        isPending={false}
      />

      {/* Issue #1263: in-app web OAuth login. On success the accounts query is
          invalidated (useAccountLogin), so the new account APPEARS in the list
          regardless of onAdded. #3465: onAdded additionally force-refreshes the
          usage envelope (mirroring #3452's AddAccountSection) so the new
          account's card shows LIVE meters instead of the synthesized degraded
          envelope (:177-190). Fires for a login started from EITHER the
          empty-state CTA or the populated-footer trigger — one shared mount. */}
      <AddAccountWizard
        isOpen={showAddWizard}
        onClose={() => setShowAddWizard(false)}
        api={api}
        onAdded={() => {
          void refreshUsage();
        }}
      />
    </>
  );
}
