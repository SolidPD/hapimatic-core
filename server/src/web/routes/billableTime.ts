// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { defineCapability } from "@hapi/protocol";
import type { Store } from "../../store";
import type { SyncEngine } from "../../sync/syncEngine";
import type { WebAppEnv } from "../middleware/auth";
import { configuration } from "../../configuration";
import { isValidTimezone, loadTimeLogConfig } from "../../config/timeLogConfig";
import { resolveNamespaceTimezone } from "../../parity/timeParityDerivation";
import { cataloged } from "../../capabilities/cataloged";
import { readLatestReconcile } from "../../billable/reconcile";
import type { IntervalRecord } from "../../store/billable/intervalStore";
import { requireSyncEngine } from "./guards";

/**
 * Billable-time read API (issue #6586, R22). The read the Wrike sync (#6204) and
 * the nightly logging (MattStarfield/rp1-home#3142) consume.
 *
 *   GET /api/billable-time/sessions/:id?from=&to=&tz=
 *   GET /api/billable-time/reconcile/latest
 *
 * Billing contract (mirrored into the consumers' issues):
 * 1. The amount to log for a session is `totalMs` minus what was already logged,
 *    dated the day it is logged.
 * 2. Totals use closed intervals only; a turn running at the cut-off is logged
 *    whole after it closes (ruling D3-A).
 * 3. Day portions are attribution only and can change after the day ends.
 * 4. Carried-forward time has no interval history and is logged once.
 * 5. Intervals are the billed basis only where `coverage` is `intervals`;
 *    elsewhere the session timer stays the basis.
 * 6. Intervals whose `launcherKind` is `tmux` or `pty` are not written to Wrike
 *    until the launcher fix (#4684) lands (ruling D2-A).
 *
 * `open` and `days` are never an amount to log. A zero where `coverage` is
 * `shadow` or `no_interval_data` means "not known from intervals", never "no
 * work". To apply point 6, subtract the `tmux` and `pty` entries of
 * `intervalsMsByLauncher` from `totalMs`.
 *
 * A session outside the caller's namespace answers 404 with the unknown-id body,
 * because any other answer would reveal that it exists.
 */

const NOT_FOUND = { error: "Session not found" } as const;
const NON_NEGATIVE_INT = /^[0-9]+$/;

type Coverage = "intervals" | "shadow" | "no_interval_data";

function coverageFor(mode: string): Coverage {
  if (mode === "on") return "intervals";
  if (mode === "shadow") return "shadow";
  return "no_interval_data";
}

function toWireInterval(i: IntervalRecord) {
  return {
    id: i.id,
    startedAtMs: i.startedAtMs,
    endedAtMs: i.endedAtMs,
    durationMs: i.durationMs,
    endCause: i.endCause,
    launcherKind: i.launcherKind,
  };
}

/** Parse an optional epoch-ms query value; `undefined` when absent, `null` when invalid. */
function parseBound(value: string | undefined): number | undefined | null {
  if (value === undefined || value === "") return undefined;
  if (!NON_NEGATIVE_INT.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

export function createBillableTimeRoutes(
  getStore: () => Store | null,
  getSyncEngine: () => SyncEngine | null,
  options: {
    getNodeRegistry?: () => {
      locateSession(sessionId: string): { nodeId: string } | null;
    } | null;
    getLocalNodeId: () => string;
    getDataDir?: () => string;
  }
): Hono<WebAppEnv> {
  const resolveDataDir = options.getDataDir ?? (() => configuration.dataDir);
  const app = new Hono<WebAppEnv>();

  app.get(
    "/billable-time/sessions/:id",
    cataloged(
      defineCapability({
        id: "telemetry.billable-time-session",
        domain: "telemetry",
        surface: "rest",
        description:
          "Report a session's billable thinking time: lifetime totals, closed intervals and local-day portions, with the owning node's mode and coverage.",
        whenToUse:
          "When a billing consumer needs a session's billable time from stored thinking intervals.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/billable-time/sessions/:id",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const store = getStore();
      if (!store) return c.json({ error: "Store not available" }, 503);
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) return engine;

      const sessionId = c.req.param("id");
      const from = parseBound(c.req.query("from"));
      const to = parseBound(c.req.query("to"));
      if (from === null || to === null) {
        return c.json(
          { error: "from and to must be non-negative integers" },
          400
        );
      }
      const fromMs = from ?? 0;
      const toMs = to ?? Number.MAX_SAFE_INTEGER;
      if (fromMs > toMs)
        return c.json({ error: "from must not exceed to" }, 400);
      const tzOverride = c.req.query("tz");
      if (tzOverride !== undefined && !isValidTimezone(tzOverride)) {
        return c.json({ error: "Invalid timezone" }, 400);
      }

      const namespace = c.get("namespace");

      // Namespace check: the first step that finds the session decides.
      let source: "local" | "mirror";
      let localRow = false;
      let located: string | null = null;
      const stored = store.sessions.getSession(sessionId);
      if (stored) {
        if (stored.namespace !== namespace) return c.json(NOT_FOUND, 404);
        source = "local";
        localRow = true;
      } else {
        const ns = store.intervalMirror.namespacesForSession(sessionId);
        if (ns.local.length > 0) {
          if (!ns.local.includes(namespace)) return c.json(NOT_FOUND, 404);
          source = "local";
        } else if (ns.mirror.length > 0) {
          if (!ns.mirror.includes(namespace)) return c.json(NOT_FOUND, 404);
          source = "mirror";
        } else {
          const hit =
            options.getNodeRegistry?.()?.locateSession(sessionId) ?? null;
          if (!hit) return c.json(NOT_FOUND, 404);
          source = "mirror";
          located = hit.nodeId;
        }
      }

      const cfg = await loadTimeLogConfig(resolveDataDir());
      const timezone =
        tzOverride ??
        resolveNamespaceTimezone(
          store.getRawDb(),
          namespace,
          cfg.timezone,
          cfg.isFederation ? cfg.timezone : null
        );
      const timezoneSource: "override" | "federation" | "local" =
        tzOverride !== undefined
          ? "override"
          : cfg.isFederation
            ? "federation"
            : "local";

      const asOfMs = Date.now();
      if (source === "local") {
        const mode = engine.getBillableEffectiveMode();
        const totals = store.billableIntervals.sessionTotals(sessionId);
        const intervals = store.billableIntervals.listForSession(sessionId, {
          fromMs,
          toMs,
        });
        const { days } = store.billableIntervals.billableByLocalDay({
          namespace,
          sessionId,
          fromMs,
          toMs,
          timezone,
        });
        const timerMs =
          localRow && mode === "on" ? (stored?.serverAccumulatedMs ?? 0) : null;
        return c.json({
          sessionId,
          source,
          originNodeId: options.getLocalNodeId(),
          mode,
          coverage: coverageFor(mode),
          asOfMs,
          mirrorSyncedAtMs: null,
          timezone,
          timezoneSource,
          intervals: intervals.map(toWireInterval),
          open: store.billableIntervals.openForSession(sessionId),
          carriedForwardMs: totals.carriedForwardMs,
          intervalsMs: totals.intervalsMs,
          intervalsMsByLauncher: totals.intervalsMsByLauncher,
          totalMs: totals.totalMs,
          days,
          timerMs,
          matches: timerMs === null ? null : timerMs === totals.totalMs,
        });
      }

      const totals = store.intervalMirror.sessionTotals(sessionId, namespace);
      const originNodeId = located ?? totals.originNodeId ?? null;
      const state = originNodeId
        ? store.intervalMirror.getOriginState(originNodeId)
        : null;
      const mode =
        state === null || state.feedState === "unsupported"
          ? "unsupported"
          : (state.originMode ?? "unsupported");
      const intervals = store.intervalMirror.listForSession(
        sessionId,
        namespace,
        {
          fromMs,
          toMs,
        }
      );
      const { days } = store.intervalMirror.billableByLocalDay({
        namespace,
        sessionId,
        fromMs,
        toMs,
        timezone,
      });
      return c.json({
        sessionId,
        source,
        originNodeId,
        mode,
        coverage: coverageFor(mode),
        asOfMs,
        mirrorSyncedAtMs: state?.lastSyncAtMs ?? null,
        timezone,
        timezoneSource,
        intervals: intervals.map(toWireInterval),
        open: null,
        carriedForwardMs: totals.carriedForwardMs,
        intervalsMs: totals.intervalsMs,
        intervalsMsByLauncher: totals.intervalsMsByLauncher,
        totalMs: totals.totalMs,
        days,
        timerMs: null,
        matches: null,
      });
    }
  );

  app.get(
    "/billable-time/reconcile/latest",
    cataloged(
      defineCapability({
        id: "telemetry.billable-time-reconcile-latest",
        domain: "telemetry",
        surface: "rest",
        description:
          "Report this node's latest billable-time daily check: the run row and its detail rows in the caller's namespace.",
        whenToUse:
          "When an operator or a billing consumer checks whether the node's stored timers and thinking intervals agree.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/billable-time/reconcile/latest",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    c => {
      const store = getStore();
      if (!store) return c.json({ error: "Store not available" }, 503);
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) return engine;
      return c.json(readLatestReconcile(store.getRawDb(), c.get("namespace")));
    }
  );

  return app;
}
