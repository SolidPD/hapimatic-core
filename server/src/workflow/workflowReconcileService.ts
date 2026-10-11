// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Workflow Reconcile Service (issue #1672, epic #1662 — Sub J, R6).
 *
 * A periodic, node-LOCAL poller that absorbs out-of-band GitHub label edits into
 * `workflow_reconcile` (which `v_workflow_state` UNIONs) so the session checkpoint
 * badge stays honest vs GitHub even for labels no turn touched. Turn events stay
 * immutable "what-the-turn-did"; reconcile corrects the badge state only (R6).
 *
 * Drift-free `setTimeout` loop (mirrors HeartbeatService — never `setInterval`,
 * to prevent overlapping ticks). Each tick:
 *   1. lists this node's sessions (federation node-locality is free — remote
 *      nodes run their own poller — Fable D10);
 *   2. dedupes distinct linked issues (gh-quota: bounded by distinct issues ×
 *      cadence, NOT session count);
 *   3. fetches each issue's `labeled`/`unlabeled` timeline via `gh api`;
 *   4. mirrors the snapshot into `workflow_reconcile` per (session, issue).
 *
 * Fail-open everywhere (R7): a tick, a single-issue fetch, or a single-session
 * write failing never throws and never aborts the loop. DEFAULT DISABLED (KD3) —
 * `start()` no-ops unless `config.enabled`.
 */

import type { Session } from "@hapi/protocol";
import type { TurnStore } from "../store/turns/turnStore";
import type { ErrorLogger } from "../logging/errorLogger";
import type { WorkflowReconcileConfig } from "../config/workflowReconcileConfig";
import { SupervisedLoop, type JobRegistry } from "@hapi/protocol";

/** A resolved label timeline event (the shape `replaceReconcileLabels` consumes). */
export interface TimelineEvent {
  kind: "label_added" | "label_removed";
  label: string;
  tsMs: number;
}

export interface WorkflowReconcileDeps {
  /** Lists this node's sessions (e.g. syncEngine.getSessions). */
  getSessions: () => Session[];
  /** The turn store — only `replaceReconcileLabels` is used. */
  turnStore: Pick<TurnStore, "replaceReconcileLabels">;
  /** This node's id (= `federationConfig?.nodeId ?? "standalone"`), stamped on rows (R5). */
  nodeId: string;
  config: WorkflowReconcileConfig;
  errorLogger?: ErrorLogger | null;
  /** Runtime job registry to register the supervised loop into (#1963). */
  jobRegistry?: JobRegistry | null;
  /**
   * Timeline fetcher — injectable testing seam. Defaults to the `gh api` spawn
   * below. Returns the issue's `labeled`/`unlabeled` events. MAY throw / reject;
   * the tick wraps it fail-open per-issue.
   */
  fetchTimeline?: (
    repo: string,
    issueNumber: number
  ) => Promise<TimelineEvent[]>;
}

/**
 * Default timeline fetcher: `gh api repos/<repo>/issues/<n>/timeline --paginate`
 * filtered to label events. Output is newline-delimited compact JSON (verified).
 * Spawns `gh` exactly like `routes/github.ts:fetchIssueWithGhCli`.
 */
async function defaultFetchTimeline(
  repo: string,
  issueNumber: number
): Promise<TimelineEvent[]> {
  const proc = Bun.spawn(
    [
      "gh",
      "api",
      `repos/${repo}/issues/${issueNumber}/timeline`,
      "--paginate",
      "--jq",
      '.[] | select(.event == "labeled" or .event == "unlabeled") | {event: .event, label: .label.name, created_at: .created_at}',
    ],
    { stdout: "pipe", stderr: "pipe" }
  );
  const [exitCode, stdoutText] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`gh api timeline failed (exit ${exitCode})`);
  }
  return parseTimelineJsonl(stdoutText);
}

/** Parse newline-delimited `{event,label,created_at}` JSON into TimelineEvents. */
export function parseTimelineJsonl(stdout: string): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let obj: { event?: string; label?: string | null; created_at?: string };
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof obj.label !== "string" || typeof obj.created_at !== "string") {
      continue;
    }
    const tsMs = Date.parse(obj.created_at);
    if (Number.isNaN(tsMs)) continue;
    const kind =
      obj.event === "labeled"
        ? "label_added"
        : obj.event === "unlabeled"
          ? "label_removed"
          : null;
    if (kind === null) continue;
    events.push({ kind, label: obj.label, tsMs });
  }
  return events;
}

export class WorkflowReconcileService {
  /**
   * #1963: supervised-loop wrapper (finally-reschedule + stall watchdog +
   * job-registry registration). `tick()` below is the unit of work — kept
   * public + fail-open so tests can still drive it deterministically.
   */
  private readonly loop: SupervisedLoop;

  constructor(private readonly deps: WorkflowReconcileDeps) {
    this.loop = new SupervisedLoop({
      name: "workflow-reconcile",
      node: this.deps.nodeId,
      intervalMs: this.deps.config.intervalMs,
      enabled: this.deps.config.enabled,
      immediate: false, // first tick after one interval (preserves prior cadence)
      registry: this.deps.jobRegistry ?? undefined,
      tick: () => this.tick(),
    });
  }

  /** Start the poller if enabled (KD3 default-disabled). */
  start(): void {
    if (!this.deps.config.enabled) {
      this.deps.errorLogger?.info(
        "[WorkflowReconcile] disabled in config, not starting",
        { category: "workflow-reconcile" }
      );
      // Register as stopped so a disabled poller is still visible (Sub-D #1964).
      this.loop.start();
      return;
    }
    this.deps.errorLogger?.info(
      `[WorkflowReconcile] started (interval ${this.deps.config.intervalMs}ms)`,
      { category: "workflow-reconcile" }
    );
    this.loop.start();
  }

  stop(): void {
    this.loop.stop();
  }

  /**
   * Run one reconcile pass. Public so tests can drive it deterministically.
   * Fail-open: never throws.
   */
  async tick(): Promise<void> {
    try {
      const fetch = this.deps.fetchTimeline ?? defaultFetchTimeline;

      // Dedupe distinct linked issues across active sessions (gh-quota bound).
      const byIssue = new Map<
        string,
        { repo: string; number: number; sessionIds: string[] }
      >();
      for (const s of this.deps.getSessions()) {
        if (!s.active) continue;
        const li = s.linkedIssue;
        if (
          !li ||
          typeof li.repo !== "string" ||
          typeof li.number !== "number"
        ) {
          continue;
        }
        const key = `${li.repo}#${li.number}`;
        const entry = byIssue.get(key);
        if (entry) {
          entry.sessionIds.push(s.id);
        } else {
          byIssue.set(key, {
            repo: li.repo,
            number: li.number,
            sessionIds: [s.id],
          });
        }
      }

      for (const entry of byIssue.values()) {
        let events: TimelineEvent[];
        try {
          events = await fetch(entry.repo, entry.number);
        } catch (error) {
          this.deps.errorLogger?.warn(
            "[WorkflowReconcile] timeline fetch failed",
            {
              category: "workflow-reconcile",
              stack: error instanceof Error ? error.stack : null,
              context: { repo: entry.repo, issueNumber: entry.number },
            }
          );
          continue; // one bad issue never aborts the tick (R7)
        }
        for (const sessionId of entry.sessionIds) {
          try {
            this.deps.turnStore.replaceReconcileLabels(
              sessionId,
              entry.number,
              this.deps.nodeId,
              events
            );
          } catch (error) {
            this.deps.errorLogger?.warn(
              "[WorkflowReconcile] reconcile write failed",
              {
                category: "workflow-reconcile",
                stack: error instanceof Error ? error.stack : null,
                context: { sessionId, issueNumber: entry.number },
              }
            );
          }
        }
      }
    } catch (error) {
      this.deps.errorLogger?.warn("[WorkflowReconcile] tick failed", {
        category: "workflow-reconcile",
        stack: error instanceof Error ? error.stack : null,
      });
    }
  }

  /**
   * Skill-revamp 3.2 (#2157) — one-shot reconcile of a repo's linked issues,
   * triggered by the webhook gap detector when webhooks are broken (R6). Reuses
   * the exact tick machinery (gh timeline → `replaceReconcileLabels`) rather than
   * forking a second poller — the whole point of #2157's "wire the existing
   * poller, don't rebuild it".
   *
   * 🔴 Respects the operator disable: the service is constructed unconditionally
   * (`server/src/index.ts`), so a public `reconcileNow` would otherwise run `gh`
   * fetches even when the operator set `HAPI_WORKFLOW_RECONCILE_ENABLED=false`.
   * When disabled it no-ops with an explanatory log line. Fail-open like `tick`.
   *
   * `issueNumbers` omitted ⇒ reconcile ALL of this repo's linked issues.
   */
  async reconcileNow(repo: string, issueNumbers?: number[]): Promise<void> {
    if (!this.deps.config.enabled) {
      this.deps.errorLogger?.info(
        "[WorkflowReconcile] reconcileNow: disabled by config " +
          "(HAPI_WORKFLOW_RECONCILE_ENABLED=false) — no-op",
        { category: "workflow-reconcile", context: { repo } }
      );
      return;
    }
    try {
      const fetch = this.deps.fetchTimeline ?? defaultFetchTimeline;
      const wanted = issueNumbers ? new Set(issueNumbers) : null;

      // Map this repo's linked issues → the sessions tracking them (gh-quota
      // bound: distinct issues, not session count — mirrors tick()).
      const byIssue = new Map<number, string[]>();
      for (const s of this.deps.getSessions()) {
        const li = s.linkedIssue;
        if (
          !li ||
          li.repo !== repo ||
          typeof li.number !== "number" ||
          (wanted && !wanted.has(li.number))
        ) {
          continue;
        }
        const list = byIssue.get(li.number) ?? [];
        list.push(s.id);
        byIssue.set(li.number, list);
      }

      for (const [issueNumber, sessionIds] of byIssue) {
        let events: TimelineEvent[];
        try {
          events = await fetch(repo, issueNumber);
        } catch (error) {
          this.deps.errorLogger?.warn(
            "[WorkflowReconcile] reconcileNow timeline fetch failed",
            {
              category: "workflow-reconcile",
              stack: error instanceof Error ? error.stack : null,
              context: { repo, issueNumber },
            }
          );
          continue; // one bad issue never aborts the reconcile (R7)
        }
        for (const sessionId of sessionIds) {
          try {
            this.deps.turnStore.replaceReconcileLabels(
              sessionId,
              issueNumber,
              this.deps.nodeId,
              events
            );
          } catch (error) {
            this.deps.errorLogger?.warn(
              "[WorkflowReconcile] reconcileNow write failed",
              {
                category: "workflow-reconcile",
                stack: error instanceof Error ? error.stack : null,
                context: { sessionId, issueNumber },
              }
            );
          }
        }
      }
    } catch (error) {
      this.deps.errorLogger?.warn("[WorkflowReconcile] reconcileNow failed", {
        category: "workflow-reconcile",
        stack: error instanceof Error ? error.stack : null,
        context: { repo },
      });
    }
  }
}
