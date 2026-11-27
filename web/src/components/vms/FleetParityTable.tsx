// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type ReactNode } from "react";
import {
  FLEET_PARITY_ITEM_ORDER,
  FLEET_PARITY_ITEMS_MAX,
  type FleetParityAction,
  type FleetParityEngine,
  type FleetParityItem,
  type FleetParityNode,
  type FleetParityNodeState,
  type FleetParityVerdict,
} from "@hapi/protocol/adminVms";
import { IconExpandToggle } from "@/components/ui/IconExpandToggle";
import { HoverTooltip, HoverTooltipButton } from "@/components/ui/tooltip";
import { formatRelativeTime } from "@/lib/sessionHelpers";

const CHIP_BASE =
  "inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-[length:var(--text-caption)] font-medium leading-none";
const OK = "border-emerald-500/40 bg-emerald-500/10 text-emerald-300";
const BAD = "border-red-500/40 bg-red-500/10 text-red-300";
const WARN = "border-amber-500/40 bg-amber-500/10 text-amber-300";
const INFO = "border-sky-500/40 bg-sky-500/10 text-sky-300";
const NEUTRAL =
  "border-[var(--app-border)] bg-[var(--app-secondary-bg)] text-[var(--app-hint)]";

/**
 * The chip for each node state (§ 2.4 of #6300's plan). Exhaustive over
 * `FLEET_PARITY_NODE_STATES`: a state added there is a compile error here.
 */
export const FLEET_PARITY_CHIP: Record<
  FleetParityNodeState,
  { label: string; className: string; tip: string }
> = {
  "at-parity": {
    label: "At parity",
    className: OK,
    tip: "Every probe row passes",
  },
  repairing: {
    label: "Repairing",
    className: INFO,
    tip: "The node's config pull engine is repairing a failing item: nothing to do yet",
  },
  held: {
    label: "Held",
    className: NEUTRAL,
    tip: "The engine reports a deliberate hold: it repairs nothing until the hold is lifted",
  },
  known: {
    label: "Known",
    className: NEUTRAL,
    tip: "Each failing item has an owner row citing an open issue",
  },
  capped: {
    label: "Capped",
    className: NEUTRAL,
    tip: "Every account was at its limit for today's session check",
  },
  failing: {
    label: "Failing",
    className: WARN,
    tip: "An item fails with no repair and no owner: it becomes an action after 20 hours",
  },
  "not-judged": {
    label: "Not judged",
    className: NEUTRAL,
    tip: "Some rows were not judged in this run: their last state is carried",
  },
  "not-contacted": {
    label: "Not contacted",
    className: NEUTRAL,
    tip: "The sweep did not reach this node: a VM becomes an action after 7 days",
  },
  "needs-you": {
    label: "Needs you",
    className: BAD,
    tip: "An item needs a person: expand the row for what to do",
  },
};

/**
 * A node state's chip with its tooltip. `stale` marks a chip read from a
 * verdict older than one missed sweep: a stale pass is not current evidence
 * of parity, so a green chip renders neutral instead.
 */
export function FleetParityChip(props: {
  state: FleetParityNodeState;
  stale?: boolean;
}) {
  const chip = FLEET_PARITY_CHIP[props.state];
  const className =
    props.stale && chip.className === OK ? NEUTRAL : chip.className;
  return (
    <HoverTooltip content={chip.tip}>
      <span
        className={`${CHIP_BASE} ${className}`}
        data-fleet-parity-chip={props.state}
      >
        {chip.label}
      </span>
    </HoverTooltip>
  );
}

const FLEET_PARITY_STALE_TIP =
  "RP1's nightly sweep has not written a verdict for more than 26 hours";

/** The "Stale" chip: the verdict is older than one missed nightly sweep. */
export function FleetParityStaleChip(props: { testId?: string }) {
  return (
    <HoverTooltip content={FLEET_PARITY_STALE_TIP}>
      <span
        className={`${CHIP_BASE} ${WARN} normal-case tracking-normal`}
        data-testid={props.testId}
      >
        Stale
      </span>
    </HoverTooltip>
  );
}

/** A fact on the row's title line, with its tooltip. */
function Fact(props: {
  tip: string;
  className: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <HoverTooltip content={props.tip}>
      <span className={props.className} data-testid={props.testId}>
        {props.children}
      </span>
    </HoverTooltip>
  );
}

function ago(iso: string | null): string | null {
  return iso ? formatRelativeTime(Date.parse(iso)) : null;
}

/** What a withheld message counted: the names stay in RP1's mail. */
function countedText(action: FleetParityAction): string {
  const n = action.count ?? 0;
  if (action.class === "fleet-parity-secret-names") {
    return `${n} secret name${n === 1 ? "" : "s"} missing (names withheld here; RP1's alert mail has them)`;
  }
  return `${n} account${n === 1 ? "" : "s"} signed out (named in RP1's alert mail)`;
}

function itemText(item: FleetParityItem): string {
  const what =
    item.item ??
    `${item.count} secret name${item.count === 1 ? "" : "s"} (withheld)`;
  return `${item.probe} · ${what} · ${item.cause}`;
}

function EngineLine(props: { engine: FleetParityEngine }) {
  const e = props.engine;
  const parts = [
    e.healthy ? "healthy" : "not healthy",
    e.result ? `last result ${e.result}` : null,
    e.lastTickAt ? `last tick ${ago(e.lastTickAt) ?? e.lastTickAt}` : null,
    e.consecutiveFailures !== null
      ? `${e.consecutiveFailures} failure${e.consecutiveFailures === 1 ? "" : "s"}`
      : null,
    e.hold ? "on hold" : null,
    e.rejection
      ? `rolled back ${e.rejection.firstCommit} (${ago(e.rejection.at) ?? e.rejection.at})`
      : null,
  ].filter(Boolean);
  return (
    <p className="text-[var(--app-hint)]" data-testid="fleet-parity-engine">
      Config pull engine: {parts.join(" · ")}
    </p>
  );
}

/** The failing items shown before "and N more" (#6300 PR-4: the actions must stay near the top on a phone). */
export const ITEM_CAP = 8;

/**
 * The served items, most in need of a person first (the shared order; the sort
 * is stable within a disposition). `omitted` is how many the server's cap left
 * out, so "and N more" counts every item the node has (#6300 PR-4 round 4).
 */
function ItemList(props: {
  name: string;
  items: FleetParityItem[];
  omitted: number;
}) {
  const [all, setAll] = useState(false);
  const sorted = [...props.items].sort(
    (a, b) =>
      FLEET_PARITY_ITEM_ORDER[a.disposition] -
      FLEET_PARITY_ITEM_ORDER[b.disposition]
  );
  const shown = all ? sorted : sorted.slice(0, ITEM_CAP);
  const more = sorted.length + props.omitted - ITEM_CAP;
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <ul
        className="flex min-w-0 flex-col gap-0.5"
        role="list"
        data-testid={`fleet-parity-items-${props.name}`}
      >
        {shown.map((item, i) => (
          <li
            key={`${item.probe}-${item.item ?? "counted"}-${i}`}
            className="flex min-w-0 items-center gap-1.5"
          >
            <FleetParityChip state={item.disposition} />
            <span className="min-w-0 truncate text-[var(--app-fg)]">
              {itemText(item)}
            </span>
          </li>
        ))}
      </ul>
      {more > 0 && (
        <HoverTooltipButton
          type="button"
          content={
            all
              ? "Show only the first items"
              : "Show every failing item on this node"
          }
          onClick={() => setAll(a => !a)}
          aria-expanded={all}
          data-testid={`fleet-parity-items-more-${props.name}`}
          className="self-start text-[var(--app-link)] hover:underline"
        >
          {all ? "Show fewer" : `and ${more} more`}
        </HoverTooltipButton>
      )}
      {all && props.omitted > 0 && (
        <p
          className="text-[var(--app-hint)]"
          data-testid={`fleet-parity-items-omitted-${props.name}`}
        >
          and {props.omitted} less urgent, not listed: the page lists the{" "}
          {FLEET_PARITY_ITEMS_MAX} most urgent
        </p>
      )}
    </div>
  );
}

/**
 * The expanded detail, in the order the operator acts on it (#6300 PR-4): why the
 * node was not checked, then each action with what to do, then the engine, then
 * the failing items (the most urgent first, capped at {@link ITEM_CAP}).
 */
function NodeDetail(props: { node: FleetParityNode }) {
  const { node } = props;
  const nothing =
    !node.cause && !node.engine && !node.items.length && !node.actions.length;
  return (
    <div
      className="flex min-w-0 flex-col gap-1.5 border-t border-[var(--app-border)] px-2 py-1.5 text-[length:var(--text-caption)]"
      data-testid={`fleet-parity-detail-${node.name}`}
    >
      {node.cause && (
        <p className="text-[var(--app-hint)]">Not checked: {node.cause}</p>
      )}
      {node.actions.map((action, i) => (
        <div
          key={`${action.class}-${i}`}
          className="flex min-w-0 flex-col gap-0.5"
          data-testid={`fleet-parity-action-${node.name}-${action.class}`}
        >
          <p className="font-medium text-[var(--app-fg)] [overflow-wrap:anywhere]">
            {action.class}: {action.message ?? countedText(action)}
            {!action.judged && (
              <span className="font-normal text-[var(--app-hint)]">
                {" "}
                (from an earlier run; not checked this run)
              </span>
            )}
          </p>
          {action.whatToDo && (
            <p className="whitespace-pre-wrap text-[var(--app-hint)] [overflow-wrap:anywhere]">
              {action.whatToDo}
            </p>
          )}
        </div>
      ))}
      {node.engine && <EngineLine engine={node.engine} />}
      {node.items.length > 0 && (
        <ItemList
          name={node.name}
          items={node.items}
          omitted={node.itemsOmitted}
        />
      )}
      {nothing && <p className="text-[var(--app-hint)]">No failing items.</p>}
    </div>
  );
}

/**
 * One node: its own rounded box (R10-a), every fact on the title line (R10-b).
 * At 393px the commit truncates first, then "N behind", then the last check
 * (flex-shrink weights); the name, chip and session days never shrink.
 */
function NodeRow(props: { node: FleetParityNode; stale: boolean }) {
  const { node, stale } = props;
  const [open, setOpen] = useState(false);
  const checked = ago(node.lastContactedAt);
  return (
    <li
      className="min-w-0 overflow-hidden rounded-md border border-[var(--app-border)]"
      data-testid={`fleet-parity-row-${node.name}`}
      data-fleet-parity-state={node.state}
    >
      <div className="flex min-w-0 items-center gap-1.5 px-0.5 py-0.5 text-sm">
        <IconExpandToggle
          expanded={open}
          onToggle={() => setOpen(o => !o)}
          aria-label={open ? `Collapse ${node.name}` : `Expand ${node.name}`}
          data-testid={`fleet-parity-expand-${node.name}`}
        />
        <span className="shrink-0 font-medium text-[var(--app-fg)]">
          {node.name}
        </span>
        <FleetParityChip state={node.state} stale={stale} />
        <span className="ml-auto flex min-w-0 items-center gap-2 text-[length:var(--text-caption)] text-[var(--app-hint)]">
          {node.commit && (
            <Fact
              tip={`Deployed rp1-home commit ${node.commit}`}
              className="min-w-0 shrink-[100] truncate font-mono"
              testId={`fleet-parity-commit-${node.name}`}
            >
              {node.commit.slice(0, 8)}
            </Fact>
          )}
          {node.commitsBehind !== null && (
            <Fact
              tip="Commits behind RP1's main"
              className="min-w-0 shrink-[10] truncate"
            >
              {node.commitsBehind} behind
            </Fact>
          )}
          {checked && (
            <Fact
              tip={`Last contacted ${node.lastContactedAt}`}
              className="min-w-0 truncate"
            >
              {checked}
            </Fact>
          )}
          {node.sessionDays !== null && (
            <Fact
              tip="Days of the last 14 on which the session check passed (it needs 7)"
              className="shrink-0"
            >
              {node.sessionDays}/14
            </Fact>
          )}
        </span>
      </div>
      {open && <NodeDetail node={node} />}
    </li>
  );
}

/**
 * FleetParityTable — the Fleet parity panel at the top of /settings/vms (#6300
 * PR-4, Task 20): one compact row per node from RP1's nightly verdict, and an
 * expandable detail with the engine summary, the failing items and each action's
 * "What to do". A list of rounded boxes (R10-a, the PinRow pattern), not a table.
 */
export function FleetParityTable(props: {
  verdict: FleetParityVerdict | undefined;
  isLoading: boolean;
  isError: boolean;
}) {
  const { verdict, isLoading, isError } = props;
  const ok = verdict?.state === "ok" ? verdict : null;
  return (
    <section className="flex min-w-0 flex-col gap-1" data-testid="fleet-parity">
      <h2 className="flex min-w-0 items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--app-hint)]">
        <span className="shrink-0">Fleet parity</span>
        {ok && (
          <Fact
            tip={`Run ${ok.runId}, written ${ok.checkedAt}`}
            className="min-w-0 truncate font-normal normal-case tracking-normal"
            testId="fleet-parity-checked"
          >
            checked {ago(ok.checkedAt) ?? ok.checkedAt}
          </Fact>
        )}
        {ok?.stale && <FleetParityStaleChip testId="fleet-parity-stale" />}
      </h2>
      {isError && (
        <p
          className="py-1 text-sm text-[var(--app-hint)]"
          data-testid="fleet-parity-error"
        >
          Fleet parity is unavailable.
        </p>
      )}
      {isLoading && !isError && (
        <p
          className="py-1 text-sm text-[var(--app-hint)]"
          data-testid="fleet-parity-loading"
        >
          Loading fleet parity…
        </p>
      )}
      {verdict?.state === "absent" && !isError && (
        <p
          className="py-1 text-sm text-[var(--app-hint)]"
          data-testid="fleet-parity-absent"
        >
          No fleet parity verdict here yet: RP1's nightly sweep writes it.
        </p>
      )}
      {verdict?.state === "unreadable" && !isError && (
        <p
          className="py-1 text-sm text-amber-300"
          data-testid="fleet-parity-unreadable"
          role="alert"
        >
          The fleet parity verdict is unreadable.
        </p>
      )}
      {ok && !isError && (
        <ul className="flex min-w-0 flex-col gap-1" role="list">
          {ok.nodes.map(node => (
            <NodeRow key={node.name} node={node} stale={ok.stale} />
          ))}
        </ul>
      )}
    </section>
  );
}
