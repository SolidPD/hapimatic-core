// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Account-headroom check for the spawn and rebind routes (issue #5879, the
 * second point of the three-point spawn checklist — capacity, account headroom,
 * effort).
 *
 * ONE decision point, called by every entry route on the node that holds the
 * account: the local spawn route (`routes/machines.ts`), the peer-incoming spawn
 * receiver (`routes/federation/peerSpawn.ts`), the local rebind route
 * (`routes/sessions.ts`) and the peer rebind receiver
 * (`routes/federation/sessionMutations.ts`). It is deliberately NOT in
 * `syncEngine.spawnSession` / `switchAccount`: reconnect, respawn, branch, the
 * scheduler, auto-switch and the switch rollback all share those, and refusing
 * them would strand live sessions (Fallback Preservation Rule).
 *
 * Reconciliation with #5460 ("never refuse a spawn for a spent account"): this
 * refuses only an EXPLICIT pin onto a CONFIRMED lock (`findHardLock` — a window
 * at its cap with a future reset, in a known usage row, overage off), always with
 * a `forceAccount` escape and a named alternative. Unknown usage fails open with
 * a warning; un-pinned spawns never reach this check.
 */
import {
  ACCOUNT_EXHAUSTED_CODE,
  findHardLock,
  resolveModelFamily,
  selectOptimalAccountUuid,
  type AccountExhaustion,
  type AccountUsage,
  type HardLock,
  type ModelFamily,
  type SpawnWarning,
} from "@hapi/protocol";
import { parseEnvInt } from "../utils/rateLimitCounter";
import { DEFAULT_USAGE_STALE_AFTER_MS } from "./usageService";
import type { ErrorLogger } from "../logging/errorLogger";

export { ACCOUNT_EXHAUSTED_CODE };

/**
 * The model family a rebind's headroom check uses for a session: the live pins
 * first, then the durable metadata ones. `buildSessionRecord` rebuilds the
 * top-level `modelMode` from memory only, so after a server restart a
 * disconnected session pinned to Fable would otherwise skip its Fable weekly
 * window, which the spawn path checks.
 */
export function sessionModelFamily(session: {
  rawModel?: string | null;
  modelMode?: string | null;
  metadata?: { rawModel?: string | null; modelMode?: string | null } | null;
}): ModelFamily | null {
  return resolveModelFamily(
    session.rawModel ??
      session.modelMode ??
      session.metadata?.rawModel ??
      session.metadata?.modelMode
  );
}

/**
 * How long a route waits for a stale usage snapshot to refresh before deciding
 * on the cached one (`getLatest()`). A stale `getCachedOrRefresh()` can take ~20 s
 * (5 s fetch + a 10 s 429 budget + a last retry, `usageService.ts`); 2.5 s keeps
 * a spawn responsive and under the hub's 10 s federation timeout. Deciding on a
 * cached snapshot is sound for a refusal: a window's utilization only falls at
 * its `resets_at`, which `findHardLock` checks. Env `HAPI_SPAWN_USAGE_DEADLINE_MS`.
 */
export const DEFAULT_SPAWN_USAGE_DEADLINE_MS = 2_500;
export const MAX_SPAWN_USAGE_DEADLINE_MS = 7_000;

export function resolveSpawnUsageDeadlineMs(
  raw: string | undefined = process.env.HAPI_SPAWN_USAGE_DEADLINE_MS
): number {
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_SPAWN_USAGE_DEADLINE_MS;
  // Capped below the hub's 10 s federation timeout (`nodeRegistry.ts`
  // `FETCH_TIMEOUT_MS`), so a peer's headroom wait can never outlast the hub
  // that is waiting on it.
  return Math.min(MAX_SPAWN_USAGE_DEADLINE_MS, Math.max(250, Math.round(n)));
}

/** Read once at module load (mirrors the rate-limit env knobs). */
const SPAWN_USAGE_DEADLINE_MS = resolveSpawnUsageDeadlineMs();

/**
 * Issue #6028: a decision made on a usage row older than this carries a
 * warning. The same env knob and default as the usage service's own staleness
 * guard (`HAPI_USAGE_STALE_AFTER_MS`, `usageService.ts`), read here rather than
 * threaded from `index.ts`, so the two thresholds cannot drift apart.
 */
const SPAWN_USAGE_STALE_AFTER_MS = parseEnvInt(
  process.env.HAPI_USAGE_STALE_AFTER_MS,
  DEFAULT_USAGE_STALE_AFTER_MS
);

/** The usage reader this module needs — a structural subset of `UsageService`. */
export interface HeadroomUsageSource {
  getCachedOrRefresh(): Promise<AccountUsage[]>;
  getLatest(): AccountUsage[] | null;
}

/** Whether the account store lists `accountUuid` under a non-Anthropic provider.
 *  An unreadable store or an unknown account reads as Anthropic (the check runs). */
function isNonAnthropicAccount(
  deps: HeadroomDeps,
  accountUuid: string
): boolean {
  try {
    const account = deps.accountService
      ?.list()
      .find(a => a.accountUuid === accountUuid);
    return (
      account !== undefined && (account.provider ?? "anthropic") !== "anthropic"
    );
  } catch {
    return false;
  }
}

/** The account reader this module needs — a structural subset of `AccountService`. */
export interface HeadroomAccountSource {
  list(): Array<{
    accountUuid: string;
    provider?: string;
    unrefreshable?: boolean;
  }>;
}

export interface HeadroomDeps {
  usageService: HeadroomUsageSource | null | undefined;
  accountService: HeadroomAccountSource | null | undefined;
  /** This node's identity, named in the refusal. */
  nodeIdentity: { nodeId: string; nodeLabel: string };
  now?: () => number;
  deadlineMs?: number;
  /** Issue #6028: usage older than this (ms) warns. Defaults to the usage
   *  service's stale threshold; a test seam. */
  staleAfterMs?: number;
  /** Issue #6028: where a swallowed refresh rejection or account-store read
   *  failure is logged; `console.warn` when unwired. */
  errorLogger?: Pick<ErrorLogger, "warn"> | null;
}

export interface HeadroomRequest {
  accountUuid: string;
  /** From `resolveModelFamily(rawModel ?? modelMode)`; null = no scoped check. */
  modelFamily: string | null;
  forceAccount: boolean;
}

export type HeadroomVerdict =
  /** Known usage, no lock. `warning` set when the deciding usage is stale (#6028). */
  | { kind: "clear"; email: string | null; warning?: SpawnWarning }
  /** Usage unknown — the caller proceeds and attaches `warning`. */
  | { kind: "unknown"; email: string | null; warning: SpawnWarning }
  /**
   * A confirmed lock. `forced` → the caller proceeds and attaches `warning`;
   * otherwise it answers 409 with `message` + `exhaustion`.
   */
  | {
      kind: "exhausted";
      email: string | null;
      forced: boolean;
      message: string;
      exhaustion: AccountExhaustion;
      warning: SpawnWarning;
      /** Issue #6028: set when the deciding usage is stale; a forced pin carries it. */
      staleWarning?: SpawnWarning;
    };

/**
 * Read the node's usage, refreshing a stale snapshot for at most `deadlineMs`.
 * Never throws: a late or rejected refresh falls back to the cached snapshot
 * (which may be `null`). The refresh keeps running in the background and fills
 * the cache. Its rejection is handed to `onRefreshError` exactly once — before or
 * after the deadline — so it is logged and never unhandled (issue #6028).
 */
export async function readUsageWithDeadline(
  source: HeadroomUsageSource,
  deadlineMs: number,
  onRefreshError: (err: unknown) => void = () => {}
): Promise<AccountUsage[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const refresh = source.getCachedOrRefresh();
    refresh.catch(err => {
      try {
        onRefreshError(err);
      } catch {
        // A logging failure must never surface as an unhandled rejection.
      }
    });
    const result = await Promise.race([
      refresh,
      new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), deadlineMs);
      }),
    ]);
    return result ?? source.getLatest();
  } catch {
    try {
      return source.getLatest();
    } catch {
      return null;
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function windowLabel(lock: HardLock): string {
  switch (lock.window) {
    case "five_hour":
      return "5-hour limit";
    case "seven_day":
      return "weekly limit";
    case "weekly_scoped":
      return `${lock.model ?? "model"} weekly limit`;
  }
}

function hasMeters(row: AccountUsage): boolean {
  const u = row.utilization;
  return Boolean(
    u && (u.five_hour || u.seven_day || (u.limits && u.limits.length > 0))
  );
}

/**
 * Decide whether `req.accountUuid` has headroom on this node. Pure apart from
 * the injected services.
 */
export async function checkAccountHeadroom(
  deps: HeadroomDeps,
  req: HeadroomRequest
): Promise<HeadroomVerdict> {
  const now = (deps.now ?? Date.now)();
  const unknown = (email: string | null, why: string): HeadroomVerdict => ({
    kind: "unknown",
    email,
    warning: {
      code: "usage_unavailable",
      message: `Usage for the selected account is unavailable on ${deps.nodeIdentity.nodeLabel} (${why}); proceeding without a headroom check.`,
    },
  });

  // No usage service wired (a test stub or a node without the usage cache) is
  // "not configured", not a usage outage: the check does not apply and the
  // response stays byte-identical (the #3633 envelope lock). A real outage —
  // no snapshot, no row, a degraded status — still warns below.
  if (!deps.usageService) return { kind: "clear", email: null };
  // The usage cache meters Anthropic accounts only, so a non-Anthropic target
  // (an OpenAI or Google account on a codex or gemini rebind) has no window to
  // check: clear, with no usage read and no warning. This also clears an API
  // pin of such an account on a claude or opencode spawn, which the web never sends.
  if (isNonAnthropicAccount(deps, req.accountUuid)) {
    return { kind: "clear", email: null };
  }
  const rows = await readUsageWithDeadline(
    deps.usageService,
    deps.deadlineMs ?? SPAWN_USAGE_DEADLINE_MS,
    err =>
      logWarn(
        deps,
        `Spawn headroom: the usage refresh on ${deps.nodeIdentity.nodeLabel} failed (${errText(err)})`
      )
  );
  if (!rows) return unknown(null, "no usage snapshot");
  const row = rows.find(r => r.accountUuid === req.accountUuid);
  if (!row) return unknown(null, "account not in the usage snapshot");
  const email = row.email ?? null;
  if (row.status !== "ok" && row.status !== "rate_limited") {
    return unknown(email, `usage status ${row.status}`);
  }
  if (!hasMeters(row)) return unknown(email, "no usage meters");

  // Issue #6028: the row may be a cached snapshot (a late or failed refresh) or
  // a last-good row the usage service preserved across an upstream error, which
  // keeps status "ok" with its original fetchedAt. Either way, say how old it is.
  const staleAfterMs = deps.staleAfterMs ?? SPAWN_USAGE_STALE_AFTER_MS;
  const ageMs = now - row.fetchedAt;
  const staleWarning: SpawnWarning | undefined =
    ageMs > staleAfterMs
      ? {
          code: "usage_unavailable",
          message: `Usage for the selected account on ${deps.nodeIdentity.nodeLabel} was fetched ${Math.round(ageMs / 60_000)} min ago (older than ${Math.round(staleAfterMs / 60_000)} min); the headroom check used that snapshot.`,
        }
      : undefined;

  const lock = findHardLock(row.utilization, {
    modelFamily: req.modelFamily,
    now,
  });
  if (!lock) {
    return staleWarning
      ? { kind: "clear", email, warning: staleWarning }
      : { kind: "clear", email };
  }

  const pick = pickAlternative(deps, rows, req, now);
  const alternative = pick.kind === "pick" ? pick.alternative : null;
  const who = email ?? row.displayLabel;
  const instead = refusalAdvice(pick, deps.nodeIdentity.nodeLabel);
  const message = `Account ${who} is at its ${windowLabel(lock)} (${Math.round(lock.utilization)}%) until ${lock.resetsAt} on ${deps.nodeIdentity.nodeLabel}. ${instead}`;
  return {
    kind: "exhausted",
    email,
    forced: req.forceAccount,
    message,
    exhaustion: {
      accountUuid: req.accountUuid,
      email,
      window: lock.window,
      model: lock.model,
      utilization: lock.utilization,
      resetsAt: lock.resetsAt,
      fetchedAt: row.fetchedAt,
      alternative,
      nodeId: deps.nodeIdentity.nodeId,
      nodeLabel: deps.nodeIdentity.nodeLabel,
    },
    warning: {
      code: "forced_exhausted_account",
      message: `forceAccount: bound ${who}, which is at its ${windowLabel(lock)} until ${lock.resetsAt}; the session may fail on its first turn until then.`,
    },
    ...(staleWarning ? { staleWarning } : {}),
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Log through the wired error logger, else the console (issue #6028). */
function logWarn(deps: HeadroomDeps, message: string): void {
  if (deps.errorLogger) {
    deps.errorLogger.warn(message, { category: "spawn-headroom" });
  } else {
    console.warn(`[accountHeadroom] ${message}`);
  }
}

/** The outcome of {@link pickAlternative} (issue #6028). */
type AlternativePick =
  | { kind: "pick"; alternative: NonNullable<AccountExhaustion["alternative"]> }
  | { kind: "none" }
  | { kind: "unreadable" };

/** The refusal's "what to do instead" sentence for each pick outcome. */
function refusalAdvice(pick: AlternativePick, nodeLabel: string): string {
  switch (pick.kind) {
    case "pick": {
      const { email, displayLabel, score } = pick.alternative;
      const scored = score != null ? ` (score ${score})` : "";
      return `Use ${email ?? displayLabel}${scored}, or send forceAccount: true to use it anyway.`;
    }
    case "unreadable":
      return `The account list on ${nodeLabel} could not be read, so no alternative was checked; send forceAccount: true to use it anyway.`;
    case "none":
      return "No other account on this node has headroom; send forceAccount: true to use it anyway.";
  }
}

/**
 * The lowest-score account in this node's store with headroom for the same
 * model, excluding the requested one — the shared #3611 picker, plus the
 * model-scoped lock check the score does not cover. `unreadable` when the
 * account store cannot be listed (issue #6028), so the refusal does not claim
 * that no other account has headroom.
 */
function pickAlternative(
  deps: HeadroomDeps,
  rows: AccountUsage[],
  req: HeadroomRequest,
  now: number
): AlternativePick {
  let accounts: ReturnType<HeadroomAccountSource["list"]>;
  try {
    accounts = deps.accountService?.list() ?? [];
  } catch (err) {
    logWarn(
      deps,
      `Spawn headroom: the account list on ${deps.nodeIdentity.nodeLabel} could not be read; no alternative offered (${errText(err)})`
    );
    return { kind: "unreadable" };
  }
  const byUuid = new Map(rows.map(r => [r.accountUuid, r]));
  const candidates = accounts.filter(a => {
    if ((a.provider ?? "anthropic") !== "anthropic") return false;
    if (a.accountUuid === req.accountUuid) return false;
    const r = byUuid.get(a.accountUuid);
    return (
      !r || !findHardLock(r.utilization, { modelFamily: req.modelFamily, now })
    );
  });
  const unrefreshable = new Set(
    accounts.filter(a => a.unrefreshable === true).map(a => a.accountUuid)
  );
  const pick = selectOptimalAccountUuid(candidates, rows, uuid =>
    unrefreshable.has(uuid)
  );
  if (!pick) return { kind: "none" };
  const r = byUuid.get(pick);
  if (!r) return { kind: "none" };
  return {
    kind: "pick",
    alternative: {
      accountUuid: pick,
      email: r.email ?? null,
      displayLabel: r.nickname ?? r.displayLabel,
      score: typeof r.score === "number" ? r.score : null,
    },
  };
}

/** The warnings a verdict adds to a success response (a clear verdict adds only its stale-usage warning, if any). */
export function headroomWarnings(verdict: HeadroomVerdict): SpawnWarning[] {
  if (verdict.kind === "unknown") return [verdict.warning];
  if (verdict.kind === "clear") return verdict.warning ? [verdict.warning] : [];
  if (verdict.forced) {
    return verdict.staleWarning
      ? [verdict.warning, verdict.staleWarning]
      : [verdict.warning];
  }
  return [];
}
