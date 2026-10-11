// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";
import type { WebAppEnv } from "../middleware/auth";
import { createRateLimiter } from "../middleware/rateLimit";
import {
  readSettings,
  writeSettings,
  type Settings,
} from "../../config/settings";
import {
  AddApiKeyRequestSchema,
  maskApiKey,
  type RedactedApiKey,
  type StoredApiKey,
} from "@hapi/protocol/schemas";
import { validateApiKeyById } from "../../services/apiKeyValidation";

/**
 * API Keys routes (issue #1955, epic #1954 — the secrets-vault management UI).
 *
 * The data layer for the admin "API Keys" page. Stores node-local provider keys
 * in settings.json's `apiKeys[]` field (written 0600 by writeSettings). Mirrors
 * the `preferences.ts` route-factory pattern.
 *
 * SECURITY (PM-locked, issue #1955):
 * - The raw secret (`key`) crosses the wire EXACTLY ONCE (client → server, on POST).
 * - Every response is a RedactedApiKey — built field-by-field, structurally
 *   incapable of carrying `key` (the RedactedAccount / #1446 discipline). No code
 *   path returns or renders a stored key in plaintext after entry (R5).
 * - The agent never sees these keys: they live only in the 0600 settings file and
 *   are read node-side at spawn; #1734's SECRET_ENV_VARS strip + egress broker keep
 *   them out of the agent environment.
 *
 * INVARIANT: at most one entry per `provider` (POST upserts — KD-4).
 *
 * SEAM (#1733): a `provider:"openrouter"` add/remove is written through to the flat
 * `openRouterApiKey` setting so the already-merged Codex/OpenRouter gateway consumer
 * works end-to-end with no daemon change (R9/KD-3).
 */

/**
 * The masking rule lives in `@hapi/protocol` (#4568) so the daemon's spawn-time
 * stamp and the launcher's per-launch re-check of an API-key session use the SAME
 * function as this redaction. Re-exported for the existing importers.
 */
export { maskApiKey };

/**
 * Map a StoredApiKey to its redacted view. Explicit field-by-field construction
 * (NEVER a spread) is the structural guarantee the secret cannot leak — adding a
 * secret-bearing field to StoredApiKey cannot accidentally surface it here.
 */
function toRedactedApiKey(entry: StoredApiKey): RedactedApiKey {
  return {
    id: entry.id,
    provider: entry.provider,
    label: entry.label,
    maskedKey: maskApiKey(entry.key),
    createdAt: entry.createdAt,
    // B3 (#1956): per-key validation status — derived, non-secret state. Defaults
    // to "none" until the first validate. Surfaced here so the API Keys page AND
    // the SEAM-2 selector (#1947 A3) read it off the standard list response.
    status: entry.status ?? "none",
    lastValidatedAt: entry.lastValidatedAt,
    // B4 (#1957): reusable service descriptor — derived, NON-SECRET provider
    // config + provenance. Added field-by-field (NEVER a spread) so the
    // structural no-leak guarantee holds: the secret cannot ride this path.
    ...(entry.descriptor ? { descriptor: entry.descriptor } : {}),
  };
}

/**
 * Issue #4823: read ONE vault entry by id, redacted. The mid-session payment-method
 * switch validates its key target with this BEFORE killing the session (the
 * daemon's own check runs only at respawn, after the kill). Returns the redacted
 * view only — the field-by-field `toRedactedApiKey` mapping above stays the single
 * no-leak boundary. Fails closed: an unreadable settings file reads as "no such
 * key" (`null`), never as an exception the caller could mistake for success.
 */
export async function readRedactedApiKeyById(
  settingsFile: string,
  id: string
): Promise<RedactedApiKey | null> {
  const settings = await readSettings(settingsFile);
  const entry = settings?.apiKeys?.find(k => k.id === id);
  return entry ? toRedactedApiKey(entry) : null;
}

export function createApiKeysRoutes(settingsFile: string): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const mutateLimiter = createRateLimiter({ name: "api-keys-mutate" });
  // B3 (#1956): the validate probe hits an external provider endpoint — rate-limit
  // it (defense-in-depth; the per-key TTL cache is the primary anti-hammering control).
  const validateLimiter = createRateLimiter({ name: "api-keys-validate" });

  // GET /api-keys — list stored keys, redacted (masked). Never returns `key`.
  app.get(
    "/api-keys",
    cataloged(
      defineCapability({
        id: "accounts.list-api-keys",
        domain: "accounts",
        surface: "rest",
        description:
          "List stored provider API keys with the secret masked (never the raw key), including each key's validation status and descriptor.",
        whenToUse: "When the user opens the API Keys settings page.",
        invocation: { kind: "rest", method: "GET", path: "/api/api-keys" },
        auth: "jwt",
        // #3837 R12 (never-readonly class): reveals which providers have keys
        // configured — a generic auto-invoke would enumerate the user's key
        // config, so it must not be `readonly` (KD-1). [ER 2026-09-19: D17]
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const settings = await readSettings(settingsFile);
      const entries = settings?.apiKeys ?? [];
      return c.json(entries.map(toRedactedApiKey));
    }
  );

  // POST /api-keys — add / upsert a provider key (provider-unique invariant).
  app.post(
    "/api-keys",
    cataloged(
      defineCapability({
        id: "accounts.add-api-key",
        domain: "accounts",
        surface: "rest",
        description:
          "Add or upsert a provider API key (one entry per provider); the raw secret is accepted once and never returned.",
        whenToUse: "When the user saves a provider API key.",
        invocation: { kind: "rest", method: "POST", path: "/api/api-keys" },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    mutateLimiter,
    async c => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
      }
      const parsed = AddApiKeyRequestSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { error: "Invalid API key request", details: parsed.error.issues },
          400
        );
      }

      const settings = await readSettings(settingsFile);
      // Refuse to write over an unparseable settings file — clobbering it would
      // lose existing secrets. readSettings returns null ONLY on a parse error
      // (a missing file returns {}).
      if (settings === null) {
        return c.json(
          { error: "Settings file is unreadable; refusing to overwrite" },
          500
        );
      }

      const { provider, accountUuid, label, key, descriptor } = parsed.data;
      const existing = settings.apiKeys ?? [];
      const entry: StoredApiKey = {
        id: randomUUID(),
        provider,
        // #3808: bind the key to an account when the request carries one, so N
        // per-account Gemini keys coexist under one provider. Absent ⇒ the
        // provider's unbound (default) key.
        ...(accountUuid ? { accountUuid } : {}),
        ...(label ? { label } : {}),
        key,
        createdAt: new Date().toISOString(),
        // B4 (#1957): persist the conversational-registration descriptor when the
        // (secure entry card's) request carries one. Non-secret provider config.
        ...(descriptor ? { descriptor } : {}),
      };
      // Upsert by (provider, accountUuid ?? null) (#3808, widening KD-4): replace
      // only the entry with the SAME provider AND the same account binding, so a
      // per-account key never clobbers the provider's unbound key or a sibling
      // account's key. `?? null` collapses absent/undefined to one bucket.
      const next: Settings = {
        ...settings,
        apiKeys: [
          ...existing.filter(
            e =>
              e.provider !== provider ||
              (e.accountUuid ?? null) !== (accountUuid ?? null)
          ),
          entry,
        ],
      };

      // OpenRouter write-through (R9/KD-3).
      if (provider === "openrouter") {
        (next as Settings & { openRouterApiKey?: string }).openRouterApiKey =
          key;
      }

      await writeSettings(settingsFile, next);
      return c.json(toRedactedApiKey(entry), 201);
    }
  );

  // DELETE /api-keys/:id — remove a stored key by id.
  app.delete(
    "/api-keys/:id",
    cataloged(
      defineCapability({
        id: "accounts.delete-api-key",
        domain: "accounts",
        surface: "rest",
        description: "Remove a stored provider API key by id.",
        whenToUse: "When the user deletes a saved provider key.",
        invocation: {
          kind: "rest",
          method: "DELETE",
          path: "/api/api-keys/:id",
        },
        auth: "jwt",
        riskTier: "destructive",
        availability: { scope: "user" },
      })
    ),
    mutateLimiter,
    async c => {
      const id = c.req.param("id");
      const settings = await readSettings(settingsFile);
      if (settings === null) {
        return c.json(
          { error: "Settings file is unreadable; refusing to overwrite" },
          500
        );
      }
      const existing = settings.apiKeys ?? [];
      const removed = existing.find(e => e.id === id);
      if (!removed) {
        return c.json({ error: "API key not found" }, 404);
      }
      const remaining = existing.filter(e => e.id !== id);
      const next: Settings = { ...settings, apiKeys: remaining };

      // OpenRouter write-through: clear the flat field when the openrouter entry is
      // removed (mirror of the POST write-through). undefined → omitted by JSON.stringify.
      if (removed.provider === "openrouter") {
        (next as Settings & { openRouterApiKey?: string }).openRouterApiKey =
          undefined;
      }

      await writeSettings(settingsFile, next);
      return c.json(remaining.map(toRedactedApiKey));
    }
  );

  // POST /api-keys/:id/validate — probe the stored key and update its status
  // (B3 #1956). Resolves the plaintext key node-side, probes the provider via the
  // per-provider adapter, and returns the redacted view with the updated status.
  // The secret never crosses the wire — the service hands back the StoredApiKey
  // in-process and toRedactedApiKey is the single redaction chokepoint (R8).
  app.post(
    "/api-keys/:id/validate",
    cataloged(
      defineCapability({
        id: "accounts.validate-api-key",
        domain: "accounts",
        surface: "rest",
        description:
          "Probe a stored provider key against its provider and update its validation status; the secret never leaves the node.",
        whenToUse: "When the user validates a saved provider key.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/api-keys/:id/validate",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
        probe: "skip",
      })
    ),
    validateLimiter,
    async c => {
      const id = c.req.param("id");
      const result = await validateApiKeyById(settingsFile, id);
      if (!result.ok) {
        if (result.reason === "unreadable") {
          return c.json(
            { error: "Settings file is unreadable; refusing to overwrite" },
            500
          );
        }
        return c.json({ error: "API key not found" }, 404);
      }
      return c.json(toRedactedApiKey(result.entry));
    }
  );

  return app;
}
