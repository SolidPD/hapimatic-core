// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes, randomUUID } from "node:crypto";

/**
 * Anthropic OAuth login client — PKCE authorization-code flow for issue #1263
 * (web-initiated "add a new Claude account").
 *
 * The wire contract is reimplemented from Claude Code's
 * `services/oauth/client.ts` (the source mirror is reference only — a different
 * build, not importable), the same way `cli/src/accounts/tokenRefreshService.ts`
 * reimplements `refreshOAuthToken` and `cli/src/accounts/oauthProfile.ts`
 * reimplements the profile fetch. This is the `authorization_code` SIBLING of
 * the refresh service's `refresh_token` grant — same `TOKEN_URL`, `CLIENT_ID`,
 * and scope set.
 *
 * Lives in the SERVER package (not `cli/`) because the login flow runs
 * server-side (issue #1263, Option B): the server holds the short-lived PKCE
 * state and calls `AccountService.add()`. The server already touches token
 * values (it reads full `StoredAccount` records to redact them for every
 * `GET /api/accounts`), so this introduces no new token-handling boundary.
 *
 * Security: token values (`access`/`refresh`) and the PKCE `code_verifier`
 * NEVER appear in a thrown message or log line — only HTTP-status /
 * OAuth-error-code strings.
 */

// --- Verified production constants (Claude Code `constants/oauth.ts`) -----------
/** Claude.ai-subscriber authorize endpoint (Pro/Max — the `loginWithClaudeAi` path). */
const AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
/** OAuth token endpoint (shared with the refresh grant). */
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
/** Anthropic-hosted manual paste-back redirect (the code-display page). */
const MANUAL_REDIRECT_URL = "https://platform.claude.com/oauth/code/callback";
/** OAuth profile endpoint (Bearer access token). */
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
/** Public OAuth client id for Claude Code — a PKCE public client (no secret). */
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
/** Login scope set — matches Claude Code's `ALL_OAUTH_SCOPES` (console ∪ claude.ai). */
const SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
];
const REQUEST_TIMEOUT_MS = 15_000;
const PROFILE_TIMEOUT_MS = 10_000;

/** Narrow `fetch` shape — a test double satisfies it without the full signature. */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export interface PkceMaterial {
  verifier: string;
  challenge: string;
  state: string;
}

/** base64url (RFC 4648 §5, no padding). */
function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Generate PKCE material: a URL-safe `verifier` (base64url of 32 random bytes,
 * 43 chars), its S256 `challenge` (base64url of SHA-256(verifier)), and a random
 * `state` nonce for CSRF binding.
 */
export function generatePkce(): PkceMaterial {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = randomUUID();
  return { verifier, challenge, state };
}

/**
 * Build the authorize URL for the manual paste-back flow. Param order mirrors
 * Claude Code's `buildAuthUrl`: `code`, `client_id`, `response_type`,
 * `redirect_uri` (manual), `scope`, `code_challenge`, `code_challenge_method=S256`,
 * `state`.
 */
export function buildAuthorizeUrl(params: {
  challenge: string;
  state: string;
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.append("code", "true");
  url.searchParams.append("client_id", CLIENT_ID);
  url.searchParams.append("response_type", "code");
  url.searchParams.append("redirect_uri", MANUAL_REDIRECT_URL);
  url.searchParams.append("scope", SCOPES.join(" "));
  url.searchParams.append("code_challenge", params.challenge);
  url.searchParams.append("code_challenge_method", "S256");
  url.searchParams.append("state", params.state);
  return url.toString();
}

/** Failure of the OAuth exchange. `code` is non-secret (status / oauth-error). */
export class OauthLoginError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "OauthLoginError";
    this.code = code;
  }
}

export interface ExchangedTokens {
  accessToken: string;
  refreshToken: string;
  /** Unix epoch ms. */
  expiresAt: number;
  scopes: string[];
  /** Identity carried in the token response (`data.account`); may be null. */
  accountUuid: string | null;
  emailAddress: string | null;
}

interface TokenExchangeResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  account?: { uuid?: string; email_address?: string };
}

export interface ExchangeOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * Exchange an authorization code for tokens (`grant_type=authorization_code`).
 * The POST body mirrors Claude Code's `exchangeCodeForTokens`. The response also
 * carries `account.{uuid,email_address}` and the granted `scope` string.
 *
 * The paste-back value is conventionally `<code>#<state>`; the caller splits it
 * (see `AccountLoginService.complete`) and passes the bare `code` here.
 *
 * Throws {@link OauthLoginError} on any failure — never echoes the code,
 * verifier, or a token value.
 */
export async function exchangeCodeForTokens(
  params: { code: string; verifier: string; state: string },
  opts: ExchangeOptions = {}
): Promise<ExchangedTokens> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const now = opts.now ?? Date.now;

  let res: Response;
  try {
    res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code: params.code,
        redirect_uri: MANUAL_REDIRECT_URL,
        client_id: CLIENT_ID,
        code_verifier: params.verifier,
        state: params.state,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Report only the error NAME — never the message (could echo request data).
    throw new OauthLoginError(
      `token exchange request failed: ${err instanceof Error ? err.name : "unknown error"}`,
      "network"
    );
  }

  if (!res.ok) {
    let errCode = "";
    try {
      const body = (await res.json()) as { error?: string };
      errCode = body?.error ?? "";
    } catch {
      // Body absent or not JSON — the status alone classifies the failure.
    }
    const detail = `HTTP ${res.status}${errCode ? ` (${errCode})` : ""}`;
    throw new OauthLoginError(
      `token exchange rejected: ${detail}`,
      res.status === 400 || res.status === 401
        ? "invalid_code"
        : "exchange_failed"
    );
  }

  const data = (await res.json()) as TokenExchangeResponse;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? "",
    expiresAt: now() + data.expires_in * 1000,
    scopes: data.scope ? data.scope.split(" ").filter(Boolean) : [],
    accountUuid: data.account?.uuid ?? null,
    emailAddress: data.account?.email_address ?? null,
  };
}

export interface OauthProfile {
  accountUuid: string | null;
  emailAddress: string | null;
  displayName: string;
  organizationUuid: string;
  organizationName: string;
}

interface OauthProfileResponse {
  account?: { uuid?: string; email_address?: string; display_name?: string };
  organization?: { uuid?: string; name?: string };
}

/**
 * Fetch the OAuth profile for identity enrichment (display name + organization).
 * Mirrors the wire contract of `cli/src/accounts/oauthProfile.ts`. Returns
 * `null` on ANY failure so the caller can fall back to the token response's
 * `account` fields. NEVER logs the access token.
 */
export async function fetchOauthProfile(
  accessToken: string,
  opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {}
): Promise<OauthProfile | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? PROFILE_TIMEOUT_MS;
  try {
    const res = await fetchImpl(PROFILE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as OauthProfileResponse;
    return {
      accountUuid: body.account?.uuid ?? null,
      emailAddress: body.account?.email_address ?? null,
      displayName: body.account?.display_name ?? "",
      organizationUuid: body.organization?.uuid ?? "",
      organizationName: body.organization?.name ?? "",
    };
  } catch {
    return null;
  }
}
