// SPDX-License-Identifier: AGPL-3.0-only
import type { GitHubFailureReason } from "@hapi/protocol/githubFailureReason";
import type { GitHubAccountResult, GitHubRepoResult } from "./githubCli";
import type { FetchImpl, RestIssueResult } from "./githubRest";

/**
 * VM-side client for the gateway GitHub read broker (issue #3013).
 *
 * 🔴 WHY THIS EXISTS: #2672 branch A removed the VM-resident `GH_TOKEN`, so the
 * read-only GitHub listings that authenticated via it went dark on a cloud VM (no
 * `gh`, no token). This module restores them WITHOUT a VM-resident credential: it
 * calls the gateway broker (`gateway/src/routes/githubBroker.ts`), which performs the
 * GitHub REST call with ITS OWN read-only credential and returns shaped results. No
 * GitHub token ever reaches the VM (R2). This is a transport, exactly like the `gh`
 * and token-REST transports — added strictly as the no-local-token fallback, so a host
 * that DOES have a token (RP1, CI) is byte-unchanged (CLAUDE.md → Fallback Preservation).
 *
 * 🔴 PATTERN: modeled on `server/src/feedback/relayTransport.ts` (`sendViaRelay`). It
 * reads the gateway URL + the per-VM broker token from the VM env and calls the gateway
 * with `Authorization: Bearer <brokerToken>`. That broker token is a DISTINCT scoped
 * secret from the feedback-relay token (expert ruling A5) and — like the relay token —
 * is NOT a GitHub credential (R2 preserved).
 *
 * 🔴 SECURITY: on any transport failure the swallow-the-throw discipline returns a bare
 * reason enum (never the token in a thrown/logged message), mirroring
 * `githubRequest`'s discipline in `githubRest.ts`.
 */

/** The two VM env keys the broker client reads. Neither is a GitHub credential (R2). */
const BROKER_URL_ENV_KEY = "FEEDBACK_RELAY_URL";
const BROKER_TOKEN_ENV_KEY = "HAPI_GITHUB_BROKER_TOKEN";

/**
 * The `/api/feedback-relay` endpoint suffix on `FEEDBACK_RELAY_URL`. The broker mounts
 * as a SIBLING at `/api/github-broker` (both under the gateway's `/api`), so the broker
 * base is the relay URL with this suffix swapped (finding 3013-4 — the relay URL is a
 * FULL endpoint URL from a `provision.sh` systemd drop-in, not a bare origin).
 */
const RELAY_URL_SUFFIX = "/feedback-relay";
const BROKER_URL_SUFFIX = "/github-broker";

/** Resolved broker transport config: the gateway broker base + the per-VM auth token. */
export interface GithubBrokerClientConfig {
  /** e.g. `https://gateway.example.com/api/github-broker`. */
  baseUrl: string;
  /** The per-VM broker auth token (a gateway-auth secret, NOT a GitHub credential). */
  token: string;
}

/**
 * Resolve the broker transport config from the VM env, or `null` when this host is not
 * provisioned for the broker (missing URL/token, or a `FEEDBACK_RELAY_URL` whose shape we
 * don't recognize). Returning `null` is the signal to callers to keep their pre-#3013
 * no-token behavior — the broker is strictly additive, never a behavior change for a
 * non-broker host (RP1 / CI / dev).
 */
export function resolveGithubBrokerConfig(
  env: Record<string, string | undefined> = process.env
): GithubBrokerClientConfig | null {
  const relayUrl = env[BROKER_URL_ENV_KEY]?.trim();
  const token = env[BROKER_TOKEN_ENV_KEY]?.trim();
  if (!relayUrl || !token) return null;
  // Derive the broker base by swapping the known endpoint suffix. If the relay URL is not
  // the expected `<base>/api/feedback-relay` shape, do NOT guess a base — treat the host
  // as unprovisioned (null), so a misconfigured URL degrades gracefully rather than POSTing
  // the broker token to an unexpected origin.
  if (!relayUrl.endsWith(RELAY_URL_SUFFIX)) return null;
  const baseUrl =
    relayUrl.slice(0, -RELAY_URL_SUFFIX.length) + BROKER_URL_SUFFIX;
  return { baseUrl, token };
}

/** Broker transport result — `reason` is the full shared enum (allows `broker_unavailable`). */
export type GitHubBrokerResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: GitHubFailureReason };

/**
 * REST reasons the gateway broker can legitimately forward, passed through verbatim.
 * Anything else (incl. a hypothetical `no_token` — which must NEVER render "install a
 * token" for a token-banned VM, finding 3013-7) collapses to `broker_unavailable`.
 */
const BROKER_PASSTHROUGH_REASONS: ReadonlySet<GitHubFailureReason> = new Set([
  "token_rejected",
  "rate_limited",
  "forbidden",
  "network",
  "unknown",
]);

function mapBrokerReason(reason: unknown): GitHubFailureReason {
  if (
    typeof reason === "string" &&
    BROKER_PASSTHROUGH_REASONS.has(reason as GitHubFailureReason)
  ) {
    return reason as GitHubFailureReason;
  }
  return "broker_unavailable";
}

/** The `{ success, reason?, <items> }` envelope every broker endpoint returns. */
interface BrokerEnvelope {
  success?: boolean;
  reason?: string;
  [k: string]: unknown;
}

/**
 * Issue ONE authenticated GET to the broker and return the parsed envelope, or a
 * transport failure. A missing config, a network throw, a non-2xx (gateway 401/429/503/5xx),
 * or unparseable JSON all degrade to `broker_unavailable` — the token never appears in a
 * thrown/returned message (the throw is swallowed whole).
 */
async function brokerFetch(
  path: string,
  env: Record<string, string | undefined>,
  fetchImpl: FetchImpl
): Promise<
  | { ok: true; envelope: BrokerEnvelope }
  | { ok: false; reason: GitHubFailureReason }
> {
  const config = resolveGithubBrokerConfig(env);
  if (!config) return { ok: false, reason: "broker_unavailable" };

  let response: Response;
  try {
    response = await fetchImpl(`${config.baseUrl}${path}`, {
      headers: { authorization: `Bearer ${config.token}` },
    });
  } catch {
    // Swallow the throw whole: a fetch rejection can embed the request (and the
    // Authorization header) in its message.
    return { ok: false, reason: "broker_unavailable" };
  }
  if (!response.ok) return { ok: false, reason: "broker_unavailable" };
  try {
    return { ok: true, envelope: (await response.json()) as BrokerEnvelope };
  } catch {
    return { ok: false, reason: "broker_unavailable" };
  }
}

/** Interpret a broker envelope: `success:true` → extracted data, else a mapped reason. */
function interpretEnvelope<T>(
  result:
    | { ok: true; envelope: BrokerEnvelope }
    | { ok: false; reason: GitHubFailureReason },
  extract: (envelope: BrokerEnvelope) => T | undefined
): GitHubBrokerResult<T> {
  if (!result.ok) return result;
  const { envelope } = result;
  if (envelope.success === true) {
    const data = extract(envelope);
    if (data === undefined) return { ok: false, reason: "broker_unavailable" };
    return { ok: true, data };
  }
  return { ok: false, reason: mapBrokerReason(envelope.reason) };
}

/** The broker credential's own identity (mirrors `fetchAccountViaRest`, minus token). */
export async function fetchAccountViaBroker(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: FetchImpl = fetch
): Promise<GitHubBrokerResult<GitHubAccountResult>> {
  const result = await brokerFetch("/accounts", env, fetchImpl);
  return interpretEnvelope(result, e =>
    Array.isArray(e.accounts)
      ? (e.accounts[0] as GitHubAccountResult | undefined)
      : undefined
  );
}

/** Repos accessible to `account` via the broker (mirrors `fetchReposViaRest`). */
export async function fetchReposViaBroker(
  account: string,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: FetchImpl = fetch
): Promise<GitHubBrokerResult<GitHubRepoResult[]>> {
  const result = await brokerFetch(
    `/repos?account=${encodeURIComponent(account)}`,
    env,
    fetchImpl
  );
  return interpretEnvelope(result, e =>
    Array.isArray(e.repos) ? (e.repos as GitHubRepoResult[]) : undefined
  );
}

/** One issue via the broker (mirrors `fetchIssueViaRest`). */
export async function fetchIssueViaBroker(
  owner: string,
  repo: string,
  issueNumber: number,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: FetchImpl = fetch
): Promise<GitHubBrokerResult<RestIssueResult>> {
  const result = await brokerFetch(
    `/issues/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${issueNumber}`,
    env,
    fetchImpl
  );
  return interpretEnvelope(result, e =>
    e.issue && typeof e.issue === "object"
      ? (e.issue as RestIssueResult)
      : undefined
  );
}

/** A repo's OPEN issues via the broker (mirrors `listOpenIssuesViaRest`; PRs pre-filtered). */
export async function listOpenIssuesViaBroker(
  owner: string,
  repo: string,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: FetchImpl = fetch
): Promise<GitHubBrokerResult<RestIssueResult[]>> {
  const result = await brokerFetch(
    `/repo-issues?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`,
    env,
    fetchImpl
  );
  return interpretEnvelope(result, e =>
    Array.isArray(e.issues) ? (e.issues as RestIssueResult[]) : undefined
  );
}
