// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import type { Context } from "hono";
import {
  buildExportScript,
  buildExportScriptPowerShell,
} from "@hapi/protocol/porter";
import type { PorterTokenResponse } from "@hapi/protocol/porter";
import type { WebAppEnv } from "../middleware/auth";
import type { ErrorLogger } from "../../logging/errorLogger";
import type { SSEManager } from "../../sse/sseManager";
import { VERSION } from "../../version.generated";
import {
  stageAndPlan,
  statusForError,
  MAX_ARCHIVE_BYTES,
  type PlanStore,
} from "./porterImport";
import { deriveInstanceProvenance } from "./porterKey";
import { toPlanSummary } from "../../porter/importArchive";
import type { PorterTokenStore } from "../../porter/porterToken";
import { createRateLimiter } from "../middleware/rateLimit";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";

/**
 * Configuration Porter — tokenized one-liner export routes (issue #3446, epic
 * #3445 Sub A). TWO factories, mounted at DIFFERENT prefixes in `server.ts`:
 *
 *  - {@link createPorterOnelinerApiRoutes} → mounted under `/api` → JWT-gated by
 *    mount position (mint + status; the operator's namespace is the identity).
 *  - {@link createPorterOnelinerPublicRoutes} → mounted at the app ROOT →
 *    public by mount position (`/p/:token` fetch + `/p/:token/archive` upload).
 *    The TOKEN is the auth: base64url + short TTL + fetch ≤ 5 + upload single-use
 *    + a token lookup BEFORE any body read + a Content-Length 413 pre-check. The
 *    JWT middleware is `/api/*`-scoped (`server.ts` `app.use("/api/*", …)`), so
 *    these routes never enter it — precedent `/ext-assets` (`server.ts:1147`).
 *
 * ONE factory cannot be mounted at two prefixes without exposing both route sets
 * at both, so the api/public split is deliberate (1B#3). Both factories share
 * the SAME injected {@link PorterTokenStore} and {@link PlanStore} — the upload
 * leg stages into the plan store `POST /api/porter/import/commit` reads (K6).
 */

/**
 * Rate-limit key for the PUBLIC legs: the client address (the mint leg keys on
 * the namespace instead — the default). `createRateLimiter`'s default key is the
 * namespace, which is `"anonymous"` for every unauthenticated caller → one
 * shared bucket; keying on the forwarded client address restores per-client
 * limiting behind a reverse proxy (Tailscale Serve sets `x-forwarded-for`). This
 * is defense-in-depth; the token + TTL + single-use are the real protection.
 */
function clientAddrKey(c: Context<WebAppEnv>): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim() || "anonymous";
  return c.req.header("x-real-ip") ?? "anonymous";
}

/**
 * Resolve the instance's public origin (scheme://host[:port]) for building the
 * absolute `fetchUrl`/`uploadUrl`. `deriveInstanceProvenance` already prefers
 * `webappUrl` → `federation.selfUrl` → `x-forwarded-host` → request origin, so
 * `new URL(c.req.url).origin` — which yields `http://127.0.0.1:3008` behind a
 * proxy — is only the last resort (1B#8).
 */
async function resolveOrigin(
  c: Context<WebAppEnv>,
  settingsFile: string
): Promise<{ origin: string | undefined; instanceLabel?: string }> {
  const { instanceUrl, instanceLabel } = await deriveInstanceProvenance(
    c,
    settingsFile
  );
  let origin = instanceUrl;
  if (!origin) {
    try {
      origin = new URL(c.req.url).origin;
    } catch {
      origin = undefined;
    }
  }
  return { origin, instanceLabel };
}

/**
 * Mount BOTH one-liner factories on the app in `server.ts`, sharing ONE token
 * store + ONE {@link PlanStore} (K6). The api legs go under `/api` (JWT-gated by
 * mount position); the public `/p/*` legs go at the ROOT and MUST be registered
 * BEFORE the SPA `app.get("*")` catch-all (else `/p/*` is dev-only in the compiled
 * binary — 1B#3). Call this at the porter-mounts region: it is after the `/api/*`
 * JWT middleware (so the api legs are gated) and before the catch-all (so `/p/*`
 * is reachable in both dev and the binary). Public by mount position — the JWT
 * middleware is `/api/*`-scoped; the token is the auth. See
 * docs/internal/architecture/auth.md.
 */
export function mountPorterOnelinerRoutes(
  app: Hono<WebAppEnv>,
  opts: {
    tokenStore: PorterTokenStore;
    planStore: PlanStore;
    settingsFile: string;
    dataDir: string;
    errorLogger?: ErrorLogger | null;
    getSseManager?: () => SSEManager | null;
  }
): void {
  app.route(
    "/api",
    createPorterOnelinerApiRoutes({
      tokenStore: opts.tokenStore,
      planStore: opts.planStore,
      settingsFile: opts.settingsFile,
    })
  );
  app.route("/", createPorterOnelinerPublicRoutes(opts));
}

export function createPorterOnelinerApiRoutes(opts: {
  tokenStore: PorterTokenStore;
  planStore: PlanStore;
  settingsFile: string;
}): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  // POST /api/porter/token — mint. JWT-gated by mount position; rate-limited on
  // the namespace key (the authenticated default). Binds the token to the
  // caller's namespace/user so the upload broadcast passes the SSE namespace gate.
  app.post(
    "/porter/token",
    createRateLimiter({ name: "porter-token-mint" }),
    cataloged(
      defineCapability({
        id: "porter.mint-oneliner-token",
        domain: "porter",
        surface: "rest",
        description:
          "Mint a one-time namespace-bound token backing a copy-paste config-export one-liner; rate-limited per namespace.",
        whenToUse: "When the user starts a one-liner config export.",
        invocation: { kind: "rest", method: "POST", path: "/api/porter/token" },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "operator" },
        probe: "skip",
      })
    ),
    async c => {
      const namespace = c.get("namespace");
      const userId = c.get("userId");
      if (!namespace) return c.json({ error: "Unauthorized" }, 401);

      const { origin } = await resolveOrigin(c, opts.settingsFile);
      if (!origin) {
        return c.json({ error: "Cannot derive the instance origin" }, 500);
      }

      const entry = opts.tokenStore.mint({
        namespace,
        userId: String(userId ?? namespace),
      });
      const response: PorterTokenResponse = {
        token: entry.token,
        expiresAt: entry.expiresAt,
        fetchUrl: `${origin}/p/${entry.token}`,
        uploadUrl: `${origin}/p/${entry.token}/archive`,
        // #3447 (Sub B, K1/K2): the `.ps1` variant of fetchUrl. base64url has no
        // `.`, so the suffix split in `GET /p/:token` is unambiguous (D1).
        fetchUrlPowerShell: `${origin}/p/${entry.token}.ps1`,
      };
      return c.json(response);
    }
  );

  // GET /api/porter/token/:token/status — owner-scoped status. Carries the staged
  // plan summary (the plan flows to the BROWSER here, not over the curl channel).
  app.get(
    "/porter/token/:token/status",
    cataloged(
      defineCapability({
        id: "porter.oneliner-token-status",
        domain: "porter",
        surface: "rest",
        description:
          "Return the owner-scoped status and staged plan summary for a one-liner export token.",
        whenToUse: "When the browser polls the progress of a one-liner export.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/porter/token/:token/status",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      const namespace = c.get("namespace");
      const token = c.req.param("token");
      if (!namespace) return c.json({ error: "Unauthorized" }, 401);

      const st = opts.tokenStore.statusForOwner(token, namespace);
      if (!st) return c.json({ error: "Token not found" }, 404);

      const plan = st.stagingHandle
        ? opts.planStore.get(st.stagingHandle)
        : undefined;
      return c.json({
        state: st.state,
        expiresAt: st.expiresAt,
        fetchCount: st.fetchCount,
        ...(plan ? { plan: toPlanSummary(plan) } : {}),
      });
    }
  );

  return app;
}

export function createPorterOnelinerPublicRoutes(opts: {
  tokenStore: PorterTokenStore;
  planStore: PlanStore;
  settingsFile: string;
  dataDir: string;
  errorLogger?: ErrorLogger | null;
  getSseManager?: () => SSEManager | null;
  /**
   * Destination overrides forwarded to `stageAndPlan`. Production leaves these
   * undefined so the upload leg's plan targets the LIVE `~/.claude` (the intended
   * import destination — the operator reviews + commits it). Tests inject temp
   * dirs so a round-trip's commit never touches real user files.
   */
  claudeDir?: string;
  hostConfigPath?: string;
  accountConfigBases?: string[];
}): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  // GET /p/:token — serve the personalized export script. Public by mount
  // position; the token IS the auth. Variant is bash (A) or powershell (B fills
  // it): a `.ps1` suffix OR a `PowerShell/` User-Agent selects powershell.
  app.get(
    "/p/:token",
    createRateLimiter({ name: "porter-oneliner-fetch", keyFn: clientAddrKey }),
    cataloged(
      defineCapability({
        id: "porter.oneliner-fetch-script",
        domain: "porter",
        surface: "rest",
        description:
          "Serve the personalized bash/PowerShell export script for a one-liner token; public by mount position, the token is the auth.",
        whenToUse:
          "When the user runs the copy-paste export one-liner on a machine.",
        invocation: { kind: "rest", method: "GET", path: "/p/:token" },
        auth: "none",
        riskTier: "readonly",
        availability: { scope: "user" },
        probe: "skip",
      })
    ),
    async c => {
      const rawParam = c.req.param("token");
      let token = rawParam;
      let variant: "bash" | "powershell" = "bash";
      if (token.endsWith(".ps1")) {
        variant = "powershell";
        token = token.slice(0, -4); // base64url has no `.`, so the split is exact
      }
      if ((c.req.header("user-agent") ?? "").includes("PowerShell/")) {
        variant = "powershell";
      }

      // Token lookup BEFORE any work. getForFetch increments the fetch count.
      const entry = opts.tokenStore.getForFetch(token);
      if (!entry) {
        // Distinguish unknown (404) from expired/over-fetched (410): a non-null
        // status means the token exists but its fetch leg is spent or expired.
        return opts.tokenStore.status(token)
          ? c.text(
              "Gone: this export link has expired or been used too many times.\n",
              410
            )
          : c.text("Not found.\n", 404);
      }

      const { origin, instanceLabel } = await resolveOrigin(
        c,
        opts.settingsFile
      );
      // Personalize the served script with ITS OWN single-use upload leg so the
      // script self-uploads back to this exact token (R2). No origin → serve the
      // legacy Download/Copy script (no upload step) rather than a broken URL.
      const uploadUrl = origin ? `${origin}/p/${token}/archive` : undefined;
      const scriptInput = {
        instanceLabel,
        generatedAt: new Date().toISOString(),
        generatorVersion: VERSION,
        uploadUrl,
      };
      if (variant === "powershell") {
        // #3447 (Sub B, R1): the Windows-native PowerShell twin, built from the
        // SAME input + shared constants as bash. Content-Type MUST be exactly
        // `text/plain; charset=utf-8` — 5.1's `irm` decodes a charset-less body
        // as ISO-8859-1 and would parse an application/json body into objects
        // before `iex` (1B#16). The `.ps1` fetch already counted against the
        // same fetchCount (getForFetch ran above); token semantics unchanged (K3).
        const psScript = buildExportScriptPowerShell(scriptInput);
        c.header("Content-Type", "text/plain; charset=utf-8");
        return c.body(psScript);
      }
      const script = buildExportScript(scriptInput);
      c.header("Content-Type", "text/x-shellscript; charset=utf-8");
      return c.body(script);
    }
  );

  // POST /p/:token/archive — the single-use upload leg. Cheap checks first
  // (token → Content-Length) so a bad/oversize upload never buffers the body.
  app.post(
    "/p/:token/archive",
    createRateLimiter({ name: "porter-oneliner-upload", keyFn: clientAddrKey }),
    cataloged(
      defineCapability({
        id: "porter.oneliner-upload-archive",
        domain: "porter",
        surface: "rest",
        description:
          "Receive the single-use config archive upload from a running export one-liner; public by mount position, token-gated.",
        whenToUse:
          "When the export one-liner uploads the captured config back to this instance.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/p/:token/archive",
        },
        auth: "none",
        riskTier: "mutating",
        availability: { scope: "user" },
        probe: "skip",
      })
    ),
    async c => {
      const token = c.req.param("token");

      const entry = opts.tokenStore.getForUpload(token);
      if (!entry) {
        return opts.tokenStore.status(token)
          ? c.json({ error: "Upload link expired or already used" }, 410)
          : c.json({ error: "Not found" }, 404);
      }

      // 413 on Content-Length BEFORE parseBody() — curl -F always sends it, and
      // parseBody() buffers the whole body up to the 220 MB socket limit, a
      // per-request memory lever on a public route. `-F` bodies exceed the raw
      // archive size by the multipart envelope, so this is a conservative outer
      // guard; stageAndPlan re-checks the exact archive bytes below.
      const contentLength = Number(c.req.header("content-length") ?? "0");
      if (Number.isFinite(contentLength) && contentLength > MAX_ARCHIVE_BYTES) {
        return c.json(
          {
            error: `Archive too large. Maximum is ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB`,
          },
          413
        );
      }

      let body: Awaited<ReturnType<typeof c.req.parseBody>>;
      try {
        body = await c.req.parseBody();
      } catch {
        return c.json({ error: "Malformed multipart body" }, 400);
      }
      const file = body["file"];
      if (!file || !(file instanceof File)) {
        return c.json(
          { error: "No archive file provided (field 'file')" },
          400
        );
      }

      const buf = new Uint8Array(await file.arrayBuffer());
      try {
        const outcome = await stageAndPlan(
          buf,
          {
            name: file.name,
            mime: file.type,
            dataDir: opts.dataDir,
            settingsFile: opts.settingsFile,
            errorLogger: opts.errorLogger,
            claudeDir: opts.claudeDir,
            hostConfigPath: opts.hostConfigPath,
            accountConfigBases: opts.accountConfigBases,
          },
          opts.planStore
        );
        if (!outcome.ok)
          return c.json({ error: outcome.error }, outcome.status);

        // Consume the single-use upload leg ONLY on a successful stage (a failed
        // stage leaves the leg open for a retry), then wake the waiting page.
        opts.tokenStore.markUploaded(token, outcome.plan.stagingHandle);
        opts.getSseManager?.()?.broadcast({
          type: "porter-token-received",
          namespace: entry.namespace, // captured at mint → passes shouldSend()
          token,
          stagingHandle: outcome.plan.stagingHandle,
        });
        return c.json({ stagingHandle: outcome.plan.stagingHandle });
      } catch (err) {
        const status = statusForError(err);
        const message =
          err instanceof Error ? err.message : "Import plan failed";
        opts.errorLogger?.log(
          status >= 500 ? "error" : "warn",
          `[porter-oneliner] upload failed: ${message}`,
          { category: "porter-oneliner", source: "server" }
        );
        return c.json({ error: message }, status);
      }
    }
  );

  return app;
}
