// SPDX-License-Identifier: AGPL-3.0-only
/**
 * NodeAccountRow — the accounts signed in on one node, on its federation node
 * card (issue #6884: #6161's pattern C, the health strip, in reverse; the
 * forward view is `AccountUsage/AccountNodeRow`).
 *
 * Collapsed it is ONE line whatever the account count, so the card keeps one
 * height at 1, 6 and 25 accounts: a chevron, the account count with a strip of
 * one cell per account (`HealthStrip`, worst first), then the attention text.
 * A state with one account names it as its chip, a state with more shows a
 * count, and a node with one account shows that account's chip and age.
 *
 * The chevron expands the line in place to tiles, each its own rounded box 4 px
 * apart (R10-a): the accounts that need attention as full-width rows (chip,
 * age or countdown, the state, "Sign in again"), then the running accounts as
 * a grid of two per row on a phone and three at 1280 (Matt's V1 = C: no "set
 * default" on a tile; the default account keeps its mint ring and the card's
 * Active Account Switch stays the way to change it).
 *
 * The members are the node's Anthropic records only, every auth kind (Q1);
 * their state is the one rule in `lib/memberHealth.ts` (R5).
 *
 * Chip taps (ruling NAME-2, the #6161 node-pill precedent):
 * - a chip whose account can sign in again (re-login, due, ending, quarantined
 *   with a re-login) opens that re-login on any pointer, and its sentence is
 *   its hover title; there is no tap bubble on touch. Its full nickname stays
 *   readable on touch in its own full-width row, where the chip gets the
 *   row's width.
 * - every other chip (running, quarantined without a re-login) opens a tap
 *   bubble on touch (hover on a mouse) whose sentence starts with the account's
 *   full nickname, so a nickname cut in the grid is one tap from readable.
 *
 * No control here opens the node: each stops `click` and `pointerdown`, and the
 * card ignores a key that is not on the card itself.
 *
 * The row reads the minute clock itself; its parents never do (#6801 Key
 * Decision 15). It runs no query of its own: the page passes the node's
 * account-health row and the account labels, so the card renders without a
 * query client.
 */
import { useState, type SyntheticEvent } from "react";
import type {
  AccountHealthEntry,
  AccountMonogram,
  NodeAccountHealth,
  SignInAgeInput,
} from "@hapi/protocol";
import type { ApiClient } from "@/api/client";
import { Button } from "@/components/ui/button";
import { HealthStrip } from "@/components/ui/HealthStrip";
import { HoverTooltipButton } from "@/components/ui/tooltip";
import { ChevronIcon } from "@/components/icons";
import {
  AccountChip,
  accountShortName,
} from "@/components/session/AccountChip";
import { SignInAgeToken } from "@/components/AccountUsage/SignInAgeToken";
import { SignInAgainButton } from "@/components/AccountUsage/SignInAgainButton";
import type { AccountLabelSource } from "@/hooks/queries/useAccountLabels";
import { useNodeActiveAccount } from "@/hooks/queries/useNodeActiveAccount";
import type { AttentionRing } from "@/lib/attentionRing";
import {
  attentionBuckets,
  isAttentionState,
  MEMBER_BUCKET_TEXT_CLASS,
  memberHealthTone,
  memberHealthTooltipLines,
  memberStateWords,
  signInMemberState,
  sortWorstFirst,
  type SignInMemberState,
} from "@/lib/memberHealth";
import { useMinuteNow } from "@/lib/pins/useMinuteNow";
import { requestRelogin } from "@/lib/reloginLink";
import { daysLeftPhrase, pickSignInAgeInput } from "@/lib/signInAge";

/** One account on the node, with its state at `now`. */
export type NodeAccountMember = SignInMemberState & {
  entry: AccountHealthEntry;
  /** The account uuid. */
  key: string;
  /** The full nickname (never cut here; the chip ellipsizes by width only). */
  label: string;
  monogram?: AccountMonogram;
  signIn: SignInAgeInput;
};

/**
 * One account's member. Its name: the UI host's nickname (`/api/accounts`),
 * else the node's own `nickname` (an account held only by a peer), else the
 * email's local part. Its monogram likewise.
 */
export function nodeAccountMember(
  entry: AccountHealthEntry,
  labels: ReadonlyMap<string, AccountLabelSource>,
  now: number
): NodeAccountMember {
  const host = labels.get(entry.accountUuid);
  const label =
    host?.nickname?.trim() ||
    (entry.nickname ?? "").trim() ||
    accountShortName(entry.emailAddress);
  const signIn = pickSignInAgeInput(entry);
  return {
    entry,
    key: entry.accountUuid,
    label,
    monogram: host?.monogram ?? entry.monogram ?? undefined,
    signIn,
    ...signInMemberState({ signIn, needsRelogin: entry.needsRelogin }, now),
  };
}

/** The node's Anthropic members (Q1: every auth kind), worst first. */
export function nodeAccountMembers(
  row: NodeAccountHealth,
  labels: ReadonlyMap<string, AccountLabelSource>,
  now: number
): NodeAccountMember[] {
  return sortWorstFirst(
    row.accounts
      .filter(e => e.provider === "anthropic")
      .map(e => nodeAccountMember(e, labels, now))
  );
}

/** The chip's ring: its attention state, else mint for the node's default. */
function memberRing(
  m: NodeAccountMember,
  isDefault: boolean
): AttentionRing | undefined {
  switch (m.state) {
    case "relogin":
      return "alert";
    case "due":
    case "ending":
      return "warn";
    case "quarantined":
      return "held";
    default:
      return isDefault ? "default" : undefined;
  }
}

/**
 * The chip's sentence: the full nickname first, then its state on the node
 * (ruling NAME), then the email.
 */
export function memberSentence(
  m: NodeAccountMember,
  nodeLabel: string,
  isDefault: boolean
): string {
  const tap = m.canRelogin ? " · tap to sign in again" : "";
  const email = m.entry.emailAddress ? ` · ${m.entry.emailAddress}` : "";
  switch (m.state) {
    case "relogin":
      return `${m.label}: re-login required on ${nodeLabel} · tap to log in there${email}`;
    case "due":
      return `${m.label}: its sign-in on ${nodeLabel} reached its end date${tap}${email}`;
    case "ending":
      return `${m.label}: its sign-in on ${nodeLabel} ends in ${daysLeftPhrase(m.daysLeft ?? 0, m.ending?.estimated === true)}${tap}${email}`;
    case "quarantined":
      return `${m.label}: quarantined on ${nodeLabel}; its login was shared with a host's ~/.claude, so Hapimatic holds it until a new sign-in${tap}${email}`;
    default:
      return `${m.label}: running on ${nodeLabel}${isDefault ? " · the default account" : ""}${email}`;
  }
}

const stop = (e: SyntheticEvent) => e.stopPropagation();

/**
 * The account chip in its tap target (ruling NAME-2): a re-login button when
 * the account can sign in again, else a tap-bubble button. `fill` (a
 * full-width attention row) lets the chip take the row's width.
 */
function MemberChip(props: {
  m: NodeAccountMember;
  nodeId: string;
  nodeLabel: string;
  isDefault: boolean;
  fill?: boolean;
}) {
  const { m, nodeId, nodeLabel, isDefault, fill = false } = props;
  const sentence = memberSentence(m, nodeLabel, isDefault);
  const chip = (
    <AccountChip
      email={m.entry.emailAddress}
      label={m.label}
      monogram={m.monogram}
      colorSeed={m.entry.emailAddress || m.key}
      ring={memberRing(m, isDefault)}
      nativeTitle={false}
    />
  );
  const wrapClass = `inline-flex min-w-0 ${fill ? "" : "max-w-full "}items-center rounded-md p-0.5 align-middle`;
  if (m.canRelogin) {
    return (
      // An enabled `Button` with a `title` stays a plain button (no tap
      // bubble on touch): the hover title only, as the #6161 node pill.
      <Button
        type="button"
        variant="ghostStatic"
        size="bare"
        data-testid="node-account-chip"
        data-action="relogin"
        title={sentence}
        aria-label={sentence}
        onPointerDown={stop}
        onClick={e => {
          e.stopPropagation();
          requestRelogin({ provider: "anthropic", nodeId, accountUuid: m.key });
        }}
        className={wrapClass}
      >
        {chip}
      </Button>
    );
  }
  return (
    <HoverTooltipButton
      type="button"
      data-testid="node-account-chip"
      data-action="reveal"
      content={sentence}
      aria-label={sentence}
      onPointerDown={stop}
      onClick={stop}
      className={wrapClass}
    >
      {chip}
    </HoverTooltipButton>
  );
}

/**
 * One account's tile, its own rounded box. `wide` (an account that needs
 * attention): full width, the chip, its age or countdown, its state, and
 * "Sign in again"; the state words take only the space left, so the chip keeps
 * the full nickname. Otherwise a grid tile: the chip and its age on one row.
 */
function AccountTile(props: {
  m: NodeAccountMember;
  nodeId: string;
  nodeLabel: string;
  isDefault: boolean;
  wide: boolean;
}) {
  const { m, nodeId, nodeLabel, isDefault, wide } = props;
  const words = memberStateWords(m.state);
  return (
    <div
      data-testid={`node-account-${m.key}`}
      data-state={m.state}
      data-default={isDefault ? "true" : undefined}
      className={`flex min-w-0 items-center gap-1.5 rounded-md border border-[var(--app-border)] ${
        wide ? "h-8 pl-1 pr-1" : "h-7 pl-1 pr-1.5"
      }`}
    >
      <MemberChip
        m={m}
        nodeId={nodeId}
        nodeLabel={nodeLabel}
        isDefault={isDefault}
        fill={wide}
      />
      <span className="inline-flex shrink-0">
        <SignInAgeToken
          entry={m.signIn}
          nodeLabel={nodeLabel}
          surface="node-card"
        />
      </span>
      {wide ? (
        <span
          data-testid="node-account-state-words"
          className={`min-w-0 flex-1 basis-0 truncate text-[length:var(--text-caption-xs)] ${words.className}`}
        >
          <span className={words.phoneHidden ? "max-sm:hidden" : undefined}>
            {words.text}
          </span>
        </span>
      ) : null}
      {wide && m.canRelogin ? (
        <SignInAgainButton
          nodeId={nodeId}
          nodeLabel={nodeLabel}
          accountUuid={m.key}
          accountLabel={m.label}
          data-testid="node-account-sign-in-again"
        />
      ) : null}
    </div>
  );
}

/**
 * The attention text: each state that needs attention, worst first (one
 * account as its chip and a word, more as a count whose tooltip names them).
 * With none: "all running". A read that dropped entries (`rejectedEntries`)
 * never says "all running": it says how many were not read.
 */
function AttentionText(props: {
  members: NodeAccountMember[];
  nodeId: string;
  nodeLabel: string;
  defaultUuid: string | null;
  rejected: number;
}) {
  const { members, nodeId, nodeLabel, defaultUuid, rejected } = props;
  const notRead =
    rejected > 0 ? (
      <span data-testid="node-account-summary-unread">
        <span className="mx-1 text-[var(--app-hint)]">·</span>
        <span className={MEMBER_BUCKET_TEXT_CLASS.unread}>
          {rejected} not read
        </span>
      </span>
    ) : null;
  if (members.length === 1) {
    const m = members[0];
    return (
      <>
        <span className="inline-flex items-center gap-1.5 align-middle">
          <MemberChip
            m={m}
            nodeId={nodeId}
            nodeLabel={nodeLabel}
            isDefault={m.key === defaultUuid}
          />
          <SignInAgeToken
            entry={m.signIn}
            nodeLabel={nodeLabel}
            surface="node-card"
          />
        </span>
        {notRead}
      </>
    );
  }
  const attention = attentionBuckets(members);
  if (attention.length === 0) {
    return rejected > 0 ? (
      <>
        <span className={MEMBER_BUCKET_TEXT_CLASS.running}>
          {members.length} running
        </span>
        {notRead}
      </>
    ) : (
      <span className="text-[var(--status-ok)]">all running</span>
    );
  }
  return (
    <>
      {attention.map((b, i) => {
        const names = b.members.map(m => m.label).join(", ");
        return (
          <span key={b.key} data-testid={`node-account-summary-${b.key}`}>
            {i > 0 ? (
              <span className="mx-1 text-[var(--app-hint)]">·</span>
            ) : null}
            {b.members.length === 1 ? (
              <>
                <MemberChip
                  m={b.members[0]}
                  nodeId={nodeId}
                  nodeLabel={nodeLabel}
                  isDefault={false}
                />
                <span className={`ml-1 ${MEMBER_BUCKET_TEXT_CLASS[b.key]}`}>
                  {b.one}
                </span>
              </>
            ) : (
              <HoverTooltipButton
                type="button"
                data-testid={`node-account-count-${b.key}`}
                content={names}
                aria-label={`${b.members.length} ${b.title}: ${names}`}
                onClick={stop}
                onPointerDown={stop}
                className={`inline ${MEMBER_BUCKET_TEXT_CLASS[b.key]}`}
              >
                {b.members.length} {b.many}
              </HoverTooltipButton>
            )}
          </span>
        );
      })}
      {notRead}
    </>
  );
}

/** The one-line hint where no strip can be drawn (R8), at the line's height. */
function HintLine(props: { state: string; text: string; tooltip: string }) {
  return (
    <div
      data-testid="node-account-row"
      data-hint={props.state}
      className="flex h-7 min-w-0 items-center"
      // A tap inside the hint's portaled bubble reaches here through React's
      // tree, not the button: it stays in the accounts, never the card (R7).
      onClick={stop}
    >
      <HoverTooltipButton
        type="button"
        data-testid="node-account-hint"
        content={props.tooltip}
        aria-label={props.tooltip}
        onClick={stop}
        onPointerDown={stop}
        className="min-w-0 truncate text-left text-[length:var(--text-caption)] text-[var(--app-hint)]"
      >
        {props.text}
      </HoverTooltipButton>
    </div>
  );
}

/** Why a node's accounts were not read, for the hint's tooltip. */
function notReadReason(nodeLabel: string, row: NodeAccountHealth): string {
  const why = row.reason ? ` (${row.reason})` : "";
  switch (row.status) {
    case "offline":
      return `${nodeLabel} is offline, so its accounts were not read`;
    case "unreachable":
      return `${nodeLabel} did not answer the account read${why}`;
    case "unsupported":
      return `${nodeLabel}'s build does not report its accounts`;
    default:
      return `${nodeLabel}'s account read failed${why}`;
  }
}

export type NodeAccountRowProps = {
  api: ApiClient | null;
  nodeId: string;
  nodeLabel: string;
  /** This node's account-health row, if the read has one. */
  row: NodeAccountHealth | undefined;
  /** The account-health read has succeeded at least once (`hasData`). */
  read: boolean;
  /** The UI host's account labels by uuid (`useAccountLabelsByUuid`). */
  labels?: ReadonlyMap<string, AccountLabelSource>;
};

const NO_LABELS: ReadonlyMap<string, AccountLabelSource> = new Map();

export function NodeAccountRow(props: NodeAccountRowProps) {
  const { api, nodeId, nodeLabel, row, read, labels = NO_LABELS } = props;
  const now = useMinuteNow();
  const [open, setOpen] = useState(false);
  // ONE read of the node's default per row (R12), never per tile.
  const { account: active, status: activeStatus } = useNodeActiveAccount(
    api,
    nodeId
  );
  if (!read) {
    return (
      <HintLine
        state="reading"
        text="Reading accounts…"
        tooltip={`Reading the accounts signed in on ${nodeLabel}`}
      />
    );
  }
  if (!row) {
    return (
      <HintLine
        state="not-read"
        text="Accounts not read"
        tooltip={`This page has no account read for ${nodeLabel} yet`}
      />
    );
  }
  if (row.status !== "ok") {
    return (
      <HintLine
        state="not-read"
        text="Accounts not read"
        tooltip={notReadReason(nodeLabel, row)}
      />
    );
  }
  const members = nodeAccountMembers(row, labels, now);
  const rejected = row.rejectedEntries ?? 0;
  if (members.length === 0) {
    // R8: entries the read could not parse mean the list is incomplete, so
    // "No accounts signed in" would be a false claim.
    if (rejected > 0) {
      return (
        <HintLine
          state="not-read"
          text={`${rejected} not read`}
          tooltip={`${rejected} of ${nodeLabel}'s account records could not be read`}
        />
      );
    }
    return (
      <HintLine
        state="none"
        text="No accounts signed in"
        tooltip={`No Anthropic account is signed in on ${nodeLabel}`}
      />
    );
  }
  // `set`, or `expired` when the default is the unrefreshable record; drawn
  // only when that account is on this row (the two reads poll at 30 s and 60 s).
  const activeUuid =
    activeStatus === "set" || activeStatus === "expired"
      ? (active?.accountUuid ?? null)
      : null;
  const defaultUuid =
    activeUuid && members.some(m => m.key === activeUuid) ? activeUuid : null;
  // A re-login targets the node the read names: the identity-only fallback's
  // local card carries the LOCAL_NODE_ID sentinel, its row the real id.
  const reloginNodeId = row.nodeId;
  const word = members.length === 1 ? "account" : "accounts";
  const tipLines = memberHealthTooltipLines(
    members,
    m => m.label,
    `${nodeLabel} · ${members.length} ${word}`
  );
  if (rejected > 0) tipLines.push(`${rejected} not read`);
  const attention = members.filter(m => isAttentionState(m.state));
  const rest = members.filter(m => !isAttentionState(m.state));
  return (
    <div
      data-testid="node-account-row"
      data-open={open ? "true" : "false"}
      // A tap inside a chip's portaled bubble reaches here through React's
      // tree, not the chip: it stays in the accounts, never the card (R7).
      onClick={stop}
    >
      <div
        data-testid="node-account-summary"
        className="flex h-7 min-w-0 items-center gap-1.5"
      >
        <Button
          type="button"
          variant="ghostStatic"
          size="bare"
          data-testid="node-account-toggle"
          aria-expanded={open}
          aria-label={`${open ? "Hide" : "Show"} ${nodeLabel}'s ${members.length} ${word}`}
          title={`${open ? "Hide" : "Show"} the ${word}`}
          onPointerDown={stop}
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
          aria-label={`${members.length} ${word}: ${tipLines.slice(1).join("; ")}`}
          data-testid="node-account-strip"
        />
        <span
          data-testid="node-account-summary-text"
          // A chip the line cannot fit fades out at the edge (CSS ellipsis
          // only applies to text), instead of being cut mid-label.
          className="block min-w-0 flex-1 truncate text-[length:var(--text-caption)] leading-7 [mask-image:linear-gradient(90deg,black_calc(100%_-_1rem),transparent)]"
        >
          <AttentionText
            members={members}
            nodeId={reloginNodeId}
            nodeLabel={nodeLabel}
            defaultUuid={defaultUuid}
            rejected={rejected}
          />
        </span>
      </div>
      {open ? (
        <div
          data-testid="node-account-tiles"
          className="flex flex-col gap-1 pb-1 pt-0.5"
          // A tap between tiles is still inside the accounts, not the card.
          onClick={stop}
        >
          {attention.map(m => (
            <AccountTile
              key={m.key}
              m={m}
              nodeId={reloginNodeId}
              nodeLabel={nodeLabel}
              isDefault={m.key === defaultUuid}
              wide
            />
          ))}
          {rest.length > 0 ? (
            <div
              data-testid="node-account-grid"
              className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-1" /* design-tokens-allow: the running-tile column width (Matt's V1 = C, #6884): two tiles per row in a phone's card, three at 1280, a nickname and its age on one row */
            >
              {rest.map(m => (
                <AccountTile
                  key={m.key}
                  m={m}
                  nodeId={reloginNodeId}
                  nodeLabel={nodeLabel}
                  isDefault={m.key === defaultUuid}
                  wide={false}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
