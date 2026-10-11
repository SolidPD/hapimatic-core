// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { z } from "zod";
import { defineCapability, harnessProvenanceSchema } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";

import type { ScorecardStore } from "../../store/scorecardStore";
import type { TelemetryStore } from "../../store/telemetryStore";
import type { WebAppEnv } from "../middleware/auth";
import { configuration } from "../../configuration";
import { constantTimeEquals } from "../../utils/crypto";
import { parseAccessToken } from "../../utils/accessToken";

/**
 * Harness Scorecard routes (issue #3128, epic #3117 Sub-Issue N).
 *
 * TWO factories, split by auth tier exactly like telemetry (ruling 1B-21iv):
 *   - {@link createScorecardIngestRoute} — the two producer transports (`run`,
 *     `conformance`) mount PRE-JWT with CLI-token Bearer auth (the
 *     `createTelemetryIngestRoute` pattern), because their callers are the cli
 *     teardown reporter and the #3129 runner, not a JWT web client.
 *   - {@link createScorecardRoutes} — `rating` (session UI) + the admin read +
 *     the #3132 export mount BEHIND the JWT gate.
 */

// ── Ingest schemas ─────────────────────────────────────────

/** POST /api/scorecard/run body (KD6a — the #3130 provenance transport). */
const runIngestSchema = z
  .object({
    sessionId: z.string().min(1),
    provenance: harnessProvenanceSchema,
  })
  .passthrough();

/**
 * Zod MIRROR of `scripts/conformance/report.schema.json` (#3129 — the CG-5
 * ingestion contract). `scripts/` is outside the server tsconfig `rootDir`, so a
 * direct JSON import is impossible; this is the house-convention Zod
 * representation. 🔴 KEEP IN LOCKSTEP with `report.schema.json`: on a breaking
 * shape change there, update this schema in the same PR (the JSON schema's own
 * `schemaVersion` doc says as much). `.strict()` mirrors the schema's
 * `additionalProperties: false` (two-sided rejection — CG-5); `runner` stays
 * permissive to match its `additionalProperties: true`.
 */
const conformanceRowSchema = z
  .object({
    skill: z.string().nullable(),
    harness: z.string(),
    version: z.string().nullable(),
    model: z.string().nullable(),
    scenario: z.string(),
    status: z.enum(["pass", "fail", "skip"]),
    observed: z.unknown().optional(),
    expected: z.unknown().optional(),
    detail: z.string().optional(),
  })
  .strict()
  .superRefine((row, ctx) => {
    // R5: a failing scenario names observed-vs-expected — never a bare boolean.
    if (row.status === "fail") {
      if (row.observed === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["observed"],
          message: "a `fail` row requires `observed` (R5)",
        });
      }
      if (row.expected === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["expected"],
          message: "a `fail` row requires `expected` (R5)",
        });
      }
    }
    // OR2: a skipped scenario carries an explicit reason.
    if (row.status === "skip" && row.detail === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["detail"],
        message: "a `skip` row requires `detail` (OR2)",
      });
    }
  });

const conformanceReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.string(),
    runner: z
      .object({
        mode: z.enum(["live", "dry-run"]),
        host: z.string(),
      })
      .passthrough(),
    rows: z.array(conformanceRowSchema),
  })
  .strict();

/** POST /api/scorecard/rating body — the one-tap operator rating (R3). */
const ratingSchema = z
  .object({
    harness: z.string().min(1),
    model: z.string().nullable().optional(),
    skill: z.string().nullable().optional(),
    sessionId: z.string().optional(),
    value: z.number().int().min(1).max(5),
  })
  .passthrough();

// ── Ingest routes (pre-JWT, CLI-token auth) ────────────────

export function createScorecardIngestRoute(
  getScorecardStore: () => ScorecardStore | null,
  getTelemetryStore: () => TelemetryStore | null
): Hono {
  const app = new Hono();

  function authOk(c: {
    req: { header: (name: string) => string | undefined };
  }): boolean {
    const raw = c.req.header("authorization");
    if (!raw) return false;
    const token = raw.replace(/^Bearer\s+/i, "");
    const parsed = parseAccessToken(token);
    return (
      !!parsed &&
      constantTimeEquals(parsed.baseToken, configuration.cliApiToken)
    );
  }

  // POST /scorecard/run — session-teardown provenance ingress (KD6a). The cli
  // sends NO skill; the skill dimension is supplied SERVER-side by joining the
  // session against the telemetry store's skill-invocation events (KD4), fanning
  // out one `kind:"run"` row per invoked skill. Zero skills ⇒ ONE `skill:null`
  // harness-level run row — never a guessed skill (OR4).
  app.post(
    "/scorecard/run",
    cataloged(
      defineCapability({
        id: "telemetry.scorecard-run",
        domain: "telemetry",
        surface: "rest",
        description:
          "Run a scorecard evaluation for a session and record the result to the scorecard store (CLI-token producer transport).",
        whenToUse: "When the CLI submits a completed scorecard run.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/scorecard/run",
        },
        auth: "cli-token",
        riskTier: "mutating",
        availability: { scope: "operator", mountedWhen: "scorecard-store" },
        probe: "skip",
      })
    ),
    async c => {
      if (!authOk(c)) return c.json({ error: "Invalid token" }, 401);
      const store = getScorecardStore();
      if (!store)
        return c.json({ error: "Scorecard store not available" }, 503);

      const body = await c.req.json().catch(() => null);
      if (!body) return c.json({ error: "Invalid JSON body" }, 400);
      const parsed = runIngestSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { error: "Invalid run body", details: parsed.error.issues },
          400
        );
      }

      const { sessionId, provenance } = parsed.data;
      // #3130 fields VERBATIM (CG-4). No runtime ⇒ `unattributed` (visible — OR4).
      const harness = provenance.runtime?.harness?.id ?? "unattributed";
      const model = provenance.model ?? null;

      const skills = getTelemetryStore()?.getSessionSkills(sessionId) ?? [];
      // KD4: one run row per invoked skill; a session with zero recorded skill
      // events records ONE `skill: null` harness-level row (never a guessed skill).
      // `[null]` folds both cases into a single insertion path.
      const skillDims: Array<string | null> =
        skills.length > 0 ? skills : [null];
      store.recordEvents(
        skillDims.map(skill => ({
          skill,
          harness,
          model,
          kind: "run" as const,
          sessionId,
          provenance,
        }))
      );
      return c.json({ recorded: skillDims.length, skills: skills.length }, 201);
    }
  );

  // POST /scorecard/conformance — a #3129 report, validated against the mirror
  // of report.schema.json; non-conforming ⇒ 4xx, never silently dropped (CG-5).
  app.post(
    "/scorecard/conformance",
    cataloged(
      defineCapability({
        id: "telemetry.scorecard-conformance",
        domain: "telemetry",
        surface: "rest",
        description:
          "Ingest a conformance-check result for a session into the scorecard store (CLI-token producer transport).",
        whenToUse: "When the CLI reports a conformance check outcome.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/scorecard/conformance",
        },
        auth: "cli-token",
        riskTier: "mutating",
        availability: { scope: "operator", mountedWhen: "scorecard-store" },
        probe: "skip",
      })
    ),
    async c => {
      if (!authOk(c)) return c.json({ error: "Invalid token" }, 401);
      const store = getScorecardStore();
      if (!store)
        return c.json({ error: "Scorecard store not available" }, 503);

      const body = await c.req.json().catch(() => null);
      if (!body) return c.json({ error: "Invalid JSON body" }, 400);
      const parsed = conformanceReportSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          {
            error: "Report does not conform to report.schema.json",
            details: parsed.error.issues,
          },
          400
        );
      }

      const rows = parsed.data.rows;
      store.recordEvents(
        rows.map(row => ({
          skill: row.skill,
          harness: row.harness,
          model: row.model,
          kind: "conformance" as const,
          scenario: row.scenario,
          version: row.version,
          status: row.status,
        }))
      );
      return c.json({ recorded: rows.length }, 201);
    }
  );

  return app;
}

// ── Read / rating routes (post-JWT) ────────────────────────

export function createScorecardRoutes(
  getScorecardStore: () => ScorecardStore | null
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  function requireStore(c: {
    json: (data: unknown, status?: number) => Response;
  }): ScorecardStore | Response {
    const store = getScorecardStore();
    if (!store) {
      return c.json({ error: "Scorecard store not available" }, 503);
    }
    return store;
  }

  function readFilters(c: {
    req: { query: (name: string) => string | undefined };
  }): { harness?: string; model?: string; skill?: string } {
    return {
      harness: c.req.query("harness") || undefined,
      model: c.req.query("model") || undefined,
      skill: c.req.query("skill") || undefined,
    };
  }

  // POST /scorecard/rating — one-tap operator rating (R3). Fire-and-forget on the
  // client; here it simply records and 201s.
  app.post(
    "/scorecard/rating",
    cataloged(
      defineCapability({
        id: "telemetry.scorecard-rating",
        domain: "telemetry",
        surface: "rest",
        description: "Record a human/agent rating against a scorecard entry.",
        whenToUse: "When a reviewer rates a scorecard result in the UI.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/scorecard/rating",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "operator", mountedWhen: "scorecard-store" },
      })
    ),
    async c => {
      const store = requireStore(c);
      if (store instanceof Response) return store;

      const body = await c.req.json().catch(() => null);
      if (!body) return c.json({ error: "Invalid JSON body" }, 400);
      const parsed = ratingSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { error: "Invalid rating body", details: parsed.error.issues },
          400
        );
      }
      const { harness, model, skill, sessionId, value } = parsed.data;
      store.recordEvent({
        harness,
        model: model ?? null,
        skill: skill ?? null,
        sessionId,
        kind: "rating",
        value,
      });
      return c.json({ recorded: 1 }, 201);
    }
  );

  // GET /scorecard — the admin-view data (per skill × harness × model rows).
  app.get(
    "/scorecard",
    cataloged(
      defineCapability({
        id: "telemetry.scorecard-read",
        domain: "telemetry",
        surface: "rest",
        description: "Return the scorecard summary for the authenticated view.",
        whenToUse: "When the user opens the scorecard dashboard.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/scorecard",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "operator", mountedWhen: "scorecard-store" },
      })
    ),
    c => {
      const store = requireStore(c);
      if (store instanceof Response) return store;
      // Refresh the rollup snapshot before reading (mirrors telemetry's
      // aggregate-before-read); scorecard volume is low, so this is cheap.
      store.aggregateMissing();
      const rows = store.getScorecard(readFilters(c));
      return c.json({ rows });
    }
  );

  // GET /scorecard/export — machine-readable evidence for Sub R (#3132).
  app.get(
    "/scorecard/export",
    cataloged(
      defineCapability({
        id: "telemetry.scorecard-export",
        domain: "telemetry",
        surface: "rest",
        description: "Export the scorecard data set for offline analysis.",
        whenToUse: "When the user downloads the scorecard export.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/scorecard/export",
        },
        auth: "jwt",
        // #3837 R12 (never-readonly class): a bulk data export — expensive and
        // sensitive to auto-invoke, so it stays out of the generic invoker even
        // though it is operator-scoped. [ER 2026-09-19: D17]
        riskTier: "mutating",
        availability: { scope: "operator", mountedWhen: "scorecard-store" },
      })
    ),
    c => {
      const store = requireStore(c);
      if (store instanceof Response) return store;
      store.aggregateMissing();
      const rows = store.getScorecard(readFilters(c));
      return c.json({
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        rows,
      });
    }
  );

  return app;
}
