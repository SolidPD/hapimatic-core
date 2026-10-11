// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import {
  computeUtilizationScore,
  type ProviderAccountUsage,
  type ProviderUsageStatus,
  type ProviderUsageWindow,
  type Utilization,
} from "@hapi/protocol";
import type { ProviderUsageSnapshotWindow } from "@hapi/protocol/schemas";
import type {
  AccountService,
  RedactedAccount,
} from "../services/accountService";

/**
 * Per-account usage for NON-Anthropic providers (issue #3809, epic #3345 — the
 * K9 serial chain #3806 → #3807 → #3808 → #3809). The SIBLING of `UsageService`
 * (ruling D5 = C): it populates `providerUsage[]` while `UsageService` owns the
 * Anthropic-only `usage[]`, so `usage[]` stays byte-identical and Anthropic-only
 * forever and history/alerts never see a provider row (they consume
 * `UsageService.refresh()` exclusively).
 *
 * Unlike `UsageService` this service makes NO upstream fetch — neither provider
 * exposes a pollable account-level limit like Anthropic's OAuth usage endpoint:
 *
 *  - **OpenAI (codex)**: a SESSION-delivered snapshot. The codex app-server
 *    `token_count` event carries a `rate_limits` sibling (`primary` = 5-hour,
 *    `secondary` = weekly); `codexRemoteLauncher` forwards it over the `/cli`
 *    socket (`provider-usage-snapshot`), `sessionHandlers` attributes it to the
 *    session's bound account and calls {@link recordCodexSnapshot}. The snapshot
 *    is ACCOUNT-scoped but only refreshes while a session of that account runs,
 *    so staleness is first-class (`stale` past the sampler interval → the card
 *    shows "as of <time>"; `error` past 30 min → a selector never makes a
 *    false-healthy pick).
 *  - **Google (gemini)**: a derived token-SPEND counter, aggregated on read from
 *    this node's `turns` rows (`model_provider = 'google'`, keyed by
 *    `account_id`). There is no queryable account-level Gemini limit for an API
 *    key, so a Google row is never a 0–100 % bar and never a veto/HOLD input.
 *
 * Redaction: it returns only `ProviderAccountUsage` (a `.parse()`d whitelist on
 * every route egress). No token/key value is ever read or surfaced.
 */

/** OpenAI snapshot older than this reads `stale` — the card shows "as of <time>".
 *  Default 2 min = the usage sampler interval (`usageHistory.ts` default). */
export const DEFAULT_PROVIDER_STALE_AFTER_MS = 2 * 60 * 1000;
/** OpenAI snapshot older than this reads `error` (never `ok`/`stale`) so a
 *  selector never makes a false-healthy pick against a long-dead session. */
export const DEFAULT_PROVIDER_ERROR_AFTER_MS = 30 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** The newest normalized codex snapshot for one OpenAI account. */
interface StoredSnapshot {
  /** Windows with `resets_at` already normalized to an ISO-8601 string | null. */
  windows: ProviderUsageWindow[];
  fetchedAt: number;
}

/** Per-account Google token spend (rolling 24 h / 7 d), keyed by `account_id`. */
interface GoogleSpendRow {
  tokensToday: number;
  tokensThisWeek: number;
}

export interface ProviderUsageServiceOptions {
  /** Source of the provider-inclusive account list (redacted, cross-provider). */
  accountService: AccountService;
  /** Raw turns DB (`store.getRawDb()`) for the Google spend counter. */
  turnsDb: Database;
  /** This node's federation label for the `machines` field; null → `[]`. */
  nodeLabel?: string | null;
  /** Clock seam (test seam). Defaults to `Date.now`. */
  now?: () => number;
  /** User-set nickname resolver (injected, mirrors `UsageService`). */
  nicknameLookup?: (uuid: string) => string | undefined;
  /** OpenAI snapshot `stale` threshold (default {@link DEFAULT_PROVIDER_STALE_AFTER_MS}). */
  staleAfterMs?: number;
  /** OpenAI snapshot `error` threshold (default {@link DEFAULT_PROVIDER_ERROR_AFTER_MS}). */
  errorAfterMs?: number;
}

export class ProviderUsageService {
  private readonly accountService: AccountService;
  private readonly turnsDb: Database;
  private readonly nodeLabel: string | null;
  private readonly now: () => number;
  private readonly nicknameLookup?: (uuid: string) => string | undefined;
  private readonly staleAfterMs: number;
  private readonly errorAfterMs: number;
  /** Newest OpenAI snapshot per `accountUuid` (push-to-cache; session-delivered). */
  private readonly snapshots = new Map<string, StoredSnapshot>();

  constructor(opts: ProviderUsageServiceOptions) {
    this.accountService = opts.accountService;
    this.turnsDb = opts.turnsDb;
    this.nodeLabel = opts.nodeLabel ?? null;
    this.now = opts.now ?? Date.now;
    this.nicknameLookup = opts.nicknameLookup;
    this.staleAfterMs = opts.staleAfterMs ?? DEFAULT_PROVIDER_STALE_AFTER_MS;
    this.errorAfterMs = opts.errorAfterMs ?? DEFAULT_PROVIDER_ERROR_AFTER_MS;
  }

  /**
   * Store the NEWEST codex `rate_limits` snapshot for a bound OpenAI account
   * (the `/cli` `provider-usage-snapshot` receiver calls this). Each window's
   * reset is normalized to an ISO-8601 string here — the one place the
   * epoch-seconds vs. relative-`resets_in_seconds` ambiguity is resolved (#3352
   * pins the source field; this tolerates either). Fire-and-forget; never throws.
   */
  recordCodexSnapshot(
    accountUuid: string,
    windows: ProviderUsageSnapshotWindow[],
    fetchedAt?: number
  ): void {
    const at = fetchedAt ?? this.now();
    const normalized: ProviderUsageWindow[] = windows.map(w => ({
      name: w.name,
      used_percent: w.used_percent,
      window_minutes: w.window_minutes,
      resets_at: this.normalizeResetsAt(w, at),
    }));
    this.snapshots.set(accountUuid, { windows: normalized, fetchedAt: at });
  }

  /**
   * Assemble the `providerUsage[]` rows for THIS node: one row per non-Anthropic
   * account (OpenAI snapshot rows + Google counter rows). Synchronous — reads the
   * in-memory snapshot cache + one turns aggregate query; makes no upstream call.
   */
  getCached(): ProviderAccountUsage[] {
    const now = this.now();
    const spend = this.queryGoogleTokenSpend(now);
    const rows: ProviderAccountUsage[] = [];
    for (const acct of this.accountService.list()) {
      if (acct.provider === "openai") {
        rows.push(this.buildOpenAiRow(acct, now));
      } else if (acct.provider === "google") {
        rows.push(this.buildGoogleRow(acct, spend.get(acct.accountUuid), now));
      }
      // Anthropic rows are `usage[]`'s domain (D5 = C) — never emitted here.
    }
    return rows;
  }

  /** Build an OpenAI row from its newest snapshot (or an `unknown` placeholder). */
  private buildOpenAiRow(
    acct: RedactedAccount,
    now: number
  ): ProviderAccountUsage {
    const snap = this.snapshots.get(acct.accountUuid);
    if (!snap) {
      // No session of this account has reported a snapshot yet.
      return {
        ...this.identityFields(acct),
        status: "unknown",
        fetchedAt: now,
        score: null,
        utilization: {},
        windows: undefined,
      };
    }
    const age = now - snap.fetchedAt;
    const status: ProviderUsageStatus =
      age > this.errorAfterMs
        ? "error"
        : age > this.staleAfterMs
          ? "stale"
          : "ok";
    const utilization = this.windowsToUtilization(snap.windows);
    // Score reuses the Anthropic sustainable-rate formula (five_hour + seven_day),
    // but ONLY when the snapshot is fresh enough to trust (`ok`/`stale`) AND both
    // windows carry a `resets_at` (R4). `error` (>30 min) → null so a selector
    // reading `.score` never makes a false-healthy pick.
    const bothHaveReset =
      utilization.five_hour?.resets_at != null &&
      utilization.seven_day?.resets_at != null;
    const score =
      (status === "ok" || status === "stale") && bothHaveReset
        ? computeUtilizationScore(utilization, { now })
        : null;
    return {
      ...this.identityFields(acct),
      status,
      fetchedAt: snap.fetchedAt,
      score,
      utilization,
      windows: snap.windows,
    };
  }

  /** Build a Google row: a spend counter, never a meter (`score: null`, `utilization: {}`). */
  private buildGoogleRow(
    acct: RedactedAccount,
    spend: GoogleSpendRow | undefined,
    now: number
  ): ProviderAccountUsage {
    return {
      ...this.identityFields(acct),
      status: "ok",
      fetchedAt: now,
      score: null,
      utilization: {},
      windows: undefined,
      tokenSpend: {
        tokensToday: spend?.tokensToday ?? 0,
        tokensThisWeek: spend?.tokensThisWeek ?? 0,
        asOf: now,
      },
    };
  }

  /** Shared display-safe identity fields (redaction-safe; mirrors `buildUsage`). */
  private identityFields(
    acct: RedactedAccount
  ): Pick<
    ProviderAccountUsage,
    "provider" | "accountUuid" | "displayLabel" | "nickname" | "machines"
  > & { provider: "openai" | "google" } {
    return {
      provider: acct.provider as "openai" | "google",
      accountUuid: acct.accountUuid,
      displayLabel: acct.displayName || acct.emailAddress,
      nickname: this.nicknameLookup?.(acct.accountUuid),
      machines: this.nodeLabel ? [this.nodeLabel] : [],
    };
  }

  /** Map codex `primary`→`five_hour`, `secondary`→`seven_day` as RateLimit entries. */
  private windowsToUtilization(windows: ProviderUsageWindow[]): Utilization {
    const primary = windows.find(w => w.name === "primary");
    const secondary = windows.find(w => w.name === "secondary");
    const util: Utilization = {};
    if (primary) {
      util.five_hour = {
        utilization: primary.used_percent,
        resets_at: primary.resets_at,
      };
    }
    if (secondary) {
      util.seven_day = {
        utilization: secondary.used_percent,
        resets_at: secondary.resets_at,
      };
    }
    return util;
  }

  /** Resolve a raw codex window reset (epoch seconds | ISO | relative) → ISO | null. */
  private normalizeResetsAt(
    w: ProviderUsageSnapshotWindow,
    now: number
  ): string | null {
    const abs = w.resets_at;
    if (typeof abs === "number" && Number.isFinite(abs)) {
      // codex emits epoch SECONDS.
      return new Date(abs * 1000).toISOString();
    }
    if (typeof abs === "string" && abs.trim() !== "") {
      const trimmed = abs.trim();
      if (/^\d+$/.test(trimmed)) {
        // Numeric string → epoch seconds.
        return new Date(Number(trimmed) * 1000).toISOString();
      }
      const parsed = Date.parse(trimmed);
      return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
    }
    if (
      typeof w.resets_in_seconds === "number" &&
      Number.isFinite(w.resets_in_seconds)
    ) {
      return new Date(now + w.resets_in_seconds * 1000).toISOString();
    }
    return null;
  }

  /**
   * Sum this node's Google (`model_provider = 'google'`) turn tokens per
   * `account_id` over a rolling 24 h (`tokensToday`) and 7 d (`tokensThisWeek`)
   * window. "tokens" = `tok_in + tok_out` (billable throughput — the standard
   * "tokens used"; cache-read/write are excluded so the counter is not inflated).
   * Rolling windows (not calendar) are timezone-free and deterministic under the
   * injected clock, matching the rolling nature of the Anthropic 5h/weekly resets.
   * Fail-soft: any DB error yields an empty map (the rows read `tokenSpend: 0`).
   */
  private queryGoogleTokenSpend(now: number): Map<string, GoogleSpendRow> {
    const out = new Map<string, GoogleSpendRow>();
    try {
      const dayFloor = now - DAY_MS;
      const weekFloor = now - WEEK_MS;
      const rows = this.turnsDb
        .prepare(
          `SELECT account_id AS accountId,
                  SUM(CASE WHEN started_at_ms >= @dayFloor
                        THEN COALESCE(tok_in, 0) + COALESCE(tok_out, 0)
                        ELSE 0 END) AS tokensToday,
                  SUM(COALESCE(tok_in, 0) + COALESCE(tok_out, 0)) AS tokensThisWeek
             FROM turns
            WHERE model_provider = 'google'
              AND account_id IS NOT NULL
              AND started_at_ms >= @weekFloor
            GROUP BY account_id`
        )
        .all({ dayFloor, weekFloor }) as Array<{
        accountId: string;
        tokensToday: number | null;
        tokensThisWeek: number | null;
      }>;
      for (const r of rows) {
        out.set(r.accountId, {
          tokensToday: r.tokensToday ?? 0,
          tokensThisWeek: r.tokensThisWeek ?? 0,
        });
      }
    } catch {
      // Fail-soft — a counter query failure must not blank the whole envelope.
    }
    return out;
  }
}
