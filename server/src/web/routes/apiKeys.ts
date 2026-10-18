// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";
import type { WebAppEnv } from "../middleware/auth";
import { createRateLimiter } from "../middleware/rateLimit";
import {
  readSettings,
  SettingsUnreadableError,
  updateSettings,
  type Settings,
} from "../../config/settings";
import {
  AddApiKeyRequestSchema,
  maskApiKey,
  PatchApiKeyRequestSchema,
  type RedactedApiKey,
  type StoredApiKey,
} from "@hapi/protocol/schemas";
import {
  normalizeAccountMonogram,
  type AccountMonogram,
  type GoogleStoredAccount,
} from "@hapi/protocol";
import {
  probeProvider,
  toLastValidation,
  validateApiKeyById,
  type FetchLike,
} from "../../services/apiKeyValidation";
import type { AccountService } from "../../services/accountService";
import { uuidV5 } from "../../services/providerAccountImport";
import type { NicknameStore } from "../../accounts/nicknameStore";
import type { MonogramStore } from "../../accounts/monogramStore";

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
 * Multi-key (#4463 D-2 A): a provider may hold several entries. The default POST
 * (Settings → Keys, the chat registration card) upserts ONE entry in place; an
 * append add (`mode: "append"`, anthropic/openai) and every gemini/google add
 * (each mints its own Google account, R3) add a new entry. An identical key for
 * the same provider is refused (409 `duplicate_key`) where a new entry is added.
 *
 * Validate-then-store (#4463 D-1 A): with `validate: true` the key is probed
 * first and stored only when the provider accepts it — a rejected or unverifiable
 * key stores nothing. Every write goes through `updateSettings` (X5).
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
    // #4463 R4: non-secret identity + probe detail, field-by-field. The
    // lastValidation copy is rebuilt from its three numbers — never a provider
    // response text.
    ...(entry.accountUuid ? { accountUuid: entry.accountUuid } : {}),
    ...(entry.monogram ? { monogram: entry.monogram } : {}),
    ...(entry.lastValidation
      ? { lastValidation: toLastValidation(entry.lastValidation) }
      : {}),
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

const UNREADABLE_BODY = {
  error: "Settings file is unreadable; refusing to overwrite",
} as const;

/** gemini and google are one API (#4463 R2): one duplicate scope, one mint. */
function isGoogleProvider(provider: string): boolean {
  return provider === "gemini" || provider === "google";
}

function sameProviderFamily(a: string, b: string): boolean {
  return a === b || (isGoogleProvider(a) && isGoogleProvider(b));
}

/** The providers D-2 A keeps single-key: an append add is refused for them. */
const SINGLE_KEY_PROVIDERS = new Set(["openrouter", "custom"]);

/**
 * Does `entries` already hold `key` for `provider` where a new entry would be
 * added (#4463 R2)? Comparison is on trimmed strings, and gemini/google are one
 * provider. `ownAccountUuid` excludes a bound gemini/google add's own bucket: a
 * re-save of the same key onto the same account replaces it, it is no duplicate.
 */
function findDuplicate(
  entries: StoredApiKey[],
  provider: string,
  key: string,
  ownAccountUuid: string | undefined
): boolean {
  const wanted = key.trim();
  return entries.some(
    e =>
      sameProviderFamily(e.provider, provider) &&
      e.key.trim() === wanted &&
      !(ownAccountUuid !== undefined && e.accountUuid === ownAccountUuid)
  );
}

/** The flat `openRouterApiKey` mirrors the first remaining openrouter entry
 *  (R9/KD-3); with none left it is removed. */
function withOpenRouterFlat(settings: Settings): Settings {
  const first = (settings.apiKeys ?? []).find(e => e.provider === "openrouter");
  return {
    ...settings,
    openRouterApiKey: first ? first.key : undefined,
  } as Settings;
}

export interface ApiKeysRoutesOptions {
  /** #4463 R3/R7: mints a Gemini key's Google account on add, removes it on delete. */
  getAccountService?: () => AccountService | null;
  /** #4463 R6: a Gemini key's name and monogram mirror onto its Google account. */
  getNicknameStore?: () => NicknameStore | null;
  getMonogramStore?: () => MonogramStore | null;
  /** Test seam: the provider probe's fetch. */
  fetchImpl?: FetchLike;
}

export function createApiKeysRoutes(
  settingsFile: string,
  opts: ApiKeysRoutesOptions = {}
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const mutateLimiter = createRateLimiter({ name: "api-keys-mutate" });
  // B3 (#1956): the validate probe hits an external provider endpoint — rate-limit
  // it (defense-in-depth; the per-key TTL cache is the primary anti-hammering control).
  const validateLimiter = createRateLimiter({ name: "api-keys-validate" });

  /** Mirror a Gemini key's name and/or monogram onto its Google account's
   *  sidecar stores (#4463 R6). Best-effort: the vault entry is the record. */
  function syncAccountIdentity(
    accountUuid: string,
    change: { label?: string; monogram?: AccountMonogram }
  ): void {
    try {
      if (change.label !== undefined) {
        opts.getNicknameStore?.()?.set(accountUuid, change.label);
      }
      if (change.monogram !== undefined) {
        opts.getMonogramStore?.()?.set(accountUuid, change.monogram);
      }
    } catch {
      // A sidecar write failure leaves the account showing its old identity;
      // the key itself is stored and the next edit retries the mirror.
    }
  }

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

  // POST /api-keys — add a provider key: upsert by default, append on request,
  // validate-then-store when `validate` is set (#4463).
  app.post(
    "/api-keys",
    cataloged(
      defineCapability({
        id: "accounts.add-api-key",
        domain: "accounts",
        surface: "rest",
        description:
          "Add a provider API key (replace in place, or append on request), optionally validated first; the raw secret is accepted once and never returned.",
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
      const { provider, accountUuid, label, key, descriptor } = parsed.data;
      const mode = parsed.data.mode ?? "upsert";
      if (mode === "append" && SINGLE_KEY_PROVIDERS.has(provider)) {
        return c.json(
          {
            error: `${provider} keeps one key per node; append is not supported`,
            code: "append_unsupported",
          },
          400
        );
      }
      let monogram: AccountMonogram | undefined;
      if (parsed.data.monogram !== undefined) {
        const normalized = normalizeAccountMonogram(parsed.data.monogram);
        if (!normalized.ok) return c.json({ error: normalized.error }, 400);
        if (Object.keys(normalized.value).length > 0) {
          monogram = normalized.value;
        }
      }

      const google = isGoogleProvider(provider);
      // R2: a duplicate is refused wherever the add creates a new entry.
      const checkDuplicate = mode === "append" || google;
      // R3: a gemini/google add without a binding mints its own Google account.
      const mint = google && !accountUuid;
      const accountService = mint ? opts.getAccountService?.() : null;
      if (mint && !accountService) {
        return c.json({ error: "Account service unavailable" }, 503);
      }

      const settings = await readSettings(settingsFile);
      // Refuse to write over an unparseable settings file — clobbering it would
      // lose existing secrets. readSettings returns null ONLY on a parse error
      // (a missing file returns {}).
      if (settings === null) return c.json(UNREADABLE_BODY, 500);
      const duplicateBody = {
        error: "This key is already stored for this provider",
        code: "duplicate_key",
      } as const;
      // An append always adds a new entry, so it never excludes its own
      // account's entries from the duplicate scan — only a bound upsert that
      // REPLACES its own entry may (#4463 review F1).
      const dupOwnUuid = mode === "append" ? undefined : accountUuid;
      if (
        checkDuplicate &&
        findDuplicate(settings.apiKeys ?? [], provider, key, dupOwnUuid)
      ) {
        return c.json(duplicateBody, 409);
      }

      // D-1 A: probe first; only a `valid` key is stored. Neither refusal writes.
      let validated: Pick<
        StoredApiKey,
        "status" | "lastValidatedAt" | "lastValidation"
      > = {};
      if (parsed.data.validate) {
        const probe = await probeProvider(provider, key, {
          fetchImpl: opts.fetchImpl,
        });
        const upstream =
          probe.httpStatus !== undefined
            ? { upstreamStatus: probe.httpStatus }
            : {};
        if (probe.outcome === "invalid") {
          return c.json(
            {
              error: "The provider rejected this key",
              code: "key_rejected",
              ...upstream,
            },
            422
          );
        }
        if (probe.outcome !== "valid") {
          return c.json(
            {
              error: "The key could not be verified, so it was not stored",
              code: "key_unverified",
              ...upstream,
            },
            424
          );
        }
        validated = {
          status: "valid",
          lastValidatedAt: new Date().toISOString(),
          lastValidation: toLastValidation(probe),
        };
      }

      const id = randomUUID();
      const boundUuid = mint ? uuidV5(`google:${id}`) : accountUuid;
      const entry: StoredApiKey = {
        id,
        provider,
        // #3808: bind the key to an account when the request carries one, so N
        // per-account Gemini keys coexist under one provider. #4463 R3: a
        // gemini/google add without one is bound to its freshly minted account.
        ...(boundUuid ? { accountUuid: boundUuid } : {}),
        ...(label ? { label } : {}),
        key,
        createdAt: new Date().toISOString(),
        // B4 (#1957): persist the conversational-registration descriptor when the
        // (secure entry card's) request carries one. Non-secret provider config.
        ...(descriptor ? { descriptor } : {}),
        ...(monogram ? { monogram } : {}),
        ...validated,
      };

      const outcome: { duplicate: boolean } = { duplicate: false };
      try {
        await updateSettings(settingsFile, fresh => {
          const existing = fresh.apiKeys ?? [];
          if (
            checkDuplicate &&
            findDuplicate(existing, provider, key, dupOwnUuid)
          ) {
            outcome.duplicate = true;
            return fresh;
          }
          let apiKeys: StoredApiKey[];
          if (mode === "append" || mint) {
            apiKeys = [...existing, entry];
          } else {
            // Upsert by (provider, accountUuid ?? null) (#3808): replace EXACTLY
            // ONE match in place — the one already holding this key, else the
            // first in stored order (the key OpenCode uses) — and leave every
            // other entry untouched (#4463 R8). The replacement is a NEW entry
            // with a new id: #4568 binds sessions to a vault id, so an id is
            // never reused for a different key string (T38).
            const matches = existing
              .map((e, i) => ({ e, i }))
              .filter(
                ({ e }) =>
                  // gemini and google are one provider here too, matching the
                  // duplicate rule (#4463 review F2).
                  sameProviderFamily(e.provider, provider) &&
                  (e.accountUuid ?? null) === (accountUuid ?? null)
              );
            const target =
              matches.find(({ e }) => e.key.trim() === key.trim()) ??
              matches[0];
            apiKeys = target
              ? existing.map((e, i) => (i === target.i ? entry : e))
              : [...existing, entry];
          }
          const next: Settings = { ...fresh, apiKeys };
          // OpenRouter write-through (R9/KD-3).
          return provider === "openrouter" ? withOpenRouterFlat(next) : next;
        });
      } catch (error) {
        if (error instanceof SettingsUnreadableError) {
          return c.json(UNREADABLE_BODY, 500);
        }
        throw error;
      }
      if (outcome.duplicate) return c.json(duplicateBody, 409);

      if (mint && accountService && boundUuid) {
        // The record is exactly the importer's shape (providerAccountImport.ts):
        // GoogleStoredAccountSchema rejects any other, and a rejected record is
        // invisible to accountService.list(). vaultKeyRef.provider is "gemini"
        // even for a `google` vault entry.
        const record: GoogleStoredAccount = {
          schema_version: 1,
          provider: "google",
          accountUuid: boundUuid,
          label: label ?? "Gemini",
          vaultKeyRef: { provider: "gemini", accountUuid: boundUuid },
          capturedAt: Date.now(),
          lastUsedAt: 0,
        };
        try {
          accountService.add(record);
        } catch {
          // Undo the vault write so neither half survives alone.
          await updateSettings(settingsFile, fresh => ({
            ...fresh,
            apiKeys: (fresh.apiKeys ?? []).filter(e => e.id !== id),
          })).catch(() => {});
          return c.json({ error: "Failed to create the key's account" }, 500);
        }
        if (monogram) syncAccountIdentity(boundUuid, { monogram });
      }
      return c.json(toRedactedApiKey(entry), 201);
    }
  );

  // PATCH /api-keys/:id — set a key's name and monogram in one write (#4463 R6).
  app.patch(
    "/api-keys/:id",
    cataloged(
      defineCapability({
        id: "accounts.update-api-key",
        domain: "accounts",
        surface: "rest",
        description:
          "Set a stored provider key's name and monogram in one write; a Gemini key's Google account shows the same identity.",
        whenToUse: "When the user renames a saved key or edits its monogram.",
        invocation: {
          kind: "rest",
          method: "PATCH",
          path: "/api/api-keys/:id",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    mutateLimiter,
    async c => {
      const id = c.req.param("id");
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
      }
      const parsed = PatchApiKeyRequestSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { error: "Invalid API key update", details: parsed.error.issues },
          400
        );
      }
      let monogram: AccountMonogram | undefined;
      if (parsed.data.monogram !== undefined) {
        const normalized = normalizeAccountMonogram(parsed.data.monogram);
        if (!normalized.ok) return c.json({ error: normalized.error }, 400);
        monogram = normalized.value;
      }
      const label =
        parsed.data.label !== undefined ? parsed.data.label.trim() : undefined;

      const applied: { entry: StoredApiKey | null } = { entry: null };
      try {
        await updateSettings(settingsFile, fresh => {
          const entries = fresh.apiKeys ?? [];
          const idx = entries.findIndex(e => e.id === id);
          if (idx === -1) return fresh;
          const next: StoredApiKey = { ...entries[idx]! };
          if (label !== undefined) {
            if (label) next.label = label;
            else delete next.label;
          }
          if (monogram !== undefined) {
            if (Object.keys(monogram).length > 0) next.monogram = monogram;
            else delete next.monogram;
          }
          applied.entry = next;
          return {
            ...fresh,
            apiKeys: entries.map((e, i) => (i === idx ? next : e)),
          };
        });
      } catch (error) {
        if (error instanceof SettingsUnreadableError) {
          return c.json(UNREADABLE_BODY, 500);
        }
        throw error;
      }
      const updated = applied.entry;
      if (!updated) return c.json({ error: "API key not found" }, 404);
      if (updated.accountUuid && isGoogleProvider(updated.provider)) {
        syncAccountIdentity(updated.accountUuid, { label, monogram });
      }
      return c.json(toRedactedApiKey(updated));
    }
  );

  // DELETE /api-keys/:id — remove a stored key by id. A Gemini key's Google
  // mirror record goes with it (#4463 R7, epic #4460 O-2 A).
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
      if (settings === null) return c.json(UNREADABLE_BODY, 500);
      const removed = (settings.apiKeys ?? []).find(e => e.id === id);
      if (!removed) {
        return c.json({ error: "API key not found" }, 404);
      }

      // Record first, vault entry second: a failure in between leaves the key
      // listed, and a second Remove Key finishes the job. The record is removed
      // ONLY when it is this key's own Google mirror — POST accepts any string as
      // accountUuid, and a key bound to some other account leaves that account.
      // A record already gone (or tombstoned by #3982) is success.
      // #4463 review F2: an account another stored key still references is KEPT
      // (only this key is removed), and the response says so in the
      // X-Hapi-Account-Kept header — the list body's contract is unchanged.
      let accountKept: string | null = null;
      if (removed.accountUuid && isGoogleProvider(removed.provider)) {
        const accountService = opts.getAccountService?.();
        const raw = accountService?.getRawAny(removed.accountUuid);
        const isMirror =
          raw !== null &&
          raw !== undefined &&
          (raw as { provider?: string }).provider === "google" &&
          (raw as GoogleStoredAccount).vaultKeyRef?.accountUuid ===
            removed.accountUuid;
        const stillReferenced = (settings.apiKeys ?? []).some(
          e => e.id !== id && e.accountUuid === removed.accountUuid
        );
        if (stillReferenced) {
          accountKept = removed.accountUuid;
        } else if (accountService && isMirror) {
          const result = accountService.delete(removed.accountUuid, {
            allowLastOfProvider: true,
          });
          if (!result.ok && result.code !== "not_found") {
            return c.json(
              {
                error: "Failed to remove the key's account",
                code: result.code,
              },
              500
            );
          }
        }
      }

      let remaining: StoredApiKey[] = [];
      try {
        const written = await updateSettings(settingsFile, fresh => {
          const existing = fresh.apiKeys ?? [];
          if (!existing.some(e => e.id === id)) return fresh;
          const next: Settings = {
            ...fresh,
            apiKeys: existing.filter(e => e.id !== id),
          };
          // OpenRouter write-through: the flat field follows any remaining
          // openrouter entry rather than being cleared outright (#4463 R7).
          return removed.provider === "openrouter"
            ? withOpenRouterFlat(next)
            : next;
        });
        remaining = written.apiKeys ?? [];
      } catch (error) {
        if (error instanceof SettingsUnreadableError) {
          return c.json(UNREADABLE_BODY, 500);
        }
        throw error;
      }
      if (accountKept) c.header("X-Hapi-Account-Kept", accountKept);
      return c.json(remaining.map(toRedactedApiKey));
    }
  );

  // POST /api-keys/:id/validate — probe the stored key and update its status
  // (B3 #1956). Resolves the plaintext key node-side, probes the provider via the
  // per-provider adapter, and returns the redacted view with the updated status.
  // The secret never crosses the wire — the service hands back the StoredApiKey
  // in-process and toRedactedApiKey is the single redaction chokepoint (R8).
  // #4463 R5: `?force=1` bypasses the TTL cache (a re-Test from the UI).
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
      const force = c.req.query("force");
      const result = await validateApiKeyById(settingsFile, id, {
        fetchImpl: opts.fetchImpl,
        force: force === "1" || force === "true",
      });
      if (!result.ok) {
        if (result.reason === "unreadable") {
          return c.json(UNREADABLE_BODY, 500);
        }
        return c.json({ error: "API key not found" }, 404);
      }
      return c.json(toRedactedApiKey(result.entry));
    }
  );

  return app;
}
