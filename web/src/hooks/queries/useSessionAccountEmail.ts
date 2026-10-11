// SPDX-License-Identifier: AGPL-3.0-only
import { LOCAL_NODE_ID } from "@hapi/protocol";
import type { ApiClient } from "@/api/client";
import { useNodeActiveAccount } from "@/hooks/queries/useNodeActiveAccount";

/**
 * useSessionAccountEmail — the ONE rule for "which provider account is this
 * session on" (epic #3285 round 15, operator ruling 2026-09-08: the Account
 * Chip always names the LITERAL account — it never says "default", because
 * nothing in the UI tells the user which account the default is).
 *
 * Resolution order:
 * 1. A Claude session records its bound account at spawn
 *    (`metadata.claudeAccount.email`) — the answer whenever present
 *    (`source: "session"`).
 * 2. A Claude session that recorded NO account runs on its node's active
 *    (default) account credential (client.ts: "host/node-default credential"),
 *    so resolve that node's active account and name it literally
 *    (`source: "node"`). The node is the session's `nodeId` (federation-
 *    enriched rows), an explicit override (the header's `nodeId` prop), or the
 *    `LOCAL_NODE_ID` sentinel — which the nodes route serves locally on
 *    federated instances as of round 15 (it used to proxy it to a peer named
 *    "local" and 502).
 * 3. Non-Claude sessions (Codex/Gemini) have no Claude account → `undefined`
 *    (`source: "not-claude"`); the consumers render nothing for them.
 *
 * Every consumer of the account (list badge, header badge, Session
 * Configuration modal, and the prompt-box Session Config Cluster via
 * SessionChat) reads THIS hook so the four surfaces cannot disagree.
 * The node lookup is enabled only when it is actually needed (Claude session
 * with no recorded email), so a list of recorded sessions issues no request;
 * React Query dedupes the per-node key across rows.
 */
export type SessionAccountSource =
  | "session" // recorded on the session at spawn
  | "node" // resolved from the node's active account (session recorded none)
  | "pending" // node lookup in flight
  | "none" // Claude session, no recorded account, node has no active account
  | "not-claude" // Codex/Gemini — no Claude account exists
  | "api-key"; // #4568: a Claude session billed to an API key — NO account

export type SessionAccountInput = {
  nodeId?: string;
  metadata?: {
    flavor?: string | null;
    claudeAccount?: { email?: string } | null;
    /** #4568: the spawn-time auth binding (`kind: "api-key"` ⇒ a key session). */
    authBinding?: { kind?: string; displayIdentity?: string } | null;
  } | null;
};

/**
 * Issue #4568: the display name of an API-key session's credential — "Anthropic
 * API · <key label>", from `authBinding.displayIdentity` ONLY (the daemon's
 * label-or-mask), so it is label-only by construction.
 */
export function apiKeyCredentialLabel(displayIdentity?: string): string {
  return `Anthropic API · ${apiKeyCredentialName(displayIdentity)}`;
}

/** Issue #4568: the key's own short name (label, else masked) for a chip cell. */
export function apiKeyCredentialName(displayIdentity?: string): string {
  return displayIdentity?.trim() || "API key";
}

/**
 * Issue #4568: the identity an `AccountChip` hashes for EVERY API-key session —
 * one stable chip color for keys, and a chip title of "<key> · Anthropic API".
 */
export const API_KEY_CHIP_IDENTITY = "Anthropic API";

/** Mirrors `getAccountEmail`'s flavor rule: Claude, or an unset flavor. */
export function isClaudeFlavor(flavor: string | null | undefined): boolean {
  const f = flavor?.trim().toLowerCase();
  return f === "claude" || !f;
}

export function useSessionAccountEmail(
  api: ApiClient | null,
  session: SessionAccountInput,
  nodeIdOverride?: string
): {
  email: string | undefined;
  source: SessionAccountSource;
  /** #4568: set ONLY for `source: "api-key"` — the credential's display name.
   *  `email` stays unset then, so no consumer treats a key as an account. */
  label?: string;
  /** #4568: with `label` — the key's own short name, for a chip cell. */
  keyName?: string;
} {
  const claude = isClaudeFlavor(session.metadata?.flavor);
  // Issue #4568: a Claude session billed to an API key binds NO account. It
  // never falls back to the node's active account (that is a subscription the
  // session does not use) and starts no node-account query.
  const binding = session.metadata?.authBinding;
  const apiKeySession = claude && binding?.kind === "api-key";
  const recorded =
    claude && !apiKeySession
      ? session.metadata?.claudeAccount?.email || undefined
      : undefined;
  const nodeId = nodeIdOverride ?? session.nodeId ?? LOCAL_NODE_ID;
  const { account, status } = useNodeActiveAccount(api, nodeId, {
    enabled: claude && !apiKeySession && !recorded,
  });
  if (!claude) return { email: undefined, source: "not-claude" };
  if (apiKeySession) {
    return {
      email: undefined,
      source: "api-key",
      label: apiKeyCredentialLabel(binding?.displayIdentity),
      keyName: apiKeyCredentialName(binding?.displayIdentity),
    };
  }
  if (recorded) return { email: recorded, source: "session" };
  if (account?.emailAddress) {
    return { email: account.emailAddress, source: "node" };
  }
  return {
    email: undefined,
    source: status === "loading" ? "pending" : "none",
  };
}
