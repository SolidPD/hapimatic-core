// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { useAppContext } from "@/lib/app-context";
import { useSession } from "@/hooks/queries/useSession";
import { useSessionTokenStats } from "@/hooks/queries/useSessionTokenStats";
import { RobotIcon } from "@/components/icons";
import { BareButton } from "@/components/ui/BareButton";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { AgentPeek } from "@/components/AgentPeek";
import { formatTokens } from "@/lib/formatTokens";
import { rawTokenTotal } from "@/lib/weightedQuota";

/**
 * BackgroundAgentsModal — the centered, READ-ONLY modal listing a session's
 * background agents (issue #4383, DD10). Opened by `SessionAgentsBadge` (list +
 * header). Mirrors `LoopCronModal`'s centered-dialog chrome.
 *
 * Reads the full per-agent list from the session detail (`useSession`) — the list
 * rides the Session record (the summary carries counts only). One card per agent:
 * a `RobotIcon` colored by status (green running / gray done / red error), the
 * agentType, status + elapsed (live-ticking while running), the description, and a
 * chevron that opens the in-place read-only peek (#4386).
 *
 * #4385: each card shows the agent's tokens — the STORED row from token-stats'
 * `backgroundAgentUsage` once the agent has finished (authoritative, the same row
 * folded into the session total), else the tracker's live figure (refreshed by
 * its 30 s reconcile), else "—". The summary adds the tokens the finished agents
 * added to the session.
 *
 * #4386: holds a `view` (`"list" | {agentId}`). The peek swaps `AgentPeek` into
 * the SAME DialogContent at `heightVariant="threeQuarter"` (no second dialog,
 * DD11/DD12). `initialAgentId` opens straight into the peek (so #4385's usage
 * rows can deep-link an agent).
 *
 * #4385 (DD18 Option C, T27): the live snapshot clears at the first turn end after
 * the agents' results are consumed (DD14 T1), but their stored rows persist. A
 * stored agent the live list no longer carries is merged into the list as a
 * finished card and stays peekable, so a finished agent's transcript remains
 * reachable from the Token Usage breakdown after the badge is gone.
 */
export function BackgroundAgentsModal({
  sessionId,
  open,
  onOpenChange,
  initialAgentId,
}: {
  sessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialAgentId?: string;
}) {
  const { api } = useAppContext();
  const { session } = useSession(api, sessionId, true);
  const snapshot = session?.backgroundAgents ?? null;
  const liveAgents = snapshot?.agents ?? [];
  // #4385: stored per-agent usage — the authoritative figure for a finished agent.
  const { data: tokenStats } = useSessionTokenStats(
    open ? api : null,
    sessionId
  );
  const storedUsage = tokenStats?.backgroundAgentUsage;
  const storedTokensById = new Map<string, number>();
  for (const a of storedUsage?.agents ?? []) {
    storedTokensById.set(a.agentId, rawTokenTotal(a));
  }
  const addedToSession = storedUsage ? rawTokenTotal(storedUsage) : 0;
  // #4385 (T27): stored agents the live snapshot no longer carries (it clears at
  // DD14 T1) become finished cards, so the list and the peek outlive the badge.
  const liveIds = new Set(liveAgents.map(a => a.id));
  const storedOnly = (storedUsage?.agents ?? [])
    .filter(a => !liveIds.has(a.agentId))
    .map(storedRowToAgent);
  const agents = [...liveAgents, ...storedOnly];
  // #4388 (R2, B1 pick): order the merged agents parent-before-child with a
  // render depth so a nested agent renders indented (with a connector rail)
  // under its parent. The summary/badge counts already include every depth (the
  // tracker counts the whole map); foreground children never reach the snapshot
  // (#4599). A stored-only finished card has no parentAgentId → rendered flat.
  const agentRows = useMemo(() => buildAgentRows(agents), [agents]);

  // #4386: which view the modal shows. Reset each time the modal opens (or the
  // deep-link target changes) so a stale peek never lingers across reopens.
  const [view, setView] = useState<"list" | { agentId: string }>(
    initialAgentId ? { agentId: initialAgentId } : "list"
  );
  useEffect(() => {
    if (open) setView(initialAgentId ? { agentId: initialAgentId } : "list");
  }, [open, initialAgentId]);

  // Live clock for the elapsed display — ticks only while a card is running.
  const hasRunning = agents.some(a => a.status === "running");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasRunning) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasRunning]);

  const running = snapshot?.running ?? 0;
  const done =
    (snapshot?.done ?? 0) + storedOnly.filter(a => a.status !== "error").length;
  const error =
    (snapshot?.error ?? 0) +
    storedOnly.filter(a => a.status === "error").length;
  // #4388 R3: background Bash shell counts (shown in the summary so the badge's
  // degraded "dot" form still has its count visible — the C1→C3 fallback).
  const shells = snapshot?.shells;

  const peekAgent =
    view !== "list" ? agents.find(a => a.id === view.agentId) : undefined;

  // Peek view: swap AgentPeek into the SAME dialog at threeQuarter height.
  if (peekAgent) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          data-testid={`background-agents-modal-${sessionId}`}
          description="Background agent transcript (read-only)"
          className="flex flex-col overflow-hidden p-0"
          heightVariant="threeQuarter"
        >
          <DialogTitle className="sr-only">
            {peekAgent.agentType} transcript
          </DialogTitle>
          <AgentPeek
            api={api}
            sessionId={sessionId}
            agent={peekAgent}
            now={now}
            onBack={() => setView("list")}
          />
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid={`background-agents-modal-${sessionId}`}
        description="Background agents launched by this session"
        className="flex flex-col overflow-hidden p-0"
        style={{ maxHeight: "85vh" }}
      >
        {/* Header — `pr-12` clears the primitive's absolute close button. */}
        <div className="flex items-center gap-2 border-b border-[var(--app-border)] px-4 py-3 pr-12">
          <DialogTitle className="text-[length:var(--text-body)] font-semibold leading-tight tracking-normal text-[var(--app-fg)]">
            Background Agents{" "}
            <span className="text-[length:var(--text-caption)] font-medium text-[var(--app-hint)]">
              · this session
            </span>
          </DialogTitle>
        </div>

        {/* Summary line. */}
        <div
          className="border-b border-[var(--app-border)] px-4 py-2 text-[length:var(--text-caption)] tabular-nums text-[var(--app-hint)]"
          data-testid={`background-agents-summary-${sessionId}`}
        >
          <span className="text-[var(--app-badge-success-text)]">
            {running} active
          </span>{" "}
          · <span>{done} done</span> ·{" "}
          <span
            className={error > 0 ? "text-[var(--app-badge-error-text)]" : ""}
          >
            {error} error
          </span>
          {addedToSession > 0 ? (
            <span
              data-testid={`background-agents-added-${sessionId}`}
              title="Finished background agents' full usage, already included in the session total"
            >
              {" "}
              · +{formatTokens(addedToSession)} tokens added to the session
            </span>
          ) : null}
          {shells && shells.total > 0 ? (
            <>
              {" · "}
              <span
                data-testid={`background-shells-summary-${sessionId}`}
                className={
                  shells.error > 0 ? "text-[var(--app-badge-error-text)]" : ""
                }
              >
                {shells.running}/{shells.total} background shell
                {shells.total === 1 ? "" : "s"}
              </span>
            </>
          ) : null}
        </div>

        {/* Body: one card per agent, or the empty state. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {agents.length === 0 ? (
            <p
              data-testid={`background-agents-empty-${sessionId}`}
              className="px-1 py-6 text-center text-[length:var(--text-body-dense)] text-[var(--app-hint)]"
            >
              No background agents.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {agentRows.map(({ agent, depth }) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  depth={depth}
                  now={now}
                  storedTokens={storedTokensById.get(agent.id)}
                  onPeek={() => setView({ agentId: agent.id })}
                />
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

type AgentCardProps = {
  agent: {
    id: string;
    agentType: string;
    description: string;
    status: "running" | "done" | "error";
    startedAt: number;
    endedAt?: number;
    tokens?: { in: number; out: number; cacheRead: number; cacheWrite: number };
  };
  /** #4388 (R2): render depth (0 = top-level). > 0 indents under the parent. */
  depth?: number;
  now: number;
  /** #4385: the agent's stored (authoritative) token total, once recorded. */
  storedTokens?: number;
  onPeek: () => void;
};

/**
 * #4385: the card's token figure. A finished agent shows its stored row (the
 * full file, recorded at completion). A running agent shows its live estimate:
 * its stored row, if any, is the partial written when its spawning turn ended
 * and is replaced in full when the agent finishes.
 */
function cardTokens(
  agent: AgentCardProps["agent"],
  storedTokens: number | undefined
): { text: string; title: string } {
  const live = agent.tokens
    ? {
        text: `${formatTokens(agent.tokens.in + agent.tokens.out + agent.tokens.cacheRead + agent.tokens.cacheWrite)} tokens so far`,
        title:
          "Live estimate from the agent's transcript, refreshed every 30 s",
      }
    : null;
  if (agent.status === "running") {
    if (live) return live;
    if (storedTokens !== undefined) {
      return {
        text: `${formatTokens(storedTokens)} tokens so far`,
        title:
          "Counted when its turn ended — replaced by the full figure when the agent finishes",
      };
    }
    return { text: "— tokens", title: "No usage recorded yet" };
  }
  if (storedTokens !== undefined) {
    return {
      text: `${formatTokens(storedTokens)} tokens`,
      title: "Recorded when the agent finished — included in the session total",
    };
  }
  return live ?? { text: "— tokens", title: "No usage recorded yet" };
}

// #4385 storedTokens + #4388 R2 depth: the card renders both the per-agent token
// figure (C) and the nested-tree indent/rail (F).
function AgentCard({
  agent,
  depth = 0,
  now,
  storedTokens,
  onPeek,
}: AgentCardProps) {
  const color =
    agent.status === "running"
      ? "text-[var(--app-badge-success-text)]"
      : agent.status === "error"
        ? "text-[var(--app-badge-error-text)]"
        : "text-[var(--app-hint)]";
  const end = agent.status === "running" ? now : (agent.endedAt ?? now);
  const elapsed = formatElapsed(Math.max(0, end - agent.startedAt));
  const tok = cardTokens(agent, storedTokens);

  return (
    <li
      data-testid={`background-agent-card-${agent.id}`}
      data-status={agent.status}
      data-depth={depth}
      // #4388 B1: a nested agent indents under its parent with a left connector
      // rail; depth scales the indent so depth-3+ keeps nesting legibly.
      className={
        depth > 0
          ? "relative border-l border-[var(--app-border)] pl-3"
          : undefined
      }
      style={depth > 0 ? { marginLeft: depth * 14 } : undefined}
    >
      {/* #4386: the whole card opens the in-place read-only peek. BareButton
          (ghostStatic/bare) adds no chrome, so the card keeps its own box;
          justify-start + whitespace-normal counteract BareButton's centered,
          no-wrap base (same lesson as the transcript list row). */}
      <BareButton
        type="button"
        onClick={onPeek}
        data-testid={`background-agent-peek-${agent.id}`}
        className="flex w-full items-start justify-start gap-2 whitespace-normal rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2.5 py-2 text-left transition-colors hover:bg-[var(--app-hover)]"
      >
        <RobotIcon className={`mt-px h-4 w-4 shrink-0 ${color}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold text-[length:var(--text-caption)] text-[var(--app-fg)]">
              {agent.agentType}
            </span>
            <span
              className={`shrink-0 tabular-nums text-[length:var(--text-caption-xs)] ${color}`}
            >
              {agent.status} · {elapsed}
            </span>
          </div>
          {agent.description ? (
            <p className="mt-0.5 line-clamp-2 text-[length:var(--text-caption-xs)] text-[var(--app-hint)]">
              {agent.description}
            </p>
          ) : null}
          <p
            data-testid={`background-agent-tokens-${agent.id}`}
            className="mt-0.5 tabular-nums text-[length:var(--text-caption-xs)] text-[var(--app-hint)]"
            title={tok.title}
          >
            {tok.text}
          </p>
        </div>
        <ChevronRight className="mt-px h-4 w-4 shrink-0 text-[var(--app-hint)]" />
      </BareButton>
    </li>
  );
}

/**
 * #4385: a stored `backgroundAgentUsage` row as a finished card / peek target.
 * The stored status is "done" or "error" (recorded at completion); anything else
 * reads as done.
 */
function storedRowToAgent(row: {
  agentId: string;
  agentType: string | null;
  description: string | null;
  status: string;
  startedAtMs: number | null;
  endedAtMs: number | null;
}): AgentCardProps["agent"] {
  return {
    id: row.agentId,
    agentType: row.agentType ?? "agent",
    description: row.description ?? "",
    status: row.status === "error" ? "error" : "done",
    startedAt: row.startedAtMs ?? row.endedAtMs ?? 0,
    ...(row.endedAtMs !== null ? { endedAt: row.endedAtMs } : {}),
  };
}

/** Compact elapsed: `45s`, `2m 03s`, `1h 04m`. */
function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

type AgentRow<T> = { agent: T; depth: number };

/**
 * #4388 (R2, B1): order the agents parent-before-child with a render depth
 * (0 = top-level). A child whose `parentAgentId` is absent from the list (its
 * parent dropped by the 50-cap, or not a tracked agent) renders top-level.
 * Cycle-safe via a visited set; any agent left unreached still renders flat so
 * nothing is ever dropped from the list.
 *
 * Generic over the element type (reads only `id` + optional `parentAgentId`) so
 * it accepts the merged list of live `BackgroundAgentEntry`s (#4388) AND #4385's
 * stored-only finished cards, which carry no `notifications`/`parentAgentId` and
 * so render flat.
 */
function buildAgentRows<T extends { id: string; parentAgentId?: string }>(
  agents: readonly T[]
): AgentRow<T>[] {
  const ids = new Set(agents.map(a => a.id));
  const childrenOf = new Map<string, T[]>();
  const topLevel: T[] = [];
  for (const a of agents) {
    const p = a.parentAgentId;
    if (p && p !== a.id && ids.has(p)) {
      const arr = childrenOf.get(p) ?? [];
      arr.push(a);
      childrenOf.set(p, arr);
    } else {
      topLevel.push(a);
    }
  }
  const rows: AgentRow<T>[] = [];
  const seen = new Set<string>();
  const walk = (a: T, depth: number): void => {
    if (seen.has(a.id)) return;
    seen.add(a.id);
    rows.push({ agent: a, depth });
    for (const c of childrenOf.get(a.id) ?? []) walk(c, depth + 1);
  };
  for (const a of topLevel) walk(a, 0);
  for (const a of agents)
    if (!seen.has(a.id)) rows.push({ agent: a, depth: 0 });
  return rows;
}
