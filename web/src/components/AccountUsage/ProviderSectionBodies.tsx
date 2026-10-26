// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The OpenAI (Codex) and Google Gemini section bodies of the Accounts page
 * (`/account-usage`), moved out of `routes/account-usage.tsx` by #3982 to keep the
 * route under its `max-lines` cap. #4466 builds the Gemini key cards on these
 * exports (it imports `GoogleUsageCounter` from here), so keep the names stable.
 */
import { useState } from "react";
import type {
  NodeProviderAuthState,
  OpenAiAuthState,
  ProviderAccountUsage,
} from "@hapi/protocol";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import type { ApiClient } from "@/api/client";
import { Button } from "@/components/ui/button";
import { AddAccountInstructions } from "@/components/AddAccountInstructions";
import { AddToProviderModal } from "@/components/AccountUsage/AddToProviderModal";
import { UsageBar } from "@/components/AccountUsage/UsageBar";
import { SortableAccountCard } from "@/components/AccountUsage/SortableAccountCard";
import { ProviderAccountCard } from "@/components/AccountUsage/ProviderAccountCard";
import {
  DRAG_ACTIVATION,
  GuardedPointerSensor,
  GuardedTouchSensor,
} from "@/components/SessionList/guardedDragSensors";
import {
  getStoredCustomOrder,
  orderByCustom,
  persistCustomOrder,
} from "@/lib/accountSort";
import { formatRelativeTime } from "@/lib/sessionHelpers";

// ── Non-Anthropic provider sections (issue #3806, epic #3345) ───────────────
// The OpenAI + Google Gemini sections render per-node DERIVED rows from the
// provider-auth-state envelope. Presentational + self-contained; they read only
// `NodeProviderAuthState[]` and a node-label resolver. NEVER render a token/key
// value — the envelope carries none (structural guarantee, R6).

export const OPENAI_MODE_LABEL: Record<string, string> = {
  chatgpt: "ChatGPT subscription",
  "api-key": "API key",
  unknown: "Unknown — run codex login status",
  none: "Not configured",
};
export const OPENAI_SOURCE_LABEL: Record<string, string> = {
  host: "Host login (~/.codex)",
  account: "Per-account",
};
export const GEMINI_AUTH_LABEL: Record<string, string> = {
  "api-key": "API key",
  "google-login": "Google login",
  vertex: "Vertex AI",
  none: "Not configured",
  unknown: "Unknown",
};
export const GEMINI_KEYSOURCE_LABEL: Record<string, string> = {
  vault: "Key: vault (this node)",
  "daemon-env": "Key: daemon env-file",
  none: "No key on this node",
};

export function ProviderDetailRow(props: {
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
export function OpenAiUsageMeter(props: { usage: ProviderAccountUsage }) {
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
export function GoogleUsageCounter(props: { usage: ProviderAccountUsage }) {
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

/**
 * #5739: the text of a node whose OWN provider-auth-state reader failed (row
 * `status:"error"`). It answered, so it is not "unreachable"; the page uses the
 * same phrase for a whole-request failure ("Couldn't load provider auth state").
 * Operator wording decision OD-1 on #5739.
 */
export const PROVIDER_NODE_ERROR_TEXT = "couldn't load provider auth state";

export function DegradedNodeRow(props: {
  nodeLabel: string;
  status: "unreachable" | "error";
}) {
  const isError = props.status === "error";
  return (
    <div
      className="rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 py-2"
      data-testid={
        isError ? "provider-node-error" : "provider-node-unreachable"
      }
    >
      <p className="text-[length:var(--text-body)] text-[var(--toast-warning)]">
        {props.nodeLabel}: {isError ? PROVIDER_NODE_ERROR_TEXT : "unreachable"}
      </p>
    </div>
  );
}

/** The detail rows of one Codex login (shared by the #3982 account card and the
 *  unmatched per-node row). Derived fields only — never a token. */
function OpenAiLoginDetails(props: {
  row: OpenAiAuthState;
  /** #3982: a ProviderAccountCard already names the email in Row 1. */
  showEmail?: boolean;
}) {
  const { row, showEmail = true } = props;
  return (
    <>
      <ProviderDetailRow
        label="Mode"
        value={OPENAI_MODE_LABEL[row.mode] ?? row.mode}
        testId="openai-mode"
      />
      {/* Email as a detail row ONLY when a label occupies the header,
          so a host login (header == email) never shows it twice. */}
      {showEmail && row.email && row.label && (
        <ProviderDetailRow label="Email" value={row.email} />
      )}
      {row.plan && <ProviderDetailRow label="Plan" value={row.plan} />}
      {row.expiresAt && (
        <ProviderDetailRow
          label="Expires"
          value={
            formatRelativeTime(new Date(row.expiresAt).getTime()) ??
            row.expiresAt
          }
        />
      )}
    </>
  );
}

export function OpenAiSectionBody(props: {
  nodes: NodeProviderAuthState[];
  resolveNodeLabel: (nodeId: string) => string;
  api: ApiClient | null;
  // Issue #3809 / #3982: the OpenAI providerUsage[] rows — one per STORED
  // account (federation-merged, keyed by accountUuid). Each renders as a
  // ProviderAccountCard; its auth-state detail is joined by accountUuid.
  openaiUsage: ProviderAccountUsage[];
  /** #3982: `usage.machines` labels → the node ids a NodeChip can target. */
  resolveNodes: (machines: string[]) => { nodeId: string; nodeLabel: string }[];
  /** #3982: drag start/end, so the page's pull-to-refresh stays gated. */
  onDragActiveChange?: (active: boolean) => void;
}) {
  const [wizardOpen, setWizardOpen] = useState(false);
  // #3982: the OpenAI section's own per-device drag order (a sibling key of the
  // Anthropic one). orderByCustom appends accounts the stored order lacks.
  const [customOrder, setCustomOrder] = useState<string[]>(() =>
    getStoredCustomOrder("openai")
  );
  const sensors = useSensors(
    useSensor(GuardedPointerSensor, { activationConstraint: DRAG_ACTIVATION }),
    useSensor(GuardedTouchSensor, { activationConstraint: DRAG_ACTIVATION }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );
  const cards = orderByCustom(
    props.openaiUsage,
    customOrder,
    u => u.accountUuid
  );
  const cardUuids = new Set(cards.map(u => u.accountUuid));
  // Auth-state detail per stored account: the first reachable node's row wins
  // (the same login reads identically on every node that holds it).
  // A uuid that is the host `~/.codex` login on any reachable node is the
  // read-only host row (D2) — unless some node also holds it as a per-account
  // login (a ChatGPT login reuses its PK): that store record is removable.
  const authByUuid = new Map<string, OpenAiAuthState>();
  const hostUuids = new Set<string>();
  const accountUuids = new Set<string>();
  for (const node of props.nodes) {
    if (node.status !== "ok") continue;
    for (const row of node.openai) {
      if (!row.accountUuid) continue;
      (row.source === "host" ? hostUuids : accountUuids).add(row.accountUuid);
      // A per-account row wins over a host row for the same uuid, so the caption
      // and detail rows describe the (removable) store record.
      const seen = authByUuid.get(row.accountUuid);
      if (!seen || (seen.source === "host" && row.source === "account")) {
        authByUuid.set(row.accountUuid, row);
      }
    }
  }
  const onDragEnd = (e: DragEndEvent) => {
    props.onDragActiveChange?.(false);
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    // The full rendered list, so every on-screen card is named in the order.
    const ids = cards.map(u => u.accountUuid);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    const next = arrayMove(ids, from, to);
    setCustomOrder(next);
    persistCustomOrder(next, "openai");
  };

  const anyRows =
    cards.length > 0 ||
    props.nodes.some(n => n.status === "ok" && n.openai.length > 0);
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
      {cards.length > 0 && (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={() => props.onDragActiveChange?.(true)}
          onDragCancel={() => props.onDragActiveChange?.(false)}
          onDragEnd={onDragEnd}
        >
          <SortableContext
            items={cards.map(u => u.accountUuid)}
            strategy={verticalListSortingStrategy}
          >
            <div className="flex flex-col gap-2">
              {cards.map(usage => {
                const auth = authByUuid.get(usage.accountUuid);
                const isHost =
                  hostUuids.has(usage.accountUuid) &&
                  !accountUuids.has(usage.accountUuid);
                return (
                  <SortableAccountCard
                    key={usage.accountUuid}
                    id={usage.accountUuid}
                  >
                    {({ dragHandle }) => (
                      <ProviderAccountCard
                        usage={usage}
                        email={auth?.email}
                        sourceLabel={
                          isHost
                            ? OPENAI_SOURCE_LABEL.host
                            : auth
                              ? (OPENAI_SOURCE_LABEL[auth.source] ??
                                auth.source)
                              : undefined
                        }
                        readOnly={isHost}
                        api={props.api}
                        nodes={props.resolveNodes(usage.machines)}
                        dragHandle={dragHandle}
                      >
                        {auth && (
                          <div className="mt-1.5">
                            <OpenAiLoginDetails row={auth} showEmail={false} />
                          </div>
                        )}
                        <OpenAiUsageMeter usage={usage} />
                      </ProviderAccountCard>
                    )}
                  </SortableAccountCard>
                );
              })}
            </div>
          </SortableContext>
        </DndContext>
      )}
      {props.nodes.map(node => {
        const nodeLabel = props.resolveNodeLabel(node.nodeId);
        if (node.status !== "ok") {
          return (
            <DegradedNodeRow
              key={node.nodeId}
              nodeLabel={nodeLabel}
              status={node.status}
            />
          );
        }
        // Logins with no stored record (keyring / unclassified, or a peer on an
        // older binary) keep the per-node display row — nothing to manage yet.
        const unmatched = node.openai.filter(
          row => !row.accountUuid || !cardUuids.has(row.accountUuid)
        );
        if (unmatched.length === 0) return null;
        return (
          <div key={node.nodeId} className="flex flex-col gap-2">
            {unmatched.map((row, i) => (
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
                <OpenAiLoginDetails row={row} />
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

export function GeminiSectionBody(props: {
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
        if (node.status !== "ok") {
          return (
            <DegradedNodeRow
              key={node.nodeId}
              nodeLabel={nodeLabel}
              status={node.status}
            />
          );
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
