// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The OpenAI (Codex) and Google Gemini section bodies of the Accounts page
 * (`/account-usage`), moved out of `routes/account-usage.tsx` by #3982 to keep the
 * route under its `max-lines` cap. #4466 puts both on the shared card contract:
 * OpenAI account cards then OpenAI key cards; Gemini key cards (each joined to
 * its Google usage row) then muted per-node auth lines. Adding lives in the
 * section header's "+ Add" pill, not here.
 */
import { useContext, useState } from "react";
import { LOCAL_NODE_ID } from "@hapi/protocol";
import type {
  NodeProviderAuthState,
  OpenAiAuthState,
  ProviderAccountUsage,
} from "@hapi/protocol";
import type { RedactedApiKey } from "@hapi/protocol/schemas";
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
import { UsageBar } from "@/components/AccountUsage/UsageBar";
import { ArcsView } from "@/components/AccountUsage/views/ArcsView";
import { ChipsView } from "@/components/AccountUsage/views/ChipsView";
import { buildUsageColumns } from "@/components/AccountUsage/views/usageMeters";
import { UsageViewContext } from "@/components/AccountUsage/views/UsageViewContext";
import { SortableAccountCard } from "@/components/AccountUsage/SortableAccountCard";
import { ProviderAccountCard } from "@/components/AccountUsage/ProviderAccountCard";
import { ApiKeyCard } from "@/components/AccountUsage/ApiKeyCard";
import type { AccountNodeItem } from "@/components/AccountUsage/AccountNodeRow";
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
import { pickUseFirstKeyId } from "@/lib/apiKeyBudget";

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
  // #4467: the OpenAI section's usage view, dispatched at the one site that
  // creates this card's meter element. The `unknown` hint and the "as of" line
  // render the same in every view (R1).
  const usageView = useContext(UsageViewContext) ?? "bars";
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
  const columns =
    usageView === "bars"
      ? null
      : buildUsageColumns(usage.utilization, "openai");
  return (
    <div
      className="mt-2 flex flex-col gap-1.5"
      data-testid="openai-usage-meter"
      data-usage-view={usageView}
    >
      {columns && usageView === "arcs" ? (
        <ArcsView columns={columns} />
      ) : columns ? (
        <ChipsView columns={columns} />
      ) : (
        <>
          <UsageBar label="5-hour" value={fiveHour} />
          <UsageBar label="Weekly" value={weekly} />
        </>
      )}
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
export function GoogleUsageCounter(props: {
  usage: ProviderAccountUsage;
  /** #4466: the two detail rows only — inside a key card, which is already the
   *  card layer and already names the key. */
  bare?: boolean;
}) {
  const { usage } = props;
  const spend = usage.tokenSpend;
  const rows = (
    <>
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
    </>
  );
  if (props.bare) {
    return <div data-testid="google-usage-counter-bare">{rows}</div>;
  }
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
      {rows}
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
  /** #4466 R6: one account's node-row items (A's read merged with `machines`). */
  resolveNodeItems: (usage: ProviderAccountUsage) => AccountNodeItem[];
  /** #4466 R9a: this node's OpenAI vault keys, rendered after the accounts. */
  keys: RedactedApiKey[];
  /** The node serving this UI (where a vault key is stored). */
  localNode: { nodeId?: string; nodeLabel: string };
  /** #4466 R12: the page's expand/collapse-all reaches every card. */
  allExpanded: boolean;
  genId: number;
  /** #4466 R8: open the single-account removal for this account. */
  onRemove?: (usage: ProviderAccountUsage) => void;
  /** #3982: drag start/end, so the page's pull-to-refresh stays gated. */
  onDragActiveChange?: (active: boolean) => void;
}) {
  // API key budgets: the OpenAI key whose credit is most at risk of expiring.
  const useFirstId = pickUseFirstKeyId(props.keys, Date.now());
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
  // D2: a host login only reads as one once its node's auth state is in. While
  // that read is loading or failed, or the node is unreachable, a host login looks
  // like any store record, so a card offers Remove only when every node its
  // removal would target answered `ok`. A label that resolves to no node is never
  // a removal target (the modal says so), so it does not withhold Remove. The UI
  // host's row may carry the LOCAL_NODE_ID sentinel.
  const okNodeIds = new Set(
    props.nodes.filter(n => n.status === "ok").map(n => n.nodeId)
  );
  const authKnownOn = (items: AccountNodeItem[]): boolean =>
    items.every(
      i =>
        i.nodeId === undefined ||
        okNodeIds.has(i.nodeId) ||
        (i.nodeId === props.localNode.nodeId && okNodeIds.has(LOCAL_NODE_ID))
    );
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
    props.keys.length > 0 ||
    props.nodes.some(n => n.status === "ok" && n.openai.length > 0);
  const allReachableNoLogin =
    !anyRows && props.nodes.every(n => n.status === "ok");

  if (allReachableNoLogin) {
    // #4466 R10: the add paths live in the header's "+ Add" pill and the
    // "Other ways to add" popover; the empty section is one muted line.
    return (
      <p
        className="text-[length:var(--text-body)] text-[var(--app-hint)]"
        data-testid="provider-section-openai-empty"
      >
        No OpenAI account on any node yet — use + Add
      </p>
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
                const nodeItems = props.resolveNodeItems(usage);
                const removable = !isHost && authKnownOn(nodeItems);
                return (
                  <SortableAccountCard
                    key={`${usage.accountUuid}:${props.genId}`}
                    id={usage.accountUuid}
                  >
                    {({ dragHandle }) => (
                      <ProviderAccountCard
                        usage={usage}
                        email={auth?.email}
                        plan={auth?.plan}
                        mode={auth?.mode}
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
                        nodeItems={nodeItems}
                        dragHandle={dragHandle}
                        defaultExpanded={props.allExpanded}
                        onRemove={
                          props.onRemove && removable
                            ? () => props.onRemove?.(usage)
                            : undefined
                        }
                      >
                        {auth && (
                          <OpenAiLoginDetails row={auth} showEmail={false} />
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
      {/* R9a: the OpenAI vault keys follow the accounts — outside the drag
          context, in vault order. */}
      {props.keys.map(key => (
        <ApiKeyCard
          key={`${key.id}:${props.genId}`}
          apiKey={key}
          api={props.api}
          localNode={props.localNode}
          defaultExpanded={props.allExpanded}
          useFirst={key.id === useFirstId}
        />
      ))}
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
    </div>
  );
}

/**
 * #4466 R9b: a peer node's Gemini key, known only from its Google usage row (the
 * key list is the UI host's vault), shaped as a key for its read-only card. The
 * card shows no status, masked key or date, so those carry neutral values.
 */
function peerKeyFromUsage(row: ProviderAccountUsage): RedactedApiKey {
  return {
    id: row.accountUuid,
    provider: "gemini",
    accountUuid: row.accountUuid,
    label: row.nickname?.trim() || row.displayLabel,
    maskedKey: "",
    createdAt: "",
    status: "none",
  };
}

/**
 * #4466 R9b: the Google usage rows that are a PEER node's key — rows whose
 * `accountUuid` matches no local key and whose `machines` names a node other
 * than the UI host. An unmatched row that names only the UI host belongs to a
 * key just removed here and is dropped. Shared by the section body and the
 * section header's key count.
 */
export function geminiPeerRows(
  rows: ProviderAccountUsage[],
  keys: RedactedApiKey[],
  uiHostLabel: string
): { row: ProviderAccountUsage; peer: string }[] {
  const keyUuids = new Set(
    keys.map(k => k.accountUuid).filter((u): u is string => Boolean(u))
  );
  const out: { row: ProviderAccountUsage; peer: string }[] = [];
  for (const row of rows) {
    if (keyUuids.has(row.accountUuid)) continue;
    const peer = row.machines.find(m => m !== uiHostLabel);
    if (peer) out.push({ row, peer });
  }
  return out;
}

export function GeminiSectionBody(props: {
  nodes: NodeProviderAuthState[];
  resolveNodeLabel: (nodeId: string) => string;
  currentNodeId: string;
  api: ApiClient | null;
  // Issue #3809: the Google providerUsage[] counter rows (account-keyed, not
  // node-keyed like the auth rows). #4466 R9b joins each to its key card.
  googleUsageRows: ProviderAccountUsage[];
  /** #4466 R9a: this node's gemini/google vault keys. */
  keys: RedactedApiKey[];
  /** The node serving this UI (where a vault key is stored). */
  localNode: { nodeId?: string; nodeLabel: string };
  /** #4466 R12: the page's expand/collapse-all reaches every card. */
  allExpanded: boolean;
  genId: number;
}) {
  // R9b: each Gemini key appears once. A usage row whose accountUuid matches a
  // local key feeds that key's card; the rest are peer keys (geminiPeerRows).
  const usageByUuid = new Map(
    props.googleUsageRows.map(row => [row.accountUuid, row])
  );
  const peerRows = geminiPeerRows(
    props.googleUsageRows,
    props.keys,
    props.localNode.nodeLabel
  );
  const peerNodes = new Set(peerRows.map(p => p.peer));

  return (
    <div className="flex flex-col gap-3">
      {props.keys.length > 0 || peerRows.length > 0 ? (
        <div className="flex flex-col gap-2" data-testid="gemini-key-cards">
          {props.keys.map(key => {
            const usage = key.accountUuid
              ? usageByUuid.get(key.accountUuid)
              : undefined;
            return (
              <ApiKeyCard
                key={`${key.id}:${props.genId}`}
                apiKey={key}
                api={props.api}
                localNode={props.localNode}
                defaultExpanded={props.allExpanded}
              >
                {usage ? <GoogleUsageCounter usage={usage} bare /> : undefined}
              </ApiKeyCard>
            );
          })}
          {peerRows.map(({ row, peer }) => (
            <ApiKeyCard
              key={`${row.accountUuid}:${props.genId}`}
              apiKey={peerKeyFromUsage(row)}
              api={props.api}
              localNode={props.localNode}
              defaultExpanded={props.allExpanded}
              readOnlyRemote={{ nodeLabel: peer }}
            >
              <GoogleUsageCounter usage={row} bare />
            </ApiKeyCard>
          ))}
        </div>
      ) : null}
      {/* R9c: each node's Gemini auth that is not a listed vault key, as a muted
          detail line beneath the key list. */}
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
        // An unconfigured node (no auth chosen, nothing bound) is EMPTY, not an
        // auth to describe. A peer that is empty and shows no key card here
        // reads "No Gemini key on <node> yet"; the UI host's add is "+ Add".
        const empty =
          g == null ||
          (!g.bound &&
            (g.selectedAuthType === "none" ||
              g.selectedAuthType === "unknown"));
        // A vault API key normally shows as a key card — the UI host's from its
        // vault, a peer's from its Google usage row. When no card stands for
        // this node's key (a peer on an older binary that mints no account, a
        // failed usage read), the auth line keeps the node visible.
        const keyCardShown = isLocal
          ? props.keys.length > 0
          : peerNodes.has(nodeLabel);
        const showLine =
          !empty &&
          g != null &&
          (g.selectedAuthType !== "api-key" ||
            g.keySource !== "vault" ||
            !keyCardShown);
        const peerEmpty = !isLocal && empty && !peerNodes.has(nodeLabel);
        if (!showLine && !peerEmpty) return null;
        return (
          <div key={node.nodeId} className="flex flex-col gap-1">
            {showLine && g ? (
              <p
                className="text-[length:var(--text-body-dense)] text-[var(--app-hint)]"
                data-testid="gemini-node-row"
              >
                {`${nodeLabel}: `}
                <span data-testid="gemini-auth-type">
                  {GEMINI_AUTH_LABEL[g.selectedAuthType] ?? g.selectedAuthType}
                </span>
                {` · ${GEMINI_KEYSOURCE_LABEL[g.keySource] ?? g.keySource}`}
              </p>
            ) : null}
            {peerEmpty ? (
              <p
                className="text-[length:var(--text-body-dense)] text-[var(--app-hint)]"
                data-testid="provider-section-google-peer-empty"
              >
                No Gemini key on {nodeLabel} yet
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
