// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Infra-exclusion class for the capability catalog (issue #3746, Sub-Issue F.1 /
 * R10, ruling D7).
 *
 * These REST route paths are **infrastructure, not agent capabilities** — they are
 * deliberately NEVER annotated with `cataloged()` and never appear in the committed
 * Tier-0 index. Naming them here gives the #3744 runtime audit's REST coverage meter
 * a DEFINED denominator: "100 % REST coverage" means every mounted route group EXCEPT
 * this named class is cataloged. Without a named boundary, a `GET /health` or SPA
 * catch-all would read as permanent reverse drift and 100 % could never be reached.
 *
 * The FOUR members, verified at `server/src/web/buildWebApp.ts` /
 * `server/src/web/routes/health.ts` (#3837 F.16 / ruling D18-A extended the set with
 * `/api/health`):
 *   - `"/health"`     — the top-level unauthenticated liveness probe
 *                       (`buildWebApp.ts` `app.get("/health", …)` → `{status:"ok"}`).
 *   - `"/api/health"` — the operational-status summary (`routes/health.ts`
 *                       `app.get("/health", …)` mounted under `app.route("/api", …)`);
 *                       a real JSON status surface but infrastructure, not an agent
 *                       capability — deliberately never cataloged.
 *   - `"*"`           — the SPA catch-all(s) that serve the web client bundle
 *                       (`app.get("*", …)`; mutually-exclusive branches, one live per boot).
 *   - `"/"`           — the SPA root route (`app.get("/", …)`).
 *
 * ⚠️ `"*"` and `"/"` are ALSO excluded from the runtime audit by COLLECTOR PLACEMENT:
 * `buildAuditProvider(app, …)` is built in `buildWebApp.ts` BEFORE the
 * `if (options.embeddedAssetMap)` SPA branch registers them, so they are never in the
 * route table the audit walks. Their membership here is documentation + belt-and-braces
 * (and the lexical lint exemption). The runtime filter's live effect is on `/health` and
 * `/api/health` (and any future pre-collector infra route).
 *
 * 🔒 This set MIRRORS the `INFRA_EXCLUDED_PATHS` in
 * `scripts/eslint-rules/no-uncataloged-route.mjs` (the LEXICAL pre-filter that exempts
 * the same paths from the `hapi/no-uncataloged-route` rule; note the lint rule sees only
 * the literal `/health` for BOTH health routes — the `/api` mount prefix is invisible to
 * it — so it carries `/api/health` for parity/documentation). The two live in different
 * layers — this one is the AUDIT-side (runtime) denominator, that one is the LINT-side
 * (lexical) exemption — but they name the SAME paths and must stay in sync.
 *
 * As of #3837 (F.16) the AUDIT-side consumer EXISTS: `server/src/capabilities/audit.ts`
 * imports this constant and excludes these paths (plus exact-path `ALL` auth-middleware
 * companions of a cataloged route) from BOTH the observed REST denominator and reverse
 * drift, so `hapi capabilities audit` can report REST 100% with empty reverse drift.
 * `index-shape.test.ts` pins this list against its documented contents
 * (`docs/internal/architecture/capability-catalog.md`).
 */
export const INFRA_EXCLUDED_ROUTE_PATHS = [
  "/health",
  "/api/health",
  "*",
  "/",
] as const;

/** One infra-excluded route path. */
export type InfraExcludedRoutePath =
  (typeof INFRA_EXCLUDED_ROUTE_PATHS)[number];
