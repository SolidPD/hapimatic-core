// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { AccountMonogramSchema, type AccountMonogram } from "./accountMonogram";
import { ProviderIdSchema, type ProviderId } from "./providerAuthState";
import { AccountUsageStatusSchema, type AccountUsageStatus } from "./usage";

/**
 * Per-node account health (issue #4461, epic #4460 sub-issue A).
 *
 * The federation-aware read that reports, for every node, the state of every
 * account record THAT node holds — so a record that is dead on one node is visible
 * even when the same account is healthy on another. (The combined usage view keeps
 * the healthiest row per account, `server/src/web/routes/federation/usage.ts`, which
 * is how one node's healthy row for an account hid another node's dead record
 * of the same account.)
 *
 * WHITELIST BY CONSTRUCTION: every schema here is a plain `z.object()` (no
 * `.passthrough()`). No token, refresh-token, PKCE or credentials-file field exists
 * on any of them, and the receiver parses on egress while the hub parses again on
 * ingress, so a token that reached a row by a reader bug is STRIPPED on parse (R4).
 *
 * Consumers: #4462 (node-targeted login), #4464 (the "+ Add" modal), #4466 (the
 * red-ring chip) read this envelope; none recomputes `needsRelogin` or `since`.
 */

/**
 * How a record authenticates. `oauth` is the Hapimatic-refreshed OAuth record (an
 * Anthropic record with no `authKind` key reads as `oauth`); `env-token` is a raw
 * service-env token with no refresh chain (#2268); `native` is a token-less record
 * whose credential the Claude Code binary itself holds and rotates in the account's
 * isolated config dir (#4349). OpenAI and Google rows carry `null`.
 */
export const AccountAuthKindSchema = z.enum(["oauth", "env-token", "native"]);
export type AccountAuthKind = z.infer<typeof AccountAuthKindSchema>;

/** Which stored timestamp `since` was taken from (ruled D-A2 = A, 2026-10-02). */
export const AccountHealthSinceSourceSchema = z.enum([
  "lastRefreshedAt",
  "capturedAt",
]);
export type AccountHealthSinceSource = z.infer<
  typeof AccountHealthSinceSourceSchema
>;

/**
 * One account record on one node. `lastRefreshedAt` and `expiresAt` are `null`
 * when the store holds the `0` sentinel (a fresh login, an env seed and a first
 * capture all write `0`). Both are ADVISORY caches (`shared/src/accounts.ts`); the
 * node's cached `usageStatus` is carried as the live confirmation. `unrefreshable`
 * is the authoritative store flag the spawn gate reads.
 */
export const AccountHealthEntrySchema = z.object({
  provider: ProviderIdSchema,
  accountUuid: z.string(),
  emailAddress: z.string(),
  nickname: z.string().nullable(),
  monogram: AccountMonogramSchema.nullable(),
  authKind: AccountAuthKindSchema.nullable(),
  unrefreshable: z.boolean(),
  lastRefreshedAt: z.number().nullable(),
  capturedAt: z.number(),
  expiresAt: z.number().nullable(),
  /** True when this node needs a re-login for this account (R3). */
  needsRelogin: z.boolean(),
  /** Epoch ms: the last successful refresh, else the capture time (D-A2 = A). */
  since: z.number(),
  sinceSource: AccountHealthSinceSourceSchema,
  usageStatus: AccountUsageStatusSchema.nullable(),
});
export type AccountHealthEntry = z.infer<typeof AccountHealthEntrySchema>;

/**
 * Read status of one node's row. `offline`: the hub's registry already marks the
 * node offline (no fetch is attempted). `unsupported`: the peer runs a build
 * without this read (HTTP 404, or HTTP 401 `{"error":"Invalid token"}` from its JWT
 * middleware answering for a route it does not have — the #4073 K13 rule).
 * `unreachable`: any other failure fetching a peer, including a timeout; the row's
 * `reason` says which. `error`: the SERVING node's own reader failed (issue #5420) —
 * the node answered, so it is not unreachable. A peer never sends `error`: its
 * receiver answers 503 instead, which the hub reports as `unreachable`/`http_5xx`.
 */
export const NodeAccountHealthStatusSchema = z.enum([
  "ok",
  "offline",
  "unreachable",
  "unsupported",
  "error",
]);
export type NodeAccountHealthStatus = z.infer<
  typeof NodeAccountHealthStatusSchema
>;

/**
 * Why the hub reported a peer `unreachable` (issue #5420). A closed whitelist on
 * purpose: the raw failure text stays in the hub's server log and never crosses
 * the wire. `auth` is a federation-token mismatch (401/403 other than the
 * `unsupported` 401 shape); `malformed` is a 2xx whose body is not JSON or not a
 * row; `network` is any other throw before a response.
 */
export const NodeAccountHealthReasonSchema = z.enum([
  "timeout",
  "network",
  "auth",
  "http_4xx",
  "http_5xx",
  "malformed",
]);
export type NodeAccountHealthReason = z.infer<
  typeof NodeAccountHealthReasonSchema
>;

/**
 * One node's row. `nodeId` / `nodeLabel` are the HUB's canonical identity for a
 * peer, never the peer's self-report. `fetchedAt` is `null` when the row was not
 * read (`offline` / `unreachable` / `unsupported`).
 */
export const NodeAccountHealthSchema = z.object({
  nodeId: z.string(),
  nodeLabel: z.string(),
  isLocal: z.boolean(),
  status: NodeAccountHealthStatusSchema,
  fetchedAt: z.number().nullable(),
  accounts: z.array(AccountHealthEntrySchema),
  /**
   * #4462: which providers a login can be stored for on this node, from the
   * HUB's view of the node's `accounts:anthropic-login` capability (never the
   * node's self-report); the serving node's own row is always `true`.
   */
  loginSupported: z.object({ anthropic: z.boolean() }).optional(),
  /** Set on an `unreachable` peer row only (issue #5420). */
  reason: NodeAccountHealthReasonSchema.optional(),
  /**
   * How many account records failed the whitelist schema and were dropped from
   * `accounts` (issue #5420) — e.g. a newer node's provider id this build does not
   * know. Absent when none were dropped.
   */
  rejectedEntries: z.number().int().positive().optional(),
});
export type NodeAccountHealth = z.infer<typeof NodeAccountHealthSchema>;

/** A row's shape with its accounts left unparsed, for the per-entry parse below. */
const NodeAccountHealthShellSchema = NodeAccountHealthSchema.extend({
  accounts: z.array(z.unknown()),
});

/**
 * Parse a node row one account entry at a time (issue #5420). A strict parse of the
 * whole row fails on ONE entry this build cannot read — a provider, usage status or
 * auth kind added by a newer node, since all three are closed enums — and blanks a
 * reachable node. Here each entry is parsed alone with the whitelist
 * {@link AccountHealthEntrySchema} (so token material is still stripped, R4), a bad
 * entry is dropped and counted into `rejectedEntries`, and only a row whose own
 * fields do not parse is refused (`null`).
 */
export function parseNodeAccountHealthPerEntry(
  input: unknown
): NodeAccountHealth | null {
  const shell = NodeAccountHealthShellSchema.safeParse(input);
  if (!shell.success) return null;
  const accounts: AccountHealthEntry[] = [];
  let rejected = 0;
  for (const entry of shell.data.accounts) {
    const parsed = AccountHealthEntrySchema.safeParse(entry);
    if (parsed.success) accounts.push(parsed.data);
    else rejected++;
  }
  const { rejectedEntries: carried, ...rest } = shell.data;
  const total = (carried ?? 0) + rejected;
  return total > 0
    ? { ...rest, accounts, rejectedEntries: total }
    : { ...rest, accounts };
}

/**
 * `GET /api/federation/account-health`: one row per known node, the serving node
 * first (`isLocal: true`). `localNodeId` is the serving node's id.
 */
export const AccountHealthEnvelopeSchema = z.object({
  localNodeId: z.string(),
  nodes: z.array(NodeAccountHealthSchema),
});
export type AccountHealthEnvelope = z.infer<typeof AccountHealthEnvelopeSchema>;

/**
 * The bare per-node facts a node's reader returns (the route adds the node
 * identity and status, then parses the whole row with `NodeAccountHealthSchema`).
 */
export type NodeAccountHealthFacts = {
  accounts: AccountHealthEntry[];
  fetchedAt: number;
};

/**
 * The `account_unrefreshable` refusal body (R6). `nodeId` / `nodeLabel` name the
 * node whose store refused (hub-canonical for a peer-owned session); `accountUuid`
 * is the target account. `ok` is present on the switch route only — the reconnect
 * and create routes answer `{ error, code, … }`.
 */
export const AccountUnrefreshableErrorSchema = z.object({
  ok: z.literal(false).optional(),
  error: z.string(),
  code: z.literal("account_unrefreshable"),
  nodeId: z.string().min(1),
  nodeLabel: z.string().min(1),
  accountUuid: z.string().optional(),
});
export type AccountUnrefreshableError = z.infer<
  typeof AccountUnrefreshableErrorSchema
>;

/**
 * The re-login text for an `account_unrefreshable` refusal, ONE copy for every
 * surface that shows it (issue #4914). A reconnect refusal reaches the browser as
 * an HTTP 409 and as the `account-unrefreshable` notification, and the toast
 * layer deduplicates by exact text only, so the server's notification title and
 * the web's toast must be byte-identical or one refusal shows two toasts. The web
 * keeps its own copies (`web/src/lib/reconnectError.ts`,
 * `web/src/lib/reloginLink.ts`); `web/src/lib/reloginParity.test.ts` pins them to
 * these.
 *
 * {@link ACCOUNT_UNREFRESHABLE_MESSAGE} is the text when no node is named (a
 * pre-#4461 node); {@link formatReloginMessage} is the text when one is.
 */
export const ACCOUNT_UNREFRESHABLE_MESSAGE =
  "An account's login expired and the session couldn't refresh. " +
  "Re-login via the account menu in the session header.";

/** "Re-login required on <node>" / "Re-login required for <account> on <node>". */
export function formatReloginMessage({
  nodeLabel,
  accountLabel,
}: {
  nodeLabel: string;
  accountLabel?: string;
}): string {
  return accountLabel
    ? `Re-login required for ${accountLabel} on ${nodeLabel}`
    : `Re-login required on ${nodeLabel}`;
}

/** The record facts {@link deriveAccountHealth} reads — never a token. */
export type AccountHealthRecordInput = {
  provider: ProviderId;
  accountUuid: string;
  emailAddress: string;
  /** The record's `authKind` as stored; `undefined` on an Anthropic record ⇒ oauth. */
  authKind?: string | null;
  unrefreshable: boolean;
  lastRefreshedAt: number;
  capturedAt: number;
  expiresAt: number;
};

/** Node-local display context for one record. */
export type AccountHealthContext = {
  nickname?: string | null;
  monogram?: AccountMonogram | null;
  usageStatus?: AccountUsageStatus | null;
};

/** Normalize a stored `authKind` to the wire value (non-Anthropic ⇒ `null`). */
function normalizeAuthKind(
  provider: ProviderId,
  authKind: string | null | undefined
): AccountAuthKind | null {
  if (provider !== "anthropic") return null;
  if (authKind === "env-token" || authKind === "native") return authKind;
  return "oauth";
}

/**
 * Build one {@link AccountHealthEntry} from a record's facts — the single place the
 * R3 and D-A2 rules live, so no consumer recomputes them.
 *
 * - `needsRelogin` (R3): an Anthropic `oauth` record whose store flag
 *   `unrefreshable` is set. An `env-token` record never needs one (no refresh
 *   chain); neither does a `native` record (the binary owns its credential) nor an
 *   OpenAI or Google row.
 * - `since` (D-A2 = A): `lastRefreshedAt` when it is non-zero, else `capturedAt`,
 *   with `sinceSource` naming which — never a 1970 date.
 */
export function deriveAccountHealth(
  record: AccountHealthRecordInput,
  ctx: AccountHealthContext = {}
): AccountHealthEntry {
  const authKind = normalizeAuthKind(record.provider, record.authKind);
  const refreshed = record.lastRefreshedAt > 0;
  return {
    provider: record.provider,
    accountUuid: record.accountUuid,
    emailAddress: record.emailAddress,
    nickname: ctx.nickname ?? null,
    monogram: ctx.monogram ?? null,
    authKind,
    unrefreshable: record.unrefreshable,
    lastRefreshedAt: refreshed ? record.lastRefreshedAt : null,
    capturedAt: record.capturedAt,
    expiresAt: record.expiresAt > 0 ? record.expiresAt : null,
    needsRelogin:
      record.provider === "anthropic" &&
      authKind === "oauth" &&
      record.unrefreshable,
    since: refreshed ? record.lastRefreshedAt : record.capturedAt,
    sinceSource: refreshed ? "lastRefreshedAt" : "capturedAt",
    usageStatus: ctx.usageStatus ?? null,
  };
}
