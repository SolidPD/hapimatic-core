// SPDX-License-Identifier: AGPL-3.0-only
import { Hono, type Context } from "hono";
import {
  THROUGHPUT_BREAKDOWN_DIMS,
  defineCapability,
  type ThroughputBreakdownDim,
} from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";
import type { RollupScope } from "../../store/throughput/rollupStore";
import {
  issueCsvHeader,
  issueCsvLine,
} from "../../throughput/github/issueFacts";
import {
  parseCursor,
  resolveWindow,
  type ThroughputSummaryService,
} from "../../throughput/summary";
import type { WebAppEnv } from "../middleware/auth";

/**
 * Throughput telemetry routes (issue #6164, A1 — R10), mounted after the JWT
 * middleware next to the telemetry routes.
 *
 *   GET /telemetry/throughput/summary     readonly: aggregates only
 *   GET /telemetry/throughput/breakdown   per account / session / issue
 *   GET /telemetry/throughput/issues      per-issue rows, JSON or the
 *                                         28-column lane-backtest CSV
 *   GET /telemetry/throughput/tests       per-test catches (CI and agents)
 *   GET /telemetry/throughput/digests     stored weekly digests
 *   GET /telemetry/throughput/digests/:id one digest
 *
 * Everything but the summary names accounts, sessions, issues or tests, so it
 * is `mutating` tier and listed in `SENSITIVE_READ_MATCHERS`. Every read is
 * scoped by the caller's namespace. Breakdown, issues and tests page at 200
 * rows; the digest list returns the newest 104 (the retention), unpaged.
 */
export function createThroughputRoutes(opts: {
  getService: () => ThroughputSummaryService | null;
  /** The node's owning namespace (from its own CLI token), or null. */
  getOwnerNamespace: () => string | null;
  now?: () => number;
}): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const now = opts.now ?? Date.now;

  const scopeOf = (c: Context<WebAppEnv>): RollupScope => {
    const namespace = c.get("namespace");
    const owner = opts.getOwnerNamespace();
    return { namespace, isOwner: owner !== null && namespace === owner };
  };
  const unavailable = (c: Context<WebAppEnv>) =>
    c.json(
      { error: "Throughput telemetry is not available on this node" },
      503
    );
  const badRequest = (c: Context<WebAppEnv>, error: string) =>
    c.json({ error }, 400);

  /** Service, window and page offset for a list route (or an error response). */
  const listArgs = (c: Context<WebAppEnv>) => {
    const service = opts.getService();
    if (!service) return unavailable(c);
    const window = resolveWindow(c.req.query("from"), c.req.query("to"), now());
    if (!window) return badRequest(c, "Invalid from/to");
    const offset = parseCursor(c.req.query("cursor"));
    if (offset === null) return badRequest(c, "Invalid cursor");
    return { service, window, offset, scope: scopeOf(c) };
  };

  app.get(
    "/telemetry/throughput/summary",
    cataloged(
      defineCapability({
        id: "telemetry.throughput-summary",
        domain: "telemetry",
        surface: "rest",
        description:
          "Return the throughput summary for a window: API-equivalent cost and cache split by source, stage, model, node and day, context, waits, delivery, quota and coverage.",
        whenToUse:
          "When reporting fleet cost, throughput or coverage for a period without per-account, session, issue or test detail.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/telemetry/throughput/summary",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user", mountedWhen: "getThroughputSummary" },
        telemetry: "off",
      })
    ),
    c => {
      const service = opts.getService();
      if (!service) return unavailable(c);
      const window = resolveWindow(
        c.req.query("from"),
        c.req.query("to"),
        now()
      );
      if (!window) return badRequest(c, "Invalid from/to");
      const { json, etag } = service.summary(window, scopeOf(c));
      c.header("ETag", etag);
      c.header("Cache-Control", "private, max-age=60");
      if (c.req.header("If-None-Match") === etag) return c.body(null, 304);
      c.header("Content-Type", "application/json; charset=utf-8");
      return c.body(json, 200);
    }
  );

  app.get(
    "/telemetry/throughput/breakdown",
    cataloged(
      defineCapability({
        id: "telemetry.throughput-breakdown",
        domain: "telemetry",
        surface: "rest",
        description:
          "Return throughput cost and tokens per account, session or issue for a window, paged at 200 rows, with each account's weekly-quota runway.",
        whenToUse:
          "When a user asks which account, session or issue used the most tokens or cost in a period.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/telemetry/throughput/breakdown",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user", mountedWhen: "getThroughputSummary" },
        probe: "skip",
        telemetry: "off",
      })
    ),
    c => {
      const args = listArgs(c);
      if (args instanceof Response) return args;
      const dim = c.req.query("dim") ?? "";
      if (!(THROUGHPUT_BREAKDOWN_DIMS as readonly string[]).includes(dim)) {
        return badRequest(c, "dim must be account, session or issue");
      }
      return c.json(
        args.service.breakdown(
          dim as ThroughputBreakdownDim,
          args.window,
          args.scope,
          args.offset
        )
      );
    }
  );

  app.get(
    "/telemetry/throughput/issues",
    cataloged(
      defineCapability({
        id: "telemetry.throughput-issues",
        domain: "telemetry",
        surface: "rest",
        description:
          "Return issues closed in a window with lead time, stage hours, escapes, PRs, CI failures, lanes and cost, as JSON or the 28-column lane-backtest CSV, paged.",
        whenToUse:
          "When analysing delivered issues, lead time or lanes, or exporting the lane-backtest dataset.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/telemetry/throughput/issues",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user", mountedWhen: "getThroughputSummary" },
        telemetry: "off",
      })
    ),
    c => {
      const args = listArgs(c);
      if (args instanceof Response) return args;
      const format = c.req.query("format") ?? "json";
      if (format !== "json" && format !== "csv") {
        return badRequest(c, "format must be json or csv");
      }
      const { page, rows } = args.service.issues(
        args.window,
        args.scope,
        args.offset
      );
      if (format === "json") return c.json(page);
      const day = new Date(args.window.toMs - 1).toISOString().slice(0, 10);
      c.header("Content-Type", "text/csv; charset=utf-8");
      c.header(
        "Content-Disposition",
        `attachment; filename="throughput-issues-${day}.csv"`
      );
      if (page.nextCursor) c.header("X-Next-Cursor", page.nextCursor);
      c.header("X-Total-Count", String(page.total));
      return c.body(
        `${[issueCsvHeader(), ...rows.map(issueCsvLine)].join("\n")}\n`,
        200
      );
    }
  );

  app.get(
    "/telemetry/throughput/tests",
    cataloged(
      defineCapability({
        id: "telemetry.throughput-tests",
        domain: "telemetry",
        surface: "rest",
        description:
          "Return failing test units in a window with their CI catches and agents' own failing runs, sessions and first and last seen, paged at 200 rows.",
        whenToUse:
          "When deciding which tests catch problems in CI or locally, or which ones never fail.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/telemetry/throughput/tests",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user", mountedWhen: "getThroughputSummary" },
        telemetry: "off",
      })
    ),
    c => {
      const args = listArgs(c);
      if (args instanceof Response) return args;
      return c.json(args.service.tests(args.window, args.scope, args.offset));
    }
  );

  app.get(
    "/telemetry/throughput/digests",
    cataloged(
      defineCapability({
        id: "telemetry.throughput-digests",
        domain: "telemetry",
        surface: "rest",
        description:
          "List the stored weekly throughput digests: window, headline, report path and whether the PM was notified, newest first.",
        whenToUse: "When looking for a past weekly throughput digest.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/telemetry/throughput/digests",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user", mountedWhen: "getThroughputSummary" },
        telemetry: "off",
      })
    ),
    c => {
      const service = opts.getService();
      if (!service) return unavailable(c);
      return c.json(service.digestList(scopeOf(c)));
    }
  );

  app.get(
    "/telemetry/throughput/digests/:id",
    cataloged(
      defineCapability({
        id: "telemetry.throughput-digest",
        domain: "telemetry",
        surface: "rest",
        description:
          "Return one stored weekly throughput digest: its markdown report and the full summary it was computed from.",
        whenToUse: "When reading a specific weekly throughput digest.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/telemetry/throughput/digests/:id",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user", mountedWhen: "getThroughputSummary" },
        probe: "skip",
        telemetry: "off",
      })
    ),
    c => {
      const service = opts.getService();
      if (!service) return unavailable(c);
      const digest = service.digest(c.req.param("id"), scopeOf(c));
      return digest ? c.json(digest) : c.json({ error: "Not found" }, 404);
    }
  );

  return app;
}
