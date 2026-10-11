// SPDX-License-Identifier: AGPL-3.0-only
import { logger } from "@/ui/logger";
import type { ResolvedIdentity } from "@/accounts/credentialsWatcher";

/**
 * OAuth profile-fetch fallback for account auto-capture (issue #1449, Sub-Issue
 * C of epic #1446 — Option-3 hybrid local-first).
 *
 * The watcher's PRIMARY identity source is local (`~/.claude.json`
 * `oauthAccount`); this network fetch is the FALLBACK used only when local
 * identity is absent (e.g. login mid-flight). Mirrors Claude Code's own profile
 * call (CC source `services/oauth/getOauthProfile.ts`) — that file is NOT
 * importable from this repo, so the wire contract is reimplemented here (the
 * same way Sub-Issue B reimplements the token-refresh call).
 *
 * Security: NEVER logs the access token or any response token field (R10).
 * Returns `null` on ANY failure (network / timeout / non-2xx / missing uuid) so
 * the caller treats it as "identity unresolvable → skip gracefully" (R7).
 */

/** OAuth profile endpoint (Bearer access token). Verified from Claude Code source. */
const OAUTH_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const DEFAULT_TIMEOUT_MS = 10_000;

/** Shape of the `/api/oauth/profile` response fields this consumes (CC source). */
interface OauthProfileResponse {
  account?: {
    uuid?: string;
    email_address?: string;
    display_name?: string;
  };
  organization?: {
    uuid?: string;
    name?: string;
  };
}

export async function fetchOauthProfile(
  accessToken: string,
  opts?: { timeoutMs?: number; fetchImpl?: typeof fetch }
): Promise<ResolvedIdentity | null> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = opts?.fetchImpl ?? fetch;

  try {
    const res = await doFetch(OAUTH_PROFILE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      logger.debug(
        `[OAUTH_PROFILE] profile fetch returned ${res.status}; treating identity as unresolved`
      );
      return null;
    }

    const body = (await res.json()) as OauthProfileResponse;
    const accountUuid = body.account?.uuid;
    if (!accountUuid) {
      logger.debug(
        "[OAUTH_PROFILE] profile response missing account.uuid; identity unresolved"
      );
      return null;
    }

    return {
      accountUuid,
      emailAddress: body.account?.email_address,
      displayName: body.account?.display_name,
      organizationUuid: body.organization?.uuid,
      // organization.name coverage is inconsistent in the profile response; the
      // local read is the authoritative source for organizationName. Leaving it
      // undefined here is an acceptable degraded fallback.
      organizationName: body.organization?.name,
    };
  } catch (err) {
    logger.debug(
      `[OAUTH_PROFILE] profile fetch failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}
