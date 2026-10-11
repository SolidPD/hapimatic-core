// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import type { Context } from "hono";
import {
  PORTER_SCHEMA_VERSION,
  buildExportScript,
  buildExtractionPrompt,
} from "@hapi/protocol/porter";
import type { WebAppEnv } from "../middleware/auth";
import { getPorterRecipient } from "../../config/porterAgeKeys";
import { readSettingsOrThrow } from "../../config/settings";
import { VERSION } from "../../version.generated";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";

/**
 * Config Porter recipient route (issue #2341, epic #2339 Sub B).
 *
 * Publishes the instance's PUBLIC age recipient so Sub C (#2342) can embed it in
 * the generated extraction prompt (R2). The response also carries
 * `schemaVersion` (`PORTER_SCHEMA_VERSION` from `@hapi/protocol/porter`, #2340)
 * so #2342 can pin the prompt to a manifest schema version in the same
 * round-trip.
 *
 * Sub C (#2342) additionally returns `prompt` — the fully-rendered extraction
 * prompt (`buildExtractionPrompt`, `@hapi/protocol/porter`) with the recipient
 * embedded as a literal value. This lets the Admin Configuration page (#2344)
 * render a copyable prompt block from a SINGLE fetch rather than composing it
 * client-side. This issue ships the generator + the data surface; the display is
 * #2344's (epic #2339 dependency graph C → E).
 *
 * 🔴 SECURITY (R1, R2):
 * - The response carries ONLY the public `age1…` recipient. The secret identity
 *   (`AGE-SECRET-KEY-1…`) is never read here: this route calls
 *   {@link getPorterRecipient}, which returns the public half only. The identity
 *   lives exclusively inside `config/porterAgeKeys.ts` and never crosses the
 *   wire. `porterKey.test.ts` asserts the response body contains no
 *   `AGE-SECRET-KEY` substring — a regression guard against a future refactor
 *   that returns the whole keypair.
 * - 🔴 The MOUNT POSITION *is* the auth mechanism for the PROMPT-serving route.
 *   This factory applies no inline auth; it MUST be mounted in `server.ts` AFTER
 *   the global JWT middleware (`app.use("/api/*", createAuthMiddleware(...))`),
 *   beside `createApiKeysRoutes`. Mounting it before the gate would expose the
 *   prompt-serving recipient route unauthenticated.
 *
 * 🔴 Sub A / F1 (#2617, D1=A): this factory ALSO serves an UNAUTHENTICATED
 * `GET /porter/recipient/public` that returns ONLY the public recipient +
 * schema version (never the prompt, never any secret). A cold extraction session
 * has no JWT, so it cannot re-fetch the gated route to run the recipient
 * consistency check (#2617 R3) — the public endpoint is what makes that check
 * executable. It is unauthenticated by an EXACT-match exemption in
 * `middleware/auth.ts` (NOT a prefix), so it exempts ONLY this one path and the
 * prompt-serving `GET /porter/recipient` stays JWT-gated. Serving the public age
 * recipient unauthenticated is acceptable — it is public-key material meant to be
 * pasted into arbitrary sessions. The only accepted trade-off is a small
 * instance-fingerprinting surface (an unauth caller learns the instance runs the
 * porter + its recipient); the exposure is bounded to the recipient, with no
 * listing/enumeration.
 *
 * Follows the `createApiKeysRoutes` factory shape (`web/routes/apiKeys.ts`).
 */
/**
 * Derive the destination instance's base URL + label for the extraction
 * prompt's recipient consistency check (#2617 R1/R3). Precedence (RC-3):
 * `webappUrl` → `federation.selfUrl` → request origin. Returns `instanceUrl:
 * undefined` only when none of the three resolves — the prompt then instructs a
 * secrets omission (never operator intervention). Settings-read failures fall
 * through to the request-origin path so the prompt still renders with the
 * guardrail intact.
 */
export async function deriveInstanceProvenance(
  c: Context<WebAppEnv>,
  settingsFile: string
): Promise<{ instanceUrl?: string; instanceLabel?: string }> {
  let instanceUrl: string | undefined;
  let instanceLabel: string | undefined;
  try {
    const settings = await readSettingsOrThrow(settingsFile);
    instanceUrl = settings.webappUrl ?? settings.federation?.selfUrl;
    instanceLabel = settings.federation?.nodeLabel;
  } catch {
    // Settings unreadable → fall through to request origin below. The prompt
    // still renders (guardrail intact); it simply lacks a configured URL/label.
  }
  if (!instanceUrl) {
    const forwardedHost = c.req.header("x-forwarded-host");
    if (forwardedHost) {
      // A forwarded-host header implies a reverse proxy (e.g. Tailscale Serve),
      // whose public scheme is effectively always https.
      const forwardedProto = c.req.header("x-forwarded-proto") ?? "https";
      instanceUrl = `${forwardedProto}://${forwardedHost}`;
    } else {
      try {
        instanceUrl = new URL(c.req.url).origin;
      } catch {
        instanceUrl = undefined;
      }
    }
  }
  return { instanceUrl, instanceLabel };
}

export function createPorterKeyRoutes(settingsFile: string): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  // GET /porter/recipient — JWT-gated (the mount position IS the auth). Returns
  // the instance's public age recipient + schema version + the ready-to-copy
  // extraction prompt (#2342) with the recipient AND its in-band provenance
  // embedded (#2617 R1). Mounted under /api in server.ts → effective path
  // GET /api/porter/recipient.
  app.get(
    "/porter/recipient",
    cataloged(
      defineCapability({
        id: "porter.get-recipient",
        domain: "porter",
        surface: "rest",
        description:
          "Return this instance's PUBLIC age recipient used to encrypt a config export to it (never the private identity).",
        whenToUse:
          "When a peer prepares an encrypted config bundle for this instance.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/porter/recipient",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      const recipient = await getPorterRecipient(settingsFile);
      const { instanceUrl, instanceLabel } = await deriveInstanceProvenance(
        c,
        settingsFile
      );
      // The route is mounted AFTER the JWT gate, so it runs only for an
      // authenticated operator on THIS instance — exactly the provenance anchor
      // the prompt asserts (#2617 R4). `generatedAt` is stamped here (the route is
      // impure by nature) and passed IN, keeping the pure generators pure.
      const generatedAt = new Date().toISOString();
      return c.json({
        recipient,
        schemaVersion: PORTER_SCHEMA_VERSION,
        // #3245: the script-driven, secrets-free export is the DEFAULT export
        // affordance the web UI presents. Additive `script` field — a self-
        // contained shell script the user runs directly (no LLM, no recipient, no
        // secrets). The `prompt` below is PRESERVED as the advanced/opt-in
        // "include secrets (LLM-assisted)" path (do not delete it).
        script: buildExportScript({
          instanceLabel,
          generatedAt,
          generatorVersion: VERSION,
        }),
        // Versioned download filename (Matt's 2026-08-27 directive: script
        // artifacts must carry a version in the FILENAME — an unversioned name
        // made a stale local copy indistinguishable from the fixed script). The
        // client uses this verbatim; single source of truth is the server's own
        // version, matching the `generatorVersion` baked into the script banner.
        scriptFilename: `hapimatic-config-export-v${VERSION}.sh`,
        prompt: buildExtractionPrompt({
          recipient,
          instanceUrl,
          instanceLabel,
          generatedAt,
        }),
        // Provenance fields surfaced additively for the #2344 admin UI. Non-secret
        // (a public URL + label); the response contract stays backward-compatible.
        instanceUrl,
        instanceLabel,
      });
    }
  );

  // GET /porter/recipient/public — UNAUTHENTICATED (#2617 Task 3.5, D1=A).
  // Exact-match exempt in middleware/auth.ts. Returns ONLY the public recipient
  // + schema version — NEVER the prompt, NEVER any secret — so a cold extraction
  // session with no JWT can run the recipient consistency check the extraction
  // prompt instructs. `getPorterRecipient` returns the public half only.
  app.get(
    "/porter/recipient/public",
    cataloged(
      defineCapability({
        id: "porter.get-recipient-public",
        domain: "porter",
        surface: "rest",
        description:
          "Public, unauthenticated read of this instance's age recipient for the config-extraction handoff (the four exact-match auth-exempt paths).",
        whenToUse:
          "When an external extraction prompt embeds this instance's public recipient.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/porter/recipient/public",
        },
        auth: "none",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const recipient = await getPorterRecipient(settingsFile);
      return c.json({
        recipient,
        schemaVersion: PORTER_SCHEMA_VERSION,
      });
    }
  );

  return app;
}
