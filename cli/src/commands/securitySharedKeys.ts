// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #5127: `hapi security audit` coverage for API keys shared across the
 * federation. A key marked `shareAcrossNodes` can be fetched by any node that
 * holds the federation token, so the audit names the shared keys, checks that
 * token, and summarises the last 30 days of cross-node requests the server
 * recorded in `api_key_share_audit`.
 *
 * Output rules (the audit's): no key, token or token fragment appears in any
 * message or hint — keys are named by label and masked form only. A settings
 * shape the audit cannot read fails closed (a `high` finding).
 */
import { lstatSync } from "node:fs";
import type { Finding } from "./security";
import { isAbsentError, unreadableFinding } from "./securityFailClosed";
import { openDatabase } from "@/ext/sqlite";
import { maskApiKey } from "@hapi/protocol/schemas";

/** The audit window for cross-node requests (matches the store's retention). */
export const SHARE_ACTIVITY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Refusals that mean something other than a known node asked: raise to medium. */
const SUSPICIOUS_REFUSALS = new Set([
  "api_key_requester_unknown",
  "api_key_transport_refused",
]);

const SHARED_UNCHECKED = "the shared-API-key checks";

export interface SharedKeysInput {
  /** The parsed settings.json object (undefined when absent). */
  settings: Record<string, unknown> | undefined;
  dbPath: string;
  /** `FEDERATION_API_TOKEN` from the auditing process (the server's override). */
  envFederationToken?: string;
  isWeakToken: (token: string) => boolean;
  now?: () => number;
}

export interface SharedKeysResult {
  findings: Finding[];
  /** True when at least one key is shared — raises `sandbox-disabled`. */
  anyShared: boolean;
}

type ShareRow = { outcome: string; requesting_node_id: string; n: number };

function malformed(path: string, what: string): Finding {
  return {
    id: "shared-api-keys-unreadable",
    severity: "high",
    message: `settings.json ${what}, so ${SHARED_UNCHECKED} went unchecked — failing closed`,
    fixHint: `repair ${path}; the server cannot read its key vault in this state either`,
    fixable: null,
  };
}

function keyName(entry: Record<string, unknown>): string {
  const label =
    typeof entry.label === "string" && entry.label.trim()
      ? entry.label.trim()
      : null;
  // The vault stores the raw key: name it by the one masking rule (last 4).
  const masked = maskApiKey(typeof entry.key === "string" ? entry.key : "");
  return label ? `${label} (${masked})` : masked;
}

/** Read the 30-day request summary, or null when the table does not exist yet. */
function readShareActivity(dbPath: string, sinceMs: number): ShareRow[] | null {
  try {
    lstatSync(dbPath); // an untraversable parent is not "absent"
  } catch (err) {
    if (isAbsentError(err)) return null;
    throw err;
  }
  const db = openDatabase(dbPath, true);
  try {
    db.prepare("PRAGMA busy_timeout = 3000").get();
    const table = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'api_key_share_audit'"
      )
      .get() as { name: string } | undefined;
    if (!table) return null;
    return db
      .prepare(
        // A coalesced refusal row stands for itself plus the identical
        // refusals it summarises ("N identical refusal(s) …" in detail).
        "SELECT outcome, requesting_node_id, SUM(1 + CASE WHEN detail LIKE '% identical refusal(s)%' " +
          "THEN CAST(detail AS INTEGER) ELSE 0 END) AS n FROM api_key_share_audit " +
          "WHERE timestamp >= ? GROUP BY outcome, requesting_node_id"
      )
      .all(sinceMs) as ShareRow[];
  } finally {
    db.close();
  }
}

export function checkSharedApiKeys(
  input: SharedKeysInput,
  settingsPath: string
): SharedKeysResult {
  const findings: Finding[] = [];
  const settings = input.settings;
  if (!settings) return { findings, anyShared: false };

  const rawKeys = settings.apiKeys;
  if (rawKeys !== undefined && !Array.isArray(rawKeys)) {
    return {
      findings: [
        malformed(settingsPath, "has an apiKeys value that is not a list"),
      ],
      anyShared: false,
    };
  }
  const entries: Record<string, unknown>[] = [];
  for (const e of (rawKeys as unknown[] | undefined) ?? []) {
    if (e === null || typeof e !== "object" || Array.isArray(e)) {
      return {
        findings: [
          malformed(settingsPath, "has an apiKeys entry that is not an object"),
        ],
        anyShared: false,
      };
    }
    entries.push(e as Record<string, unknown>);
  }
  const shared = entries.filter(e => e.shareAcrossNodes === true);
  for (const e of shared) {
    if (e.provider !== "anthropic") {
      findings.push({
        id: "shared-key-non-anthropic",
        severity: "high",
        message: `the ${String(e.provider)} key ${keyName(e)} is marked to share across nodes, which only Anthropic keys support`,
        fixHint:
          "untick 'All nodes' on that key in Settings → Provider Accounts (or remove shareAcrossNodes from its settings.json entry)",
        fixable: null,
      });
    }
  }
  if (shared.length === 0) return { findings, anyShared: false };

  findings.push({
    id: "shared-api-keys",
    severity: "info",
    message: `${shared.length} API key(s) are shared with the other nodes of the federation: ${shared.map(keyName).join(", ")}`,
    fixHint:
      "any node holding the federation token can use these keys; untick 'All nodes' on a key to stop sharing it",
    fixable: null,
  });

  const federation =
    settings.federation &&
    typeof settings.federation === "object" &&
    !Array.isArray(settings.federation)
      ? (settings.federation as Record<string, unknown>)
      : undefined;
  if (federation?.enabled !== true) {
    findings.push({
      id: "shared-api-key-federation-disabled",
      severity: "info",
      message:
        "keys are marked to share, but federation is not enabled on this node, so no other node can use them",
      fixHint: "no action needed unless you meant to share them",
      fixable: null,
    });
  }

  const fedToken =
    input.envFederationToken ??
    (typeof federation?.apiToken === "string"
      ? federation.apiToken
      : undefined);
  if (!fedToken) {
    findings.push({
      id: "federation-token-unchecked",
      severity: "info",
      message:
        "no federation token in settings.json or this shell's FEDERATION_API_TOKEN, so its strength was not checked; a token set only in the server's environment is not visible to the audit",
      fixHint:
        "run the audit with the server's FEDERATION_API_TOKEN exported, or keep the token in settings.json",
      fixable: null,
    });
  }
  if (fedToken) {
    if (input.isWeakToken(fedToken)) {
      findings.push({
        id: "federation-token-weak",
        severity: "high",
        message: `the federation token fails the strength rule (length ${fedToken.length}, or a trivial pattern) while API keys are shared — it is all a node needs to fetch them`,
        fixHint:
          "rotate it: set a new 32-byte federation apiToken on every node of the federation in the same change, then restart each server",
        fixable: "rotate-prompt",
      });
    }
    const cliToken =
      typeof settings.cliApiToken === "string" ? settings.cliApiToken : "";
    if (cliToken && cliToken === fedToken) {
      findings.push({
        id: "federation-token-equals-cli-token",
        severity: "high",
        message:
          "the federation token equals this node's cliApiToken while API keys are shared — anything that holds the CLI token can fetch them as a peer",
        fixHint:
          "rotate the federation apiToken to its own 32-byte value on every node in the same change, then restart each server",
        fixable: "rotate-prompt",
      });
    }
  }

  let rows: ShareRow[] | null;
  try {
    rows = readShareActivity(
      input.dbPath,
      (input.now ?? Date.now)() - SHARE_ACTIVITY_WINDOW_MS
    );
  } catch (err) {
    findings.push(
      unreadableFinding(
        input.dbPath,
        "hapi.db (the shared-key request log)",
        err,
        "the shared-key request summary"
      )
    );
    return { findings, anyShared: true };
  }
  if (rows === null) {
    findings.push({
      id: "api-key-share-activity",
      severity: "info",
      message:
        "shared-key requests from other nodes: not recorded yet (the server has not created its request log)",
      fixHint: "no action needed",
      fixable: null,
    });
  } else {
    const served = rows
      .filter(r => r.outcome === "ok")
      .reduce((s, r) => s + r.n, 0);
    const refused = rows.filter(r => r.outcome !== "ok");
    const suspicious = refused.filter(r => SUSPICIOUS_REFUSALS.has(r.outcome));
    // A stored requester id is whatever the caller claimed: print only ids of
    // the node-id shape, so no stored text reaches the operator's terminal.
    const requesters = [
      ...new Set(
        rows.map(r =>
          /^[A-Za-z0-9._-]{1,64}$/.test(r.requesting_node_id)
            ? r.requesting_node_id
            : "(an invalid id)"
        )
      ),
    ].sort();
    const refusedCount = refused.reduce((s, r) => s + r.n, 0);
    const suspiciousCount = suspicious.reduce((s, r) => s + r.n, 0);
    findings.push({
      id: "api-key-share-activity",
      severity: suspiciousCount > 0 ? "medium" : "info",
      message:
        `shared-key requests from other nodes in the last 30 days: ${served} served, ${refusedCount} refused` +
        (requesters.length > 0
          ? ` (requesting nodes: ${requesters.slice(0, 10).join(", ")}${requesters.length > 10 ? ", …" : ""})`
          : "") +
        (suspiciousCount > 0
          ? `; ${suspiciousCount} came from an unknown node or over a non-Tailscale connection`
          : ""),
      fixHint:
        suspiciousCount > 0
          ? "check which hosts hold the federation token; rotate it on every node if one should not"
          : "no action needed",
      fixable: null,
    });
  }
  return { findings, anyShared: true };
}
