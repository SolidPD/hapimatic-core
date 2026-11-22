// SPDX-License-Identifier: AGPL-3.0-only
/**
 * AccountNodeRow — the nodes an account is on, in its expanded card (issue
 * #4466 R6 + R7; issue #6161 NP-1 / NP-2: pattern C, the health strip).
 *
 * Collapsed (the default) it is ONE line whatever the node count, so the card
 * keeps one height at 1, 6 and 25 nodes: a chevron, the node count with a
 * fixed-width strip of one cell per node (`HealthStrip`; colour = the node's
 * state, worst first, so it reads as a stacked bar), then the attention text.
 * The text is bounded by the states, never by the count: a state with one node
 * names it as its pill (re-login, ending, quarantined), a state with more shows
 * a count ("2 ending"), and an account on one node shows that node's pill and
 * sign-in age token. It ellipsizes rather than wrapping.
 *
 * The chevron expands the card in place to tiles (each its own rounded box, 4 px
 * apart — `brand-visual-language.md` R10-a): the nodes that need attention as
 * full-width rows (pill, sign-in age token or countdown, the state, and "Sign in
 * again"), then the running nodes as a compact grid (pill, age token, and
 * "default" or the "set default" link).
 *
 * Node states (`lib/memberHealth.ts`), worst first:
 * - **re-login** (#4461's `needsRelogin`): red ring; the pill's tap and the
 *   tile's button open the "+ Add" modal on that node (`requestRelogin`).
 * - **due / ending** (#6161 R10, inside the 3-day window): amber ring and the
 *   countdown; the same tap and button.
 * - **quarantined** (#6800's host-chain hold): a grey ring at 75 % (NodeBadge
 *   `held`). The record also needs a new sign-in (`needsRelogin`), so its pill
 *   and tile keep the re-login.
 * - **running**: the node's default (`set`, or `expired` when the default is the
 *   unrefreshable record) carries a mint ring and a "default" caption; any other
 *   online node offers "set default" (#3973's confirm and toast), gated by
 *   `canSetDefault` and `disableSetActive`.
 * - **not read**: a `machines` label whose node this page has not read (offline,
 *   or the read still loading); never painted as running.
 *
 * The row reads the minute clock itself (an ending node turns amber without a
 * data change); its parents never do (#6801 Key Decision 15).
 */
import { useState } from "react";
import {
  displayNodeLabel,
  type NodeAccountHealth,
  type ProviderId,
  type SignInAgeInput,
  type SignInEnding,
} from "@hapi/protocol";
import type { ApiClient } from "@/api/client";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { HealthStrip } from "@/components/ui/HealthStrip";
import { HoverTooltipButton } from "@/components/ui/tooltip";
import { ChevronIcon } from "@/components/icons";
import { NodeBadge } from "@/components/NodeBadge";
import { useNodeActiveAccount } from "@/hooks/queries/useNodeActiveAccount";
import { useAccountActions } from "@/hooks/mutations/useAccountActions";
import { requestRelogin } from "@/lib/reloginLink";
import { daysLeftPhrase, pickSignInAgeInput } from "@/lib/signInAge";
import { useMinuteNow } from "@/lib/pins/useMinuteNow";
import {
  attentionBuckets,
  bucketMembers,
  isAttentionState,
  memberHealthTone,
  memberHealthTooltipLines,
  memberStateWords,
  MEMBER_BUCKET_TEXT_CLASS,
  signInMemberState,
  sortWorstFirst,
  type MemberHealthState,
} from "@/lib/memberHealth";
import { SignInAgeToken } from "./SignInAgeToken";
import { SignInAgainButton } from "./SignInAgainButton";

export type AccountNodeItem = {
  /** Absent ⇒ a `machines` label that resolves to no known node (plain label). */
  nodeId?: string;
  nodeLabel: string;
  /** The peer's URL (`remoteNodes`), for the casing rule; absent for the UI host. */
  nodeUrl?: string;
  nodeStatus?: "online" | "degraded" | "offline";
  /** #4461: this node's record for the account needs a re-login. */
  needsRelogin: boolean;
  /** The node serving this UI (its label is passed through as received). */
  isUiHost?: boolean;
  /**
   * #6801: this node's record for the account, for the sign-in age token.
   * Absent for a `machines` label, which has no health entry.
   */
  signIn?: SignInAgeInput;
};

/** A resolved node: its id and its label. */
export type NodeRef = { nodeId: string; nodeLabel: string };

/** What the page knows about a node beyond its id: its URL, its connectivity,
 *  and whether it serves this UI. */
export type NodeFacts = Pick<
  AccountNodeItem,
  "nodeUrl" | "nodeStatus" | "isUiHost"
>;

/**
 * The node row's items for one account (#4466 R6): every node whose account
 * health read is `ok` and lists the account (with its `needsRelogin`, which
 * only an Anthropic record carries), then any node the usage row's `machines`
 * names that the read did not cover — while it loads, or for a node it could
 * not read. An `ok` read with no rejected entries lists every record on its
 * node (every provider), so a node it read without this account does not hold
 * it, even when a stale `machines` label still names it. A label that resolves
 * to no known node
 * stays as a plain item.
 * `fallbackNode` is the implicit local node of a non-federated install, whose
 * usage rows carry no `machines` (D2).
 */
export function buildAccountNodeItems(input: {
  provider: ProviderId;
  accountUuid: string;
  machines: string[];
  resolveLabel: (label: string) => NodeRef | undefined;
  fallbackNode?: NodeRef;
  healthNodes: NodeAccountHealth[];
  describe: (nodeId: string) => NodeFacts;
}): AccountNodeItem[] {
  const items: AccountNodeItem[] = [];
  const seenIds = new Set<string>();
  const seenLabels = new Set<string>();
  // Nodes A read in full: authoritative for whether they hold the account. A
  // read that dropped malformed entries (`rejectedEntries`) proves only what it
  // lists, so a `machines` label may still name its node.
  const readIds = new Set<string>();
  for (const row of input.healthNodes) {
    if (row.status !== "ok") continue;
    if (!row.rejectedEntries) readIds.add(row.nodeId);
    const entry = row.accounts.find(
      e => e.provider === input.provider && e.accountUuid === input.accountUuid
    );
    if (!entry || seenIds.has(row.nodeId)) continue;
    seenIds.add(row.nodeId);
    seenLabels.add(row.nodeLabel);
    const facts = input.describe(row.nodeId);
    items.push({
      nodeId: row.nodeId,
      nodeLabel: row.nodeLabel,
      ...facts,
      isUiHost: row.isLocal || facts.isUiHost === true,
      needsRelogin: input.provider === "anthropic" && entry.needsRelogin,
      signIn: pickSignInAgeInput(entry),
    });
  }
  const labels =
    input.machines.length > 0
      ? input.machines
      : input.fallbackNode
        ? [input.fallbackNode.nodeLabel]
        : [];
  for (const label of labels) {
    const node =
      input.resolveLabel(label) ??
      (input.machines.length === 0 ? input.fallbackNode : undefined);
    if (node) {
      if (seenIds.has(node.nodeId) || readIds.has(node.nodeId)) continue;
      seenIds.add(node.nodeId);
      seenLabels.add(node.nodeLabel);
      items.push({
        nodeId: node.nodeId,
        nodeLabel: node.nodeLabel,
        ...input.describe(node.nodeId),
        needsRelogin: false,
      });
    } else if (!seenLabels.has(label)) {
      seenLabels.add(label);
      items.push({ nodeLabel: label, needsRelogin: false });
    }
  }
  return items;
}

export type AccountNodeRowProps = {
  items: AccountNodeItem[];
  accountUuid: string;
  /** Names the account in the set-default confirm. */
  accountLabel: string;
  provider: ProviderId;
  api: ApiClient | null;
  disableSetActive?: boolean;
  /** Whether a "set default" caption may render (default true). */
  canSetDefault?: boolean;
};

/** One node of the account with its state at `now` (#6161 NP-1). */
export type AccountNodeMember = {
  item: AccountNodeItem;
  /** The node id, or the unresolved label. */
  key: string;
  state: MemberHealthState;
  /** Whole days left, for an ending node. */
  daysLeft?: number;
  ending: SignInEnding | null;
  /** The pill's tap and the tile's button open the re-login for this node. */
  canRelogin: boolean;
};

/**
 * A node's state for this account at `now`. A node the page has not read (a
 * `machines` label, or an unresolved one) is `unread`; a quarantined record is
 * `quarantined` even though it also needs a re-login; then re-login; then the
 * one warning-window rule (`computeSignInEnding`); else running.
 */
export function accountNodeMember(
  item: AccountNodeItem,
  now: number
): AccountNodeMember {
  const key = item.nodeId ?? `label:${item.nodeLabel}`;
  if (!item.nodeId || (item.signIn === undefined && !item.needsRelogin)) {
    return { item, key, state: "unread", ending: null, canRelogin: false };
  }
  // The one state rule, shared with the node card's account row (#6884 R5).
  return {
    item,
    key,
    ...signInMemberState(
      { signIn: item.signIn, needsRelogin: item.needsRelogin },
      now
    ),
  };
}

/** The label the pill shows (the system casing rule), for tooltips. */
export function shownNodeLabel(item: AccountNodeItem): string {
  return item.isUiHost
    ? item.nodeLabel
    : displayNodeLabel(item.nodeLabel, { url: item.nodeUrl });
}

/** The members' shown labels, comma-separated (a count's tooltip). */
function nodeNames(members: AccountNodeMember[]): string {
  return members.map(m => shownNodeLabel(m.item)).join(", ");
}

/** The pill's sentence for a node that needs attention, else undefined. */
function pillTitle(member: AccountNodeMember): string | undefined {
  // The label as received, as the age token and R10's wording name it.
  const label = member.item.nodeLabel;
  const tap = member.canRelogin ? " · tap to sign in again" : "";
  switch (member.state) {
    case "relogin":
      return `Re-login required on ${label} · tap to log in there`;
    case "due":
      return `Sign-in on ${label} reached its end date${tap}`;
    case "ending":
      return `Sign-in on ${label} ends in ${daysLeftPhrase(member.daysLeft ?? 0, member.ending?.estimated === true)}${tap}`;
    case "quarantined":
      return `Quarantined on ${label}: its login was shared with a host's ~/.claude, so Hapimatic holds it until a new sign-in${tap}`;
    default:
      return undefined;
  }
}

/**
 * The node pill: its ring from its state (red re-login, amber ending, grey
 * quarantined, mint default), and a tap that opens the re-login when the node
 * needs one (#6161 R10), else Node Health.
 */
function NodePill(props: {
  member: AccountNodeMember;
  accountUuid: string;
  isDefault: boolean;
}) {
  const { member, accountUuid, isDefault } = props;
  const { item } = member;
  if (!item.nodeId) {
    return (
      <span
        data-testid="account-node-unresolved"
        title={`${item.nodeLabel}: not a known node`}
        className="shrink-0 text-[length:var(--text-caption)] leading-tight text-[var(--app-hint)]"
      >
        {item.nodeLabel}
      </span>
    );
  }
  const nodeId = item.nodeId;
  const ring =
    member.state === "relogin"
      ? "alert"
      : member.state === "due" || member.state === "ending"
        ? "warn"
        : member.state === "quarantined"
          ? "held"
          : isDefault
            ? "default"
            : undefined;
  return (
    <span className="inline-flex shrink-0 align-middle">
      <NodeBadge
        nodeId={nodeId}
        nodeLabel={item.nodeLabel}
        nodeUrl={item.nodeUrl}
        nodeStatus={item.nodeStatus}
        labelAsReceived={item.isUiHost === true}
        ring={ring}
        title={pillTitle(member)}
        onActivate={
          member.canRelogin
            ? () =>
                requestRelogin({ provider: "anthropic", nodeId, accountUuid })
            : undefined
        }
      />
    </span>
  );
}

type RowContext = {
  accountUuid: string;
  accountLabel: string;
  provider: ProviderId;
  api: ApiClient | null;
  disableSetActive: boolean;
  canSetDefault: boolean;
};

/** Whether this account is the node's default (`set`, or `expired`). */
function useIsNodeDefault(ctx: RowContext, nodeId: string | undefined) {
  const scopedProvider =
    ctx.provider === "anthropic" ? undefined : ctx.provider;
  // The same per-node read as before #6161 NP-1 (disabled without a node id).
  const { account: active, status } = useNodeActiveAccount(
    ctx.api,
    nodeId ?? "",
    scopedProvider ? { provider: scopedProvider } : undefined
  );
  // The hook reports "expired" for an unrefreshable default; it is still THE
  // default (R7).
  return (
    active?.accountUuid === ctx.accountUuid &&
    (status === "set" || status === "expired")
  );
}

/**
 * One node's tile, its own rounded box. `wide` (a node that needs attention):
 * full width, with the pill, the sign-in age token (the countdown while
 * ending), the state, and "Sign in again" (R10). Otherwise a compact grid tile:
 * the pill and the token. Both keep R7: "default" on the node whose default
 * this account is, else "set default" (an online node, gated by
 * `canSetDefault` and `disableSetActive`, whatever its state, as before).
 */
function NodeTile(props: {
  member: AccountNodeMember;
  ctx: RowContext;
  wide: boolean;
}) {
  const { member, ctx, wide } = props;
  const { item } = member;
  const isDefault = useIsNodeDefault(ctx, item.nodeId);
  const scopedProvider =
    ctx.provider === "anthropic" ? undefined : ctx.provider;
  const { selectAccount, isPending } = useAccountActions(ctx.api, {
    nodeId: item.nodeId,
    nodeLabel: item.nodeLabel,
  });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const showSetDefault =
    item.nodeId != null &&
    !isDefault &&
    item.nodeStatus !== "offline" &&
    ctx.api != null &&
    ctx.canSetDefault &&
    !ctx.disableSetActive;
  const words = memberStateWords(member.state);
  return (
    <div
      data-testid={`account-node-${member.key}`}
      data-state={member.state}
      data-default={isDefault ? "true" : undefined}
      className={`flex min-w-0 items-center gap-1.5 rounded-md border border-[var(--app-border)] ${
        wide ? "h-8 pl-1.5 pr-1" : "h-7 px-1.5"
      }`}
    >
      <NodePill
        member={member}
        accountUuid={ctx.accountUuid}
        isDefault={isDefault}
      />
      {member.state === "unread" ? (
        <span className="min-w-0 truncate text-[length:var(--text-caption-xs)] text-[var(--app-hint)]">
          not read
        </span>
      ) : (
        <SignInAgeToken
          entry={item.signIn}
          nodeLabel={item.nodeLabel}
          surface="node-row"
        />
      )}
      {wide ? (
        <span
          data-testid="account-node-state-words"
          className={`min-w-0 flex-1 truncate text-[length:var(--text-caption-xs)] ${words.className}`}
        >
          <span className={words.phoneHidden ? "max-sm:hidden" : undefined}>
            {words.text}
          </span>
        </span>
      ) : null}
      {isDefault ? (
        <span
          data-testid="account-node-default"
          title={`${ctx.accountLabel} is the default account on ${shownNodeLabel(item)}`}
          className={`${wide ? "" : "ml-auto "}shrink-0 text-[length:var(--text-caption-xs)] leading-none text-[var(--app-accent)]`}
        >
          default
        </span>
      ) : showSetDefault ? (
        <>
          <Button
            type="button"
            variant="ghostStatic"
            size="bare"
            data-testid="account-node-set-default"
            onClick={e => {
              e.stopPropagation();
              setConfirmOpen(true);
            }}
            title="Set as Default Acct on Node"
            className={`${wide ? "" : "ml-auto "}shrink-0 text-[length:var(--text-caption-xs)] font-normal leading-none text-[var(--app-link)] hover:text-[var(--app-link)] hover:opacity-80`}
          >
            set default
          </Button>
          <ConfirmDialog
            isOpen={confirmOpen}
            onClose={() => setConfirmOpen(false)}
            title="Set active account?"
            description={`Make ${ctx.accountLabel} the active account for ${item.nodeLabel}. New sessions on this node will use it — your running sessions are not affected.`}
            confirmLabel="Set active"
            confirmingLabel="Setting…"
            onConfirm={async () => {
              if (scopedProvider) {
                await selectAccount(ctx.accountUuid, {
                  provider: scopedProvider,
                });
              } else {
                await selectAccount(ctx.accountUuid);
              }
            }}
            isPending={isPending}
          />
        </>
      ) : null}
      {wide && member.canRelogin && item.nodeId ? (
        <SignInAgainButton
          nodeId={item.nodeId}
          nodeLabel={shownNodeLabel(item)}
          accountUuid={ctx.accountUuid}
          accountLabel={ctx.accountLabel}
          data-testid="account-node-sign-in-again"
        />
      ) : null}
    </div>
  );
}

/** The one-member summary: the node's pill (with its default ring) and token. */
function SinglePill(props: { member: AccountNodeMember; ctx: RowContext }) {
  const { member, ctx } = props;
  const isDefault = useIsNodeDefault(ctx, member.item.nodeId);
  return (
    <span className="inline-flex items-center gap-1.5 align-middle">
      <NodePill
        member={member}
        accountUuid={ctx.accountUuid}
        isDefault={isDefault}
      />
      {member.state === "unread" ? (
        <span className="text-[var(--app-hint)]">not read</span>
      ) : (
        <SignInAgeToken
          entry={member.item.signIn}
          nodeLabel={member.item.nodeLabel}
          surface="node-row"
        />
      )}
    </span>
  );
}

/**
 * The attention text: each state that needs attention, worst first — one node
 * as its pill and a word, more as a count with its names in a tooltip. With no
 * attention: "all running", or the running and not-read counts.
 */
function AttentionText(props: {
  members: AccountNodeMember[];
  ctx: RowContext;
}) {
  const { members, ctx } = props;
  if (members.length === 1) {
    return <SinglePill member={members[0]} ctx={ctx} />;
  }
  const attention = attentionBuckets(members);
  if (attention.length === 0) {
    const buckets = bucketMembers(members);
    if (buckets.length === 1 && buckets[0].key === "running") {
      return <span className="text-[var(--status-ok)]">all running</span>;
    }
    return (
      <>
        {buckets.map((b, i) => (
          <span key={b.key}>
            {i > 0 ? (
              <span className="mx-1 text-[var(--app-hint)]">·</span>
            ) : null}
            <span className={MEMBER_BUCKET_TEXT_CLASS[b.key]}>
              {b.members.length} {b.many}
            </span>
          </span>
        ))}
      </>
    );
  }
  return (
    <>
      {attention.map((b, i) => (
        <span key={b.key} data-testid={`account-node-summary-${b.key}`}>
          {i > 0 ? (
            <span className="mx-1 text-[var(--app-hint)]">·</span>
          ) : null}
          {b.members.length === 1 ? (
            <>
              <NodePill
                member={b.members[0]}
                accountUuid={ctx.accountUuid}
                isDefault={false}
              />
              <span className={`ml-1 ${MEMBER_BUCKET_TEXT_CLASS[b.key]}`}>
                {b.one}
              </span>
            </>
          ) : (
            <HoverTooltipButton
              type="button"
              content={nodeNames(b.members)}
              aria-label={`${b.members.length} ${b.title}: ${nodeNames(b.members)}`}
              onClick={e => e.stopPropagation()}
              onPointerDown={e => e.stopPropagation()}
              className={`inline ${MEMBER_BUCKET_TEXT_CLASS[b.key]}`}
            >
              {b.members.length} {b.many}
            </HoverTooltipButton>
          )}
        </span>
      ))}
    </>
  );
}

export function AccountNodeRow(props: AccountNodeRowProps) {
  const {
    items,
    accountUuid,
    accountLabel,
    provider,
    api,
    disableSetActive = false,
    canSetDefault = true,
  } = props;
  const now = useMinuteNow();
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  const ctx: RowContext = {
    accountUuid,
    accountLabel,
    provider,
    api,
    disableSetActive,
    canSetDefault,
  };
  const members = sortWorstFirst(items.map(i => accountNodeMember(i, now)));
  const nodesWord = members.length === 1 ? "node" : "nodes";
  const tipLines = memberHealthTooltipLines(
    members,
    m => shownNodeLabel(m.item),
    `${accountLabel} · ${members.length} ${nodesWord}`
  );
  const attention = members.filter(m => isAttentionState(m.state));
  const rest = members.filter(m => !isAttentionState(m.state));
  return (
    <div data-testid="account-node-row" data-open={open ? "true" : "false"}>
      <div
        data-testid="account-node-summary"
        className="flex h-7 min-w-0 items-center gap-1.5"
      >
        <Button
          type="button"
          variant="ghostStatic"
          size="bare"
          data-testid="account-node-toggle"
          aria-expanded={open}
          aria-label={`${open ? "Hide" : "Show"} ${accountLabel}'s ${members.length} ${nodesWord}`}
          title={`${open ? "Hide" : "Show"} the ${nodesWord}`}
          onClick={e => {
            e.stopPropagation();
            setOpen(o => !o);
          }}
          className="h-6 w-5 shrink-0 justify-center rounded-sm hover:bg-[var(--app-hover)]"
        >
          <ChevronIcon
            className="h-3.5 w-3.5 text-[var(--app-hint)]"
            collapsed={!open}
          />
        </Button>
        <HealthStrip
          tones={members.map(m => memberHealthTone(m.state))}
          tooltip={
            <div className="flex flex-col gap-0.5">
              {tipLines.map((line, i) => (
                <span key={i}>{line}</span>
              ))}
            </div>
          }
          aria-label={`${members.length} ${nodesWord}: ${tipLines.slice(1).join("; ")}`}
          data-testid="account-node-strip"
        />
        <span
          data-testid="account-node-summary-text"
          // A chip the line cannot fit fades out at the edge (CSS ellipsis
          // only applies to text), instead of being cut mid-label.
          className="block min-w-0 flex-1 truncate text-[length:var(--text-caption)] leading-7 [mask-image:linear-gradient(90deg,black_calc(100%_-_1rem),transparent)]"
        >
          <AttentionText members={members} ctx={ctx} />
        </span>
      </div>
      {open ? (
        <div
          data-testid="account-node-tiles"
          className="flex flex-col gap-1 pb-1 pt-0.5"
        >
          {attention.map(m => (
            <NodeTile key={m.key} member={m} ctx={ctx} wide />
          ))}
          {rest.length > 0 ? (
            <div
              data-testid="account-node-grid"
              className="grid grid-cols-[repeat(auto-fill,minmax(172px,1fr))] gap-1" /* design-tokens-allow: the running-tile column width (pattern C, #6161 NP-1): the widest pill + "29d left" or "not read" + "set default" (one column on a phone) */
            >
              {rest.map(m => (
                <NodeTile key={m.key} member={m} ctx={ctx} wide={false} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
