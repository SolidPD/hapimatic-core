// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Google SSO handoff exchange route (issue #1003, D999-5a).
 *
 * This route mints NO JWT and creates NO users. It is an ACCESS-TOKEN EXCHANGE:
 * the SSO gateway (hapimatic.com) redirects the browser here with a single-use,
 * 60s handoff token; this instance verifies it and hands back the SAME instance
 * access token the manual token-paste flow uses (`configuration.cliApiToken`).
 * The web app's existing `useAuth`/`useAuthSource` replay loop then exchanges that
 * access token for a 15-minute JWT via `POST /api/auth` — entirely unchanged.
 *
 * Two methods share the path `/api/auth/google/handoff`:
 *   GET  -> serves a tiny exchange page whose inline JS POSTs the token back,
 *           writes the returned access token to localStorage, and redirects to /.
 *   POST -> verifies the handoff token (signature + freshness + allowlist +
 *           single-use jti) and returns `{ accessToken }`.
 *
 * Both return 503 when `configuration.googleHandoffSecret` is null (feature off).
 */

import { Hono } from "hono";
import { jwtVerify, type JWTPayload } from "jose";
import { z } from "zod";
import { configuration } from "../../configuration";
import { isEmailAllowed } from "../../utils/userAllowlist";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";
import type { WebAppEnv } from "../middleware/auth";
import type { ErrorLogger } from "../../logging/errorLogger";

const HANDOFF_TTL_SECONDS = 60;
const CLOCK_TOLERANCE_SECONDS = 5;

/** Claims carried by the gateway's handoff JWT (validated after signature check). */
const handoffPayloadSchema = z.object({
  email: z.string(),
  sub: z.string(),
  jti: z.string(),
  iat: z.number(),
  exp: z.number(),
});

const postBodySchema = z.object({
  token: z.string().min(1),
});

/**
 * The exchange page. Framework-free, < 2 KB. Its inline JS reads the handoff token
 * from the URL fragment (`#token=`, #2649 R2), falling back to `?token=` for the
 * dual-channel rollout window, POSTs it back to the same path, writes the returned
 * access token to localStorage under the EXACT key `useAuthSource` reads
 * (`hapi_access_token::<origin>` — see web/src/hooks/useAuthSource.ts), then
 * `location.replace("/")`. On failure it shows the error and a "Back to sign in"
 * link to `signInHref` (see {@link signInHrefFor}). The inline JS uses string
 * concatenation (not template literals) intentionally; the one `${}` below
 * interpolates a developer constant, JSON-quoted (no request data, so no XSS
 * surface).
 */
function exchangePageHtml(signInHref: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Signing you in…</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #1c1c1e; color: #e5e5e7;
         display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { text-align: center; max-width: 26rem; padding: 2rem; line-height: 1.6; }
  h1 { color: #4ade80; font-size: 1.25rem; }
  a { color: #5ae6ab; }
</style>
</head>
<body>
  <div class="card"><p id="msg">Signing you in…</p></div>
  <script>
  (function () {
    // #2649 (R2): the gateway now delivers the handoff token in the URL FRAGMENT
    // (a leading #token=), which is never sent to the server — so it can't leak into
    // origin / Cloudflare access logs or a Referer header. Read the fragment first,
    // then fall back to the ?token= query so an instance still reached with the query
    // during a gateway rollout keeps working (dual-channel).
    function readHandoffToken() {
      var fromHash = new URLSearchParams(
        location.hash ? location.hash.slice(1) : ""
      ).get("token");
      if (fromHash) return fromHash;
      return new URLSearchParams(location.search).get("token");
    }
    var token = readHandoffToken();
    // Once captured, drop the token from the URL bar / current history entry so the
    // fragment does not linger in browser history (defense-in-depth on top of moving
    // it off the query string). The token var already holds the value; best-effort.
    if (token) {
      try {
        history.replaceState(null, "", location.pathname);
      } catch (e) {
        /* history API unavailable; harmless */
      }
    }
    // Render the mint-themed error card (issue #2313) so the POST-surfaced
    // failure states (invalid / expired / replayed / not-allowlisted) present a
    // branded, navigable page — matching the server-rendered errorPage() card.
    function fail(text) {
      var card = document.querySelector(".card");
      card.textContent = "";
      var h = document.createElement("h1");
      h.textContent = "Sign-in failed";
      var p = document.createElement("p");
      p.textContent = text;
      var linkP = document.createElement("p");
      var a = document.createElement("a");
      a.href = ${JSON.stringify(signInHref)};
      a.textContent = "Back to sign in";
      linkP.appendChild(a);
      card.appendChild(h);
      card.appendChild(p);
      card.appendChild(linkP);
    }
    // #2634: the handoff exchange must be IDEMPOTENT across reloads. The token is
    // single-use (consumed by the first successful exchange) and the fragment is cleared
    // by the replaceState above — so any reload / double-navigation of this page (a Safe
    // Browsing interstitial's proceed-reload, a manual refresh, a link prefetch, an
    // aggressive extension) re-runs it with NO token, or with a now-consumed token. Without
    // this guard that renders a "Sign-in failed" card even though sign-in already SUCCEEDED.
    // If a prior exchange already stored an access token for this origin, treat the reload
    // as signed-in and go to the app instead of showing a failure.
    function alreadySignedIn() {
      try {
        return !!localStorage.getItem("hapi_access_token::" + location.origin);
      } catch (e) {
        return false;
      }
    }
    if (!token) {
      if (alreadySignedIn()) { location.replace("/"); return; }
      fail("Missing sign-in token.");
      return;
    }
    fetch(location.pathname, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: token })
    }).then(function (res) {
      if (!res.ok) {
        // #2634: a 401 on a reload is the single-use token being REPLAYED after a prior
        // successful exchange — not a genuine failure. If we already hold an access token
        // for this origin, the earlier exchange won: go to the app, not the error card.
        if (res.status === 401 && alreadySignedIn()) { location.replace("/"); return; }
        return res.json().catch(function () { return {}; }).then(function (body) {
          fail(body && body.error ? body.error : ("Sign-in failed (" + res.status + ")."));
        });
      }
      return res.json().then(function (data) {
        try {
          localStorage.setItem("hapi_access_token::" + location.origin, data.accessToken);
        } catch (e) { /* storage disabled; the redirect below will show the login prompt */ }
        location.replace("/");
      });
    }).catch(function () { fail("Sign-in failed. Please try again."); });
  })();
  </script>
</body>
</html>`;
}

const APP_BG = "#1c1c1e";
const BRAND_ACCENT = "#4ade80"; // gateway --brand-accent
const APP_LINK = "#5ae6ab"; // gateway --app-link
// #4697 (#4543 T3): the gateway serves its sign-in page at /login in both public-site
// modes (gateway/src/routes/landing.ts createLandingRoutes); "/" is the public site's
// home once GATEWAY_PUBLIC_SITE=on.
const GATEWAY_SIGN_IN_URL = "https://hapimatic.com/login";
/** This instance's own sign-in page (the web app's LoginPrompt). */
const INSTANCE_SIGN_IN_PATH = "/";

/**
 * Where a sign-in card's "Back to sign in" link goes (#4697). Only an instance onboarded
 * through the hapimatic.com gateway (`ssoEnabled`: the same `configuration.googleOAuthEnabled`
 * that `/api/version` reports) returns to the gateway sign-in page. A home instance has no
 * hapimatic.com account to return to, so it keeps its own sign-in page. Fail-safe like
 * web/src/lib/signOut.ts (#4897): anything but an explicit `true` stays on the instance.
 */
export function signInHrefFor(ssoEnabled: boolean): string {
  return ssoEnabled === true ? GATEWAY_SIGN_IN_URL : INSTANCE_SIGN_IN_PATH;
}

/**
 * A framework-free branded error card for the browser-facing GET error states
 * (issue #2313). Mirrors the gateway's landing.ts errorPage() styling
 * (brand accent + app bg) but is implemented instance-side — the instance
 * cannot import gateway code. No CSP <meta>: the instance sets no CSP header
 * and the sibling exchange page (which needs inline JS) omits it too. String
 * concatenation by design, matching exchangePageHtml(). Only developer-supplied
 * constants are interpolated (no request data) — no XSS surface.
 */
function errorPage(
  heading: string,
  message: string,
  signInHref: string
): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${heading}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: ${APP_BG}; color: #e5e5e7;
         display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { text-align: center; max-width: 26rem; padding: 2rem; line-height: 1.6; }
  h1 { color: ${BRAND_ACCENT}; font-size: 1.25rem; }
  a { color: ${APP_LINK}; }
</style>
</head>
<body>
  <div class="card">
    <h1>${heading}</h1>
    <p>${message}</p>
    <p><a href="${signInHref}">Back to sign in</a></p>
  </div>
</body>
</html>`;
}

export function createGoogleOAuthRoutes(
  errorLogger?: ErrorLogger | null
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  // Single-use jti replay cache (in-memory, per server process). A handoff token
  // redirects to exactly ONE instance, so per-process enforcement is sufficient;
  // a restart resets the set (acceptable — the replay window is the original 60s).
  const usedJti = new Set<string>();

  app.get(
    "/auth/google/handoff",
    cataloged(
      defineCapability({
        id: "accounts.google-handoff-page",
        domain: "accounts",
        surface: "rest",
        description:
          "Serve the framework-free Google SSO handoff exchange page whose inline script posts the handoff token back and stores the returned access token.",
        whenToUse:
          "When the SSO gateway redirects a signed-in browser to this instance.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/auth/google/handoff",
        },
        auth: "none",
        // #3837 R12 (never-readonly class): the SSO handoff exchange page whose
        // inline script posts the handoff token and stores the returned access
        // token — an auth-flow surface, never safe to auto-invoke. [ER 2026-09-19: D17]
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    c => {
      // #4697: read per request (the configuration Proxy resolves lazily).
      const signInHref = signInHrefFor(configuration.googleOAuthEnabled);
      // Browser-facing GET error states render a branded, navigable page instead
      // of bare JSON (issue #2313 — the #2095 dead-end fix). The POST exchange
      // below keeps its JSON { error } contract for the inline JS.
      // #2276: SSO handoff is unavailable when EITHER the handoff secret is absent (feature
      // off) OR this instance has no configured audience (rollout Stage 3 fail-closed).
      // Surface the branded 503 here rather than serving the exchange page only to 503 on
      // its POST-back.
      if (
        configuration.googleHandoffSecret === null ||
        configuration.handoffAudience === null
      ) {
        return c.html(
          errorPage(
            "Sign-in unavailable",
            "Google sign-in isn't available on this instance right now.",
            signInHref
          ),
          503
        );
      }
      // #2649 (R2): the handoff token now arrives in the URL FRAGMENT (`#token=`), which is
      // never sent to the server — so a token-less query is the EXPECTED shape here, not an
      // error. Serve the exchange page unconditionally (the feature is enabled past the 503
      // guard above); its inline JS reads location.hash first and falls back to ?token=
      // (dual-channel: an instance still reached with ?token= during the gateway rollout keeps
      // working). A truly token-less load (neither fragment nor query) is surfaced client-side
      // by the fail("Missing sign-in token.") card. The POST exchange below is UNCHANGED and
      // performs all signature / freshness / jti / aud / allowlist verification.
      c.header("Cache-Control", "no-store");
      return c.html(exchangePageHtml(signInHref));
    }
  );

  app.post(
    "/auth/google/handoff",
    cataloged(
      defineCapability({
        id: "accounts.google-handoff-exchange",
        domain: "accounts",
        surface: "rest",
        description:
          "Verify a single-use Google SSO handoff token (signature, freshness, audience, allowlist, replay) and return this instance's access token.",
        whenToUse:
          "When the handoff page exchanges its token for an instance access token.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/auth/google/handoff",
        },
        auth: "none",
        riskTier: "mutating",
        availability: { scope: "user" },
        probe: "skip",
      })
    ),
    async c => {
      // #2276: fail closed when EITHER the handoff secret is absent (feature off) OR this
      // instance has no configured audience. An unset audience is the guaranteed initial
      // state of every instance until the fleet is provisioned (rollout Stage 2), so
      // enforcing with a null audience would either skip the check (leaving the replay hole
      // open) or 401 every handoff — a 503 makes the misconfiguration loud.
      const secret = configuration.googleHandoffSecret;
      const expectedAudience = configuration.handoffAudience;
      if (secret === null || expectedAudience === null) {
        return c.json({ error: "Google OAuth disabled" }, 503);
      }

      const json = await c.req.json().catch(() => null);
      const parsedBody = postBodySchema.safeParse(json);
      if (!parsedBody.success) {
        return c.json({ error: "Missing handoff token" }, 400);
      }

      let payload: JWTPayload;
      try {
        const verified = await jwtVerify(
          parsedBody.data.token,
          new TextEncoder().encode(secret),
          {
            algorithms: ["HS256"],
            // #2276: reject a missing or mismatched `aud`. jose throws
            // JWTClaimValidationFailed (caught below -> 401) when the token's `aud` is
            // absent or != this instance's expectedAudience — reusing the existing
            // verify-failure path with no new branch. R4: a matching `aud` still passes.
            audience: expectedAudience,
            maxTokenAge: `${HANDOFF_TTL_SECONDS}s`,
            clockTolerance: `${CLOCK_TOLERANCE_SECONDS}s`,
          }
        );
        payload = verified.payload;
      } catch (error) {
        errorLogger?.warn("Google handoff token verification failed", {
          category: "auth",
          statusCode: 401,
          context: {
            error: error instanceof Error ? error.message : String(error),
          },
        });
        return c.json({ error: "Invalid handoff token" }, 401);
      }

      const parsedClaims = handoffPayloadSchema.safeParse(payload);
      if (!parsedClaims.success) {
        return c.json({ error: "Invalid handoff token" }, 401);
      }
      const { email, jti, iat } = parsedClaims.data;

      // Explicit future-iat guard: jose's maxTokenAge rejects tokens that are too
      // OLD but NOT a future-dated iat (now - iat < 0 passes). Reject here.
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (iat > nowSeconds + CLOCK_TOLERANCE_SECONDS) {
        return c.json({ error: "Invalid handoff token" }, 401);
      }

      // Single-use enforcement.
      if (usedJti.has(jti)) {
        return c.json({ error: "Handoff token already used" }, 401);
      }

      // Allowlist enforcement (fail-closed).
      if (
        !isEmailAllowed(email, {
          emails: configuration.googleAllowlistEmails,
          domains: configuration.googleAllowlistDomains,
        })
      ) {
        errorLogger?.warn("Google handoff rejected: email not on allowlist", {
          category: "auth",
          statusCode: 403,
        });
        return c.json({ error: "Account not authorized" }, 403);
      }

      // Mark the token used and schedule eviction after its max lifetime (+ skew).
      usedJti.add(jti);
      const evict = setTimeout(
        () => usedJti.delete(jti),
        (HANDOFF_TTL_SECONDS + CLOCK_TOLERANCE_SECONDS) * 1000
      );
      // Do not keep the event loop alive for a short-lived eviction timer.
      (evict as unknown as { unref?: () => void }).unref?.();

      errorLogger?.info("Google handoff exchange succeeded", {
        category: "auth",
      });

      c.header("Cache-Control", "no-store");
      // The instance access token — the SAME credential the manual paste flow
      // validates (a bare base token implies DEFAULT_NAMESPACE). No JWT minted here.
      return c.json({ accessToken: configuration.cliApiToken });
    }
  );

  return app;
}
