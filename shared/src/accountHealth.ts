// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { AccountMonogramSchema, type AccountMonogram } from "./accountMonogram";
import {
  SignInDeathSchema,
  isNonDeathFlag,
  resolveSignInDeadline,
  type SignInDeath,
} from "./accounts";
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
  /**
   * Issue #6801 (R5): epoch ms when this node first flagged the record dead, or
   * `null` when it is not flagged or has no trusted time. A node with #6801 always
   * sends the key; an ABSENT key means an older node that does not report death
   * times (see {@link computeSignInAge}'s `flagged-unreported`). Optional so an
   * older peer's entry still parses; an older hub strips it (plain `z.object`).
   */
  unrefreshableAt: z.number().nullable().optional(),
  /** Issue #6801 (R13): past login deaths on this node, newest last. */
  signInDeaths: z.array(SignInDeathSchema).optional(),
  /**
   * Issue #6801 (R14): the record is flagged for a non-death reason (#6800's
   * `host-chain-shared` quarantine). A boolean, never an enum of reasons, because
   * a closed enum gains values on a newer node and an older hub would drop the
   * whole entry (the #5420 rule).
   */
  quarantined: z.boolean().optional(),
  // Issue #6161 (R8): the four sign-in deadline FACTS; consumers run the one rule
  // (`resolveEntryDeadline`), never the node. A node with #6161 always sends all
  // four (null where unknown, and null for any record that is not Anthropic
  // `oauth`); an ABSENT key means an older node (`unreported`). Optional so an
  // older peer's entry still parses; an older hub strips them. Epoch ms, finite
  // numbers only.
  /** This instance's store `refreshTokenExpiresAt` (a sign-in on a build with #6161). */
  signInDeadlineAt: z.number().nullable().optional(),
  /** Its source: `server` or `default`. A plain string, never an enum (#5420). */
  signInDeadlineSource: z.string().nullable().optional(),
  /** The account folder file's `claudeAiOauth.refreshTokenExpiresAt`, read live. */
  folderDeadlineAt: z.number().nullable().optional(),
  /** The `writtenAt` of the folder's sign-in marker, read live (DEC-1). */
  folderSignInAt: z.number().nullable().optional(),
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
  /**
   * Issue #6801: the record's TRUSTED death time (`trustedUnrefreshableAt`), or
   * `null` / absent when it has none. The caller never passes the raw stamp.
   */
  unrefreshableAt?: number | null;
  /** Issue #6801 (R14): the stored reason, so the entry can mark a quarantine. */
  unrefreshableReason?: string | null;
  /** Issue #6801 (R13): the record's past deaths, already validated. */
  signInDeaths?: SignInDeath[];
  /** Issue #6161 (R8): the store's sign-in deadline and its source. */
  signInDeadlineAt?: number | null;
  signInDeadlineSource?: string | null;
  /** Issue #6161 (R8): the folder file's deadline and marker time, read live. */
  folderDeadlineAt?: number | null;
  folderSignInAt?: number | null;
};

/** A fact the envelope may carry: a finite number, else null. */
function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

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
 * - `unrefreshableAt` (#6801): ALWAYS emitted — the trusted death time while the
 *   record is flagged, else `null` — so on the wire an absent key means an older
 *   node. `signInDeaths` only when non-empty; `quarantined` (R14) always.
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
    unrefreshableAt:
      record.unrefreshable &&
      typeof record.unrefreshableAt === "number" &&
      record.unrefreshableAt > 0
        ? record.unrefreshableAt
        : null,
    ...(record.signInDeaths && record.signInDeaths.length > 0
      ? { signInDeaths: record.signInDeaths }
      : {}),
    quarantined: isNonDeathFlag(record),
    // Issue #6161 (R8): always emitted, so on the wire an absent key means an
    // older node; facts only, never the resolved deadline.
    ...(record.provider === "anthropic" && authKind === "oauth"
      ? {
          signInDeadlineAt: finiteOrNull(record.signInDeadlineAt),
          signInDeadlineSource:
            typeof record.signInDeadlineSource === "string"
              ? record.signInDeadlineSource
              : null,
          folderDeadlineAt: finiteOrNull(record.folderDeadlineAt),
          folderSignInAt: finiteOrNull(record.folderSignInAt),
        }
      : {
          signInDeadlineAt: null,
          signInDeadlineSource: null,
          folderDeadlineAt: null,
          folderSignInAt: null,
        }),
  };
}

/** Issue #6801: one day for the sign-in age (whole elapsed 24-hour days). */
export const SIGN_IN_AGE_DAY_MS = 86_400_000;

/**
 * Issue #6801: the entry fields the sign-in age reads. The one input type for
 * every caller (Tasks 10-12 use it, never a narrower copy: a copy without
 * `quarantined` would show every quarantined row as "died").
 */
export type SignInAgeInput = Pick<
  AccountHealthEntry,
  | "provider"
  | "authKind"
  | "capturedAt"
  | "unrefreshable"
  | "unrefreshableAt"
  | "quarantined"
  // Issue #6161 (R7): the facts the deadline rule reads.
  | "lastRefreshedAt"
  | "expiresAt"
  | "signInDeadlineAt"
  | "signInDeadlineSource"
  | "folderDeadlineAt"
  | "folderSignInAt"
>;

/**
 * Issue #6161 (Q4): how long before a login's deadline it reads `ending` —
 * 3 days, Claude Code's own notice and the acceptance criterion.
 */
export const SIGN_IN_WARNING_LEAD_MS = 3 * 86_400_000;

/**
 * Issue #6161 (R7, R8): the entry's resolved deadline. Not Anthropic, or not
 * `oauth` (so a `native` or `env-token` entry never gets an estimate) →
 * `unknown`; a node that sent none of the four facts (an older build) →
 * `unreported`; else the one rule, `resolveSignInDeadline`, over the entry's
 * facts, with a null `lastRefreshedAt` or `expiresAt` read as 0.
 */
export function resolveEntryDeadline(
  entry: SignInAgeInput,
  nowMs: number
): { at: number | null; source: string } {
  if (entry.provider !== "anthropic" || entry.authKind !== "oauth") {
    return { at: null, source: "unknown" };
  }
  if (
    entry.signInDeadlineAt === undefined &&
    entry.signInDeadlineSource === undefined &&
    entry.folderDeadlineAt === undefined &&
    entry.folderSignInAt === undefined
  ) {
    return { at: null, source: "unreported" };
  }
  return resolveSignInDeadline({
    capturedAt: entry.capturedAt,
    lastRefreshedAt: entry.lastRefreshedAt ?? 0,
    expiresAt: entry.expiresAt ?? 0,
    signInDeadline: entry.signInDeadlineAt ?? null,
    folderDeadline: entry.folderDeadlineAt ?? null,
    folderSignInAt: entry.folderSignInAt ?? null,
    nowMs,
  });
}

/**
 * Issue #6161 (R9): true when a resolved deadline is an estimate, shown as
 * "about": the sources `estimated`, `marker-estimated` and `folder-unconfirmed`,
 * and a `sign-in` deadline that came from the 30-day default rather than the
 * server's number.
 */
export function isEstimatedDeadline(
  source: string,
  signInDeadlineSource: string | null | undefined
): boolean {
  return (
    source === "estimated" ||
    source === "marker-estimated" ||
    source === "folder-unconfirmed" ||
    (source === "sign-in" && signInDeadlineSource === "default")
  );
}

/** Issue #6161: whole days left until `deadlineAt`, rounded up, floored at 0. */
function daysUntil(deadlineAt: number, nowMs: number): number {
  return Math.max(0, Math.ceil((deadlineAt - nowMs) / SIGN_IN_AGE_DAY_MS));
}

/** Issue #6161 (R9): an entry inside its warning window. */
export type SignInEnding = {
  state: "ending" | "due";
  deadlineAt: number;
  daysLeft: number;
  estimated: boolean;
};

/**
 * Issue #6161 (R9): the ONE place the warning window lives, used by the web, the
 * CLI and the alert service. `ending` from `deadline - SIGN_IN_WARNING_LEAD_MS`,
 * `due` from the deadline itself. Null for a non-`oauth` entry, a flagged or
 * quarantined one (#6801's states own those), an entry with no resolved
 * deadline, and one outside the window.
 */
export function computeSignInEnding(
  entry: SignInAgeInput,
  nowMs: number
): SignInEnding | null {
  if (entry.unrefreshable || entry.quarantined === true) return null;
  const resolved = resolveEntryDeadline(entry, nowMs);
  if (resolved.at === null) return null;
  const deadlineAt = resolved.at;
  if (nowMs < deadlineAt - SIGN_IN_WARNING_LEAD_MS) return null;
  return {
    state: nowMs >= deadlineAt ? "due" : "ending",
    deadlineAt,
    daysLeft: daysUntil(deadlineAt, nowMs),
    estimated: isEstimatedDeadline(resolved.source, entry.signInDeadlineSource),
  };
}

/**
 * Issue #6801: a record's sign-in age on one node.
 * - `running`: alive, `days` since the sign-in.
 * - `stopped`: died `days` after its sign-in (the age at death; it does not rise).
 * - `stopped-unknown`: died, and the node has no trusted time for it.
 * - `quarantined`: #6800's non-death flag (R14), `days` since the sign-in.
 * - `flagged-unreported`: flagged on a node that sends no death time (an older
 *   build); not a death, and no age.
 */
export type SignInAge =
  | { state: "running"; days: number; signedInAt: number }
  | { state: "stopped"; days: number; signedInAt: number; diedAt: number }
  | { state: "stopped-unknown"; signedInAt: number }
  | { state: "quarantined"; days: number; signedInAt: number }
  | { state: "flagged-unreported"; signedInAt: number };

/**
 * True for the two death states, the one rule `hapi accounts sign-in-ages
 * --dead` and the web token's danger colour share. A quarantine and a
 * `flagged-unreported` entry are not deaths. Exhaustive on purpose: a new state
 * fails to compile until it is placed.
 */
export function isSignInDeath(state: SignInAge["state"]): boolean {
  switch (state) {
    case "stopped":
    case "stopped-unknown":
      return true;
    case "running":
    case "quarantined":
    case "flagged-unreported":
      return false;
  }
}

/** Whole elapsed 24-hour days from `from` to `to`, clock skew clamped to 0. */
export function wholeSignInDays(from: number, to: number): number {
  return Math.floor(Math.max(0, to - from) / SIGN_IN_AGE_DAY_MS);
}

/**
 * Issue #6801: the ONE age rule. `null` unless the entry is an Anthropic `oauth`
 * record with a sign-in time (ruling D1: `env-token` and `native` records, and
 * OpenAI and Google rows, have no age). Only `unrefreshable` decides death; a
 * stray `unrefreshableAt` on an unflagged entry is ignored. Days are whole
 * elapsed 24-hour days, with clock skew clamped to 0.
 */
export function computeSignInAge(
  entry: SignInAgeInput,
  nowMs: number
): SignInAge | null {
  if (entry.provider !== "anthropic" || entry.authKind !== "oauth") return null;
  const signedInAt = entry.capturedAt;
  if (!(signedInAt > 0)) return null;
  if (entry.quarantined === true) {
    return {
      state: "quarantined",
      days: wholeSignInDays(signedInAt, nowMs),
      signedInAt,
    };
  }
  if (entry.unrefreshable) {
    if (entry.unrefreshableAt === undefined) {
      return { state: "flagged-unreported", signedInAt };
    }
    const diedAt = entry.unrefreshableAt;
    if (typeof diedAt === "number" && diedAt > 0) {
      return {
        state: "stopped",
        days: wholeSignInDays(signedInAt, diedAt),
        signedInAt,
        diedAt,
      };
    }
    return { state: "stopped-unknown", signedInAt };
  }
  return {
    state: "running",
    days: wholeSignInDays(signedInAt, nowMs),
    signedInAt,
  };
}

/** Issue #6801: one account record on one node, with its sign-in age. */
export type SignInAgeRow = {
  nodeId: string;
  nodeLabel: string;
  accountUuid: string;
  emailAddress: string;
  nickname: string | null;
  age: SignInAge;
  /**
   * The last time the record was known alive: its last refresh, else its sign-in.
   * The death time is when Hapimatic DETECTED the death, so the real death lies
   * between this and `diedAt`.
   */
  lastAliveAt: number;
  /**
   * Issue #6161 (R16): the resolved deadline and its source, kept on a flagged
   * row too (the evidence R18 reads); `null` with source `unknown`,
   * `disproved` or `unreported` when the rule cannot resolve one.
   */
  deadlineAt: number | null;
  deadlineSource: string;
  /** Whole days left (floored at 0); null for a flagged row or no deadline. */
  daysLeft: number | null;
  /** The warning window's state; null outside it and for a flagged row. */
  ending: "ending" | "due" | null;
  /** The resolved deadline is an estimate ("about"). */
  estimated: boolean;
};

/** Issue #6801 (R13): one past death a node carries for a record. */
export type SignInDeathRow = {
  nodeId: string;
  nodeLabel: string;
  accountUuid: string;
  emailAddress: string;
  signedInAt: number;
  diedAt: number;
  lastAliveAt: number;
  /** Whole days from the sign-in to the death. */
  days: number;
  /** Issue #6161 (R18): the deadline predicted for that login, or null. */
  predictedDeadlineAt: number | null;
};

/** Issue #6801 (R10): a node the list did not read in full. */
export type SignInAgeCoverage = {
  nodeId: string;
  nodeLabel: string;
  status: NodeAccountHealthStatus;
  reason?: NodeAccountHealthReason;
  rejectedEntries?: number;
  /** An `ok` node with a flagged entry it sends no death time for (R14). */
  deathsNotReported?: true;
};

/** Issue #6801: the cross-node sign-in age list. */
export type SignInAgeList = {
  rows: SignInAgeRow[];
  past: SignInDeathRow[];
  coverage: SignInAgeCoverage[];
};

/**
 * Issue #6801 (R10, R13, R14): every Anthropic `oauth` record on every node the
 * aggregate read, its age, the past deaths each node carries, and every node that
 * was NOT read in full (`coverage`), so a gap in the evidence is never silent.
 * Rows are ordered by node (envelope order), then email. A `quarantined` and a
 * `flagged-unreported` row stay in `rows` with that state and are never a death.
 */
export function listSignInAges(
  nodes: NodeAccountHealth[],
  nowMs: number
): SignInAgeList {
  const rows: SignInAgeRow[] = [];
  const past: SignInDeathRow[] = [];
  const coverage: SignInAgeCoverage[] = [];
  for (const node of nodes) {
    const ident = { nodeId: node.nodeId, nodeLabel: node.nodeLabel };
    if (node.status !== "ok") {
      coverage.push({
        ...ident,
        status: node.status,
        ...(node.reason ? { reason: node.reason } : {}),
      });
      continue;
    }
    const nodeRows: SignInAgeRow[] = [];
    const nodePast: SignInDeathRow[] = [];
    let deathsNotReported = false;
    for (const entry of node.accounts) {
      const age = computeSignInAge(entry, nowMs);
      if (!age) continue;
      if (age.state === "flagged-unreported") deathsNotReported = true;
      // Issue #6161 (R16): the deadline, from the same clock as the age.
      const deadline = resolveEntryDeadline(entry, nowMs);
      const flagged = entry.unrefreshable || entry.quarantined === true;
      const ending = flagged ? null : computeSignInEnding(entry, nowMs);
      nodeRows.push({
        ...ident,
        accountUuid: entry.accountUuid,
        emailAddress: entry.emailAddress,
        nickname: entry.nickname,
        age,
        lastAliveAt: entry.lastRefreshedAt ?? entry.capturedAt,
        deadlineAt: deadline.at,
        deadlineSource: deadline.source,
        daysLeft:
          flagged || deadline.at === null
            ? null
            : daysUntil(deadline.at, nowMs),
        ending: ending?.state ?? null,
        estimated: isEstimatedDeadline(
          deadline.source,
          entry.signInDeadlineSource
        ),
      });
      for (const death of entry.signInDeaths ?? []) {
        nodePast.push({
          ...ident,
          accountUuid: entry.accountUuid,
          emailAddress: entry.emailAddress,
          signedInAt: death.signedInAt,
          diedAt: death.diedAt,
          lastAliveAt: death.lastAliveAt,
          days: wholeSignInDays(death.signedInAt, death.diedAt),
          predictedDeadlineAt:
            typeof death.predictedDeadlineAt === "number"
              ? death.predictedDeadlineAt
              : null,
        });
      }
    }
    const byEmail = (
      a: { emailAddress: string },
      b: { emailAddress: string }
    ) => a.emailAddress.localeCompare(b.emailAddress);
    rows.push(...nodeRows.sort(byEmail));
    past.push(...nodePast.sort((a, b) => byEmail(a, b) || a.diedAt - b.diedAt));
    if (node.rejectedEntries !== undefined || deathsNotReported) {
      coverage.push({
        ...ident,
        status: node.status,
        ...(node.rejectedEntries !== undefined
          ? { rejectedEntries: node.rejectedEntries }
          : {}),
        ...(deathsNotReported ? { deathsNotReported: true as const } : {}),
      });
    }
  }
  return { rows, past, coverage };
}
