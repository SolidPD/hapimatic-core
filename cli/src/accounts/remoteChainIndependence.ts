// SPDX-License-Identifier: AGPL-3.0-only
//
// Issue #3784 — cross-node refresh-token chain independence.
//
// The idle-refresh backstop (`TokenRefreshService.refreshIdleIsolatedAccounts`)
// historically skipped rotating ANY account a federation node held a live
// session on (the "P-REVOKE skip"), on the premise that one refresh-token family
// backs an account across every node, so rotating here would revoke the remote
// holder's access token (#1645).
//
// That premise is FALSE. The verified invariant (this issue's Mose 3-machine
// coexistence evidence, 2026-09-17, plus the #4423 copy-guard that prevents a
// record ever being copied between nodes) is: a refresh token is single-use and
// DISTINCT grants form INDEPENDENT chains that coexist — only a COPIED token
// collides. So a node rotating its OWN independent chain cannot revoke a remote
// holder's chain. This module decides, for the MIXED (local AND remote) case,
// whether rotating is safe by comparing refresh-token FINGERPRINTS (sha256 hex,
// never a raw token) across nodes. It fails SAFE: any doubt ⇒ "unknown" ⇒ skip.
import { readIsolatedCredentials } from "@/accounts/accountConfigDir";
import { refreshTokenFingerprint } from "@/accounts/machineRotator";

/** Refresh-token chain fingerprints held by OTHER federation nodes for an
 *  account (sha256 hex; NEVER a raw token) + whether that view is degraded. */
export interface RemoteChainFingerprints {
  fingerprints: Set<string>;
  degraded: boolean;
}

/**
 * The verdict on whether THIS node's isolated chain for an account is a distinct
 * grant from every remote holder's:
 *  - "independent" — this node's fingerprint differs from every remote one
 *                    (rotating this chain cannot cross-revoke a remote holder);
 *  - "shared"      — this node's fingerprint EQUALS a remote one (a COPIED token:
 *                    rotating WOULD cross-revoke — must not rotate; should not
 *                    exist post-#4423, so it is reported loudly);
 *  - "unknown"     — this node's fingerprint is unreadable OR a remote view was
 *                    degraded this pass (fail SAFE: do not rotate).
 */
export type ChainIndependence = "independent" | "shared" | "unknown";

/** Default reader for THIS node's own isolated chain fingerprint: sha256 of the
 *  isolated `.credentials.json` refresh token, or null when absent/unreadable. */
export async function defaultLocalChainFingerprint(
  accountUuid: string
): Promise<string | null> {
  const oauth = await readIsolatedCredentials(accountUuid).catch(() => null);
  if (!oauth?.refreshToken) return null;
  return refreshTokenFingerprint(oauth.refreshToken);
}

/**
 * Compare this node's isolated chain fingerprint against the remote holders' set.
 * Never throws — a throw in either reader maps to the fail-safe "unknown".
 *
 * The remote set MUST already EXCLUDE this node's own id (the daemon closure
 * does so); if it ever includes self, a match reads as "shared" ⇒ skip, which is
 * merely over-conservative, never unsafe.
 */
export async function assessRemoteChainIndependence(
  accountUuid: string,
  getLocalChainFingerprint: (uuid: string) => Promise<string | null>,
  getRemoteChainFingerprints: (uuid: string) => Promise<RemoteChainFingerprints>
): Promise<ChainIndependence> {
  const localFp = await getLocalChainFingerprint(accountUuid).catch(() => null);
  if (!localFp) return "unknown";
  const remote = await getRemoteChainFingerprints(accountUuid).catch(() => ({
    fingerprints: new Set<string>(),
    degraded: true,
  }));
  if (remote.degraded) return "unknown";
  if (remote.fingerprints.has(localFp)) return "shared";
  return "independent";
}

/**
 * Build the daemon's `getRemoteChainFingerprints` reader: query the LOCAL
 * server's cross-node aggregator (`/api/federation/account-chain-fingerprints`),
 * EXCLUDE this node's own entry (`!self`), and return the other nodes'
 * fingerprints + a degraded flag. Fails SAFE on any error (degraded: true ⇒ the
 * verdict is "unknown" ⇒ no rotation) — so a probe failure can never cause a
 * blind rotation. Extracted from the daemon so `run.ts` stays thin and the I/O
 * is exercisable in isolation.
 */
export function makeRemoteChainFingerprintsFetcher(opts: {
  serverUrl: string;
  cliApiToken: string | null;
  warn?: (message: string) => void;
}): (accountUuid: string) => Promise<RemoteChainFingerprints> {
  return async (accountUuid: string) => {
    try {
      const authResp = await fetch(`${opts.serverUrl}/api/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessToken: opts.cliApiToken }),
      });
      if (!authResp.ok) throw new Error(`auth HTTP ${authResp.status}`);
      const { token } = (await authResp.json()) as { token?: string };
      if (!token) throw new Error("no JWT in /api/auth response");
      const resp = await fetch(
        `${opts.serverUrl}/api/federation/account-chain-fingerprints?accountUuid=${encodeURIComponent(accountUuid)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!resp.ok) {
        throw new Error(`account-chain-fingerprints HTTP ${resp.status}`);
      }
      const body = (await resp.json()) as {
        fingerprints?: Array<{ self?: boolean; fingerprint?: string | null }>;
        degraded?: boolean;
      };
      const fingerprints = new Set<string>();
      for (const e of body.fingerprints ?? []) {
        if (!e.self && typeof e.fingerprint === "string") {
          fingerprints.add(e.fingerprint);
        }
      }
      return { fingerprints, degraded: body.degraded === true };
    } catch (err) {
      opts.warn?.(
        `[IDLE_REFRESH] chain-fingerprint probe failed (fail-safe skip): ${err instanceof Error ? err.message : String(err)}`
      );
      return { fingerprints: new Set<string>(), degraded: true };
    }
  };
}

/** A decision for the idle backstop's MIXED (local+remote) near-expiry case. */
export type MixedBindingDecision =
  | {
      action: "skip";
      level: "info" | "warn";
      message: string;
      jobError?: string;
    }
  | { action: "rotate"; message: string };

/**
 * Decide whether the idle backstop may rotate a MIXED-bound (live locally AND on
 * a federation node), near-expiry isolated account. Pure except for the injected
 * `assess` seam; produces the exact log line + optional job-error so the caller
 * stays a thin logger. Gated: `enabled === false` ⇒ always the pre-#3784 skip.
 */
export async function decideMixedBindingRotation(args: {
  accountUuid: string;
  emailAddress: string;
  enabled: boolean;
  assess: (accountUuid: string) => Promise<ChainIndependence>;
}): Promise<MixedBindingDecision> {
  const { accountUuid: uuid, emailAddress: email, enabled, assess } = args;
  if (!enabled) {
    return {
      action: "skip",
      level: "info",
      message: `[IDLE_REFRESH] skip ${uuid} (${email}) — live session bound on a federation node (P-REVOKE guard; cross-node independence check disabled)`,
    };
  }
  const independence = await assess(uuid).catch(
    () => "unknown" as ChainIndependence
  );
  if (independence === "shared") {
    const message = `[IDLE_REFRESH] skip ${uuid} (${email}) — SHARED refresh-token chain with a federation node (copy-collision; P-REVOKE guard)`;
    return {
      action: "skip",
      level: "warn",
      message,
      jobError: `[IDLE_REFRESH] copy-collision: ${uuid} (${email}) shares a refresh-token chain with a federation node — not rotating (P-REVOKE)`,
    };
  }
  if (independence !== "independent") {
    return {
      action: "skip",
      level: "info",
      message: `[IDLE_REFRESH] skip ${uuid} (${email}) — cannot confirm cross-node chain independence this pass (fail-safe; P-REVOKE guard)`,
    };
  }
  return {
    action: "rotate",
    message: `[IDLE_REFRESH] rotate-eligible ${uuid} (${email}) — independent chain, remote holder present (P-REVOKE lifted; #3784)`,
  };
}
