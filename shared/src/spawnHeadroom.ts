// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

/**
 * Spawn account-headroom contract (issue #5879, contract C-5879 shared with
 * rp1-home#2824). A spawn or account rebind that names an account at its usage
 * cap is refused with HTTP 409 `code: "account_exhausted"` and an
 * {@link AccountExhaustion} detail. `forceAccount: true` overrides the refusal.
 *
 * These are plain `z.object()` schemas (a whitelist, NO `.passthrough()`): the
 * detail crosses the federation boundary in a peer's refusal, so an unknown key —
 * a token field above all — is stripped on parse, the same discipline as
 * `AccountUsageSchema` (`usage.ts`).
 */

/** The `code` of a headroom refusal. */
export const ACCOUNT_EXHAUSTED_CODE = "account_exhausted" as const;

/** The best alternative the deciding node offers in a refusal. */
export const ExhaustionAlternativeSchema = z.object({
  accountUuid: z.string(),
  email: z.string().nullable(),
  displayLabel: z.string(),
  score: z.number().nullable(),
});

export type ExhaustionAlternative = z.infer<typeof ExhaustionAlternativeSchema>;

/** The structured detail of a 409 `account_exhausted` refusal. */
export const AccountExhaustionSchema = z.object({
  accountUuid: z.string(),
  email: z.string().nullable(),
  window: z.enum(["five_hour", "seven_day", "weekly_scoped"]),
  /** The model a `weekly_scoped` lock applies to (e.g. "Fable"); null otherwise. */
  model: z.string().nullable(),
  utilization: z.number(),
  resetsAt: z.string(),
  /** Epoch ms the usage row was fetched — how old the data behind the refusal is. */
  fetchedAt: z.number(),
  alternative: ExhaustionAlternativeSchema.nullable(),
  nodeId: z.string(),
  nodeLabel: z.string(),
});

export type AccountExhaustion = z.infer<typeof AccountExhaustionSchema>;

/** A non-fatal note a spawn or rebind response carries. */
export const SpawnWarningSchema = z.object({
  code: z.enum([
    "usage_unavailable",
    "forced_exhausted_account",
    // Issue #6171: a project default names a server that is off for the project.
    "mcp_default_server_disabled",
  ]),
  message: z.string(),
});

export type SpawnWarning = z.infer<typeof SpawnWarningSchema>;

/**
 * The account a spawn response names. `source`: `requested` (the caller pinned
 * it), `forced` (pinned with `forceAccount` over a lock), `node` (no pin — the
 * daemon bound it; read from the session record).
 */
export const SpawnAccountSchema = z.object({
  accountUuid: z.string().nullable(),
  email: z.string().nullable(),
  source: z.enum(["requested", "forced", "node"]),
});

export type SpawnAccount = z.infer<typeof SpawnAccountSchema>;
