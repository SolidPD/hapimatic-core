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
 * Fail-open everywhere (R7): a tick, a single-issue fetch, or one issue's write
 * (all its sessions in one transaction) failing never throws and never aborts
 * the loop. DEFAULT DISABLED (KD3) —
 * `start()` no-ops unless `config.enabled`.
 */

import type { Session } from "@hapi/protocol";
import {
  RECONCILE_WRITE_BUSY_TIMEOUT_MS,
  type TurnStore,
} from "../store/turns/turnStore";
import type { ErrorLogger, ErrorLogOptions } from "../logging/errorLogger";
import type { WorkflowReconcileConfig } from "../config/workflowReconcileConfig";
import { SupervisedLoop, type JobRegistry } from "@hapi/protocol";
import type { GhRunner } from "../utils/githubCli";
import { ghRunnerWithKillTimer } from "../throughput/github/client";

/** A resolved label timeline event (the shape `replaceReconcileLabels` consumes). */
export interface TimelineEvent {
  kind: "label_added" | "label_removed";
  label: string;
  tsMs: number;
  /** #2503 (R10): the GitHub event id, the tie-break for same-second events. */
  id?: number;
}

/**
 * #2503 (R12): a repo-wide `reconcileNow(repo)` (no issue list, the webhook gap
 * detector's call) runs at most once per this window per repo.
 */
export const REPO_WIDE_RECONCILE_COOLDOWN_MS = 15 * 60_000;

/**
 * #2503 (R6): the first tick's pass covers linked sessions whose `updatedAt`, or
 * whose latest turn's start (fix round 2, R2-3), is within this many days. The
 * number is the worktree retention window,
 * `DEFAULT_RETENTION_DAYS` in `cli/src/daemon/worktree.ts:81`; it is copied, not
 * imported (that constant is unexported and outside the server's rootDir, and
 * the server's own `accounts/usageHistory.ts` export of that name is 14).
 */
export const ARCHIVED_RECONCILE_WINDOW_DAYS = 10;
const ARCHIVED_RECONCILE_WINDOW_MS =
  ARCHIVED_RECONCILE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export interface WorkflowReconcileDeps {
  /** Lists this node's sessions (e.g. syncEngine.getSessions). */
  getSessions: () => Session[];
  /**
   * The turn store: the one-issue batch writer (#2503 R10), the latest turn
   * of a session for the first tick's pass (fix round 2, R2-3), and the lock
   * try and lowered wait of this service's persisted log lines (R2-2).
   */
  turnStore: Pick<
    TurnStore,
    | "replaceReconcileLabelsForSessions"
    | "getLatestTurnForSession"
    | "tryWriteLock"
    | "withBusyTimeout"
  >;
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
  /** Clock for the repo-wide cooldown (#2503 R12); a testing seam. */
  now?: () => number;
  /**
   * Monotonic clock for the busy window (#2503 fix round 2, R2-1); a testing
   * seam. Defaults to `performance.now()`, never `Date.now()`: a wall clock
   * can step back (WSL2 steps it about 2.7 s every 32 s).
   */
  monotonicNow?: () => number;
}

/**
 * #2503 fix round 2 (R2-1): after the database answers busy, every reconcile
 * write and link clear returns busy with no database call for this long, so
 * callers that resume in one loop turn (a shared fetch's continuations, link
 * clears whose timers expire together) wait 250 ms once, not once each.
 * Fix round 3 (R3-2): a slow call's try-once window lasts as long.
 */
export const BUSY_WINDOW_MS = 1_000;

/**
 * #2503 fix round 2 (the delta reviewer's F1), fix round 3 (R3-2): a database
 * call that took this long or more begins the try-once window
 * ({@link BUSY_WINDOW_MS}), in which the write, the clear, the lock try and
 * the log INSERT wait 0 ms: a free lock lands at once (R3), and a held one
 * answers busy at once. A busy write, clear or lock try then begins the busy
 * window (R10); a busy INSERT is swallowed by ErrorLogger and begins none,
 * and the next call, at 0 ms, begins it.
 */
export const SLOW_DATABASE_CALL_MS = 50;

/**
 * #2503 (R7): a timeline fetch is killed after 30 s, the repo's REST cap
 * (`throughput/github/client.ts`). The slowest measured fetch took 3.6 s.
 */
export const TIMELINE_FETCH_TIMEOUT_MS = 30_000;
/**
 * #2503 (R7): the outer race waits this long past the kill before it settles
 * the fetch, because a descendant holding the pipes open keeps the stream reads
 * pending after the child itself was killed.
 */
export const TIMELINE_FETCH_GRACE_MS = 5_000;
/** #2503 (R7): this many timed-out fetches in a row end a tick's fetching. */
export const MAX_CONSECUTIVE_TIMEOUTS = 2;
/**
 * #2503 fix round 3 (the operator's 146 a): a final round whose fetch failed
 * is retried in the next tick, at most this many rounds in all, then dropped
 * (#6719 fix round 7: a fetch the tick's timeout carry keeps is not counted).
 */
export const MAX_FINAL_ROUND_FETCHES = 3;
/** The characters of stderr a failed fetch's error carries (its tail). */
const STDERR_TAIL_CHARS = 300;
/** Exit code of a child the kill timer ended with SIGKILL (128 + 9). */
const SIGKILL_EXIT_CODE = 137;

/**
 * The jq projection the fetcher runs: label events only, with the GitHub event
 * `id` (#2503 R10: the tie-break for same-second events).
 */
const TIMELINE_JQ =
  '.[] | select(.event == "labeled" or .event == "unlabeled") | {event: .event, label: .label.name, created_at: .created_at, id: .id}';

/**
 * #2503 (R7): one GitHub name segment (`owner` or `repo`). Never exactly `.` or
 * `..`. Mirrored from `extensions/github-issues/routes.ts` GITHUB_NAME_PATTERN,
 * because core code may not import an extension.
 */
const GITHUB_NAME_SEGMENT = /^(?!\.\.?$)[A-Za-z0-9._-]+$/;

/** True when `repo` is exactly `owner/name` with two well-formed segments. */
export function isWellFormedRepo(repo: string): boolean {
  const parts = repo.split("/");
  return (
    parts.length === 2 && parts.every(part => GITHUB_NAME_SEGMENT.test(part))
  );
}

/** A failed timeline fetch: its exit code, its stderr tail, and whether it timed out. */
export class TimelineFetchError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly timedOut: boolean
  ) {
    super(message);
    this.name = "TimelineFetchError";
  }
}

/** The default runner: `gh` killed with SIGKILL after `timeoutMs`, both streams drained. */
export function defaultTimelineRunner(timeoutMs: number): GhRunner {
  return ghRunnerWithKillTimer(timeoutMs);
}

/**
 * #2503 (R7): the timeline fetcher, `gh api repos/<repo>/issues/<n>/timeline
 * --paginate` filtered to label events (gh pages at 100). The runner kills the
 * child after `timeoutMs`; an outer race settles the fetch `graceMs` later even
 * when a descendant holds the pipes open. A non-zero exit throws a
 * {@link TimelineFetchError} carrying the exit code and the stderr tail.
 * `runGh` is the seam a test drives; it defaults to {@link defaultTimelineRunner}.
 */
export function createTimelineFetcher(
  opts: { runGh?: GhRunner; timeoutMs?: number; graceMs?: number } = {}
): (repo: string, issueNumber: number) => Promise<TimelineEvent[]> {
  const timeoutMs = opts.timeoutMs ?? TIMELINE_FETCH_TIMEOUT_MS;
  const graceMs = opts.graceMs ?? TIMELINE_FETCH_GRACE_MS;
  const runGh = opts.runGh ?? defaultTimelineRunner(timeoutMs);
  return async (repo, issueNumber) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const outer = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new TimelineFetchError(
              `gh api timeline did not settle within ${timeoutMs + graceMs}ms`,
              null,
              true
            )
          ),
        timeoutMs + graceMs
      );
    });
    try {
      const result = await Promise.race([
        runGh([
          "gh",
          "api",
          `repos/${repo}/issues/${issueNumber}/timeline`,
          "--paginate",
          "--jq",
          TIMELINE_JQ,
        ]),
        outer,
      ]);
      if (result.code !== 0) {
        const tail = result.stderr.trim().slice(-STDERR_TAIL_CHARS);
        throw new TimelineFetchError(
          `gh api timeline failed (exit ${result.code})${tail ? `: ${tail}` : ""}`,
          result.code,
          result.code === SIGKILL_EXIT_CODE
        );
      }
      return parseTimelineJsonl(result.stdout);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

/** The production fetcher (the default `gh` runner, 30 s timeout). */
const defaultFetchTimeline = createTimelineFetcher();

/** Parse newline-delimited `{event,label,created_at,id}` JSON into TimelineEvents. */
export function parseTimelineJsonl(stdout: string): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let obj: {
      event?: string;
      label?: string | null;
      created_at?: string;
      id?: unknown;
    };
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
    const event: TimelineEvent = { kind, label: obj.label, tsMs };
    if (typeof obj.id === "number" && Number.isFinite(obj.id)) {
      event.id = obj.id;
    }
    events.push(event);
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
  /** #2503 (R7): malformed linked repos already logged (once per repo, per process). */
  private readonly loggedMalformedRepos = new Set<string>();
  /** #2503 (R10): in-flight timeline fetches by `repo#number` (shared, evicted on settle). */
  private readonly inFlight = new Map<string, Promise<TimelineEvent[]>>();
  /** #2503 (R12): when each repo's last repo-wide reconcile started. */
  private readonly lastRepoWideAt = new Map<string, number>();
  /** #2503 (R6): the first tick's full pass has run (once per process). */
  private fullPassDone = false;
  /**
   * #2503 fix round 1 (O2): when the previous tick began; before the first
   * tick, when `start()` started the enabled poller (fix round 4, B6), and
   * null otherwise.
   */
  private previousTickAt: number | null = null;
  /**
   * #2503 (R6): the issue keys that had an active linked session at the
   * previous tick, or in a `reconcileNow` since it (fix round 1, 129a).
   */
  private previousActiveKeys = new Set<string>();
  /**
   * #2503 fix round 1 (S3): link clears that were busy or failed, by
   * `session#number`; each tick tries them in order, stopping at the first
   * that fails (in memory: a restart drops them).
   */
  private readonly owedClears = new Map<
    string,
    { sessionId: string; issueNumber: number }
  >();
  /**
   * #2503 fix round 2 (R2-1): the monotonic time the busy window ends. Only a
   * busy answer from the database moves it (or a lock try whose ROLLBACK
   * threw, F6); a slow call that won never does (fix round 3, R3-2), and a
   * skip inside it never does.
   */
  private busyUntil = Number.NEGATIVE_INFINITY;
  /**
   * #2503 fix round 3 (R3-2): the monotonic time the try-once window ends.
   * A database call that took {@link SLOW_DATABASE_CALL_MS} or more moves it.
   */
  private tryOnceUntil = Number.NEGATIVE_INFINITY;
  /**
   * #2503 fix round 2 (the delta reviewer's F3), fix round 3 (R3-1): the
   * `repo#number` keys a round left unwritten (a write the busy window
   * skipped or the database answered busy, or a key after a busy answer or
   * R7's break), the keys a throw in the tick left unwritten (#6719: the key
   * it hit and every key after it, but not a key whose fetch ran and
   * failed), and a key with no active session whose timeout in a hang the
   * tiers' order would have
   * carried behind R7's break (#6719 fix round 7, at the fetch's catch in
   * {@link tick}); the next tick puts each in its fetch set while a session
   * still links it, one with no active session behind the active keys and
   * ahead of the rest (fix round 4, C1) unless its last attempt timed out
   * (the closer's S-1: then after every tier), and a key it does not reach
   * is carried again.
   */
  private skippedWrites = new Set<string>();
  /**
   * #2503 closer (S-1, the board-26 PM's F-1): the `repo#number` keys whose
   * last fetch attempt in a tick timed out, each with that attempt's sequence
   * number. The next tick fetches them after every key of every tier, oldest
   * timeout first, except that a kept key with no active session ({@link
   * keptAt}) goes after the others; a key leaves when an attempt of it
   * answers or fails otherwise, or when it is not in the tick's fetch set.
   */
  private readonly timedOutAt = new Map<string, number>();
  private timeoutSeq = 0;
  /**
   * #6719 fix round 7 (the board-26 PM's G4 ruling, 2026-11-16): the keys
   * of the timed-out map whose last timeout the tick's timeout carry kept.
   * While a kept key has no active session it sorts after the map's other
   * keys, so it waits behind them while they keep timing out, as the tiers
   * kept it behind R7's break; once its lane is active again it sorts with
   * them, by its timeout (fix round 8, the re-review's R1: an active key is
   * never kept behind the group). Oldest timeout first and R3's bound hold
   * for the map's other keys. A
   * key leaves when an attempt of it answers, fails otherwise or times out
   * without being kept, or when it is not in the tick's fetch set.
   */
  private readonly keptAt = new Set<string>();
  /**
   * #2503 fix round 3 (the operator's 146 a): the final rounds owed, by
   * `repo#number`, each with its failed fetches so far. A final round is the
   * one more round of an issue whose last active session on this node ended
   * (R6); it leaves the map when it lands or its write failed (K1), when
   * its fetch fails for the {@link MAX_FINAL_ROUND_FETCHES}th time (a fetch
   * the timeout carry keeps is not counted, #6719 fix round 7), when a
   * session of the issue is active again, or when no session links it; a
   * lane that works again starts a new final round with its count afresh.
   */
  private readonly finalRounds = new Map<string, number>();

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
    // Fix round 4 (B6, the operator's 146 a): the first tick's O2 window
    // begins at the start, so a lane that works after it and ends before the
    // first tick gets its final round there, and a failed fetch is retried.
    this.previousTickAt = this.now();
    this.loop.start();
  }

  stop(): void {
    this.loop.stop();
  }

  /** True when the operator enabled the poller (Task 11's trigger reads it). */
  isEnabled(): boolean {
    return this.deps.config.enabled;
  }

  /**
   * #2503 fix round 1 (S3, O1): the link trigger's clear of one (session,
   * number) pair, through the 250 ms immediate writer (never the
   * connection's 5 s wait). A busy database or a throw logs ONE line and
   * leaves the clear owed: each later tick tries the owed clears in order,
   * stopping at the first that fails, until it lands; a later clear or write
   * of the pair for the session's link settles it.
   */
  clearLinkedPair(sessionId: string, issueNumber: number): void {
    const failure = this.tryClear(sessionId, issueNumber);
    if (failure === null) return;
    // Busy: the busy window holds, so the line goes to the journal only
    // (R2-F1, #3631); a throw: persisted when the write lock is free (R2-2).
    this.logLine(
      "warn",
      "[WorkflowReconcile] link clear not written (database busy or failed); owed to the next tick",
      {
        category: "workflow-reconcile",
        stack: failure instanceof Error ? failure.stack : null,
        context: { sessionId, issueNumber },
      }
    );
  }

  /** #2503 fix round 1 (S3): try each owed clear once; the first that fails ends this tick's tries. */
  private retryOwedClears(): void {
    for (const owed of [...this.owedClears.values()]) {
      if (this.tryClear(owed.sessionId, owed.issueNumber) !== null) return;
    }
  }

  /**
   * One clear through the 250 ms writer (0 ms inside the try-once window):
   * null when written (which settles an owed clear of the pair), else "busy"
   * or the thrown error (the clear is owed). Inside the busy window it is
   * "busy" with no database call.
   */
  private tryClear(sessionId: string, issueNumber: number): unknown {
    let failure: unknown = "busy";
    try {
      // Fix round 2 (R2-1): inside the busy window, no database call.
      if (!this.inBusyWindow()) {
        const { busy } = this.timed(() =>
          this.deps.turnStore.replaceReconcileLabelsForSessions(
            [sessionId],
            issueNumber,
            this.deps.nodeId,
            [],
            { busyTimeoutMs: this.busyWaitMs() }
          )
        );
        if (busy) this.startBusyWindow();
        else failure = null;
      }
    } catch (error) {
      failure = error;
    }
    const key = `${sessionId}#${issueNumber}`;
    if (failure === null) this.owedClears.delete(key);
    else this.owedClears.set(key, { sessionId, issueNumber });
    return failure;
  }

  /**
   * Run one reconcile pass. Public so tests can drive it deterministically.
   * Fail-open: never throws.
   *
   * #2503 (R6, the operator's D1 = option 1). The FETCH set is the distinct
   * issues with at least one active, well-formed linked session NOW or at the
   * PREVIOUS tick (so an issue is fetched one more round after its last active
   * session on this node ends, and archived siblings keep the issue's final
   * state rather than a lock taken mid-run). The FIRST tick (one interval after
   * start; `immediate: false`) also fetches, once, every linked issue with a
   * linked session updated, or whose latest turn began (fix round 2, R2-3),
   * within {@link ARCHIVED_RECONCILE_WINDOW_DAYS}.
   * gh-quota stays bounded by distinct issues × cadence. Each issue's WRITE set
   * is every session currently linked to it, active or not, built after its
   * fetch resolves ({@link writeSnapshot}), so a re-link during the fetch never
   * receives the old issue's snapshot. Fix round 1 (129a): an active linked
   * session that a `reconcileNow` finds counts as active at the previous
   * tick, so a lane that ran only between two ticks also gets its round; so
   * does a session whose `activeAt` moved after the previous tick began (O2:
   * a reconnected lane makes no link write). Fix round 3 (R3-1): every key
   * a round leaves unwritten is carried into the next tick. Fix round 4
   * (C1): each tick fetches the active keys first, then the carried keys
   * with no active session, then the rest, so an active key never waits
   * behind keys with no active session that hang; the closer's S-1: a key
   * whose last attempt timed out goes after every tier (the bound is at the
   * sort below). A key is carried again when two keys in a row ahead of it
   * time out (R7's break) or a write ahead of it answers busy; keys that
   * keep timing out do that to a key outside the timed-out group only at
   * their first timeout, since after it they go last (inside the group the
   * two oldest go first and break the round, so the group takes turns).
   * A throw that ends the tick carries the key it hit and every key after
   * it, but not a key whose fetch ran and failed (#6719); and the timeout of
   * a key with no active session in a hang where the tiers' order would
   * have carried it behind R7's break carries it (#6719 fix round 7, at the
   * fetch's catch); such a kept key goes after the timed-out group's other
   * keys while it has no active session (the PM's G4 ruling; fix round 8).
   * The operator's 146 a: a final round
   * whose fetch failed is retried, at most
   * {@link MAX_FINAL_ROUND_FETCHES} rounds (a fetch the timeout carry keeps
   * is not counted).
   * The first tick's pass is not a final round for a session last active
   * before `start()`: a fetch that fails there still waits for the next
   * restart. A lane active since `start()` and not active at the first tick
   * gets its final round there (fix round 4, B6).
   */
  async tick(): Promise<void> {
    // #6719 (the PM's adjacent ruling): a throw anywhere in the loop below
    // leaves carried the key it hit and every key after it, as R7's break
    // and a busy write do; the throw itself does not carry a key whose
    // fetch ran and failed (fix round 7's timeout carry may already have),
    // and a key before it keeps what its own round did (written, or a write
    // or fetch that failed, not carried unless that timeout carry took it).
    // A throw before the fetch order is built keeps the keys the previous
    // tick carried (the second adjacent ruling: the set is swapped after
    // the sort).
    let entries: Array<[string, { repo: string; number: number }]> = [];
    let unreached = 0;
    try {
      this.retryOwedClears();
      const carried = this.skippedWrites; // F3, R3-1: one more round each
      const fullPass = !this.fullPassDone;
      // A fetch that fails in the pass waits for the next restart, unless
      // its session was active since start() (a final round, fix round 4).
      this.fullPassDone = true;
      const startedAt = this.now();
      const windowStart = startedAt - ARCHIVED_RECONCILE_WINDOW_MS;
      const activeSince = this.previousTickAt; // fix round 1 (O2, 129a)
      this.previousTickAt = startedAt;
      const activeKeys = new Set<string>();
      const finalKeys = new Set<string>(); // 146 a: one more round begins
      const fetchSet = new Map<string, { repo: string; number: number }>();
      for (const s of this.deps.getSessions()) {
        const li = s.linkedIssue;
        if (
          !li ||
          typeof li.repo !== "string" ||
          typeof li.number !== "number"
        ) {
          continue;
        }
        const key = `${li.repo}#${li.number}`;
        const inPass = fullPass && this.activeInWindow(s, windowStart);
        // Active at some point since the previous tick began (O2): its
        // keep-alives moved activeAt, though no tick saw it active.
        const justActive = activeSince !== null && s.activeAt >= activeSince;
        if (
          !s.active &&
          !inPass &&
          !justActive &&
          !this.previousActiveKeys.has(key) &&
          !carried.has(key) &&
          !this.finalRounds.has(key)
        ) {
          continue;
        }
        if (!this.acceptRepo(li.repo)) continue;
        if (s.active) activeKeys.add(key);
        else if (justActive || this.previousActiveKeys.has(key)) {
          finalKeys.add(key);
        }
        if (!fetchSet.has(key)) {
          fetchSet.set(key, { repo: li.repo, number: li.number });
        }
      }
      // 146 a: an owed final round leaves when no session links its key or
      // one of them is active again; a new one, its count afresh, begins for
      // each key whose last active session ended since the previous tick.
      for (const key of this.finalRounds.keys()) {
        if (!fetchSet.has(key) || activeKeys.has(key)) {
          this.finalRounds.delete(key);
        }
      }
      for (const key of finalKeys) {
        if (!activeKeys.has(key)) this.finalRounds.set(key, 0);
      }
      this.previousActiveKeys = activeKeys;
      for (const key of this.timedOutAt.keys()) {
        if (!fetchSet.has(key)) this.timedOutAt.delete(key);
      }
      for (const key of this.keptAt) {
        if (!fetchSet.has(key)) this.keptAt.delete(key);
      }

      // R3-1, fix round 4 (C1, R3): the active keys first, then the carried
      // keys with no active session, then the rest (a stable sort keeps each
      // tier's order). The closer's S-1 (the board-26 PM's F-1): a key whose
      // last attempt timed out goes after every tier, oldest timeout first
      // (but see the kept keys below), so keys that keep timing out never
      // keep a key that answers from its fetch. Measured in the model to 4
      // hangers per tier (the rows measure the service): every key that
      // answers is fetched, an active one at every tick after its first fetch
      // while the keys that time out keep timing out (two keys ahead of it
      // that start to time out still skip it for one tick); a key that
      // answers again after timing out is fetched within ceil(g/2)+1 ticks
      // (g = the keys that keep timing out, all tiers), where the tiers alone
      // retried the first two hangers of a tier at every tick and every other
      // hanger never; a key whose last attempt timed out waits behind every
      // key whose last timeout is older, of any tier, and may wait behind
      // keys of a lower tier that time out for the first time. These hold for
      // the group without its kept keys that have no active session (below),
      // which wait behind it. A key
      // is still carried to the next tick when two keys in a row ahead of it
      // time out (R7's break) or a write ahead of it answers busy (R10). A
      // throw that ends the tick carries the key it hit and every key after
      // it, but not a key whose fetch ran and failed (#6719); and the
      // timeout of a key with no active session in a hang where the tiers'
      // order would have carried it behind R7's break carries it (fix round
      // 7, at the fetch's catch). The PM's G4 ruling (2026-11-16): such a kept
      // key ranks 4, after the group's other keys, oldest timeout first,
      // while it has no active session; fix round 8: once its lane is active
      // again it ranks 3 with the group, by its timeout.
      const tier = (key: string): number =>
        activeKeys.has(key) ? 0 : carried.has(key) ? 1 : 2;
      const rank = (key: string): number =>
        this.timedOutAt.has(key)
          ? this.keptAt.has(key) && !activeKeys.has(key)
            ? 4
            : 3
          : tier(key);
      // #6719 fix round 7: the tiers' order alone, as before the closer's
      // S-1, read at the catch below (it never reads the timed-out map).
      const tiers = [...fetchSet.keys()].sort((a, b) => tier(a) - tier(b));
      entries = [...fetchSet].sort(
        ([a], [b]) =>
          rank(a) - rank(b) ||
          (this.timedOutAt.get(a) ?? 0) - (this.timedOutAt.get(b) ?? 0)
      );
      // #6719: swapped only now, so a throw above leaves `carried` in place.
      this.skippedWrites = new Set();
      /** R3-1: the keys from `from` on get the next tick's round. */
      const carryFrom = (from: number): void => {
        for (const [key] of entries.slice(from)) this.skippedWrites.add(key);
      };
      let consecutiveTimeouts = 0;
      for (const [i, [key, entry]] of entries.entries()) {
        unreached = i;
        if (consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
          // #2503 (R7): stop fetching for this round, so a tick of sequential
          // timed-out fetches never reaches the loop's 3 × interval stall.
          carryFrom(i);
          this.logLine(
            "warn",
            `[WorkflowReconcile] ${MAX_CONSECUTIVE_TIMEOUTS} consecutive timeline fetches timed out; skipping the rest of this tick`,
            { category: "workflow-reconcile" }
          );
          break;
        }
        let events: TimelineEvent[];
        try {
          events = await this.fetchShared(entry.repo, entry.number);
          consecutiveTimeouts = 0;
          this.timedOutAt.delete(key);
          this.keptAt.delete(key);
        } catch (error) {
          const timedOut =
            error instanceof TimelineFetchError && error.timedOut;
          // #6719 fix round 7: while every fetch of the tick so far timed out
          // (a hang), a key with no active session that the tiers' order puts
          // behind two other keys would have waited there behind R7's break,
          // carried, as the tiers alone kept it; so its timeout carries it,
          // and its final round's count stays. Named limits: a hang that ends
          // later in the tick gives it one more round; after a fetch of the
          // tick that did not time out, its timeout is a failed fetch.
          const kept =
            timedOut &&
            consecutiveTimeouts === i &&
            !activeKeys.has(key) &&
            tiers.indexOf(key) >= MAX_CONSECUTIVE_TIMEOUTS;
          consecutiveTimeouts = timedOut ? consecutiveTimeouts + 1 : 0;
          if (timedOut) this.timedOutAt.set(key, ++this.timeoutSeq);
          else this.timedOutAt.delete(key);
          if (kept) this.keptAt.add(key);
          else this.keptAt.delete(key);
          // 146 a: a final round whose fetch failed gets the next tick's round,
          // at most MAX_FINAL_ROUND_FETCHES rounds in all (a kept fetch is not
          // counted, fix round 7).
          const failed = this.finalRounds.get(key);
          if (kept) {
            this.skippedWrites.add(key);
          } else if (failed !== undefined) {
            if (failed + 1 >= MAX_FINAL_ROUND_FETCHES) {
              this.finalRounds.delete(key);
            } else {
              this.finalRounds.set(key, failed + 1);
            }
          }
          unreached = i + 1; // its fetch ran: a throw does not carry it
          this.logLine("warn", "[WorkflowReconcile] timeline fetch failed", {
            category: "workflow-reconcile",
            stack: error instanceof Error ? error.stack : null,
            context: {
              repo: entry.repo,
              issueNumber: entry.number,
              reason: error instanceof Error ? error.message : String(error),
            },
          });
          continue; // one bad issue never aborts the tick (R7)
        }
        // R6: every session linked to the issue, archived ones included.
        const outcome = this.writeSnapshot(
          entry.repo,
          entry.number,
          events,
          () => true
        );
        if (outcome === "busy") {
          carryFrom(i);
          break; // R10: skip writing for the rest of the round
        }
        this.finalRounds.delete(key); // 146 a: the round was written (or failed, K1)
      }
    } catch (error) {
      for (const [key] of entries.slice(unreached)) {
        this.skippedWrites.add(key);
      }
      this.logLine("warn", "[WorkflowReconcile] tick failed", {
        category: "workflow-reconcile",
        stack: error instanceof Error ? error.stack : null,
      });
    }
  }

  /**
   * #2503 (R6), fix round 2 (R2-3, the operator's 129a: "sessions active in
   * the last 10 days"): the later of the session's `updatedAt` and the start
   * of its latest turn in the persisted turn ledger is at or after
   * `windowStart`. The ledger is read because `updatedAt`'s thinking-to-false
   * bump is cache-only (`sessionCache.ts`), so a restart loses it. A ledger
   * read that throws leaves `updatedAt` alone deciding, as before this round.
   */
  private activeInWindow(s: Session, windowStart: number): boolean {
    if (typeof s.updatedAt === "number" && s.updatedAt >= windowStart) {
      return true;
    }
    try {
      const turn = this.deps.turnStore.getLatestTurnForSession(s.id);
      return turn !== null && turn.startedAtMs >= windowStart;
    } catch {
      return false;
    }
  }

  /**
   * Skill-revamp 3.2 (#2157) — one-shot reconcile of a repo's linked issues,
   * triggered by the webhook gap detector when webhooks are broken (R6). Reuses
   * the exact tick machinery (gh timeline → `writeSnapshot`) rather than
   * forking a second poller — the whole point of #2157's "wire the existing
   * poller, don't rebuild it".
   *
   * 🔴 Respects the operator disable: the service is constructed unconditionally
   * (`server/src/index.ts`), so a public `reconcileNow` would otherwise run `gh`
   * fetches even when the operator set `HAPI_WORKFLOW_RECONCILE_ENABLED=false`.
   * When disabled it no-ops with an explanatory log line. Fail-open like `tick`.
   *
   * `issueNumbers` given ⇒ reconcile those of this repo's linked issues (the
   * link trigger's form; never cooled).
   * `issueNumbers` omitted ⇒ #2503 (R12): the repo-wide form (the gap
   * detector's call) runs at most once per {@link REPO_WIDE_RECONCILE_COOLDOWN_MS}
   * per repo and fetches only issues with an ACTIVE linked session; a call
   * inside the window returns without fetching.
   *
   * Every fetched issue is written to every session currently linked to it.
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
      if (!this.acceptRepo(repo)) return;
      const wanted = issueNumbers ? new Set(issueNumbers) : null;
      if (!wanted) {
        const now = this.now();
        const last = this.lastRepoWideAt.get(repo);
        if (
          last !== undefined &&
          now - last < REPO_WIDE_RECONCILE_COOLDOWN_MS
        ) {
          return;
        }
        this.lastRepoWideAt.set(repo, now);
      }

      // This repo's linked issues to fetch (gh-quota bound: distinct issues).
      const fetchSet = new Set<number>();
      for (const s of this.deps.getSessions()) {
        const li = s.linkedIssue;
        if (!li || li.repo !== repo || typeof li.number !== "number") continue;
        if (wanted ? !wanted.has(li.number) : !s.active) continue;
        // #2503 fix round 1 (129a): an active lane seen here gets the tick's
        // one round after it ends, even if it ends before the next tick.
        if (s.active) this.previousActiveKeys.add(`${repo}#${li.number}`);
        fetchSet.add(li.number);
      }

      for (const issueNumber of fetchSet) {
        let events: TimelineEvent[];
        try {
          events = await this.fetchShared(repo, issueNumber);
        } catch (error) {
          this.logLine(
            "warn",
            "[WorkflowReconcile] reconcileNow timeline fetch failed",
            {
              category: "workflow-reconcile",
              stack: error instanceof Error ? error.stack : null,
              context: {
                repo,
                issueNumber,
                reason: error instanceof Error ? error.message : String(error),
              },
            }
          );
          continue; // one bad issue never aborts the reconcile (R7)
        }
        const outcome = this.writeSnapshot(
          repo,
          issueNumber,
          events,
          () => true
        );
        if (outcome === "busy") break; // R10: skip writing for the rest of the round
      }
    } catch (error) {
      this.logLine("warn", "[WorkflowReconcile] reconcileNow failed", {
        category: "workflow-reconcile",
        stack: error instanceof Error ? error.stack : null,
        context: { repo },
      });
    }
  }

  /**
   * #2503 (R10): concurrent reconciles of one `repo#number` (the tick, the link
   * trigger, the repo-wide form) share one in-flight FETCH. Only the promise is
   * shared, never the write set, and the entry is evicted when the fetch
   * settles, so a rejected fetch is never cached.
   */
  private fetchShared(
    repo: string,
    issueNumber: number
  ): Promise<TimelineEvent[]> {
    const key = `${repo}#${issueNumber}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const fetch = this.deps.fetchTimeline ?? defaultFetchTimeline;
    const promise = (async () => {
      try {
        return await fetch(repo, issueNumber);
      } finally {
        this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, promise);
    return promise;
  }

  /**
   * #2503 (R10): write one fetched snapshot. The write set is built NOW, after
   * the fetch resolved, from the sessions whose CURRENT link equals the fetched
   * (repo, number) and that pass `include`; all of them go in one immediate
   * transaction with a 250 ms busy wait (0 ms inside the try-once window, fix
   * round 3, R3-2). `"busy"` means the caller skips writing
   * for the rest of its round (logged once here, at warn), and the key gets
   * the next tick's round (fix round 3, R3-1). Inside the busy window
   * ({@link BUSY_WINDOW_MS}) it is `"busy"` with no database call.
   */
  private writeSnapshot(
    repo: string,
    issueNumber: number,
    events: TimelineEvent[],
    include: (s: Session) => boolean
  ): "written" | "busy" | "failed" {
    const sessionIds: string[] = [];
    for (const s of this.deps.getSessions()) {
      const li = s.linkedIssue;
      if (li && li.repo === repo && li.number === issueNumber && include(s)) {
        sessionIds.push(s.id);
      }
    }
    if (sessionIds.length === 0) return "written";
    try {
      // Fix round 2 (R2-1): inside the busy window, no database call.
      const skipped = this.inBusyWindow();
      const busy =
        skipped ||
        this.timed(() =>
          this.deps.turnStore.replaceReconcileLabelsForSessions(
            sessionIds,
            issueNumber,
            this.deps.nodeId,
            events,
            { busyTimeoutMs: this.busyWaitMs() }
          )
        ).busy;
      if (!busy) {
        for (const id of sessionIds)
          this.owedClears.delete(`${id}#${issueNumber}`);
        return "written";
      }
      // F3, R3-1: a write the window skipped, or the database answered busy,
      // gets the next tick's round.
      this.skippedWrites.add(`${repo}#${issueNumber}`);
      if (!skipped) this.startBusyWindow();
      this.deps.errorLogger?.warn(
        "[WorkflowReconcile] database busy (another writer holds the lock); skipping the rest of this round",
        {
          category: "workflow-reconcile",
          context: { repo, issueNumber, sessions: sessionIds.length },
          persist: false, // R2-F1 (#3631): the lock is held; see clearLinkedPair
        }
      );
      return "busy";
    } catch (error) {
      this.logLine("warn", "[WorkflowReconcile] reconcile write failed", {
        category: "workflow-reconcile",
        stack: error instanceof Error ? error.stack : null,
        context: { repo, issueNumber, sessions: sessionIds.length },
      });
      return "failed";
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** #2503 fix round 2 (R2-1): the busy window holds. */
  private inBusyWindow(): boolean {
    return this.monotonicNow() < this.busyUntil;
  }

  /**
   * #2503 fix round 2 (R2-1): the database answered busy (or a lock try's
   * ROLLBACK threw, F6); the window begins.
   */
  private startBusyWindow(): void {
    this.busyUntil = this.monotonicNow() + BUSY_WINDOW_MS;
  }

  private monotonicNow(): number {
    return this.deps.monotonicNow?.() ?? performance.now();
  }

  /**
   * #2503 fix round 3 (R3-2): the busy wait of the next database call: 0 ms
   * inside the try-once window, else 250 ms.
   */
  private busyWaitMs(): number {
    return this.monotonicNow() < this.tryOnceUntil
      ? 0
      : RECONCILE_WRITE_BUSY_TIMEOUT_MS;
  }

  /**
   * #2503 fix round 2 (the delta reviewer's F1), fix round 3 (R3-2): one
   * database call. A call that took {@link SLOW_DATABASE_CALL_MS} or more
   * begins the try-once window, whether it then won the lock, failed busy
   * (an ErrorLogger INSERT swallows that), or threw: an outside writer that
   * releases and retakes the lock would otherwise make each later call of
   * the same loop turn wait again. Only a busy answer begins the busy
   * window, so a slow call that won never makes the next write skip (R3).
   */
  private timed<T>(call: () => T): T {
    const started = this.monotonicNow();
    try {
      return call();
    } finally {
      if (this.monotonicNow() - started >= SLOW_DATABASE_CALL_MS) {
        this.tryOnceUntil = this.monotonicNow() + BUSY_WINDOW_MS;
      }
    }
  }

  /**
   * #2503 fix round 2 (R2-2): every persisted log line of this service's
   * enabled path. ErrorLogger's row is an autocommit INSERT on the Store's one
   * connection, so under an outside write lock it would wait the connection's
   * 5 s. So the write lock is tried first under the 250 ms wait: busy, the
   * line goes to the journal only (`persist: false`) and the busy window
   * begins; inside the window, the same with no try; free, the row is
   * persisted under the 250 ms wait, restored after. Inside the try-once
   * window (fix round 3, R3-2) the try and the INSERT wait 0 ms. If another
   * process takes the lock between the try and the INSERT, the INSERT waits
   * at most 250 ms and ErrorLogger's own catch writes the line to the journal
   * instead.
   */
  private logLine(
    level: "warn" | "debug",
    message: string,
    options: ErrorLogOptions
  ): void {
    const logger = this.deps.errorLogger;
    if (!logger) return;
    if (!this.writeLockFree()) {
      logger[level](message, { ...options, persist: false });
      return;
    }
    this.timed(() =>
      this.deps.turnStore.withBusyTimeout(this.busyWaitMs(), () =>
        logger[level](message, options)
      )
    );
  }

  /**
   * #2503 fix round 2 (R2-2): false inside the busy window, or when the lock
   * try reads not free, which begins the window. Fix round 3 (R3-2): a try
   * that was slow and won reads free, inside the try-once window it began.
   */
  private writeLockFree(): boolean {
    if (this.inBusyWindow()) return false;
    let free = true;
    try {
      free = this.timed(() =>
        this.deps.turnStore.tryWriteLock(this.busyWaitMs())
      );
    } catch {
      // Not a busy error, so nothing is known of the lock: the INSERT is
      // tried, under the 250 ms wait (0 ms inside the try-once window).
    }
    if (!free) this.startBusyWindow();
    return free;
  }

  /**
   * #2503 (R7): a linked repo whose owner or name segment is malformed is left
   * out of the work set, before any fetch and before any write (an empty
   * replace would still delete the pair's rows). Logged once per repo, because
   * every ErrorLogger level persists a row to hapi.db.
   */
  private acceptRepo(repo: string): boolean {
    if (isWellFormedRepo(repo)) return true;
    if (!this.loggedMalformedRepos.has(repo)) {
      this.loggedMalformedRepos.add(repo);
      this.logLine(
        "debug",
        "[WorkflowReconcile] skipping a malformed repo on a linked issue",
        { category: "workflow-reconcile", context: { repo } }
      );
    }
    return false;
  }
}

/** The badge fields the link trigger compares (a `SessionWorkflowBadge`). */
type BadgeLike = { activeLabels: readonly string[] } | null;

/** One linked issue, as the engine's link listener reports it. */
type LinkedIssueRef = { repo: string; number: number };

/**
 * #2503 (Task 11, R11, R2; B2's deferral; B1's cross-repo clear): the listener
 * `index.ts` installs with `SyncEngine.setLinkedIssueListener`. Exported so it
 * is testable (`index.ts` exports nothing and has no test file).
 *
 * The returned listener does no work on the link write's call stack: it defers
 * with `setTimeout(0)` (a microtask would run before the route resumes), so the
 * badge SQL, the session scan and the `gh` spawn never delay the PUT. The
 * deferred job, fail-open end to end:
 *   1. returns at once when reconcile is disabled: no `reconcileNow`, no row,
 *      no log line;
 *   2. reads the session's badge;
 *   3. clears the NEW (session, number) pair's `workflow_reconcile` rows
 *      unless the previous link EQUALS the new one (same repo and number;
 *      fix round 1, Rule A). The table has no repo column, and the engine
 *      reports no unlink, so rows left by an earlier link to that number in
 *      another repo (after an unlink, or with another link in between) would
 *      show as the new issue's badge until its reconcile succeeds. The clear
 *      is the service's {@link WorkflowReconcileService.clearLinkedPair} (the
 *      250 ms writer; a busy or failed clear is owed to the next ticks);
 *   4. awaits `reconcileNow(repo, [number])` (the listed form, never cooled);
 *   5. publishes ONE `session-updated` for THIS session when its active labels
 *      changed (compared as sets), never for the siblings the reconcile fanned
 *      out to: a burst would restart every open tab's list fetch (#6208).
 * The republish makes the badge show within seconds on the OWNING node's list;
 * a hub viewing another node's session sees it on its ~30 s backstop (D2 = 1).
 */
export function createLinkReconcileTrigger(deps: {
  service: Pick<
    WorkflowReconcileService,
    "isEnabled" | "reconcileNow" | "clearLinkedPair"
  >;
  getBadge: (sessionId: string) => BadgeLike;
  republish: (sessionId: string) => void;
}): (
  issue: LinkedIssueRef,
  sessionId: string,
  previous: LinkedIssueRef | null
) => void {
  const run = async (
    issue: LinkedIssueRef,
    sessionId: string,
    previous: LinkedIssueRef | null
  ): Promise<void> => {
    if (!deps.service.isEnabled()) return;
    const before = labelSet(deps.getBadge(sessionId));
    if (
      !(
        previous &&
        previous.repo === issue.repo &&
        previous.number === issue.number
      )
    ) {
      deps.service.clearLinkedPair(sessionId, issue.number);
    }
    await deps.service.reconcileNow(issue.repo, [issue.number]);
    if (!sameLabels(before, labelSet(deps.getBadge(sessionId)))) {
      deps.republish(sessionId);
    }
  };
  return (issue, sessionId, previous) => {
    setTimeout(() => {
      void run(issue, sessionId, previous).catch(() => undefined);
    }, 0);
  };
}

function labelSet(badge: BadgeLike): Set<string> {
  return new Set(badge?.activeLabels ?? []);
}

function sameLabels(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const label of a) if (!b.has(label)) return false;
  return true;
}
