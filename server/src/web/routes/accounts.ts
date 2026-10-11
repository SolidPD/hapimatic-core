// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  AccountUsageHistorySchema,
  AccountUsageSchema,
  defineCapability,
  LOCAL_NODE_ID,
  normalizeAccountMonogram,
  ProviderAccountUsageSchema,
  ProviderAuthStateEnvelopeSchema,
  type AmbientOnboardingTokenState,
} from "@hapi/protocol";
import { configuration } from "../../configuration";
import { readSettings, writeSettings } from "../../config/settings";
import type { ProviderAuthFacts } from "../../services/providerAuthState";
import type { WebAppEnv } from "../middleware/auth";
import { createRateLimiter } from "../middleware/rateLimit";
import { cataloged } from "../../capabilities/cataloged";
import { logAndJson } from "./routeErrorHelper";
import type { AccountService } from "../../services/accountService";
import type { AccountLoginService } from "../../services/accountLoginService";
import type { CodexLoginService } from "../../services/codexLoginService";
import type { NodeRegistry } from "../../federation/nodeRegistry";
import type { UsageService } from "../../accounts/usageService";
import type { ProviderUsageService } from "../../accounts/providerUsageService";
import type { NicknameStore } from "../../accounts/nicknameStore";
import type { MonogramStore } from "../../accounts/monogramStore";
import type { UsageHistoryStore } from "../../store";
import { buildHistoryResponse } from "../../accounts/usageHistory";
import type { ErrorLogger } from "../../logging/errorLogger";
import { readOnboardingSeedState } from "../../utils/daemonControlClient";

/**
 * Account management HTTP routes (issue #1451, Sub-Issue E of epic #1446).
 *
 *   GET    /api/accounts        — redacted account list for the local node (R1)
 *   GET    /api/accounts/usage  — redacted per-account usage for this node (epic #1855, Sub B / #1857)
 *   GET    /api/accounts/:uuid  — one redacted account; 404 if unknown (R2)
 *   DELETE /api/accounts/:uuid  — remove an account; 409 if it is the only one (R3, R4)
 *
 * Mounted under `/api` AFTER the JWT auth middleware in `server.ts`, so every
 * route is authenticated (R9). Token values never appear in a response — the
 * `AccountService` returns `RedactedAccount`, whose shape structurally excludes
 * `accessToken`/`refreshToken` (R11); the usage route returns `AccountUsage`,
 * whose plain-`z.object()` schema (no `.passthrough()`) strips token fields too.
 */
/**
 * #3808: trigger the provider-record import (#3807's per-account codex dirs +
 * sidecars, the host `~/.codex` login, and the legacy Gemini vault key → store
 * records). Resolves the account-configs dir + host codex home to the SAME
 * defaults as the #3806 reader, and threads the async vault I/O (readSettings /
 * writeSettings) so `AccountService` stays decoupled from `config/settings`.
 * Best-effort (the method swallows its own errors). `force` re-imports after a
 * new #3807 login; the default GET path is once-per-process (idempotent). [ER 2026-09-19: 3808-2]
 */
async function triggerProviderImport(
  service: AccountService,
  opts?: { force?: boolean }
): Promise<void> {
  const accountConfigsDir = join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "hapimatic",
    "account-configs"
  );
  await service.importProviderAccountsOnce(
    {
      accountConfigsDir,
      hostCodexHome: process.env.CODEX_HOME ?? join(homedir(), ".codex"),
      readGeminiVaultEntries: async () => {
        const settings = await readSettings(configuration.settingsFile);
        return (settings?.apiKeys ?? [])
          .filter(k => k.provider === "gemini" || k.provider === "google")
          .map(k => ({
            id: k.id,
            label: k.label,
            accountUuid: k.accountUuid,
          }));
      },
      applyVaultStamps: async stamps => {
        const settings = await readSettings(configuration.settingsFile);
        if (!settings) return;
        const apiKeys = (settings.apiKeys ?? []).map(k => {
          const stamp = stamps.find(s => s.entryId === k.id);
          return stamp ? { ...k, accountUuid: stamp.accountUuid } : k;
        });
        await writeSettings(configuration.settingsFile, {
          ...settings,
          apiKeys,
        });
      },
    },
    opts
  );
}

/** #4736: the Accounts-page onboarding notice state — see `resolveOnboardingRegistration`. */
export type OnboardingRegistration = "missing" | "pending" | null;

/**
 * #4736: whether a provisioned VM's onboarding sign-in is missing from the account
 * store, for the Accounts-page notice. The onboarding wizard installs the Claude
 * credential as the service-env `CLAUDE_CODE_OAUTH_TOKEN` and the daemon seeds it
 * into the store at boot; when that seed fails the account never lists, and
 * otherwise nothing tells the user (#2670 made the reason journal-visible only).
 *
 * - `null` — no onboarding env credential (operator nodes, API-key VMs); or the
 *   onboarding account is in the store; or the daemon reports its seed `released`
 *   (the seed registered the account, so a later absence is a deliberate removal,
 *   not a failed sign-in);
 * - `"missing"` — the onboarding account is not in the store. Which account that
 *   is comes from slot 0 of the gateway's `HAPI_ONBOARDING_ACCOUNT_IDENTITY`. When
 *   the gateway delivered the array but slot 0 carries no identity (#2670), the
 *   seed cannot register the primary, so it counts as registered only once the
 *   store holds an Anthropic account other than the delivered extras (which seed
 *   from their own slots) — i.e. Add account landed it. With no usable array at
 *   all, any Anthropic account counts;
 * - `"pending"` — as `"missing"`, but the live daemon reports its seed still in
 *   flight.
 *
 * Computed from the LIVE store, so it clears itself once Add account (or a later
 * seed) lands the account. The daemon's `retained` state is deliberately not the
 * trigger: it covers only the primary account and stays stale after Add account
 * succeeds. Returns only the enum — never the identity payload or a token.
 */
export function resolveOnboardingRegistration(input: {
  envToken: string | undefined;
  identityRaw: string | undefined;
  anthropicAccountUuids: readonly string[];
  /** Read lazily — only when the onboarding account is not in the store. */
  readSeedState: () => AmbientOnboardingTokenState | null;
}): OnboardingRegistration {
  if (!input.envToken) return null;
  const primary = decodeOnboardingPrimary(input.identityRaw);
  if (isOnboardingPrimaryRegistered(primary, input.anthropicAccountUuids)) {
    return null;
  }
  const seed = input.readSeedState();
  if (seed === "released") return null;
  return seed === "pending" ? "pending" : "missing";
}

/**
 * What the gateway-delivered identity payload says about the onboarding primary
 * (base64-encoded JSON array, index-aligned with the onboarding accounts; mirrors
 * `decodeDeliveredIdentities` in cli/src/accounts/seedFromEnvToken.ts):
 * - `uuid` — slot 0 carries the primary's account uuid;
 * - `unidentified` — an array was delivered but slot 0 has no usable identity;
 *   `deliveredUuids` lists the extras that did;
 * - `absent` — no payload, or one that is not a non-empty JSON array.
 */
type OnboardingPrimary =
  | { kind: "uuid"; uuid: string }
  | { kind: "unidentified"; deliveredUuids: readonly string[] }
  | { kind: "absent" };

function decodeOnboardingPrimary(raw: string | undefined): OnboardingPrimary {
  if (!raw) return { kind: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    return { kind: "absent" };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return { kind: "absent" };
  const slotUuids = parsed.map(identitySlotUuid);
  const primary = slotUuids[0];
  if (primary) return { kind: "uuid", uuid: primary };
  return {
    kind: "unidentified",
    deliveredUuids: slotUuids.filter((u): u is string => u !== null),
  };
}

function identitySlotUuid(slot: unknown): string | null {
  if (slot === null || typeof slot !== "object") return null;
  const uuid = (slot as { accountUuid?: unknown }).accountUuid;
  return typeof uuid === "string" && uuid.length > 0 ? uuid : null;
}

function isOnboardingPrimaryRegistered(
  primary: OnboardingPrimary,
  anthropicAccountUuids: readonly string[]
): boolean {
  switch (primary.kind) {
    case "uuid":
      return anthropicAccountUuids.includes(primary.uuid);
    case "unidentified":
      return anthropicAccountUuids.some(
        uuid => !primary.deliveredUuids.includes(uuid)
      );
    case "absent":
      return anthropicAccountUuids.length > 0;
  }
}

export function createAccountsRoutes(opts: {
  getAccountService: () => AccountService | null;
  getLoginService?: () => AccountLoginService | null;
  getUsageService?: () => UsageService | null;
  // Issue #3809 (epic #3345, D5 = C): the local non-Anthropic provider usage
  // source — OpenAI codex snapshots + the Google spend counter — served under
  // the sibling `providerUsage[]` key. Optional (tests / non-provider instances
  // omit it → an empty providerUsage[]).
  getProviderUsageService?: () => ProviderUsageService | null;
  getUsageHistoryStore?: () => UsageHistoryStore | null;
  getNicknameStore?: () => NicknameStore | null;
  getMonogramStore?: () => MonogramStore | null;
  // Issue #3806 (epic #3345): the LOCAL-node provider auth-state reader (Codex +
  // Gemini derived state). Returns bare facts; this route frames them as the
  // single-node envelope. The federation aggregator (federation/accounts.ts) uses
  // the SAME reader via FederationDeps. [ER 2026-09-19: 3806-4]
  getProviderAuthState?: () => Promise<ProviderAuthFacts>;
  // Issue #3807 (epic #3345, K9 serial chain): the server-side Codex (OpenAI)
  // login driver for the in-app "Add account" wizard (API-key + device-auth).
  // The hub routes below dispatch on `nodeId` — served locally by this driver,
  // or proxied to a peer via getNodeRegistry (R4). Optional so test harnesses
  // that don't exercise the openai-login routes can omit it. [ER 2026-09-19: 3807-3]
  getCodexLoginService?: () => CodexLoginService | null;
  // Federation registry for the peer-dispatch branch of the openai-login routes
  // (mirrors createNodesRoutes). Optional — a non-federated instance serves
  // every nodeId locally.
  getNodeRegistry?: () => NodeRegistry | null;
  // This node's federation id (null on a non-federated instance) — resolves the
  // LOCAL_NODE_ID sentinel + "is this a local request" (mirrors createNodesRoutes).
  getLocalNodeId?: () => string | null;
  errorLogger?: ErrorLogger | null;
  // Issue #4736: the local daemon's onboarding-seed state for GET /accounts'
  // `onboardingRegistration`. Defaults to the daemon.state.json reader; tests inject.
  readOnboardingSeedState?: () => AmbientOnboardingTokenState | null;
}): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const errorLogger = opts.errorLogger ?? null;
  // Instantiated inside the factory so each createAccountsRoutes() call (incl.
  // tests) gets a fresh rate-limit bucket map (#1099).
  const deleteLimiter = createRateLimiter({ name: "accounts-delete" });
  // Web-initiated OAuth login (issue #1263). Mutating + token-handling, so
  // rate-limited like delete. 10/min is generous for a human re-login flow.
  const loginLimiter = createRateLimiter({
    name: "accounts-login",
    limit: 10,
  });
  // Nickname set/clear (epic #1855 follow-up). Mutating → rate-limited; 30/min
  // is generous for human edits.
  const nicknameLimiter = createRateLimiter({
    name: "accounts-nickname",
    limit: 30,
  });
  // Monogram set/clear (issue #3621). Mutating → rate-limited; same shape as the
  // nickname limiter (30/min is generous for human edits).
  const monogramLimiter = createRateLimiter({
    name: "accounts-monogram",
    limit: 30,
  });
  // Codex (OpenAI) in-app login START (issue #3807). Mutating + secret-handling
  // + spawns codex, so tightly rate-limited like the Anthropic login; 10/min is
  // generous for a human starting a flow.
  const openAiLoginLimiter = createRateLimiter({
    name: "accounts-openai-login",
    limit: 10,
  });
  // Device-auth STATUS/CANCEL are cheap in-memory operations that the wizard
  // POLLS every few seconds for up to 15 minutes (~20 req/min per active flow),
  // so they need a much higher ceiling than start — a tight bucket would 429 the
  // poll and, worse, the user's Cancel (leaving a staging dir + a polling child
  // behind, the V5 violation this split fixes). 120/min covers several
  // concurrent flows with headroom for a Cancel to always land.
  const openAiPollLimiter = createRateLimiter({
    name: "accounts-openai-login-poll",
    limit: 120,
  });

  // Local-vs-remote dispatch for the openai-login routes — mirrors
  // createNodesRoutes exactly. A non-federated instance (getLocalNodeId → null)
  // treats every nodeId as local; the LOCAL_NODE_ID sentinel ("local") is ALWAYS
  // served locally even on a federated hub (round-15 fix — a bare remote check
  // proxied "local" to a peer named "local" → 502). [ER 2026-09-19: 3807-4]
  const isRemoteOpenAiNode = (nodeId: string): boolean => {
    const localNodeId = opts.getLocalNodeId?.() ?? null;
    return localNodeId !== null && nodeId !== localNodeId;
  };
  const isLocalOpenAiRequest = (nodeId: string): boolean =>
    nodeId === LOCAL_NODE_ID || !isRemoteOpenAiNode(nodeId);

  app.get(
    "/accounts",
    cataloged(
      defineCapability({
        id: "accounts.list",
        domain: "accounts",
        surface: "rest",
        description:
          "List this node's stored Anthropic accounts, redacted (never access/refresh tokens), each with its nickname and whether an env credential is present.",
        whenToUse:
          "When the user opens the account switcher or needs the node's account roster.",
        invocation: { kind: "rest", method: "GET", path: "/api/accounts" },
        auth: "jwt",
        // #3837 R12 (never-readonly class): the account roster is identity
        // material — even redacted (no tokens), a generic auto-invoke would
        // enumerate the node's configured Anthropic accounts (KD-1). [ER 2026-09-19: D17]
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const service = opts.getAccountService();
      if (!service) {
        return c.json({ error: "Account service unavailable" }, 503);
      }
      try {
        // #3808: import #3807's provider artifacts into store records (once per
        // process, idempotent, best-effort) so OpenAI/Google accounts surface in
        // the roster alongside Anthropic.
        await triggerProviderImport(service);
        // #2095 (cloud onboarding): a cloud VM's Claude credential is delivered as a
        // process-level env var (wizard env-file → systemd drop-in), NOT an account-store
        // record — so the store can be empty while spawning works via the env-token
        // fallback. Surface that so the create form can display the real default
        // ("Instance credential") instead of a confusing empty field.
        const envCredentialPresent = Boolean(
          process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY
        );
        // Epic #3285 correction pass 1: surface the operator-set nickname (the
        // NicknameStore from epic #1855, already read by /accounts/usage) on each
        // redacted account, so the Account Chip can render "Work" / "Mose" instead
        // of an email local part. Absent nickname → the key is omitted (older
        // clients see the exact pre-correction shape).
        // Issue #3621: also surface the operator-set monogram override (letter +
        // color) from the sidecar MonogramStore, merged in the same read-time way
        // as the nickname — absent override → the key is omitted (older clients
        // and un-overridden accounts see the exact pre-change shape).
        const nicknames = opts.getNicknameStore?.();
        const monograms = opts.getMonogramStore?.();
        const accounts = service.list().map(account => {
          const nickname = nicknames?.get(account.accountUuid);
          const monogram = monograms?.get(account.accountUuid);
          // Spread both overrides at read time. The object literal is in the
          // callback's return position (inferred type), so there is no
          // excess-property check against RedactedAccount — an absent override
          // simply omits its key, preserving the pre-change shape.
          return {
            ...account,
            ...(nickname ? { nickname } : {}),
            ...(monogram ? { monogram } : {}),
          };
        });
        // #4736: surface a missing (or still-pending) onboarding registration so the
        // Accounts page can say so instead of rendering an unexplained empty list.
        const onboardingRegistration = resolveOnboardingRegistration({
          envToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
          identityRaw: process.env.HAPI_ONBOARDING_ACCOUNT_IDENTITY,
          anthropicAccountUuids: accounts
            .filter(a => (a.provider ?? "anthropic") === "anthropic")
            .map(a => a.accountUuid),
          readSeedState:
            opts.readOnboardingSeedState ?? readOnboardingSeedState,
        });
        return c.json({
          accounts,
          envCredentialPresent,
          onboardingRegistration,
        });
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "accounts",
          fallbackMessage: "Failed to list accounts",
        });
      }
    }
  );

  // Per-account usage for this node (epic #1855, Sub B / #1857). Registered
  // BEFORE the "/accounts/:uuid" param route so the static "usage" path wins
  // (otherwise ":uuid" would capture "usage"). Each row is
  // AccountUsageSchema.parse'd — a whitelist (plain z.object, NO .passthrough())
  // that structurally strips any token field, the redaction guarantee (R1).
  app.get(
    "/accounts/usage",
    cataloged(
      defineCapability({
        id: "accounts.usage",
        domain: "accounts",
        surface: "rest",
        description:
          "Return the per-account usage snapshot (utilization per rate-limit window) for this node, redacted; served from the sampler's cache.",
        whenToUse: "When the UI shows per-account usage or quota cards.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/accounts/usage",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
        telemetry: "off",
      })
    ),
    async c => {
      const usage = opts.getUsageService?.();
      if (!usage) {
        return c.json({ error: "Usage service unavailable" }, 503);
      }
      try {
        // Push-to-cache read (#1909/#1962): serve the sampler's latest snapshot;
        // refresh only when never populated OR stale (Fallback Preservation Rule —
        // staleness guard self-heals a frozen cache; see usageService.getCachedOrRefresh).
        const rows = await usage.getCachedOrRefresh();
        // Issue #3809 (D5 = C): the SIBLING providerUsage[] (OpenAI snapshots +
        // Google counter), each re-parsed through the whitelist
        // ProviderAccountUsageSchema on egress exactly like usage[]. usage[] stays
        // byte-identical to the pre-#3809 contract; an absent provider service
        // yields an empty array (backward-safe for a non-provider node / test).
        const providerRows =
          opts.getProviderUsageService?.()?.getCached() ?? [];
        return c.json({
          usage: rows.map(r => AccountUsageSchema.parse(r)),
          providerUsage: providerRows.map(r =>
            ProviderAccountUsageSchema.parse(r)
          ),
        });
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "accounts",
          fallbackMessage: "Failed to fetch account usage",
        });
      }
    }
  );

  // Per-account usage HISTORY for this node (epic #1855, Sub I / #1864).
  // Registered BEFORE "/accounts/:uuid" so the static "usage/history" path wins.
  // Returns per-window snapshot series + a projected-exhaustion estimate, each
  // AccountUsageHistorySchema.parse'd (plain z.object — strips any token field).
  app.get(
    "/accounts/usage/history",
    cataloged(
      defineCapability({
        id: "accounts.usage-history",
        domain: "accounts",
        surface: "rest",
        description:
          "Return one account's usage-history series plus a projected-exhaustion estimate for the given uuid.",
        whenToUse: "When the user views an account's usage trend over time.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/accounts/usage/history",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const historyStore = opts.getUsageHistoryStore?.();
      if (!historyStore) {
        return c.json({ error: "Usage history unavailable" }, 503);
      }
      const uuid = c.req.query("uuid");
      if (!uuid) {
        return c.json(
          { error: "Missing required 'uuid' query parameter" },
          400
        );
      }
      try {
        // Source the current resets_at per window from the live usage snapshot
        // (best-effort — projection still works from stored points when absent).
        let currentUtilization = null;
        const usageService = opts.getUsageService?.();
        if (usageService) {
          // Read the cached snapshot (#1909/#1962) — refresh only when null or stale.
          const rows = await usageService.getCachedOrRefresh();
          currentUtilization =
            rows.find(r => r.accountUuid === uuid)?.utilization ?? null;
        }
        const history = buildHistoryResponse(
          historyStore,
          uuid,
          currentUtilization,
          Date.now()
        );
        return c.json({ history: AccountUsageHistorySchema.parse(history) });
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "accounts",
          fallbackMessage: "Failed to fetch account usage history",
        });
      }
    }
  );

  // Provider auth-state for this node — Codex (OpenAI) logins + Gemini (Google)
  // auth type / key binding, DERIVED fields only (issue #3806, epic #3345).
  // Registered BEFORE "/accounts/:uuid" so the static path wins (otherwise
  // ":uuid" captures "provider-auth-state" → "Account not found"), exactly as
  // "/accounts/usage" is. The envelope is ProviderAuthStateEnvelopeSchema.parse'd
  // (plain z.object, NO .passthrough()) so any token/key field is structurally
  // STRIPPED — the redaction guarantee (R6). This is the LOCAL, single-node view;
  // the web consumes the federation aggregator (federation/accounts.ts).
  // [ER 2026-09-19: 3806-4]
  app.get(
    "/accounts/provider-auth-state",
    cataloged(
      defineCapability({
        id: "accounts.provider-auth-state",
        domain: "accounts",
        surface: "rest",
        description:
          "Return this node's non-Anthropic provider auth state — Codex (OpenAI) logins and Gemini (Google) auth type / key binding — as DERIVED fields only (never a token or key value).",
        whenToUse:
          "When the Accounts page shows the OpenAI / Google Gemini provider sections for this node.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/accounts/provider-auth-state",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
        telemetry: "off",
      })
    ),
    async c => {
      const reader = opts.getProviderAuthState;
      if (!reader) {
        return c.json({ error: "Provider auth-state unavailable" }, 503);
      }
      try {
        const facts = await reader();
        // Single-node envelope: the client addresses THIS node as LOCAL_NODE_ID.
        // parse-on-egress strips any token/key field (structural guarantee, R6).
        return c.json(
          ProviderAuthStateEnvelopeSchema.parse({
            nodes: [
              {
                nodeId: LOCAL_NODE_ID,
                status: "ok",
                openai: facts.openai,
                google: facts.google,
              },
            ],
          })
        );
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "accounts",
          fallbackMessage: "Failed to read provider auth state",
        });
      }
    }
  );

  // ── Codex (OpenAI) in-app login (issue #3807, epic #3345, K9 chain) ────────
  // start / status / cancel for the "Add OpenAI account" wizard. Registered
  // BEFORE "/accounts/:uuid" so these static paths win (":uuid" would otherwise
  // capture "openai"). Each dispatches on `nodeId`: served locally by the codex
  // driver, or proxied to the owning peer node (R4 — the per-account codex dir
  // lives on that node). NO key/token ever appears in a response; the API key
  // travels the request body (secure card → this route → the target node's
  // driver stdin), never the model/transcript. [ER 2026-09-19: 3807-2] [ER 2026-09-19: 3807-4]
  const openAiStartSchema = z.object({
    nodeId: z.string().min(1),
    kind: z.enum(["api-key", "device-auth"]),
    label: z.string().max(64).optional(),
    key: z.string().optional(),
  });
  const openAiTokenSchema = z.object({
    nodeId: z.string().min(1),
    loginToken: z.string().min(1),
  });

  app.post(
    "/accounts/openai/login/start",
    cataloged(
      defineCapability({
        id: "accounts.openai-login-start",
        domain: "accounts",
        surface: "rest",
        description:
          "Begin an in-app Codex (OpenAI) login on a node — API-key (key on stdin) or ChatGPT device-auth (returns a verification link + one-time code); no key is ever echoed back.",
        whenToUse:
          "When the user adds an OpenAI account via the in-app wizard (API key or ChatGPT subscription).",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/accounts/openai/login/start",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
        probe: "skip",
      })
    ),
    openAiLoginLimiter,
    async c => {
      const body = await c.req.json().catch(() => null);
      const parsed = openAiStartSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Invalid body", code: "invalid_request" }, 400);
      }
      const { nodeId, kind, label, key } = parsed.data;
      if (kind === "api-key" && (!key || !key.trim())) {
        return c.json(
          {
            error: "key is required for an api-key login",
            code: "invalid_request",
          },
          400
        );
      }
      try {
        if (isLocalOpenAiRequest(nodeId)) {
          const svc = opts.getCodexLoginService?.();
          if (!svc) {
            return c.json({ error: "Codex login service unavailable" }, 503);
          }
          const result =
            kind === "api-key"
              ? await svc.loginWithApiKey({ key: key!.trim(), label })
              : await svc.startDeviceAuth({ label });
          // #3808: an api-key login writes the account's codex dir + sidecar
          // synchronously — force-import so the new OpenAI account surfaces at once
          // (a device-auth login completes later; its status route force-imports on
          // "ok"). Best-effort — never blocks the login response.
          const acctSvc = opts.getAccountService();
          if (
            acctSvc &&
            result &&
            typeof result === "object" &&
            "state" in result &&
            (result as { state?: string }).state === "ok"
          ) {
            await triggerProviderImport(acctSvc, { force: true });
          }
          return c.json(result);
        }
        const registry = opts.getNodeRegistry?.();
        if (!registry) {
          return c.json(
            { error: "Federation not enabled", code: "federation_not_enabled" },
            503
          );
        }
        const result = await registry.startOpenAiLoginOnNode(nodeId, {
          kind,
          ...(label ? { label } : {}),
          ...(key ? { key: key.trim() } : {}),
        });
        if (result && typeof result === "object" && "type" in result) {
          return c.json(
            { error: result.message, code: "federation_proxy_error" },
            502
          );
        }
        return c.json(result);
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "accounts",
          fallbackMessage: "Failed to start OpenAI login",
        });
      }
    }
  );

  app.post(
    "/accounts/openai/login/status",
    cataloged(
      defineCapability({
        id: "accounts.openai-login-status",
        domain: "accounts",
        surface: "rest",
        description:
          "Poll an in-progress Codex device-auth login by its login token; returns the state (and the link + one-time code while pending), never a key.",
        whenToUse:
          "While the OpenAI device-auth wizard waits for the user to complete the browser login.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/accounts/openai/login/status",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
        probe: "skip",
      })
    ),
    openAiPollLimiter,
    async c => {
      const body = await c.req.json().catch(() => null);
      const parsed = openAiTokenSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Invalid body", code: "invalid_request" }, 400);
      }
      const { nodeId, loginToken } = parsed.data;
      try {
        if (isLocalOpenAiRequest(nodeId)) {
          const svc = opts.getCodexLoginService?.();
          if (!svc) {
            return c.json({ error: "Codex login service unavailable" }, 503);
          }
          const status = svc.deviceAuthStatus(loginToken);
          // #3808: on a completed device-auth login ("ok"), force-import so the new
          // OpenAI account surfaces immediately in the roster (best-effort).
          const acctSvc = opts.getAccountService();
          if (acctSvc && status.state === "ok") {
            await triggerProviderImport(acctSvc, { force: true });
          }
          return c.json(status);
        }
        const registry = opts.getNodeRegistry?.();
        if (!registry) {
          return c.json(
            { error: "Federation not enabled", code: "federation_not_enabled" },
            503
          );
        }
        const result = await registry.openAiLoginStatusOnNode(
          nodeId,
          loginToken
        );
        if (result && typeof result === "object" && "type" in result) {
          return c.json(
            { error: result.message, code: "federation_proxy_error" },
            502
          );
        }
        return c.json(result);
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "accounts",
          fallbackMessage: "Failed to read OpenAI login status",
        });
      }
    }
  );

  app.post(
    "/accounts/openai/login/cancel",
    cataloged(
      defineCapability({
        id: "accounts.openai-login-cancel",
        domain: "accounts",
        surface: "rest",
        description:
          "Cancel an in-progress Codex device-auth login by its login token; kills the login child and removes its staging dir, leaving any prior auth untouched.",
        whenToUse:
          "When the user cancels the OpenAI device-auth wizard before completing the browser login.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/accounts/openai/login/cancel",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
        probe: "skip",
      })
    ),
    openAiPollLimiter,
    async c => {
      const body = await c.req.json().catch(() => null);
      const parsed = openAiTokenSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Invalid body", code: "invalid_request" }, 400);
      }
      const { nodeId, loginToken } = parsed.data;
      try {
        if (isLocalOpenAiRequest(nodeId)) {
          const svc = opts.getCodexLoginService?.();
          if (!svc) {
            return c.json({ error: "Codex login service unavailable" }, 503);
          }
          return c.json(svc.cancelDeviceAuth(loginToken));
        }
        const registry = opts.getNodeRegistry?.();
        if (!registry) {
          return c.json(
            { error: "Federation not enabled", code: "federation_not_enabled" },
            503
          );
        }
        const result = await registry.cancelOpenAiLoginOnNode(
          nodeId,
          loginToken
        );
        if (result && typeof result === "object" && "type" in result) {
          return c.json(
            { error: result.message, code: "federation_proxy_error" },
            502
          );
        }
        return c.json(result);
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "accounts",
          fallbackMessage: "Failed to cancel OpenAI login",
        });
      }
    }
  );

  app.get(
    "/accounts/:uuid",
    cataloged(
      defineCapability({
        id: "accounts.get",
        domain: "accounts",
        surface: "rest",
        description:
          "Fetch a single redacted account by UUID; 404 when unknown.",
        whenToUse: "When the user opens one account's detail.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/accounts/:uuid",
        },
        auth: "jwt",
        // #3837 R12 (never-readonly class): a single redacted account is still
        // identity material; kept out of the generic invoker alongside the
        // roster read above (KD-1). [ER 2026-09-19: D17]
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    c => {
      const service = opts.getAccountService();
      if (!service) {
        return c.json({ error: "Account service unavailable" }, 503);
      }
      try {
        const account = service.get(c.req.param("uuid"));
        if (!account) {
          return c.json({ error: "Account not found" }, 404);
        }
        return c.json(account);
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "accounts",
          fallbackMessage: "Failed to read account",
        });
      }
    }
  );

  app.delete(
    "/accounts/:uuid",
    cataloged(
      defineCapability({
        id: "accounts.delete",
        domain: "accounts",
        surface: "rest",
        description:
          "Remove a stored account by UUID; refuses with 409 when it is the only account remaining.",
        whenToUse: "When the user deletes an account from the node.",
        invocation: {
          kind: "rest",
          method: "DELETE",
          path: "/api/accounts/:uuid",
        },
        auth: "jwt",
        riskTier: "destructive",
        availability: { scope: "user" },
      })
    ),
    deleteLimiter,
    c => {
      const service = opts.getAccountService();
      if (!service) {
        return c.json({ error: "Account service unavailable" }, 503);
      }
      try {
        // #3808: DELETE removes the store RECORD (+ index entry) and is provider-
        // agnostic (uuid-keyed). For a provider account the record is only a
        // REFERENCE — the codex login dir under `account-configs/<pk>/codex/` (or
        // the vault Gemini key) is the OPERATOR's and is deliberately NOT removed
        // here. To fully revoke a codex login, the operator removes that dir; to
        // revoke a Gemini key, the operator deletes the vault entry on the API Keys
        // page. The per-provider `last_account` guard lives in AccountService.delete
        // (#3808 Task 1b): removing the only account OF A PROVIDER trips the guard.
        const result = service.delete(c.req.param("uuid"));
        if (result.ok) {
          // TODO(#1456/J): cascade-cleanup sessions bound to this accountUuid once
          // the session<->account binding lands (Sub-Issue J). Out of scope for E;
          // does not block DELETE.
          return c.json({ ok: true });
        }
        if (result.code === "last_account") {
          return c.json(
            {
              ok: false,
              error: "Cannot delete the only stored account",
              code: "last_account",
            },
            409
          );
        }
        return c.json(
          { ok: false, error: "Account not found", code: "not_found" },
          404
        );
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "accounts",
          fallbackMessage: "Failed to delete account",
        });
      }
    }
  );

  // Set (or clear, with a blank value) an account's user-facing nickname (epic
  // #1855 follow-up). Persisted in the dedicated NicknameStore — NOT the
  // token-bearing account record — then the UsageService TTL cache is cleared so
  // the next /accounts/usage reflects it immediately. Mutating → rate-limited.
  app.patch(
    "/accounts/:uuid/nickname",
    cataloged(
      defineCapability({
        id: "accounts.set-nickname",
        domain: "accounts",
        surface: "rest",
        description:
          "Set or clear (blank value) an account's user-facing nickname, stored outside the token-bearing account record.",
        whenToUse: "When the user renames an account in the switcher.",
        invocation: {
          kind: "rest",
          method: "PATCH",
          path: "/api/accounts/:uuid/nickname",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    nicknameLimiter,
    async c => {
      const store = opts.getNicknameStore?.();
      if (!store) {
        return c.json({ error: "Nickname store unavailable" }, 503);
      }
      const uuid = c.req.param("uuid");
      const accountService = opts.getAccountService();
      if (accountService && !accountService.get(uuid)) {
        return c.json({ error: "Account not found" }, 404);
      }
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
      }
      const nickname = (body as { nickname?: unknown } | null)?.nickname;
      if (typeof nickname !== "string" || nickname.length > 64) {
        return c.json(
          { error: "nickname must be a string of at most 64 characters" },
          400
        );
      }
      try {
        store.set(uuid, nickname);
        // Bust the usage TTL cache so the new nickname appears on the next fetch.
        opts.getUsageService?.()?.clearCache();
        return c.json({ ok: true, nickname: store.get(uuid) ?? null });
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "accounts",
          fallbackMessage: "Failed to set account nickname",
        });
      }
    }
  );

  // Set (or clear, with an empty override) an account's monogram override — the
  // chip's displayed letter + color (issue #3621). Persisted in the dedicated
  // MonogramStore — NOT the token-bearing account record — mirroring the nickname
  // route above. The body is `{ letter?, color? }`; a present letter pins it,
  // `{}` clears. Mutating → rate-limited.
  app.patch(
    "/accounts/:uuid/monogram",
    cataloged(
      defineCapability({
        id: "accounts.set-monogram",
        domain: "accounts",
        surface: "rest",
        description:
          "Set or clear (empty override) an account's chip monogram letter and/or color, stored outside the token-bearing account record.",
        whenToUse:
          "When the user edits an account's monogram letter or color in the account editor.",
        invocation: {
          kind: "rest",
          method: "PATCH",
          path: "/api/accounts/:uuid/monogram",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    monogramLimiter,
    async c => {
      const store = opts.getMonogramStore?.();
      if (!store) {
        return c.json({ error: "Monogram store unavailable" }, 503);
      }
      const uuid = c.req.param("uuid");
      const accountService = opts.getAccountService();
      if (accountService && !accountService.get(uuid)) {
        return c.json({ error: "Account not found" }, 404);
      }
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
      }
      // Shared contract validation (letter = one code unit → upper-cased;
      // color ∈ ACCOUNT_MONO_COLOR_IDS). Rejects anything else with 400. An
      // empty/all-absent body normalizes to {} → clears the override.
      const parsed = normalizeAccountMonogram(body);
      if (!parsed.ok) {
        return c.json({ error: parsed.error }, 400);
      }
      try {
        store.set(uuid, parsed.value);
        // Bust the usage TTL cache like the nickname route, for consistency with
        // any surface reading through the usage aggregate.
        opts.getUsageService?.()?.clearCache();
        return c.json({ ok: true, monogram: store.get(uuid) ?? null });
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "accounts",
          fallbackMessage: "Failed to set account monogram",
        });
      }
    }
  );

  // ── Web-initiated OAuth login (issue #1263) ───────────────────────────────
  // Two-step PKCE: `start` returns the Anthropic authorize URL + an opaque
  // loginToken; the user authenticates in a browser and pastes the code back;
  // `complete` exchanges it and persists a new account via AccountService.add().
  // Both are JWT-gated (the /api/* auth middleware in server.ts runs before
  // these are mounted) and rate-limited. Token values never appear in a
  // response — `complete` returns only the redacted account.

  app.post(
    "/accounts/login/start",
    cataloged(
      defineCapability({
        id: "accounts.login-start",
        domain: "accounts",
        surface: "rest",
        description:
          "Begin web-initiated Anthropic OAuth (PKCE): returns the authorize URL plus an opaque login token to complete the flow.",
        whenToUse: "When the user starts adding an account via browser login.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/accounts/login/start",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
        probe: "skip",
      })
    ),
    loginLimiter,
    c => {
      const login = opts.getLoginService?.();
      if (!login) {
        return c.json({ error: "Account login service unavailable" }, 503);
      }
      try {
        return c.json(login.start());
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "accounts",
          fallbackMessage: "Failed to start account login",
        });
      }
    }
  );

  app.post(
    "/accounts/login/complete",
    cataloged(
      defineCapability({
        id: "accounts.login-complete",
        domain: "accounts",
        surface: "rest",
        description:
          "Complete web OAuth by exchanging the login token and code, persisting the new account; returns only the redacted account.",
        whenToUse: "When the user finishes browser login and submits the code.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/accounts/login/complete",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
        probe: "skip",
      })
    ),
    loginLimiter,
    async c => {
      const login = opts.getLoginService?.();
      if (!login) {
        return c.json({ error: "Account login service unavailable" }, 503);
      }
      let body: { loginToken?: string; code?: string; state?: string };
      try {
        body = await c.req.json();
      } catch {
        return c.json(
          { ok: false, error: "Invalid JSON body", code: "invalid_request" },
          400
        );
      }
      if (!body?.loginToken || !body?.code) {
        return c.json(
          {
            ok: false,
            error: "loginToken and code are required",
            code: "invalid_request",
          },
          400
        );
      }
      try {
        const result = await login.complete({
          loginToken: body.loginToken,
          code: body.code,
          state: body.state,
        });
        if (result.ok) {
          // #3452 iteration 2: the usage snapshot is push-to-cache (#1909) and
          // does not know the new account until the sampler's next cycle. Refresh
          // it now (fire-and-forget; refresh() coalesces concurrent callers) so
          // the next poll from ANY client already carries the new card. The web
          // wizard additionally force-refreshes on its own side.
          void opts
            .getUsageService?.()
            ?.refresh()
            .catch(() => undefined);
          return c.json({ ok: true, account: result.account });
        }
        // 400 for client-side fixable causes; 502 for upstream OAuth failures.
        const status =
          result.code === "expired_state" ||
          result.code === "csrf" ||
          result.code === "invalid_request" ||
          result.code === "invalid_code"
            ? 400
            : 502;
        return c.json(
          { ok: false, error: result.error, code: result.code },
          status
        );
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "accounts",
          fallbackMessage: "Failed to complete account login",
        });
      }
    }
  );

  return app;
}
