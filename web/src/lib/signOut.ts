// SPDX-License-Identifier: AGPL-3.0-only
import { buildGatewayLogoutUrl } from "@/lib/ssoStartUrl";

/**
 * Sign this browser out of the instance — Settings → Sign Out's single code path
 * (issue #4897; wired as `onLogout` in `App.tsx`).
 *
 * Always clears the instance access token first (`clearAuth`). On an instance onboarded
 * through the hapimatic.com gateway (`ssoEnabled`, from `/api/version`) it then sends the
 * top-level browser to the gateway's `GET /logout`, which ends the hapimatic.com session
 * (its host-only cookie can only be cleared by an apex response) and lands on the gateway
 * sign-in page. Elsewhere — home instances, worktrees, an older server that omits the
 * flag, or a failed `/api/version` — the instance sign-in page renders in place, exactly
 * as before, and nothing is sent to hapimatic.com.
 *
 * The token is cleared BEFORE navigating so any page that survives the navigation is
 * signed out: an iOS home-screen app opens the out-of-scope apex in an in-app browser
 * sheet over the still-loaded app, and a bfcache Back or a blocked navigation also leaves
 * this page alive.
 *
 * The auth-error banner's "Log In" deliberately does NOT use this: it re-authenticates to
 * THIS instance (its sign-in page keeps the Google return hint), so it stays plain
 * `clearAuth` and never ends the gateway session.
 *
 * @param redirect test seam; defaults to a top-level navigation.
 * @returns the gateway URL navigated to, or `null` when the instance page is kept.
 */
export function signOut({
  ssoEnabled,
  clearAuth,
  redirect = navigateTo,
}: {
  ssoEnabled: boolean;
  clearAuth: () => void;
  redirect?: (url: string) => void;
}): string | null {
  clearAuth();
  if (!ssoEnabled) return null;
  const url = buildGatewayLogoutUrl();
  redirect(url);
  return url;
}

function navigateTo(url: string): void {
  window.location.href = url;
}
