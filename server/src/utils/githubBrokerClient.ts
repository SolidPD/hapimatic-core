// SPDX-License-Identifier: AGPL-3.0-only
import type { GitHubFailureReason } from "@hapi/protocol/githubFailureReason";
import { asGitHubConnectionStatus } from "@hapi/protocol/githubConnection";
import type { GitHubAccountResult, GitHubRepoResult } from "./githubCli";
import type { FetchImpl, RepoListing, RestIssueResult } from "./githubRest";

/**
 * VM-side client for the gateway GitHub read broker (issue #3013).
 *
 * 🔴 WHY THIS EXISTS: #2672 branch A removed the VM-resident `GH_TOKEN`, so the
 * read-only GitHub listings that authenticated via it went dark on a cloud VM (`gh` is
 * installed but has no credential). This module restores them WITHOUT a VM-resident credential: it
 * calls the gateway broker (`gateway/src/routes/githubBroker.ts`), which performs the
 * GitHub REST call — since #4793 with the user's OWN linked GitHub App token, held on the
 * gateway (issue reads fall back to the operator's broker credential, for public repositories
 * only, when no usable link supplies a token) — and returns shaped results. No
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
/**
 * #4793: the gateway's `reason` on a "not configured" 503 (`BROKER_NOT_CONFIGURED` in
 * gateway/src/routes/githubBroker.ts; the VM cannot import the gateway, so the literal is repeated).
 */
const GATEWAY_NOT_CONFIGURED = "not_configured";

/**
 * The reason behind a non-2xx broker answer: `broker_not_configured` when the gateway says its
 * GitHub App is not set up yet (an answer, not an outage), else `broker_unavailable`. An older
 * gateway, an unreadable body or any other status stays `broker_unavailable`.
 */
async function failureReason(response: Response): Promise<GitHubFailureReason> {
  try {
    const body = (await response.json()) as { reason?: unknown } | null;
    return body?.reason === GATEWAY_NOT_CONFIGURED
      ? "broker_not_configured"
      : "broker_unavailable";
  } catch {
    return "broker_unavailable";
  }
}

/**
 * A broker call gives up after this long. Account reads are not cached on a broker host (#4793),
 * so a hung gateway would otherwise stall every Create page and Settings visit; the budget leaves
 * room for the gateway's own GitHub round trips behind a repository or issue read.
 */
export const BROKER_FETCH_TIMEOUT_MS = 20_000;

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
      signal: AbortSignal.timeout(BROKER_FETCH_TIMEOUT_MS),
    });
  } catch {
    // Swallow the throw whole: a fetch rejection can embed the request (and the
    // Authorization header) in its message.
    return { ok: false, reason: "broker_unavailable" };
  }
  if (!response.ok) return { ok: false, reason: await failureReason(response) };
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

/** #5973: the longest display name the VM accepts from the gateway, in code points (its own cap). */
const MAX_DISPLAY_NAME = 255;
/** #5973: the most `installedOn` logins the VM keeps (the gateway's own cap). */
const MAX_INSTALLED_ON = 100;
/** #5973: a GitHub login in the broker's `?account=` charset (gateway routes/githubBroker.ts). */
const INSTALLED_ON_LOGIN = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * #5973: controls, bidi formatting, zero-width characters and line separators (the gateway's own
 * set, lib/githubConnections.ts), removed again here so the VM does not depend on the gateway.
 */
const NAME_STRIP =
  // eslint-disable-next-line no-control-regex -- #5973: stripping control characters is the point
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060\u2066-\u206f\ufeff]/g;

/**
 * #5973: a display name of at most {@link MAX_DISPLAY_NAME} code points, cleaned and trimmed; null
 * when it is not a string, is too long, or is empty once cleaned.
 */
function toDisplayName(raw: unknown): string | null {
  if (typeof raw !== "string" || Array.from(raw).length > MAX_DISPLAY_NAME) {
    return null;
  }
  const cleaned = raw.replace(NAME_STRIP, "").trim();
  return cleaned === "" ? null : cleaned;
}

/**
 * #5973: the valid logins of an `installedOn` array, de-duplicated (case-insensitively, first kept)
 * and capped; undefined when the value is not an array, so the field is omitted.
 */
function toInstalledOn(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const logins: string[] = [];
  for (const entry of raw as unknown[]) {
    if (typeof entry !== "string" || !INSTALLED_ON_LOGIN.test(entry)) continue;
    const key = entry.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    logins.push(entry);
    if (logins.length === MAX_INSTALLED_ON) break;
  }
  return logins;
}

/**
 * Map one broker account entry onto {@link GitHubAccountResult}, keeping only known fields of the
 * right type ("never trust the gateway's shape" — a malformed entry is dropped, not passed on).
 */
function toAccount(raw: unknown): GitHubAccountResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.login !== "string" || r.login === "") return null;
  const account: GitHubAccountResult = {
    login: r.login,
    name: toDisplayName(r.name),
  };
  if (typeof r.email === "string") account.email = r.email;
  if (typeof r.isDefault === "boolean") account.isDefault = r.isDefault;
  const status = asGitHubConnectionStatus(r.status);
  if (status) account.status = status;
  // #6085: kept only when the gateway sent the boolean `true`. Anything else, including a missing
  // field, is treated as checked (an older gateway sends no flag, so it cannot say).
  if (r.statusUnchecked === true) account.statusUnchecked = true;
  const installedOn = toInstalledOn(r.installedOn);
  if (installedOn) account.installedOn = installedOn;
  return account;
}

/**
 * The GitHub accounts the VM's users linked on hapimatic.com (#4793), default first, each with its
 * email, status and default mark, and `statusUnchecked: true` when GitHub did not confirm that
 * status in time (#6085), and its GitHub display name and `installedOn` logins when the gateway sent
 * them (#5973). The WHOLE list: an empty list is a SUCCESS (`ok: true`, no
 * accounts — the Create page then offers "Connect GitHub"), never `broker_unavailable`, which is
 * a real outage (finding 4793-5). The gateway never lists its own credential here (R8).
 */
export async function fetchAccountsViaBroker(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: FetchImpl = fetch
): Promise<GitHubBrokerResult<GitHubAccountResult[]>> {
  const result = await brokerFetch("/accounts", env, fetchImpl);
  return interpretEnvelope(result, e => {
    if (!Array.isArray(e.accounts)) return undefined;
    const accounts = e.accounts
      .map(toAccount)
      .filter((a): a is GitHubAccountResult => a !== null);
    // Default first, order otherwise kept (the gateway already sends them so; this keeps the
    // Create page's "first account" auto-select on the default whatever the gateway's version).
    return [
      ...accounts.filter(a => a.isDefault === true),
      ...accounts.filter(a => a.isDefault !== true),
    ];
  });
}

/**
 * Map one broker repository entry onto {@link GitHubRepoResult} (#6326). A row without a string
 * `nameWithOwner` and `name` is dropped: the picker keys and searches on them. The pre-#6326
 * fields pass through as received; the #6326 fields are kept only when correctly typed, so a
 * skewed gateway can never hide the wrong rows (a string `"true"` is not an archived flag).
 */
function toRepo(raw: unknown): GitHubRepoResult | null {
  if (!raw || typeof raw !== "object") return null;
  const { createdAt, isArchived, isFork, ...rest } = raw as Record<
    string,
    unknown
  >;
  if (typeof rest.nameWithOwner !== "string" || typeof rest.name !== "string") {
    return null;
  }
  const repo = rest as unknown as GitHubRepoResult;
  if (typeof createdAt === "string") repo.createdAt = createdAt;
  if (typeof isArchived === "boolean") repo.isArchived = isArchived;
  if (typeof isFork === "boolean") repo.isFork = isFork;
  return repo;
}

/** Repos accessible to `account` via the broker (mirrors `fetchReposViaRest`). */
export async function fetchReposViaBroker(
  account: string,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: FetchImpl = fetch
): Promise<GitHubBrokerResult<RepoListing>> {
  const result = await brokerFetch(
    `/repos?account=${encodeURIComponent(account)}`,
    env,
    fetchImpl
  );
  return interpretEnvelope(result, e => {
    if (!Array.isArray(e.repos)) return undefined;
    return {
      repos: e.repos
        .map(toRepo)
        .filter((r): r is GitHubRepoResult => r !== null),
      // #6326: an older gateway sends no flag; it cannot say, so the list reads as complete.
      truncated: e.truncated === true,
    };
  });
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
