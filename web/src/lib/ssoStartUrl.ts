// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Build the gateway OAuth-start URL for the instance-page "Sign in with Google"
 * button (issue #2650).
 *
 * The instance UI is served from a `*.hapimatic.com` subdomain (or a `.ts.net` /
 * localhost host in dev), while Google OAuth starts on the APEX gateway
 * (`hapimatic.com`). So the redirect MUST be an absolute cross-origin URL — a
 * relative `/oauth/google/start` would hit the instance, not the gateway.
 *
 * R2 (optional return-to-instance hint): when the page is on a single-label
 * `*.hapimatic.com` instance host, append `?return=<subdomain>` so a user with
 * multiple instances is routed back to the ORIGINATING instance after auth. The
 * gateway treats the hint as ADVISORY only — it disambiguates among the instances
 * the signed-in email already owns and never grants one it does not
 * (`gateway/src/routes/oauth.ts` reuses `findSelectable`, the #2309 R3 allowlist
 * check). The apex, `www`, multi-label, `.ts.net`, and localhost hosts get the
 * bare start URL (no meaningful hapimatic.com subdomain to return to).
 */
const APEX = "hapimatic.com";
const SSO_START_BASE = `https://${APEX}/oauth/google/start`;

/** A single DNS label: 1-63 chars of lowercase alphanumerics/hyphens. */
const DNS_LABEL = /^[a-z0-9-]{1,63}$/;

export function buildSsoStartUrl(hostname: string): string {
  const host = hostname.toLowerCase();
  // Only an instance subdomain of the apex carries a meaningful return hint.
  if (host === APEX || host === `www.${APEX}` || !host.endsWith(`.${APEX}`)) {
    return SSO_START_BASE;
  }
  const label = host.slice(0, host.length - `.${APEX}`.length);
  // Require exactly one DNS label (a multi-label host like `a.b.hapimatic.com`
  // has no single return subdomain — fall back to the bare start URL).
  if (!DNS_LABEL.test(label)) {
    return SSO_START_BASE;
  }
  return `${SSO_START_BASE}?return=${encodeURIComponent(label)}`;
}

/**
 * Build the gateway onboarding-wizard ("Restart onboarding") URL (issue #2711).
 *
 * The Admin → Preferences "Restart onboarding" control REOPENS the gateway `/setup`
 * wizard. Re-entry already works by URL — the wizard renders current state and honors
 * `?step=X` (`resolveCurrentStep`) — so this helper produces the absolute apex-gateway
 * `/setup` URL to navigate to; it clears NO state.
 *
 * Like `buildSsoStartUrl`, the setup wizard lives on the APEX gateway (`hapimatic.com`),
 * so the URL is ALWAYS the absolute apex `/setup` regardless of the instance host — the
 * helper CANNOT tell that a self-hosted / `.ts.net` / localhost host has no gateway and
 * will hand back the apex URL anyway. That is exactly why the caller MUST gate this behind
 * the runtime `ssoEnabled` flag (#2312, R4): an ungated control would send a
 * non-gateway-managed user to a gateway that never provisioned them.
 *
 * `hostname` is accepted for signature parallelism with `buildSsoStartUrl` and forward-
 * compat with a per-instance gateway origin (option (b), #2711); today every host resolves
 * to the apex `/setup`.
 */
export function buildGatewaySetupUrl(hostname: string, step?: string): string {
  void hostname; // reserved for a future per-instance gateway origin (option (b), #2711)
  const base = `https://${APEX}/setup`;
  return step ? `${base}?step=${encodeURIComponent(step)}` : base;
}

/**
 * Build the gateway sign-out URL (issue #4897).
 *
 * Settings → Sign Out on a gateway-onboarded instance must end the hapimatic.com session
 * too, not just this instance's. The gateway's session cookie is host-only on the apex
 * (no Domain attribute), so only a response from `hapimatic.com` can delete it: its
 * `GET /logout` clears that cookie plus the OAuth cookies and 302s to the gateway
 * sign-in entry (`/login` with the public site on). Targeting `/login` directly would
 * leave the gateway session alive, and the gateway owns which sign-in path it serves.
 *
 * Like `buildGatewaySetupUrl`, this always resolves to the apex and cannot tell that a
 * host has no gateway, so the caller MUST gate it behind the runtime `ssoEnabled` flag
 * (#2312) — see `web/src/lib/signOut.ts`.
 */
export function buildGatewayLogoutUrl(): string {
  return `https://${APEX}/logout`;
}
