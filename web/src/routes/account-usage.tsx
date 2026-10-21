// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RefreshCw,
  ChevronsDownUp,
  ChevronsUpDown,
  ArrowUp,
  ArrowDown,
  Gauge,
} from "lucide-react";
import { useAppContext } from "@/lib/app-context";
import { ReloginDeepLink } from "@/components/AccountUsage/ReloginDeepLink";
import { useFederatedSessions } from "@/hooks/queries/useFederatedSessions";
import { useAppGoBack } from "@/hooks/useAppGoBack";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useEmojiFavicon } from "@/hooks/useEmojiFavicon";
import { useScrollToLocationHash } from "@/hooks/useScrollToLocationHash";
import { BackIcon, SortIcon, FilterIcon } from "@/components/icons";
import { Spinner } from "@/components/Spinner";
import { TitleChip } from "@/components/settings/SettingsSectionHeader";
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
import { Button } from "@/components/ui/button";
import { BareButton } from "@/components/ui/BareButton";
import {
  useAccountUsage,
  useRefreshAccountUsage,
} from "@/hooks/queries/useAccountUsage";
import { AccountUsageCard } from "@/components/AccountUsage/AccountUsageCard";
import { useAccountUsageHistory } from "@/hooks/queries/useAccountUsageHistory";
import type {
  AccountUsage,
  NodeProviderAuthState,
  ProviderAccountUsage,
} from "@hapi/protocol";
import { LOCAL_NODE_ID, LOCAL_NODE_LABEL } from "@hapi/protocol";
import { ProviderSection } from "@/components/AccountUsage/ProviderSection";
import { UsageBar } from "@/components/AccountUsage/UsageBar";
import { useProviderAuthState } from "@/hooks/queries/useProviderAuthState";
import { useAccounts } from "@/hooks/queries/useAccounts";
import { AddAccountInstructions } from "@/components/AddAccountInstructions";
import { AddToProviderModal } from "@/components/AccountUsage/AddToProviderModal";
import type { ApiClient } from "@/api/client";
import { DeviceConnectionFooter } from "@/components/AccountUsage/DeviceConnectionFooter";
import { ApiKeysSection } from "@/components/settings/sections/ApiKeysSection";
import { AddAccountSection } from "@/components/AccountUsage/AddAccountSection";
import {
  RemoveAccountsModal,
  type AccountRemovalRow,
} from "@/components/AccountUsage/RemoveAccountsModal";
import { useAccountActions } from "@/hooks/mutations/useAccountActions";
import {
  formatRelativeTime,
  getAccountEmail,
  getSessionTitle,
} from "@/lib/sessionHelpers";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  DRAG_ACTIVATION,
  GuardedPointerSensor,
  GuardedTouchSensor,
} from "@/components/SessionList/guardedDragSensors";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { SortableAccountCard } from "@/components/AccountUsage/SortableAccountCard";
import type { SortableDragHandle } from "@/components/SessionList/SortableListEntry";
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
  persistCustomOrder,
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

// Pull-to-refresh tuning (epic #1855, Sub F / #1861, R8).
const PULL_THRESHOLD = 64; // px of resisted pull that triggers a refresh
const PULL_RESISTANCE = 0.5; // finger travel → indicator travel ratio
const PULL_MAX = 96; // clamp the indicator travel

/**
 * AccountUsagePage — the standalone `/account-usage` route (epic #1855, Sub F / #1861).
 *
 * Mounts the Sub D data hooks (`useAccountUsage` / `useRefreshAccountUsage`) and the Sub E
 * presentational `<AccountUsageCard>` into a page shell modeled on `analytics.tsx`
 * (`BackIcon` + `useDocumentTitle` + `useEmojiFavicon` + `useAppGoBack`). A top-level route
 * (registered in `router.tsx`, reached via the USER group's Provider Accounts drawer row)
 * — opening it dismisses the admin drawer. #4906: it also hosts the Provider API Keys
 * section (`#api-keys`), moved from the retired Keys page.
 *
 * Refresh model (R5/R6): `useAccountUsage`'s `staleTime: 0` refetches on mount (on-open
 * refresh); the header exposes a manual refresh button and an "Updated Xs ago" indicator
 * derived from the query's `dataUpdatedAt`. iOS pull-to-refresh (R8) is implemented with
 * passive React touch handlers that drive a pull indicator and trigger `refresh()` on
 * release — the native overscroll bounce is already suppressed by `usePreventRubberBand`
 * (mounted on the BrandedFrame shell), so this handler never needs `preventDefault` (React
 * registers `onTouchMove` as passive anyway).
 *
 * Expand/collapse-all (R7): `<AccountUsageCard>` owns its expanded state internally
 * (`useState(defaultExpanded)`), so toggling all cards is done by bumping a remount key —
 * the cards re-mount and read the new `defaultExpanded`. This keeps the Sub E component
 * untouched (it intentionally exposes `defaultExpanded`, not a controlled `expanded` prop).
 */
/**
 * Per-account card + its usage-history fetch. The history hook (Sub I #1864) is
 * the impure piece — calling it once per account here (one component instance
 * per account → stable hook order) keeps <AccountUsageCard> pure. History
 * degrades to null on error, in which case the card simply omits the trend
 * sparkline + projection. The 5-hour and weekly windows render the trend when
 * history has >=2 points for them.
 */
function AccountUsageCardWithHistory(props: {
  account: AccountUsage;
  defaultExpanded: boolean;
  onRetry: () => void;
  api: ApiClient | null;
  nodes: { nodeId: string; nodeLabel: string }[];
  /** #3537: forwarded from the SortableAccountCard render-prop to the card. */
  dragHandle?: SortableDragHandle;
}) {
  const { history } = useAccountUsageHistory(
    props.api,
    props.account.accountUuid,
    true
  );
  return (
    <AccountUsageCard
      account={props.account}
      defaultExpanded={props.defaultExpanded}
      onRetry={props.onRetry}
      api={props.api}
      nodes={props.nodes}
      history={history ?? undefined}
      dragHandle={props.dragHandle}
    />
  );
}

// ── Non-Anthropic provider sections (issue #3806, epic #3345) ───────────────
// The OpenAI + Google Gemini sections render per-node DERIVED rows from the
// provider-auth-state envelope. Presentational + self-contained; they read only
// `NodeProviderAuthState[]` and a node-label resolver. NEVER render a token/key
// value — the envelope carries none (structural guarantee, R6).

const OPENAI_MODE_LABEL: Record<string, string> = {
  chatgpt: "ChatGPT subscription",
  "api-key": "API key",
  unknown: "Unknown — run codex login status",
  none: "Not configured",
};
const OPENAI_SOURCE_LABEL: Record<string, string> = {
  host: "Host login (~/.codex)",
  account: "Per-account",
};
const GEMINI_AUTH_LABEL: Record<string, string> = {
  "api-key": "API key",
  "google-login": "Google login",
  vertex: "Vertex AI",
  none: "Not configured",
  unknown: "Unknown",
};
const GEMINI_KEYSOURCE_LABEL: Record<string, string> = {
  vault: "Key: vault (this node)",
  "daemon-env": "Key: daemon env-file",
  none: "No key on this node",
};

function ProviderDetailRow(props: {
  label: string;
  value: string;
  testId?: string;
}) {
  return (
    <div
      className="flex items-baseline justify-between gap-3 py-0.5"
      data-testid={props.testId}
    >
      <span className="shrink-0 text-[length:var(--text-caption)] text-[var(--app-hint)]">
        {props.label}
      </span>
      <span className="min-w-0 truncate text-[length:var(--text-body)] text-[var(--app-fg)]">
        {props.value}
      </span>
    </div>
  );
}

/**
 * OpenAI per-account pacing meter (issue #3809) — rendered into the #3806 login
 * row's meter slot. Reuses `UsageBar` UNCHANGED for the 5-hour + weekly windows
 * (mapped server-side from codex primary/secondary); shows "as of <time>" when
 * the snapshot is stale/error, and a hint when no snapshot has arrived yet. Uses
 * only existing token classes (no new hex/px literal — the design-token ratchet).
 */
function OpenAiUsageMeter(props: { usage: ProviderAccountUsage }) {
  const { usage } = props;
  if (usage.status === "unknown") {
    return (
      <p
        className="mt-2 text-[length:var(--text-caption)] text-[var(--app-hint)]"
        data-testid="openai-usage-unknown"
      >
        No usage snapshot yet — run a Codex session to populate.
      </p>
    );
  }
  const fiveHour = usage.utilization.five_hour?.utilization ?? null;
  const weekly = usage.utilization.seven_day?.utilization ?? null;
  return (
    <div
      className="mt-2 flex flex-col gap-1.5"
      data-testid="openai-usage-meter"
    >
      <UsageBar label="5-hour" value={fiveHour} />
      <UsageBar label="Weekly" value={weekly} />
      {(usage.status === "stale" || usage.status === "error") && (
        <span
          className="text-[length:var(--text-caption)] text-[var(--app-hint)]"
          data-testid="openai-usage-asof"
        >
          as of {formatRelativeTime(usage.fetchedAt) ?? "unknown"}
        </span>
      )}
    </div>
  );
}

/**
 * Google (Gemini) token-SPEND counter (issue #3809) — NEVER a % bar (no queryable
 * account-level limit for an API key). Renders "tokens used (no limit known)" +
 * the rolling today / this-week totals from the derived counter. Token classes
 * mirror the sibling provider rows (no new hex/px literal).
 */
function GoogleUsageCounter(props: { usage: ProviderAccountUsage }) {
  const { usage } = props;
  const spend = usage.tokenSpend;
  return (
    <div
      className="rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 py-2"
      data-testid="google-usage-counter"
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[length:var(--text-label-strong)] font-medium text-[var(--app-fg)]">
          {usage.nickname || usage.displayLabel}
        </span>
        <span className="shrink-0 text-[length:var(--text-caption)] text-[var(--app-hint)]">
          tokens used (no limit known)
        </span>
      </div>
      <ProviderDetailRow
        label="Today"
        value={`${(spend?.tokensToday ?? 0).toLocaleString()} tokens`}
        testId="google-usage-today"
      />
      <ProviderDetailRow
        label="This week"
        value={`${(spend?.tokensThisWeek ?? 0).toLocaleString()} tokens`}
        testId="google-usage-week"
      />
    </div>
  );
}

function DegradedNodeRow(props: { nodeLabel: string }) {
  return (
    <div
      className="rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 py-2"
      data-testid="provider-node-unreachable"
    >
      <p className="text-[length:var(--text-body)] text-[var(--toast-warning)]">
        {props.nodeLabel}: unreachable
      </p>
    </div>
  );
}

function OpenAiSectionBody(props: {
  nodes: NodeProviderAuthState[];
  resolveNodeLabel: (nodeId: string) => string;
  api: ApiClient | null;
  // Issue #3809: the OpenAI providerUsage[] rows keyed by accountUuid, rendered
  // into each login row's meter slot below.
  openaiUsageByUuid: Map<string, ProviderAccountUsage>;
}) {
  const [wizardOpen, setWizardOpen] = useState(false);
  const anyRows = props.nodes.some(
    n => n.status === "ok" && n.openai.length > 0
  );
  const allReachableNoLogin =
    !anyRows && props.nodes.every(n => n.status === "ok");
  // #4464: the in-app "Add account" opens the OpenAI "+ Add" modal — ChatGPT
  // device-auth or a Codex API-key login on the node the user picks (the UI
  // host by default), plus OpenAI vault keys.
  const addButton = (
    <div className="flex justify-end">
      <Button
        type="button"
        size="sm"
        onClick={() => setWizardOpen(true)}
        data-testid="openai-add-account"
      >
        Add account
      </Button>
    </div>
  );
  const wizard = wizardOpen ? (
    <AddToProviderModal
      isOpen
      onClose={() => setWizardOpen(false)}
      api={props.api}
      provider="openai"
    />
  ) : null;

  if (allReachableNoLogin) {
    // Every node reachable, no Codex login anywhere → host-side add instructions
    // (the on-host fallback) PLUS the in-app add for the local node (#3807).
    return (
      <div className="flex flex-col gap-3">
        <div
          className="flex flex-col gap-2 text-[length:var(--text-body)]"
          data-testid="provider-section-openai-empty"
        >
          <AddAccountInstructions
            provider="openai"
            intro="No Codex (OpenAI) login on this node yet:"
          />
        </div>
        {addButton}
        {wizard}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {props.nodes.map(node => {
        const nodeLabel = props.resolveNodeLabel(node.nodeId);
        if (node.status === "unreachable") {
          return <DegradedNodeRow key={node.nodeId} nodeLabel={nodeLabel} />;
        }
        if (node.openai.length === 0) return null;
        return (
          <div key={node.nodeId} className="flex flex-col gap-2">
            {node.openai.map((row, i) => (
              <div
                key={`${node.nodeId}:${row.source}:${row.accountUuid ?? i}`}
                className="rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 py-2"
                data-testid="openai-login-row"
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-[length:var(--text-label-strong)] font-medium text-[var(--app-fg)]">
                    {row.label ?? row.email ?? nodeLabel}
                  </span>
                  <span className="shrink-0 text-[length:var(--text-caption)] text-[var(--app-hint)]">
                    {OPENAI_SOURCE_LABEL[row.source] ?? row.source}
                  </span>
                </div>
                <ProviderDetailRow
                  label="Mode"
                  value={OPENAI_MODE_LABEL[row.mode] ?? row.mode}
                  testId="openai-mode"
                />
                {/* Email as a detail row ONLY when a label occupies the header,
                    so a host login (header == email) never shows it twice. */}
                {row.email && row.label && (
                  <ProviderDetailRow label="Email" value={row.email} />
                )}
                {row.plan && (
                  <ProviderDetailRow label="Plan" value={row.plan} />
                )}
                {row.expiresAt && (
                  <ProviderDetailRow
                    label="Expires"
                    value={
                      formatRelativeTime(new Date(row.expiresAt).getTime()) ??
                      row.expiresAt
                    }
                  />
                )}
                {/* #3809: the per-account OpenAI pacing meter — the sibling
                    providerUsage[] row for this login, matched by accountUuid.
                    Renders nothing until a session of the account reports a
                    snapshot (status "unknown" shows a hint). */}
                {row.accountUuid &&
                  props.openaiUsageByUuid.has(row.accountUuid) && (
                    <OpenAiUsageMeter
                      usage={props.openaiUsageByUuid.get(row.accountUuid)!}
                    />
                  )}
              </div>
            ))}
          </div>
        );
      })}
      {addButton}
      {wizard}
    </div>
  );
}

function GeminiSectionBody(props: {
  nodes: NodeProviderAuthState[];
  resolveNodeLabel: (nodeId: string) => string;
  currentNodeId: string;
  api: ApiClient | null;
  // Issue #3809: the Google providerUsage[] counter rows (account-keyed, not
  // node-keyed like the auth rows), rendered at the top of the section.
  googleUsageRows: ProviderAccountUsage[];
}) {
  // #4464: ONE "Add key" button opens the Gemini "+ Add" modal (keys only). It
  // writes THIS node's local vault (POST /api/api-keys — there is no federation
  // key store until #1996); a peer node's row keeps the #3806 host-side
  // instruction.
  const [addOpen, setAddOpen] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      {/* Issue #3809: the derived Google token-spend counters (account-keyed),
          shown above the per-node auth rows. A count row is never a % bar. */}
      {props.googleUsageRows.length > 0 && (
        <div
          className="flex flex-col gap-2"
          data-testid="google-usage-counters"
        >
          {props.googleUsageRows.map(u => (
            <GoogleUsageCounter key={u.accountUuid} usage={u} />
          ))}
        </div>
      )}
      {props.nodes.map(node => {
        const nodeLabel = props.resolveNodeLabel(node.nodeId);
        if (node.status === "unreachable") {
          return <DegradedNodeRow key={node.nodeId} nodeLabel={nodeLabel} />;
        }
        const g = node.google;
        const isLocal = node.nodeId === props.currentNodeId;
        return (
          <div key={node.nodeId} className="flex flex-col gap-2">
            {g && (
              <div
                className="rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 py-2"
                data-testid="gemini-node-row"
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-[length:var(--text-label-strong)] font-medium text-[var(--app-fg)]">
                    {nodeLabel}
                  </span>
                  <span className="shrink-0 text-[length:var(--text-caption)] text-[var(--app-hint)]">
                    {GEMINI_KEYSOURCE_LABEL[g.keySource] ?? g.keySource}
                  </span>
                </div>
                <ProviderDetailRow
                  label="Auth type"
                  value={
                    GEMINI_AUTH_LABEL[g.selectedAuthType] ?? g.selectedAuthType
                  }
                  testId="gemini-auth-type"
                />
              </div>
            )}
            {!isLocal && !g?.bound && (
              // A peer node with no bound Gemini key → host-side instruction
              // (federation key persistence is #1996's; R4).
              <div
                className="flex flex-col gap-2 text-[length:var(--text-body)]"
                data-testid="provider-section-google-peer-empty"
              >
                <AddAccountInstructions
                  provider="google"
                  intro={`No Gemini key bound on ${nodeLabel} yet:`}
                />
              </div>
            )}
          </div>
        );
      })}
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          onClick={() => setAddOpen(true)}
          data-testid="gemini-add-key"
        >
          Add key
        </Button>
      </div>
      {addOpen && (
        <AddToProviderModal
          isOpen
          onClose={() => setAddOpen(false)}
          api={props.api}
          provider="google"
        />
      )}
    </div>
  );
}

export default function AccountUsagePage(props?: { onBack?: () => void }) {
  const { api } = useAppContext();
  const defaultGoBack = useAppGoBack();
  const goBack = props?.onBack ?? defaultGoBack;
  useDocumentTitle("Provider Accounts - Hapimatic");
  useEmojiFavicon(null);

  const {
    usage,
    providerUsage,
    isLoading,
    error,
    dataUpdatedAt,
    refetch: refetchUsage,
  } = useAccountUsage(api, true);
  const refreshQuery = useRefreshAccountUsage(api);
  // #4736: the onboarding sign-in's registration state (GET /api/accounts). The
  // page fetches it explicitly — the cards' own account-label query never runs
  // when there are no cards, which is exactly when this notice matters.
  // `pollOnboardingRegistration` re-reads it while the sign-in is not yet in the
  // store (paused in a background tab), so the notice clears by itself.
  const { onboardingRegistration } = useAccounts(api, true, {
    pollOnboardingRegistration: true,
  });
  // When the notice clears, re-read the usage list so the account's card appears
  // (non-forced — the server's membership guard now includes the account).
  const prevOnboardingRegistration = useRef(onboardingRegistration);
  useEffect(() => {
    const was = prevOnboardingRegistration.current;
    prevOnboardingRegistration.current = onboardingRegistration;
    if (was !== null && onboardingRegistration === null) {
      void refetchUsage();
    }
  }, [onboardingRegistration, refetchUsage]);

  // Non-Anthropic provider auth state — Codex (OpenAI) + Gemini (Google), one row
  // per federation node (issue #3806, epic #3345). DERIVED fields only.
  const {
    nodes: providerNodes,
    error: providerError,
    isLoading: providerLoading,
  } = useProviderAuthState(api, true);

  // #4906: the menu's Provider API Keys sub-row (and old /settings/keys links)
  // deep-link to #api-keys at the foot of the page. Scroll once the usage cards
  // and provider sections above it have loaded, or they push it back down.
  useScrollToLocationHash(!isLoading && !providerLoading);

  // Issue #3809: split the sibling providerUsage[] into the OpenAI meter map
  // (accountUuid → the login row's meter slot) and the Google counter rows
  // (account-keyed, rendered as a group at the top of the Gemini section).
  const openaiUsageByUuid = useMemo(() => {
    const m = new Map<string, ProviderAccountUsage>();
    for (const u of providerUsage) {
      if (u.provider === "openai") m.set(u.accountUuid, u);
    }
    return m;
  }, [providerUsage]);
  const googleUsageRows = useMemo(
    () => providerUsage.filter(u => u.provider === "google"),
    [providerUsage]
  );

  // epic #1855, Sub J (#1865): resolve each account's `machines` (node labels)
  // to { nodeId, nodeLabel } via the federation node list, so the card can offer
  // an inline per-node "Set active" switch. `machines` are labels, but the
  // per-node switch mutation is keyed by nodeId.
  const { localNode, localNodeSettled, remoteNodes, remoteSessions } =
    useFederatedSessions(api);
  // The "currently-viewed" node for R3's pre-check. On a non-federated install
  // localNode is null, so fall back to the synthesized "local" id (D2) — the same
  // idiom the server's /federation/active-accounts uses (webClient.ts:34).
  const currentNodeId = localNode?.nodeId ?? LOCAL_NODE_ID;
  // Resolve a provider-envelope nodeId → a friendly node label for the OpenAI /
  // Gemini section rows (issue #3806). The LOCAL_NODE_ID sentinel maps to the
  // local node's label; an unknown id degrades to the raw id.
  const resolveNodeLabel = useCallback(
    (nodeId: string): string => {
      if (nodeId === LOCAL_NODE_ID) {
        return localNode?.nodeLabel ?? LOCAL_NODE_LABEL;
      }
      for (const n of [localNode, ...remoteNodes]) {
        if (n && n.nodeId === nodeId) return n.nodeLabel;
      }
      return nodeId;
    },
    [localNode, remoteNodes]
  );
  const nodeByLabel = useMemo(() => {
    const m = new Map<string, { nodeId: string; nodeLabel: string }>();
    for (const n of [localNode, ...remoteNodes]) {
      // First label wins on collision; never crash on a duplicate label.
      if (n && !m.has(n.nodeLabel)) {
        m.set(n.nodeLabel, { nodeId: n.nodeId, nodeLabel: n.nodeLabel });
      }
    }
    return m;
  }, [localNode, remoteNodes]);

  // Resolve each account's nodes (with the D2 non-federated single-local-node
  // fallback) and its email-matched bound sessions ONCE — the card list reads
  // `nodes`, and the bulk-removal modal (issue #2131) reads the full row.
  const accountsResolved = useMemo(
    () =>
      usage.map(account => {
        const resolvedNodes = account.machines
          .map(label => nodeByLabel.get(label))
          .filter((n): n is { nodeId: string; nodeLabel: string } => n != null);
        // Non-federated fallback (D2): without a federation config the server
        // returns localNode:null and every account's machines is [], so
        // resolvedNodes is empty. Treat the instance as one implicit local node
        // so the removal target exists; nodes.ts isRemoteNode() lands
        // DELETE /api/nodes/local/... on the local branch when unconfigured.
        const nodes =
          resolvedNodes.length > 0
            ? resolvedNodes
            : [
                {
                  nodeId: currentNodeId,
                  nodeLabel: localNode?.nodeLabel ?? LOCAL_NODE_LABEL,
                },
              ];
        // Sessions bound to this account by email match — mirrors
        // AccountSelectorModal's boundSessions derivation.
        const boundSessions = account.email
          ? remoteSessions
              .filter(s => getAccountEmail(s) === account.email)
              .map(s => ({ id: s.id, label: getSessionTitle(s) }))
          : [];
        return { account, nodes, boundSessions };
      }),
    [usage, nodeByLabel, currentNodeId, localNode, remoteSessions]
  );

  // Rows for the bulk "Remove Accounts" modal (issue #2131). Mirror the card's
  // Row-1 primary (email, else displayLabel) + Row-2 colloquial label (nickname,
  // falling back to the OAuth display name when no nickname is set) so the modal
  // row identifies each account the same way the card does.
  const removalRows: AccountRemovalRow[] = useMemo(
    () =>
      accountsResolved.map(({ account, nodes, boundSessions }) => {
        const hasEmail = account.email != null && account.email !== "";
        const primary = hasEmail
          ? (account.email as string)
          : account.displayLabel;
        const colloquialFallback = hasEmail ? account.displayLabel : "";
        const nickname =
          (account.nickname && account.nickname.trim()) || colloquialFallback;
        return {
          accountUuid: account.accountUuid,
          email: primary,
          nickname,
          nodes,
          boundSessions,
        };
      }),
    [accountsResolved]
  );

  // nodeId → label for the removal mutation's partial-success toast.
  const nodeLabels = useMemo(() => {
    const m: Record<string, string> = {};
    for (const n of [localNode, ...remoteNodes]) {
      if (n) m[n.nodeId] = n.nodeLabel;
    }
    return m;
  }, [localNode, remoteNodes]);

  const { removeAccountsFromNodes, isRemovingFromNodes } =
    useAccountActions(api);
  const [removeOpen, setRemoveOpen] = useState(false);

  const [refreshing, setRefreshing] = useState(false);
  const doRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await refreshQuery();
    } finally {
      setRefreshing(false);
    }
  }, [refreshing, refreshQuery]);

  // Expand/collapse-all via remount key (R7).
  const [allExpanded, setAllExpanded] = useState(true);
  const [genId, setGenId] = useState(0);
  const toggleAll = useCallback(() => {
    setAllExpanded(v => !v);
    setGenId(g => g + 1);
  }, []);

  // Account-list sorting (issue #2133). Sort mode + custom order persist per-device in
  // port-scoped localStorage (the theme-persistence precedent). `isDraggingRef` gates the
  // pull-to-refresh handlers below so an active card drag never triggers a refresh (R5).
  const [sortMode, setSortMode] = useState<SortMode>(() => getStoredSortMode());
  // Sort direction (2026-07-20): asc = the R1 base order (most-available /
  // soonest-reset first); the header toggle flips it and persists like the mode.
  // The Manual arrangement ignores direction (drag order is absolute) — the toggle
  // disables while Manual governs.
  const [sortDirection, setSortDirection] = useState<SortDirection>(() =>
    getStoredSortDirection()
  );
  const [customOrder, setCustomOrder] = useState<string[]>(() =>
    getStoredCustomOrder()
  );
  // #3537: the device-local Manual flag (mirrors the session list). Seeded from
  // localStorage so a stored order (including a migrated pre-#3537 "custom" mode)
  // governs on the very first render. First completed drag flips it on; choosing any
  // sort mode / Clear sort flips it off. The drag apparatus is ALWAYS mounted now —
  // Manual only decides whether the stored order GOVERNS, not whether a drag can arm.
  const [manualActive, setManualActive] = useState(() =>
    getStoredManualActive()
  );
  // #3880: account filters — shared with the switch-account modal via the same
  // port-scoped localStorage key. Seeded synchronously so a stored filter governs on
  // the first render.
  const [filters, setFilters] = useState<AccountFilters>(() =>
    getStoredFilters()
  );
  const isDraggingRef = useRef(false);

  const getUuid = useCallback(
    (x: (typeof accountsResolved)[number]) => x.account.accountUuid,
    []
  );

  // The render order for the current sort. A COPY is sorted so the `accountsResolved`
  // memo is never mutated. While Manual governs (#3537) the persisted uuid order applies
  // (degrading cleanly on add/remove); otherwise the active mode uses the ascending,
  // missing-to-end comparator.
  const sortedAccounts = useMemo(() => {
    if (manualActive) {
      return orderByCustom(accountsResolved, customOrder, getUuid);
    }
    const cmp = compareByMode(sortMode, sortDirection);
    return [...accountsResolved].sort((a, b) => cmp(a.account, b.account));
  }, [
    accountsResolved,
    manualActive,
    sortMode,
    sortDirection,
    customOrder,
    getUuid,
  ]);

  // #3880: RENDER-only filtered view. `sortedAccounts` stays the COMPLETE set — it feeds
  // SortableContext + onDragEnd's customOrder computation, whose #3537 R7 comment relies
  // on it being the full list; narrowing it would persist a customOrder missing every
  // hidden card. The filter narrows this derived list for display, and onDragEnd is
  // suppressed while a filter is active (Risk 1, #3880).
  const visibleAccounts = useMemo(
    () =>
      sortedAccounts.filter(({ account }) => matchesFilters(account, filters)),
    [sortedAccounts, filters]
  );

  const onSortChange = useCallback((mode: SortMode) => {
    // #3537: choosing any sort mode (including Clear sort → DEFAULT_SORT_MODE) EXITS
    // Manual (R8). The persisted `customOrder` is left intact so a later drag re-enters
    // Manual from the last arrangement. Paired with persistManualActive(false) so the
    // legacy "custom" fallback in getStoredManualActive can never re-assert Manual.
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

  // #3537: always-armed press-and-hold drag, sharing the session-list guarded sensors
  // (~300ms DRAG_ACTIVATION + interactive-target veto). A press on the chevron / nickname
  // editor / "Set active" chip / Retry never arms a drag, and a normal scroll / pull-to-
  // refresh still works until the hold threshold elapses; KeyboardSensor covers keyboard
  // reorder from the chevron handle.
  const sensors = useSensors(
    useSensor(GuardedPointerSensor, { activationConstraint: DRAG_ACTIVATION }),
    useSensor(GuardedTouchSensor, { activationConstraint: DRAG_ACTIVATION }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const onDragStart = useCallback(() => {
    isDraggingRef.current = true;
  }, []);
  const onDragCancel = useCallback(() => {
    isDraggingRef.current = false;
  }, []);
  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      isDraggingRef.current = false;
      // #3880 (Risk 1): while a filter is active the rendered list is a SUBSET, so a
      // reorder must NOT persist a customOrder computed from the visible cards (it would
      // drop every hidden card from the Manual order). Suppress the reorder entirely while
      // filtered — Manual + filter is a rare combination, and correctness (never
      // corrupting customOrder) outweighs allowing a drag in that state.
      if (filtersActive(filters)) return;
      const { active, over } = e;
      if (!over || active.id === over.id) return;
      const firstDrag = !manualActive;
      // #3537 (R7): with no filter active, `sortedAccounts` IS the complete rendered set
      // (the #3880 guard above early-returns whenever a filter narrows it), and `arrayMove`
      // yields the full post-drag arrangement — every on-screen card is named in the
      // persisted order, so an SSE refetch can't shift un-dragged cards. The session-list's
      // explicit first-drag SEED (SessionListContainer.tsx:749-760) is REDUNDANT here and
      // must NOT be added: it would re-derive from `customOrder`, which is [] on a fresh or
      // migrated-but-never-dragged device, dropping every un-dragged card. Keep `ids` from
      // `sortedAccounts`.
      const ids = sortedAccounts.map(getUuid);
      const oldIndex = ids.indexOf(String(active.id));
      const newIndex = ids.indexOf(String(over.id));
      if (oldIndex < 0 || newIndex < 0) return;
      const next = arrayMove(ids, oldIndex, newIndex);
      setCustomOrder(next);
      persistCustomOrder(next);
      // First completed drag → flip the effective sort to Manual (mirrors
      // SessionListContainer.tsx:799-806).
      if (firstDrag) {
        setManualActive(true);
        persistManualActive(true);
      }
    },
    [sortedAccounts, getUuid, manualActive, filters]
  );

  // Pull-to-refresh (R8).
  const scrollRef = useRef<HTMLDivElement>(null);
  const touchStartY = useRef(0);
  const pulling = useRef(false);
  const [pullDistance, setPullDistance] = useState(0);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    // Suppress pull-to-refresh while a card drag is active (R5) — the drag and the
    // pull share this touch surface. The long-press TouchSensor means a normal pull
    // still works until a drag actually starts.
    if (isDraggingRef.current) {
      pulling.current = false;
      return;
    }
    const el = scrollRef.current;
    // `usePreventRubberBand` nudges scrollTop to 1 at the top boundary, so treat
    // anything <= 2 as "at top".
    if (el && el.scrollTop <= 2) {
      touchStartY.current = e.touches[0].clientY;
      pulling.current = true;
    } else {
      pulling.current = false;
    }
  }, []);

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (isDraggingRef.current) {
        pulling.current = false;
        setPullDistance(0);
        return;
      }
      if (!pulling.current || refreshing) return;
      const el = scrollRef.current;
      if (!el || el.scrollTop > 2) {
        pulling.current = false;
        setPullDistance(0);
        return;
      }
      const delta = e.touches[0].clientY - touchStartY.current;
      setPullDistance(
        delta > 0 ? Math.min(delta * PULL_RESISTANCE, PULL_MAX) : 0
      );
    },
    [refreshing]
  );

  const onTouchEnd = useCallback(() => {
    if (!pulling.current) return;
    pulling.current = false;
    const shouldRefresh = pullDistance >= PULL_THRESHOLD;
    setPullDistance(0);
    if (shouldRefresh) void doRefresh();
  }, [pullDistance, doRefresh]);

  const relUpdated =
    dataUpdatedAt > 0 ? formatRelativeTime(dataUpdatedAt) : null;
  const isBusy = refreshing || isLoading;
  const showInitialLoading = isLoading && usage.length === 0;
  const showEmpty = !isLoading && !error && usage.length === 0;
  const indicatorActive = pullDistance > 0 || refreshing;

  return (
    <div className="flex h-full flex-col">
      <div
        ref={scrollRef}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        className="relative flex-1 overflow-y-auto bg-[var(--app-deepest-bg)]"
        data-testid="account-usage-page"
      >
        {/* Pull-to-refresh indicator (R8) */}
        {indicatorActive && (
          <div
            className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center"
            style={{ height: refreshing ? 40 : pullDistance }}
            aria-hidden
          >
            <div
              className="flex items-start pt-2"
              style={{
                opacity: refreshing
                  ? 1
                  : Math.min(1, pullDistance / PULL_THRESHOLD),
              }}
            >
              <Spinner size="sm" label={null} />
            </div>
          </div>
        )}

        {/* Header — a single row (left→right): Back, title, "Updated Xs ago",
            refresh, Sort, and the master expand/collapse-all chevron. Sort +
            the chevron only appear when there are accounts to sort/expand. The
            Sort control is the SAME dropdown implementation as the session
            list's sort (ui/menuPrimitives, issue #2133 + unification). */}
        <div className="sticky top-0 z-10 bg-[var(--app-deepest-bg)]">
          <div className="mx-auto flex w-full max-w-content items-center gap-1 px-3 py-2">
            <Button
              variant="ghost"
              size="icon"
              type="button"
              onClick={goBack}
              aria-label="Back"
              className="shrink-0 hover:bg-[var(--app-secondary-bg)]"
            >
              <BackIcon className="h-5 w-5" />
            </Button>
            <TitleChip icon={Gauge} accent="var(--accent-cyan)" />
            <h1 className="min-w-0 flex-1 truncate text-lg font-bold text-[var(--app-fg)]">
              Provider Accounts
            </h1>
            {relUpdated != null && (
              <span
                className="shrink-0 truncate text-[length:var(--text-caption)] text-[var(--app-hint)] max-[480px]:hidden"
                data-testid="account-usage-updated"
              >
                Updated {relUpdated}
              </span>
            )}
            <Button
              variant="ghost"
              size="icon"
              type="button"
              onClick={doRefresh}
              disabled={isBusy}
              aria-label="Refresh"
              data-testid="account-usage-refresh"
              className="shrink-0 hover:bg-[var(--app-secondary-bg)] disabled:opacity-60"
            >
              <RefreshCw
                className={`h-4 w-4 ${isBusy ? "animate-spin" : ""}`}
              />
            </Button>
            {/* #3880: Filter menu — same four dimensions as the switch-account modal
                (remaining 5h / weekly / Fable capacity + node), sharing filter state via
                the port-scoped localStorage key. Composes with sort; the drag reorder is
                suppressed while a filter is active (Risk 1). */}
            {usage.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <MenuTrigger
                    active={filtersActive(filters)}
                    data-testid="account-usage-filter"
                    className="shrink-0"
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
                      ...nodeOptions(usage).map(l => ({ value: l, label: l })),
                    ]}
                    onChange={v => onFilterChange({ node: v })}
                  />
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {usage.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <MenuTrigger
                    active={sortMode !== DEFAULT_SORT_MODE || manualActive}
                    data-testid="account-usage-sort"
                    className="shrink-0"
                    title="Sort accounts"
                  >
                    <SortIcon className="h-3.5 w-3.5" />
                    {/* #3537: always names the active mode — full label ≥ sm, the
                        two-letter abbreviation < sm (paired breakpoint spans so the
                        trigger is never empty), "Manual"/"Mn" while a drag order
                        governs. Includes the default Pace score. */}
                    <span className="hidden sm:inline">
                      {manualActive
                        ? "Manual"
                        : (SORT_MODES.find(m => m.id === sortMode)?.label ??
                          "Sort")}
                    </span>
                    <span className="sm:hidden">
                      {manualActive
                        ? "Mn"
                        : (SORT_MODES.find(m => m.id === sortMode)?.abbr ?? "")}
                    </span>
                  </MenuTrigger>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="p-0.5">
                  <MenuHeader
                    title="Sort"
                    clearLabel="Clear sort"
                    showClear={sortMode !== DEFAULT_SORT_MODE || manualActive}
                    onClear={() => onSortChange(DEFAULT_SORT_MODE)}
                  />
                  <DropdownMenuSeparator className="my-0.5" />
                  {/* #3537: while a drag order governs, "Manual" is the effective sort —
                      surface it in mint and highlight no mode option; picking one (below)
                      exits Manual via onSortChange. Mirrors SearchFilterBar. */}
                  {manualActive && (
                    <>
                      <DropdownMenuLabel className="py-0.5 text-[var(--app-accent)]">
                        Manual (drag order)
                      </DropdownMenuLabel>
                      <DropdownMenuSeparator className="my-0.5" />
                    </>
                  )}
                  {/* No section sublabel — the menu title "Sort" already names
                      the axis, so a "Sort by" here would be redundant. */}
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
            {/* Sort-direction toggle (2026-07-20) — flips asc ⇄ desc for the
                active mode. Disabled while Manual governs (#3537 — the drag order
                is absolute and has no direction). */}
            {usage.length > 0 && (
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
                data-testid="account-usage-sort-direction"
                data-sort-direction={sortDirection}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)] disabled:opacity-40"
              >
                {/* Plain up/down arrow (user feedback 2026-07-20): the
                    narrow-wide sort glyphs read too much like the adjacent
                    Sort-menu icon — a bare arrow says "direction", not
                    "sorting exists". */}
                {sortDirection === "asc" ? (
                  <ArrowUp className="h-4 w-4" />
                ) : (
                  <ArrowDown className="h-4 w-4" />
                )}
              </BareButton>
            )}
            {usage.length > 0 && (
              <Button
                variant="ghost"
                size="icon"
                type="button"
                onClick={toggleAll}
                aria-label={allExpanded ? "Collapse all" : "Expand all"}
                data-testid="account-usage-expand-toggle"
                className="shrink-0 hover:bg-[var(--app-secondary-bg)]"
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

        {/* Content — three independently-collapsible provider sections
            (issue #3806, epic #3345): Anthropic (unchanged behavior) / OpenAI /
            Google Gemini. */}
        <div className="mx-auto w-full max-w-content px-3 pb-6">
          <ProviderSection
            title="Anthropic"
            testId="provider-section-anthropic"
          >
            {error != null && (
              <div
                className="mb-3 rounded-lg border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 py-2 text-[length:var(--text-body)] text-[var(--toast-warning,#fbbf24)]"
                role="alert"
                data-testid="account-usage-error"
              >
                Couldn&apos;t refresh account usage: {error}
                {usage.length > 0 && " Showing the last loaded data."}
              </div>
            )}

            {/* #4736: the Claude account the user signed in with during onboarding
              is not in this node's account store — say so instead of leaving an
              unexplained empty list. Clears itself once the account is added. */}
            {onboardingRegistration === "missing" && (
              <div
                className="mb-3 rounded-lg border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 py-2 text-[length:var(--text-body)] text-[var(--toast-warning)]"
                role="alert"
                data-testid="onboarding-registration-missing"
              >
                The Claude account you signed in with during setup wasn&apos;t
                added to Hapimatic — use Add account to sign in with that same
                account again
              </div>
            )}
            {onboardingRegistration === "pending" && (
              <div
                className="mb-3 rounded-lg border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 py-2 text-[length:var(--text-body)] text-[var(--app-hint)]"
                role="status"
                data-testid="onboarding-registration-pending"
              >
                Hapimatic is still adding the Claude account you signed in with
                during setup
              </div>
            )}

            {/* #4461 (R9): the re-login deep link — the "+ Add" modal with the
              requested node preselected (#4464). */}
            <ReloginDeepLink
              api={api}
              localNode={localNode}
              localNodeSettled={localNodeSettled}
            />

            {showInitialLoading ? (
              <div
                className="flex justify-center py-12"
                data-testid="account-usage-loading"
              >
                <Spinner size="md" label="Loading account usage…" />
              </div>
            ) : showEmpty ? (
              <div
                className="flex flex-col items-center gap-1 py-12 text-center"
                data-testid="account-usage-empty"
              >
                <p className="text-sm font-medium text-[var(--app-fg)]">
                  No accounts logged in
                </p>
                <p className="max-w-xs text-[length:var(--text-body)] text-[var(--app-hint)]">
                  No Anthropic accounts are logged in across the federation yet.
                </p>
              </div>
            ) : (
              // #3537: the drag apparatus is ALWAYS mounted (no more "Custom" mode) — a
              // press-and-hold on a non-interactive card area arms a reorder regardless of
              // the active sort. Manual only decides whether the stored order GOVERNS.
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
                onDragCancel={onDragCancel}
              >
                <SortableContext
                  items={visibleAccounts.map(getUuid)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="flex flex-col gap-2">
                    {visibleAccounts.map(({ account, nodes }) => (
                      <SortableAccountCard
                        key={`${account.accountUuid}:${genId}`}
                        id={account.accountUuid}
                      >
                        {({ dragHandle }) => (
                          <AccountUsageCardWithHistory
                            account={account}
                            defaultExpanded={allExpanded}
                            onRetry={doRefresh}
                            api={api}
                            nodes={nodes}
                            dragHandle={dragHandle}
                          />
                        )}
                      </SortableAccountCard>
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            )}

            {/* "How to add a new account" collapsible (epic #2049, Sub F / #2055) —
              hosts the add-account guidance once Sub G (#2056) strips the buttons
              from the Switch Account modal. Rendered unconditionally (like the
              footer) so it appears in every page state, including the empty state
              where a user most needs it. */}
            <AddAccountSection />

            {/* Bulk "Remove Accounts" trigger (issue #2131) — replaces the per-card
              red ✕. Right-aligned, red-outline destructive styling, between the
              add-account section and the device footer. Proactive last-account-
              anywhere block: hidden below 2 accounts (nothing meaningful to
              bulk-remove; AddAccountSection carries the "add a new account first"
              guidance). Per-node last-account cases stay on the server 409. */}
            {usage.length >= 2 && (
              <div className="mt-2 flex justify-end">
                <Button
                  variant="outline"
                  type="button"
                  data-testid="remove-accounts-button"
                  onClick={() => setRemoveOpen(true)}
                  className="h-auto rounded-md border-red-500/60 px-3 py-1.5 text-[length:var(--text-body)] font-medium text-red-500 hover:bg-red-500/10"
                >
                  Remove Accounts
                </Button>
              </div>
            )}
          </ProviderSection>

          {providerError != null && (
            <div
              className="mt-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 py-2 text-[length:var(--text-body)] text-[var(--toast-warning)]"
              role="alert"
              data-testid="provider-auth-state-error"
            >
              Couldn&apos;t load provider auth state: {providerError}
            </div>
          )}

          {/* OpenAI (Codex) section — per-node derived login rows (#3806) + the
              in-app "Add account" (the OpenAI "+ Add" modal, #4464). */}
          <ProviderSection title="OpenAI" testId="provider-section-openai">
            <OpenAiSectionBody
              nodes={providerNodes}
              resolveNodeLabel={resolveNodeLabel}
              api={api}
              openaiUsageByUuid={openaiUsageByUuid}
            />
          </ProviderSection>

          {/* Google Gemini section — per-node auth type + key binding (#3806) +
              the "Add key" button (the Gemini "+ Add" modal, #4464). */}
          <ProviderSection
            title="Google Gemini"
            testId="provider-section-google"
          >
            <GeminiSectionBody
              nodes={providerNodes}
              resolveNodeLabel={resolveNodeLabel}
              currentNodeId={currentNodeId}
              api={api}
              googleUsageRows={googleUsageRows}
            />
          </ProviderSection>

          {/* Provider API Keys (#1955's vault; #4906: moved here from the retired
              Keys page). The menu's Provider API Keys sub-row and old
              /settings/keys links land on this anchor; scroll-mt-14 clears the
              sticky header. */}
          <div id="api-keys" className="scroll-mt-14">
            <ProviderSection
              title="Provider API Keys"
              testId="provider-section-api-keys"
            >
              <ApiKeysSection />
            </ProviderSection>
          </div>

          {/* "This device & connection" footer (epic #1855, Sub G / #1862) —
              the Hapimatic CLIENT identity, absorbed from the removed Profile page.
              Rendered unconditionally so it shows in every page state. */}
          <DeviceConnectionFooter />

          <RemoveAccountsModal
            isOpen={removeOpen}
            onClose={() => setRemoveOpen(false)}
            accounts={removalRows}
            currentNodeId={currentNodeId}
            isPending={isRemovingFromNodes}
            onConfirm={removals =>
              removeAccountsFromNodes({ removals, currentNodeId, nodeLabels })
            }
          />
        </div>
      </div>
    </div>
  );
}
