// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Server routes for `builtin.extension-marketplace` (issue #1292, epic #1264 Phase 5 — PR-2).
 *
 * The remote-discovery backend for the browse UX. Two routes, mounted by the loader under
 * `/api` AFTER the JWT auth middleware (so both are authenticated):
 *
 * - `GET  /ext/catalog`  — proxy the metadata-only community catalog. The catalog URL lives
 *   server-side (`HAPI_EXTENSION_CATALOG_URL` → `DEFAULT_CATALOG_URL`), so the browser never
 *   needs to know or reach it directly.
 * - `POST /ext/install` `{ id }` — install a `<publisher>.<name>` extension host-side via
 *   **approach A** (DECISION-2, Matt-signed-off 2026-07-20): re-invoke the compiled binary's
 *   OWN `hapi ext install <id>` subprocess (`process.execPath ext install …`). This reuses the
 *   exact catalog-resolution + integrity + `assertSafeExtensionId` path shipped in PR-1 (#2252)
 *   with zero duplication and no cross-package import (`server/` cannot import `cli/`). The
 *   subprocess inherits the server's env (HAPI_HOME), so it installs into THIS instance's
 *   `${HAPI_HOME}/extensions/` dir.
 *
 * 🔒 Security (Matt-signed-off #1292): this endpoint installs arbitrary third-party code at host
 * privilege. It is JWT-gated (loader mounts post-auth), validates the id shape before spawning,
 * and delegates deep guarding (path traversal, manifest-id integrity) to the CLI's
 * `assertSafeExtensionId` + the resolver. Installed extensions still only LOAD behind
 * `HAPI_FS_EXTENSIONS` (default OFF, pre-#1291) — the install response surfaces that warning.
 */
import { Hono } from "hono";
import { z } from "zod";

import {
  fetchCatalog,
  DEFAULT_CATALOG_URL,
  RegistryError,
  type CommunityExtensionsCatalog,
} from "@hapi/protocol/ext";

import { defineCapability } from "@hapi/protocol";

import type { WebAppEnv } from "../../web/middleware/auth";
import type { ErrorLogger } from "../../logging/errorLogger";
import { cataloged } from "../../capabilities/cataloged";
import { logAndJson } from "../../web/routes/routeErrorHelper";
import { isBunCompiled } from "../../utils/bunCompiled";

/** Captured output of the host-side install subprocess (approach A). */
export interface InstallSpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Default install runner — re-invoke the compiled binary's own `hapi ext install <id> --json`.
 * Only meaningful in the COMPILED binary (the deployed instance), where `process.execPath` IS
 * the hapimatic binary; the route guards `bun run dev` mode out separately.
 */
export async function defaultSpawnInstall(
  id: string,
  override?: boolean,
  overrideReason?: string
): Promise<InstallSpawnResult> {
  const args = ["install", id];
  // #3131: forward a per-artifact supply-chain-scan override. The array-form spawn (no
  // shell) makes the reason a single safe argument. Only when BOTH the flag AND a reason
  // are present (a reason-less override stays blocked, matching the CLI).
  if (override && overrideReason) {
    args.push("--override-scan", `--override-reason=${overrideReason}`);
  }
  return defaultSpawnExt(args);
}

/**
 * Generic `hapi ext <args...> --json` re-invocation (approach A, #3120). Backs the harness
 * catalog + uninstall routes the same way {@link defaultSpawnInstall} backs install — no
 * cross-package import (server cannot import cli), and the `--json` envelope is parsed by the
 * route. `args` are code-defined verb+id tokens (the route validates any id before spawning).
 */
export async function defaultSpawnExt(
  args: string[]
): Promise<InstallSpawnResult> {
  const proc = Bun.spawn([process.execPath, "ext", ...args, "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

/**
 * First-line id guard: a catalog id is a single `<publisher>.<name>` segment. The AUTHORITATIVE
 * traversal guard is the CLI's `assertSafeExtensionId` (reached via the subprocess); this merely
 * rejects obviously-hostile ids before we spawn anything.
 */
const EXTENSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const installBodySchema = z.object({
  id: z.string().min(1).max(200),
  // #3131: per-artifact supply-chain-scan override (block → install THAT artifact). The
  // override is honored only when a reason is supplied (audit "why").
  override: z.boolean().optional(),
  overrideReason: z.string().min(1).max(500).optional(),
});

function resolveCatalogUrl(): string {
  const env = (process.env.HAPI_EXTENSION_CATALOG_URL || "").trim();
  return env || DEFAULT_CATALOG_URL;
}

export interface MarketplaceRoutesOptions {
  errorLogger?: ErrorLogger | null;
  /** Injectable catalog fetch (tests). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable catalog URL (tests). Defaults to env → `DEFAULT_CATALOG_URL`. */
  catalogUrl?: string;
  /**
   * Injectable install runner (tests). When provided, the compiled-binary guard is skipped
   * (the injected runner IS the install mechanism). Defaults to {@link defaultSpawnInstall}.
   */
  spawnInstall?: (
    id: string,
    override?: boolean,
    overrideReason?: string
  ) => Promise<InstallSpawnResult>;
  /**
   * Injectable generic `hapi ext` runner (tests) for the harness catalog + uninstall routes
   * (#3120). When provided, the compiled-binary guard is skipped. Defaults to
   * {@link defaultSpawnExt}.
   */
  spawnExt?: (args: string[]) => Promise<InstallSpawnResult>;
}

export function createMarketplaceRoutes(
  options?: MarketplaceRoutesOptions
): Hono<WebAppEnv> {
  const errorLogger = options?.errorLogger ?? null;
  const fetchImpl = options?.fetchImpl ?? fetch;
  const injectedSpawn = options?.spawnInstall;
  const injectedExt = options?.spawnExt;
  const app = new Hono<WebAppEnv>();

  app.get(
    "/ext/catalog",
    cataloged(
      defineCapability({
        id: "harness-admin.ext-catalog",
        domain: "harness-admin",
        surface: "rest",
        description:
          "List the available extensions in the marketplace catalog.",
        whenToUse: "When the user browses installable extensions.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/ext/catalog",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      try {
        const catalog: CommunityExtensionsCatalog = await fetchCatalog(
          options?.catalogUrl ?? resolveCatalogUrl(),
          fetchImpl
        );
        return c.json({ ok: true, catalog });
      } catch (error) {
        if (error instanceof RegistryError) {
          return c.json(
            {
              ok: false,
              error: error.message,
              code: `registry_${error.reason}`,
            },
            502
          );
        }
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "ext-marketplace-catalog",
          fallbackMessage: "Failed to fetch extension catalog",
        });
      }
    }
  );

  app.post(
    "/ext/install",
    cataloged(
      defineCapability({
        id: "harness-admin.ext-install",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Install an extension onto the host (privileged, host-mutating).",
        whenToUse: "When the operator installs an extension.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/ext/install",
        },
        auth: "jwt",
        riskTier: "destructive",
        availability: { scope: "operator" },
        probe: "skip",
      })
    ),
    async c => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json(
          { ok: false, error: "invalid JSON body", code: "invalid_request" },
          400
        );
      }
      const parsed = installBodySchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          {
            ok: false,
            error: "missing or invalid 'id'",
            code: "invalid_request",
          },
          400
        );
      }
      const { id, override, overrideReason } = parsed.data;
      if (!EXTENSION_ID_RE.test(id)) {
        return c.json(
          {
            ok: false,
            error: `invalid extension id '${id}'`,
            code: "invalid_id",
          },
          400
        );
      }

      // Approach A requires the compiled binary (process.execPath IS the hapimatic binary). In
      // `bun run dev` process.execPath is the bun executable, so decline cleanly. Skipped when an
      // install runner is injected (tests / a future in-process installer).
      if (!injectedSpawn && !isBunCompiled()) {
        return c.json(
          {
            ok: false,
            error:
              "extension install requires the compiled binary (not available in `bun run dev` mode)",
            code: "dev_mode_unsupported",
          },
          501
        );
      }

      try {
        const runInstall = injectedSpawn ?? defaultSpawnInstall;
        const { exitCode, stdout, stderr } = await runInstall(
          id,
          override,
          overrideReason
        );
        let envelope: Record<string, unknown> | null = null;
        try {
          envelope = JSON.parse(stdout) as Record<string, unknown>;
        } catch {
          envelope = null;
        }
        if (exitCode === 0 && envelope?.ok === true) {
          return c.json(envelope);
        }
        // Non-zero exit → treat as an upstream failure (422); a 0 exit with ok:false is a
        // client-actionable install rejection (400). Prefer the CLI's structured envelope.
        const status: 400 | 422 = exitCode === 0 ? 400 : 422;
        if (envelope) {
          return c.json(envelope, status);
        }
        return c.json(
          {
            ok: false,
            error: stderr.trim() || `install failed (exit ${exitCode})`,
            code: "install_failed",
          },
          status
        );
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "ext-marketplace-install",
          fallbackMessage: "Extension install failed",
        });
      }
    }
  );

  // ── HAL catalog CLI harnesses (#3120) ──
  // The catalog data + uninstall ride the SAME approach-A subprocess re-invocation as install
  // (server cannot import cli). Harness INSTALL reuses `POST /ext/install` above — `hapi ext
  // install <harness-id>` routes to the recipe on the CLI side, and the CLI-side #3131 scan
  // seam covers web-initiated installs for free.

  app.get(
    "/ext/harness-catalog",
    cataloged(
      defineCapability({
        id: "harness-admin.ext-harness-catalog",
        domain: "harness-admin",
        surface: "rest",
        description: "List the available harness bundles in the catalog.",
        whenToUse: "When the user browses installable harness bundles.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/ext/harness-catalog",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      if (!injectedExt && !isBunCompiled()) {
        return c.json(
          {
            ok: false,
            error:
              "harness catalog requires the compiled binary (not available in `bun run dev` mode)",
            code: "dev_mode_unsupported",
          },
          501
        );
      }
      try {
        const runExt = injectedExt ?? defaultSpawnExt;
        const { exitCode, stdout, stderr } = await runExt(["catalog"]);
        let envelope: Record<string, unknown> | null = null;
        try {
          envelope = JSON.parse(stdout) as Record<string, unknown>;
        } catch {
          envelope = null;
        }
        if (exitCode === 0 && envelope?.ok === true) {
          return c.json(envelope);
        }
        return c.json(
          {
            ok: false,
            error: stderr.trim() || `harness catalog failed (exit ${exitCode})`,
            code: "harness_catalog_failed",
          },
          502
        );
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "ext-marketplace-harness-catalog",
          fallbackMessage: "Failed to list the CLI-harness catalog",
        });
      }
    }
  );

  app.post(
    "/ext/harness-uninstall",
    cataloged(
      defineCapability({
        id: "harness-admin.ext-harness-uninstall",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Uninstall a harness bundle from the host (privileged, host-mutating).",
        whenToUse: "When the operator uninstalls a harness bundle.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/ext/harness-uninstall",
        },
        auth: "jwt",
        riskTier: "destructive",
        availability: { scope: "operator" },
        probe: "skip",
      })
    ),
    async c => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json(
          { ok: false, error: "invalid JSON body", code: "invalid_request" },
          400
        );
      }
      const parsed = installBodySchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          {
            ok: false,
            error: "missing or invalid 'id'",
            code: "invalid_request",
          },
          400
        );
      }
      const { id } = parsed.data;
      if (!EXTENSION_ID_RE.test(id)) {
        return c.json(
          {
            ok: false,
            error: `invalid harness id '${id}'`,
            code: "invalid_id",
          },
          400
        );
      }
      if (!injectedExt && !isBunCompiled()) {
        return c.json(
          {
            ok: false,
            error:
              "harness uninstall requires the compiled binary (not available in `bun run dev` mode)",
            code: "dev_mode_unsupported",
          },
          501
        );
      }
      try {
        const runExt = injectedExt ?? defaultSpawnExt;
        // `--yes` skips the interactive confirmation (non-interactive server subprocess).
        const { exitCode, stdout, stderr } = await runExt([
          "uninstall",
          id,
          "--yes",
        ]);
        let envelope: Record<string, unknown> | null = null;
        try {
          envelope = JSON.parse(stdout) as Record<string, unknown>;
        } catch {
          envelope = null;
        }
        if (exitCode === 0 && envelope?.ok === true) {
          return c.json(envelope);
        }
        const status: 400 | 422 = exitCode === 0 ? 400 : 422;
        if (envelope) return c.json(envelope, status);
        return c.json(
          {
            ok: false,
            error:
              stderr.trim() || `harness uninstall failed (exit ${exitCode})`,
            code: "harness_uninstall_failed",
          },
          status
        );
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "ext-marketplace-harness-uninstall",
          fallbackMessage: "Harness uninstall failed",
        });
      }
    }
  );

  return app;
}
