// SPDX-License-Identifier: AGPL-3.0-only
/**
 * SignInEndingList — the "Ending soon" list at the top of the Anthropic section
 * of Provider Accounts (issue #6161, R11; NP-2: pattern C). One compact row per
 * ACCOUNT with a sign-in inside its warning window or past its deadline, the
 * soonest deadline first, so 25 nodes never make 25 rows:
 *
 * - an account ending on ONE node names it: the account chip, the node's pill
 *   (amber ring; a tap opens the re-login there, R10), "ends in N days" /
 *   "ended", and "Sign in again";
 * - an account ending on several shows the count and the soonest ("3 nodes
 *   ending · soonest ends in 1 day"); its chevron expands the row in place to
 *   one rounded row per node (pill, "ends in N days", "Sign in again"), inside
 *   the account's own box (`brand-visual-language.md` R10-a).
 *
 * Every "Sign in again" opens the existing re-login for that node
 * (`requestRelogin`). Nothing renders when nothing is ending.
 *
 * It reads the page's account-health rows (the same `useAccountHealth` query)
 * and owns the minute clock, so the page never re-renders every minute. The
 * window is the shared rule (`computeSignInEnding`), so flagged, quarantined,
 * `native`, `env-token`, OpenAI and Google entries never appear (R15).
 */
import { useState } from "react";
import {
  computeSignInEnding,
  type AccountHealthEntry,
  type NodeAccountHealth,
  type SignInEnding,
} from "@hapi/protocol";
import { AccountChip } from "@/components/session/AccountChip";
import { ChevronIcon } from "@/components/icons";
import { NodeBadge } from "@/components/NodeBadge";
import { Button } from "@/components/ui/button";
import { useMinuteNow } from "@/lib/pins/useMinuteNow";
import { daysLeftPhrase, pickSignInAgeInput } from "@/lib/signInAge";
import { requestRelogin } from "@/lib/reloginLink";
import { SignInAgainButton } from "./SignInAgainButton";

/** One ending (node, account) pair. */
export type SignInEndingRow = {
  nodeId: string;
  nodeLabel: string;
  entry: AccountHealthEntry;
  ending: SignInEnding;
};

/** One account's ending nodes, soonest first (NP-2). */
export type SignInEndingAccount = {
  accountUuid: string;
  /** The first row's entry: the account's email, nickname and monogram. */
  entry: AccountHealthEntry;
  rows: SignInEndingRow[];
};

/**
 * The ending (node, account) pairs at `now`, soonest deadline first. Only an
 * `ok` node's rows are read.
 */
export function listEndingSignIns(
  nodes: NodeAccountHealth[],
  now: number
): SignInEndingRow[] {
  const rows: SignInEndingRow[] = [];
  for (const node of nodes) {
    if (node.status !== "ok") continue;
    for (const entry of node.accounts) {
      const ending = computeSignInEnding(pickSignInAgeInput(entry), now);
      if (!ending) continue;
      rows.push({
        nodeId: node.nodeId,
        nodeLabel: node.nodeLabel || node.nodeId,
        entry,
        ending,
      });
    }
  }
  return rows.sort((a, b) => a.ending.deadlineAt - b.ending.deadlineAt);
}

/**
 * The pairs grouped by account (NP-2): the accounts in the order of their
 * soonest deadline, each account's nodes soonest first.
 */
export function groupEndingByAccount(
  rows: SignInEndingRow[]
): SignInEndingAccount[] {
  const byUuid = new Map<string, SignInEndingAccount>();
  for (const row of rows) {
    const uuid = row.entry.accountUuid;
    const group = byUuid.get(uuid);
    if (group) group.rows.push(row);
    else byUuid.set(uuid, { accountUuid: uuid, entry: row.entry, rows: [row] });
  }
  // `rows` arrive soonest first, so each group and the map's order already are.
  return [...byUuid.values()];
}

/** "ends in 2 days" / "ends in about 1 day" / "ended". */
export function endingText(ending: SignInEnding): string {
  if (ending.state === "due") return "ended";
  return `ends in ${daysLeftPhrase(ending.daysLeft, ending.estimated)}`;
}

/** The node's pill: amber ring, and a tap opens the re-login there (R10). */
function EndingNodePill(props: { row: SignInEndingRow; accountName: string }) {
  const { row, accountName } = props;
  return (
    <span className="inline-flex shrink-0">
      <NodeBadge
        nodeId={row.nodeId}
        nodeLabel={row.nodeLabel}
        ring="warn"
        title={`Sign-in for ${accountName} on ${row.nodeLabel} ${endingText(row.ending)} · tap to sign in again`}
        onActivate={() =>
          requestRelogin({
            provider: "anthropic",
            nodeId: row.nodeId,
            accountUuid: row.entry.accountUuid,
          })
        }
      />
    </span>
  );
}

function EndingText(props: { row: SignInEndingRow; accountName: string }) {
  const { row, accountName } = props;
  const text = endingText(row.ending);
  return (
    <span
      className="min-w-0 truncate whitespace-nowrap text-[length:var(--text-caption)] text-[var(--status-warn)]"
      title={`Sign-in for ${accountName} on ${row.nodeLabel} ${text}`}
    >
      {text}
    </span>
  );
}

function EndingAccountRow(props: { group: SignInEndingAccount }) {
  const { group } = props;
  const [open, setOpen] = useState(false);
  const label = group.entry.nickname ?? undefined;
  const accountName = label ?? group.entry.emailAddress;
  const single = group.rows.length === 1;
  const first = group.rows[0];
  const chip = (
    <span className="flex min-w-0 shrink items-center">
      <AccountChip
        email={group.entry.emailAddress}
        label={label}
        monogram={group.entry.monogram ?? undefined}
      />
    </span>
  );
  return (
    <div
      data-testid="sign-in-ending-row"
      data-account-uuid={group.accountUuid}
      data-count={group.rows.length}
      className="flex min-w-0 flex-col rounded-md border border-[var(--app-border)] px-2 py-[var(--row-padding-y)]"
    >
      {single ? (
        <div className="flex min-h-7 min-w-0 items-center gap-1.5">
          {chip}
          <EndingNodePill row={first} accountName={accountName} />
          <EndingText row={first} accountName={accountName} />
          <span className="ml-auto flex shrink-0">
            <SignInAgainButton
              nodeId={first.nodeId}
              nodeLabel={first.nodeLabel}
              accountUuid={group.accountUuid}
              accountLabel={accountName}
              data-testid="sign-in-ending-relogin"
            />
          </span>
        </div>
      ) : (
        <>
          <div className="flex min-h-7 min-w-0 items-center gap-1.5">
            <Button
              type="button"
              variant="ghostStatic"
              size="bare"
              data-testid="sign-in-ending-toggle"
              aria-expanded={open}
              aria-label={`${open ? "Hide" : "Show"} the ${group.rows.length} nodes where ${accountName}'s sign-in is ending`}
              title={`${open ? "Hide" : "Show"} the nodes`}
              onClick={() => setOpen(o => !o)}
              className="h-6 w-5 shrink-0 justify-center rounded-sm hover:bg-[var(--app-hover)]"
            >
              <ChevronIcon
                className="h-3.5 w-3.5 text-[var(--app-hint)]"
                collapsed={!open}
              />
            </Button>
            {chip}
            <span
              data-testid="sign-in-ending-count"
              className="min-w-0 truncate whitespace-nowrap text-[length:var(--text-caption)]"
              title={`${accountName}: sign-in ending on ${group.rows.map(r => r.nodeLabel).join(", ")}`}
            >
              <span className="text-[var(--status-warn)]">
                {group.rows.length} nodes ending
              </span>
              <span className="text-[var(--app-hint)]">
                {" "}
                · soonest {endingText(first.ending)}
              </span>
            </span>
          </div>
          {open ? (
            <div
              data-testid="sign-in-ending-nodes"
              className="flex flex-col gap-1 pb-1 pt-0.5"
            >
              {group.rows.map(row => (
                <div
                  key={row.nodeId}
                  data-testid="sign-in-ending-node"
                  data-node-id={row.nodeId}
                  className="flex h-8 min-w-0 items-center gap-1.5 rounded-md border border-[var(--app-border)] pl-1.5 pr-1"
                >
                  <EndingNodePill row={row} accountName={accountName} />
                  <EndingText row={row} accountName={accountName} />
                  <span className="ml-auto flex shrink-0">
                    <SignInAgainButton
                      nodeId={row.nodeId}
                      nodeLabel={row.nodeLabel}
                      accountUuid={group.accountUuid}
                      accountLabel={accountName}
                      data-testid="sign-in-ending-relogin"
                    />
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

export function SignInEndingList(props: { nodes: NodeAccountHealth[] }) {
  const now = useMinuteNow();
  const groups = groupEndingByAccount(listEndingSignIns(props.nodes, now));
  if (groups.length === 0) return null;
  return (
    <section
      data-testid="sign-in-ending-list"
      aria-label="Sign-ins ending soon"
      className="mb-3 flex flex-col gap-1"
    >
      <h3 className="text-[length:var(--text-caption)] font-medium text-[var(--app-hint)]">
        Ending soon
      </h3>
      {groups.map(group => (
        <EndingAccountRow key={group.accountUuid} group={group} />
      ))}
    </section>
  );
}
