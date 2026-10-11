// SPDX-License-Identifier: AGPL-3.0-only
import { configuration } from "@/configuration";

/** Mirrors `tokenRefreshService.FetchLike` — the injectable fetch seam. */
type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

const LEASE_REQUEST_TIMEOUT_MS = 4_000;

export interface RotationLeaseClientOptions {
  /** Overrides `configuration.serverUrl` (tests). */
  serverUrl?: string;
  /** Overrides `configuration.cliApiToken` (tests). */
  cliApiToken?: string;
  /** Overrides `configuration.rotationLeaseEnabled` (tests). */
  enabled?: boolean;
  /** Injectable fetch seam (tests). */
  fetchImpl?: FetchLike;
}

type LeaseOp = "acquire" | "heartbeat" | "release";

/**
 * Daemon-side client for the cross-machine rotation lease (issue #1644). Talks
 * to the LOCAL server's `/cli/account-lease/*` endpoints, which stamp the holder
 * (`federationConfig.nodeId`) and serve-local-or-proxy via `RotationLeaseService`.
 *
 * **The single feature-gate choke point + fail-open** (R5/R6):
 * - Gate off ⇒ returns `true` with NO HTTP call (byte-equivalent to #1635).
 * - Any network error / timeout / non-2xx / malformed body ⇒ returns `true`
 *   (grant local rotation rather than block the spawn or scheduler).
 *
 * It NEVER throws — the proactive-rotation and spawn-recovery hot paths depend on
 * that (Fallback Preservation Rule).
 */
export class RotationLeaseClient {
  private readonly getServerUrl: () => string;
  private readonly getCliApiToken: () => string;
  private readonly getEnabled: () => boolean;
  private readonly fetchImpl: FetchLike;

  constructor(opts?: RotationLeaseClientOptions) {
    // Read serverUrl/token/enabled lazily — `configuration.cliApiToken` is a
    // getter that can change on token rotation, and reading the gate lazily keeps
    // a long-lived (module-singleton) client consistent with the live config.
    this.getServerUrl = () => opts?.serverUrl ?? configuration.serverUrl;
    this.getCliApiToken = () => opts?.cliApiToken ?? configuration.cliApiToken;
    this.getEnabled = () => opts?.enabled ?? configuration.rotationLeaseEnabled;
    this.fetchImpl = opts?.fetchImpl ?? fetch;
  }

  /** Acquire (or renew) the family lease. `true` ⇒ this node may rotate. */
  acquireRotationLease(accountUuid: string): Promise<boolean> {
    return this.call("acquire", accountUuid);
  }

  /** Heartbeat a held lease. `true` ⇒ still held (keep rotating locally). */
  heartbeat(accountUuid: string): Promise<boolean> {
    return this.call("heartbeat", accountUuid);
  }

  /** Best-effort release. Always resolves `true` (failure is covered by TTL). */
  release(accountUuid: string): Promise<boolean> {
    return this.call("release", accountUuid);
  }

  private async call(op: LeaseOp, accountUuid: string): Promise<boolean> {
    // R6: gate off ⇒ no HTTP, byte-equivalent #1635.
    if (!this.getEnabled()) return true;
    try {
      const res = await this.fetchImpl(
        `${this.getServerUrl()}/cli/account-lease/${op}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.getCliApiToken()}`,
          },
          body: JSON.stringify({ accountUuid }),
          signal: AbortSignal.timeout(LEASE_REQUEST_TIMEOUT_MS),
        }
      );
      // Reachable but errored ⇒ fail open (R5).
      if (!res.ok) return true;
      const json = (await res.json().catch(() => null)) as {
        granted?: boolean;
      } | null;
      // Honor an explicit deny; bias to grant otherwise so a reachable-but-
      // uninterpretable server never blocks the spawn (R5).
      return json?.granted !== false;
    } catch {
      // Network error / timeout / abort ⇒ fail open (R5).
      return true;
    }
  }
}
