// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import {
  AccountUsageSchema,
  type AccountUsage,
  ProviderAccountUsageSchema,
  type ProviderAccountUsage,
  defineCapability,
} from "@hapi/protocol";
import { createAuthMiddleware, type WebAppEnv } from "../../middleware/auth";
import { cataloged } from "../../../capabilities/cataloged";
import type { FederationDeps } from "./shared";
import { checkFederationToken } from "./shared";

/**
 * Federation-wide per-account usage aggregation (epic #1855, Sub-Issue C / #1858).
 *
 *   GET  /api/federation/accounts/usage  (JWT)      — client-facing aggregator:
 *        fetches THIS node's usage locally + fans out to every peer node, then
 *        dedups the combined list by `accountUuid`. Mirrors the active-accounts
 *        aggregation pattern (`webClient.ts` GET /federation/active-accounts,
 *        Sub-Issue F / #1452).
 *   POST /api/federation/accounts/usage  (fed-token) — peer-incoming receiver:
 *        returns THIS node's redacted `AccountUsage[]`. POST (not GET) because the
 *        generic `proxyToNode` only issues POST (same convention as the
 *        active-account `/current` receiver). The hub reaches it via
 *        `NodeRegistry.getUsageOnNode`.
 *
 * The GET and POST share the path and differ by method: Hono dispatches by
 * method, the GET carries `jwtAuth` (end-user), and the POST does its own
 * `checkFederationToken` (peer node) — a peer's POST never hits the JWT route and
 * a client's GET never hits the fed-token route.
 *
 * Security (R4): no OAuth token ever crosses the federation boundary — each node
 * fetches its OWN accounts' usage locally via the read-only `UsageService`
 * (Sub B / #1857; no force-refresh on read, preserving the #1520/#1644 race
 * avoidance) and returns only the redacted `AccountUsage` envelope. Cross-boundary
 * rows are re-parsed through `AccountUsageSchema` (plain `z.object()`, NO
 * `.passthrough()`) as a defense-in-depth redaction guarantee.
 */

/** `ok` ranks above any degraded status (`expired` / `no_scope` / `error`). */
const statusRank = (s: AccountUsage["status"]): number => (s === "ok" ? 1 : 0);

/**
 * Dedup a federation-wide usage list by `accountUuid` (R1, R2).
 *
 * Usage limits are account-global (identical from any node), so a duplicate is a
 * merge, not a conflict: the `machines` lists are unioned (insertion-ordered,
 * deduped — the aggregator pushes local rows first, so the local node's labels
 * lead), and the surviving utilization/status/fetchedAt come from the
 * higher-ranked row (`ok` beats degraded; ties keep the first-seen row, i.e. the
 * local node, then node-summary order).
 */
export function mergeAccountUsage(rows: AccountUsage[]): AccountUsage[] {
  const byUuid = new Map<string, AccountUsage>();
  for (const row of rows) {
    const existing = byUuid.get(row.accountUuid);
    if (!existing) {
      byUuid.set(row.accountUuid, { ...row, machines: [...row.machines] });
      continue;
    }
    const machines = Array.from(
      new Set([...existing.machines, ...row.machines])
    );
    const winner =
      statusRank(row.status) > statusRank(existing.status) ? row : existing;
    byUuid.set(row.accountUuid, { ...winner, machines });
  }
  return Array.from(byUuid.values());
}

/**
 * Dedup a federation-wide `providerUsage[]` list by `accountUuid` (issue #3809).
 * Distinct from {@link mergeAccountUsage} because the two provider signals have
 * DIFFERENT merge semantics (the Anthropic ok-beats-degraded dedup is wrong for
 * both):
 *
 *  - **OpenAI** (a session-delivered snapshot; account-global): the NEWEST
 *    `fetchedAt` wins — a fresher snapshot from any node supersedes a staler one.
 *  - **Google** (a per-node token counter): SUM `tokensToday` / `tokensThisWeek`
 *    across nodes (each node's `turns` store holds only its OWN sessions, so the
 *    account-wide spend is the sum), with `asOf` = the newest.
 *
 * `machines[]` is unioned (insertion-ordered, deduped — local rows lead) in both
 * cases. A given `accountUuid` is single-provider, so the row's own `provider`
 * selects the branch. #1881 (degraded-peer surfacing) edits the SAME aggregator —
 * this merge stays local to `providerUsage[]` and leaves the Anthropic dedup
 * untouched.
 */
export function mergeProviderUsage(
  rows: ProviderAccountUsage[]
): ProviderAccountUsage[] {
  const byUuid = new Map<string, ProviderAccountUsage>();
  for (const row of rows) {
    const existing = byUuid.get(row.accountUuid);
    if (!existing) {
      byUuid.set(row.accountUuid, { ...row, machines: [...row.machines] });
      continue;
    }
    const machines = Array.from(
      new Set([...existing.machines, ...row.machines])
    );
    if (row.provider === "google" || existing.provider === "google") {
      // Google counter → sum across nodes.
      const a = existing.tokenSpend;
      const b = row.tokenSpend;
      byUuid.set(row.accountUuid, {
        ...existing,
        machines,
        tokenSpend: {
          tokensToday: (a?.tokensToday ?? 0) + (b?.tokensToday ?? 0),
          tokensThisWeek: (a?.tokensThisWeek ?? 0) + (b?.tokensThisWeek ?? 0),
          asOf: Math.max(a?.asOf ?? 0, b?.asOf ?? 0),
        },
      });
    } else {
      // OpenAI snapshot → newest fetchedAt wins.
      const winner = row.fetchedAt > existing.fetchedAt ? row : existing;
      byUuid.set(row.accountUuid, { ...winner, machines });
    }
  }
  return Array.from(byUuid.values());
}

export function createFederationUsageRoutes(
  deps: FederationDeps
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const jwtAuth = createAuthMiddleware(deps.jwtSecret);

  // ─── Web client endpoint: GET /federation/accounts/usage (JWT, HUB aggregation) ──
  app.get(
    "/federation/accounts/usage",
    cataloged(
      defineCapability({
        id: "accounts.federation-usage-aggregate",
        domain: "accounts",
        surface: "rest",
        description:
          "Aggregate per-account quota usage across the whole mesh: reads this node's usage and fans out to every peer, deduping by account. Pass force=1 to refresh this node.",
        whenToUse:
          "When the web UI shows how much of each account's quota is used across all federation nodes.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/accounts/usage",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
        telemetry: "off",
      })
    ),
    jwtAuth,
    async c => {
      const usageService = deps.getUsageService?.();
      const providerService = deps.getProviderUsageService?.();
      const registry = deps.getNodeRegistry();
      // Force path (#1909): the manual-refresh button hits ?force=1 → force a real
      // upstream refresh of THIS node (peer rows still come from each peer's cache;
      // cross-proxy force propagation is deferred to a future hub-aggregated cache).
      const force = c.req.query("force") === "1";
      const all: AccountUsage[] = [];
      // Issue #3809 (D5 = C): the SIBLING providerUsage[] aggregate. Collected +
      // merged independently of usage[] (which stays byte-identical).
      const allProvider: ProviderAccountUsage[] = [];

      // Local node first (the hub is itself a node; NOT in getNodeSummaries()).
      if (usageService) {
        try {
          // Push-to-cache read (#1909/#1962): serve the cached snapshot, refreshing
          // only when never populated OR stale (the staleness guard self-heals a frozen
          // cache when the UsageSampler loop has stopped). ?force=1 always does a fresh
          // upstream refresh.
          const local = force
            ? await usageService.refresh()
            : await usageService.getCachedOrRefresh();
          all.push(...local);
        } catch {
          // Local failure is non-fatal — degrade to remote-only (R3).
        }
      }
      // Issue #3809: local providerUsage rows (synchronous — no upstream fetch).
      if (providerService) {
        try {
          allProvider.push(...providerService.getCached());
        } catch {
          // Non-fatal — degrade to remote-only, mirroring the usage[] local guard.
        }
      }

      // Remote nodes — concurrent, partial-success (R3).
      if (registry) {
        const summaries = registry.getNodeSummaries();
        const results = await Promise.allSettled(
          summaries.map(s => registry.getUsageOnNode(s.nodeId))
        );
        // Indexed iteration (mirrors telemetry.ts) so a dropped row can name its
        // originating node (#1922).
        results.forEach((r, i) => {
          if (r.status !== "fulfilled") return;
          const s = summaries[i]!;
          const v = r.value;
          if (v && "usage" in v && Array.isArray(v.usage)) {
            let malformedCount = 0;
            for (const row of v.usage) {
              // Re-parse each cross-boundary row — redaction guarantee (R4).
              const parsed = AccountUsageSchema.safeParse(row);
              if (parsed.success) {
                all.push(parsed.data);
              } else {
                // #1922: a malformed peer row is still excluded from the aggregate
                // (R4 redaction preserved — only parsed.data is ever pushed), but no
                // longer SILENTLY dropped. Count per node; emit one warning below.
                malformedCount++;
              }
            }
            if (malformedCount > 0) {
              // Rate-limited per category (#1141 ErrorLogger) so a persistently
              // schema-skewed peer cannot flood the console / SQLite error_logs /
              // Sentry. `warn` (not error) — a peer schema skew is an expected,
              // non-fatal degradation, and warn does not forward to Sentry.
              deps.errorLogger?.warn(
                `[Federation] Dropped ${malformedCount} malformed usage row(s) from node ${s.nodeLabel}`,
                {
                  category: "federation-usage-malformed",
                  context: {
                    nodeId: s.nodeId,
                    nodeLabel: s.nodeLabel,
                    malformedCount,
                  },
                }
              );
            }
          }
          // Issue #3809: the SIBLING providerUsage[] from the same peer response.
          // getUsageOnNode's typed shape predates #3809, so read it via a
          // localized cast (mirrors the loose `"usage" in v` guard above). Each
          // cross-boundary row is re-parsed through the whitelist schema on
          // ingress (redaction, R4); a malformed provider row is dropped silently
          // (the usage[] malformed-count warning already flags a skewed peer).
          const peerProvider = (v as { providerUsage?: unknown }).providerUsage;
          if (Array.isArray(peerProvider)) {
            for (const row of peerProvider) {
              const parsed = ProviderAccountUsageSchema.safeParse(row);
              if (parsed.success) allProvider.push(parsed.data);
            }
          }
        });
      }

      return c.json({
        usage: mergeAccountUsage(all),
        providerUsage: mergeProviderUsage(allProvider),
      });
    }
  );

  // ─── Node-to-node endpoint: POST /federation/accounts/usage (peer fan-in) ──
  app.post(
    "/federation/accounts/usage",
    cataloged(
      defineCapability({
        id: "accounts.federation-usage-receiver",
        domain: "accounts",
        surface: "rest",
        description:
          "Return this node's redacted per-account usage rows (POST because the node proxy only issues POST); no OAuth token crosses the boundary.",
        whenToUse:
          "When the hub gathers a peer node's account-usage rows for the cross-node usage view.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/accounts/usage",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
        telemetry: "off",
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      const usageService = deps.getUsageService?.();
      if (!usageService) {
        return c.json({ error: "Usage service unavailable" }, 503);
      }
      // Push-to-cache read (#1909/#1962): peer-receiver serves this node's cached
      // snapshot; refreshes only when never populated OR stale (Fallback Preservation
      // Rule — augments the null fallback with a staleness re-arm).
      const rows = await usageService.getCachedOrRefresh();
      // Issue #3809 (D5 = C): the SIBLING providerUsage[] for the hub aggregator
      // to merge. Same whitelist redaction parse the local route applies; an
      // absent provider service yields an empty array (backward-safe for a peer
      // that has no non-Anthropic account).
      const providerRows = deps.getProviderUsageService?.()?.getCached() ?? [];
      // Same redaction parse the local /api/accounts/usage route applies.
      return c.json({
        usage: rows.map(r => AccountUsageSchema.parse(r)),
        providerUsage: providerRows.map(r =>
          ProviderAccountUsageSchema.parse(r)
        ),
      });
    }
  );

  return app;
}
