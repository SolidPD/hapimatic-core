// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

/**
 * Provider auth-state envelope (issue #3806, epic #3345 — non-Anthropic parity).
 *
 * The federation-aware, DERIVED-fields-only view of each node's non-Anthropic
 * provider auth state — Codex (OpenAI) logins and the Gemini (Google) auth type +
 * key binding. This is the ROOT of the #3345 serial chain (#3806 → #3807 → #3808
 * → #3809); the reader that produces it (`server/src/services/providerAuthState.ts`)
 * is the SINGLE per-node source the downstream issues consume.
 *
 * DERIVED-FIELDS-ONLY IS A STRUCTURAL GUARANTEE, NOT A CONVENTION. Every schema in
 * this file is a plain `z.object()` (NO `.passthrough()`, unlike the fork's
 * upstream-origin default) — the same whitelist-by-construction discipline as
 * `AccountUsageSchema` (`shared/src/usage.ts`). No token/key VALUE field exists on
 * ANY of these schemas, and every route `.parse()`s the envelope on egress, so a
 * raw `auth.json` token or `GEMINI_API_KEY` value cannot reach a client even by a
 * reader bug — it is STRIPPED on parse. `email` / `plan` / `expiresAt` are id-token
 * CLAIMS the reader decodes; `accountId` is codex's stable account id (an
 * identifier, not a secret). [ER 2026-09-19: 3806-6]
 */

/**
 * The cluster's ONE provider id literal (K1). Pinned here so #3807
 * (`StoredAccount.provider`), #3809 (`AccountUsage.providerUsage[].provider`) and
 * this issue's `AddAccountInstructions` `provider` prop (Task 6) all reference a
 * single definition. The vault enum `API_KEY_PROVIDERS` (`schemas.ts`) keeps BOTH
 * `gemini` and `google`; the reader maps vault `gemini` → `google`. #3351's
 * `authBinding.providerId` is a `coordinates_with` ask to freeze to these three.
 * [ER 2026-09-19: K1]
 */
export const ProviderIdSchema = z.enum(["anthropic", "openai", "google"]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

/**
 * One OpenAI/Codex login on a node. `source` distinguishes the host `~/.codex`
 * login (`"host"`, the pre-#3808 single login) from a per-account
 * `~/.config/hapimatic/account-configs/<pk>/codex/` dir (`"account"`,
 * K-CODEX-HOME). `mode` is codex's `auth_mode` (`chatgpt` → subscription,
 * `apikey` → api-key; a MISSING `auth.json` → `unknown`, because codex 0.147.0
 * supports keyring credential storage). `email` / `plan` / `expiresAt` are claims
 * decoded from the login's id-token; `accountId` is codex's stable account id (an
 * identifier, NOT a secret). No token/key value field exists. [ER 2026-09-19: 3806-7]
 * `accountUuid` names the store record: the `<pk>` dir for an `"account"` row; for
 * the host row, the importer's PK for its `accountId` (#3982), or null when the
 * login carries no account id.
 */
export const OpenAiAuthStateSchema = z.object({
  accountUuid: z.string().nullable(),
  source: z.enum(["host", "account"]),
  mode: z.enum(["chatgpt", "api-key", "none", "unknown"]),
  label: z.string().optional(),
  email: z.string().optional(),
  plan: z.string().optional(),
  expiresAt: z.string().optional(),
  accountId: z.string().optional(),
});
export type OpenAiAuthState = z.infer<typeof OpenAiAuthStateSchema>;

/**
 * Gemini (Google) auth state for a node. `selectedAuthType` is read from
 * `~/.gemini/settings.json` (`security.auth.selectedType ?? selectedAuthType` —
 * gemini-cli 0.57.0 is post-v2-migration) and mapped to the display literal.
 * `bound` + `keySource` report whether a `GEMINI_API_KEY` is bound and its
 * SOURCE — `vault` = a `readSettings().apiKeys` entry (provider `gemini`
 * preferred, else `google`), `daemon-env` = the daemon's machine record carries
 * `GEMINI_API_KEY` in its presence-only `providerEnv` stamp (D11 = C — the server
 * process itself NEVER sees the var), `none` = neither. NEVER a token/key value.
 * [ER 2026-09-19: D11] [ER 2026-09-19: 3806-8]
 */
export const GoogleAuthStateSchema = z.object({
  selectedAuthType: z.enum([
    "api-key",
    "google-login",
    "vertex",
    "none",
    "unknown",
  ]),
  bound: z.boolean(),
  keySource: z.enum(["vault", "daemon-env", "none"]),
});
export type GoogleAuthState = z.infer<typeof GoogleAuthStateSchema>;

/**
 * One node's provider auth state. `status:"unreachable"` is the degraded row for a
 * peer that could not be reached (`openai: []`, `google` omitted) — never silently
 * dropped, mirroring the usage aggregator's degraded-peer discipline (#1881).
 * [ER 2026-09-19: 3806-12]
 *
 * `status:"error"`: the SERVING node's own reader failed (#5739, the account-health
 * `error` rule from #5420). The node answered, so it is not unreachable
 * (`openai: []`, `google` omitted). A shipped receiver only ever sends `ok`: its
 * reader throw answers 500, which the hub reports as `unreachable` / `http_5xx`.
 */
export const NodeProviderAuthStateSchema = z.object({
  nodeId: z.string(),
  status: z.enum(["ok", "unreachable", "error"]),
  openai: z.array(OpenAiAuthStateSchema),
  google: GoogleAuthStateSchema.optional(),
});
export type NodeProviderAuthState = z.infer<typeof NodeProviderAuthStateSchema>;

/**
 * The federation-aggregated envelope: one row per node. Returned by
 * `GET /api/accounts/provider-auth-state` (local, single-node) and
 * `GET /api/federation/provider-auth-state` (hub aggregator). Every route
 * `.parse()`s this on egress — the parse-on-egress that makes the
 * derived-fields-only guarantee structural. [ER 2026-09-19: 3806-6]
 */
export const ProviderAuthStateEnvelopeSchema = z.object({
  nodes: z.array(NodeProviderAuthStateSchema),
});
export type ProviderAuthStateEnvelope = z.infer<
  typeof ProviderAuthStateEnvelopeSchema
>;
