// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";
import { homedir } from "node:os";
import { configuration } from "../../configuration";
import { VERSION, VERSION_TIMESTAMP } from "../../version.generated";
import { desktopTierAllowed, readVmTier } from "../desktopProxy";

export interface VersionInfo {
  version: string;
  timestamp: string;
  /**
   * The daemon user's home directory (#2269 F18). The web Create page uses this as the
   * Directory fallback when there are no recent paths — on a user VM the daemon runs as
   * `hapimatic`, yielding `/home/hapimatic` instead of an empty placeholder. Operator
   * instances are unaffected in practice: the recent-paths pre-fill takes precedence.
   */
  defaultDirectory: string;
  /**
   * Runtime Google SSO gate (#2312). True when the instance can complete the Google
   * handoff exchange — i.e. `HAPI_GOOGLE_HANDOFF_SECRET` is set, which is
   * `configuration.googleOAuthEnabled`. Cloud VMs set the secret (via provision.sh's
   * 20-handoff.conf drop-in) so it is `true` there; home instances (RP1/RP2/SL7) never
   * set it so it is `false`. Consumed by LoginPrompt (via useVersion) to show/hide the
   * "Sign in with Google" button — replacing the build-time `VITE_HAPI_SSO_ENABLED`
   * flag so ONE binary serves both home and cloud.
   */
  ssoEnabled: boolean;
  /**
   * Whether THIS instance can serve a web desktop (#2693 Decision A: the VM tier
   * must be desktop-eligible — Pro-and-up; a home instance has no VM tier marker
   * so this is `false` there). Mirrors the exact gate `authenticateDesktopUpgrade`
   * applies, so the View Picker greys the Desktop tab instead of letting the
   * user open a view that can only error (epic #3285 correction pass 1).
   */
  desktopEligible: boolean;
}

export function createVersionRoutes(): Hono {
  const app = new Hono();

  // No auth required for version endpoint
  app.get(
    "/version",
    cataloged(
      defineCapability({
        id: "harness-admin.version",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Return this node's Hapimatic + Claude Code version info (public, unauthenticated).",
        whenToUse: "When a client checks the running version.",
        invocation: { kind: "rest", method: "GET", path: "/api/version" },
        auth: "none",
        riskTier: "readonly",
        availability: { scope: "user" },
        telemetry: "off",
      })
    ),
    c => {
      return c.json({
        version: VERSION,
        timestamp: VERSION_TIMESTAMP,
        defaultDirectory: homedir(),
        // Read the singleton per-request (the `configuration` Proxy resolves lazily via
        // getConfiguration(); a module-load read would throw before startup init).
        ssoEnabled: configuration.googleOAuthEnabled,
        desktopEligible: desktopTierAllowed(readVmTier()),
      });
    }
  );

  return app;
}
