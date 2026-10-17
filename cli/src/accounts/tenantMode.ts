// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Tenant mode for the daemon and the spawn path (issue #4349, E6 Sub A, R3).
 *
 * On a TENANT VM — a customer's cloud VM (`isTenantVm()`, the ONE predicate in
 * `@hapi/protocol/tenantMode`) — Hapimatic must not run its own provider OAuth flow, copy a
 * provider credential into its account store, seed or inject one, or refresh one. The customer
 * signs in inside the VM with the unmodified binary's own `/login`, in a per-account
 * `CLAUDE_CONFIG_DIR`, and every bound session runs with only that `CLAUDE_CONFIG_DIR`.
 *
 * This module is the daemon's single choke point for that decision (`run.ts` reads it once at
 * boot) plus the env scrub it applies, so the gates do not sprawl across `run.ts` and
 * `tokenRefreshService.ts`. The predicate is re-exported here so the cli's tests can force it with
 * one `vi.mock("@/accounts/tenantMode")`.
 */

import {
  isTenantVm as sharedIsTenantVm,
  providerUsageReadAllowed,
} from "@hapi/protocol/tenantMode";

/** True on a tenant VM (tier marker present AND vm-class != operator). */
export function isTenantVm(): boolean {
  return sharedIsTenantVm();
}

/** D10: whether the read-only, VM-local usage/pacing readers may run (`HAPI_TENANT_USAGE_READ=0` = off). */
export function tenantUsageReadAllowed(): boolean {
  return providerUsageReadAllowed(process.env, isTenantVm());
}

/**
 * The provider-credential env vars a tenant daemon removes from its own environment at boot:
 * the SPD-delivered onboarding token(s) the gateway wrote into the VM env file before #4349, and
 * their identity payload. With them gone from `process.env` nothing can seed, hold or inject them,
 * and no tmux server or child the daemon creates inherits them.
 */
export const TENANT_SCRUBBED_ENV_VARS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "HAPI_ONBOARDING_OAUTH_TOKENS",
  "HAPI_ONBOARDING_ACCOUNT_IDENTITY",
] as const;

/**
 * Remove {@link TENANT_SCRUBBED_ENV_VARS} from `env` (the daemon passes `process.env`) and return
 * the NAMES removed — never a value. Idempotent.
 */
export function scrubTenantProviderEnv(
  env: Record<string, string | undefined>
): string[] {
  const removed: string[] = [];
  for (const name of TENANT_SCRUBBED_ENV_VARS) {
    if (env[name] !== undefined) {
      delete env[name];
      removed.push(name);
    }
  }
  return removed;
}

/** The daemon's one-line boot notice (names only, never values). */
export function tenantBootLine(removed: readonly string[]): string {
  return (
    "[TENANT] tenant VM (#4349): provider sign-in happens inside the VM — no Hapimatic login, " +
    "account-store seeding or capture, token injection or refresh" +
    (removed.length > 0
      ? `; ignored SPD-delivered ${removed.join(", ")} from the env file`
      : "")
  );
}

/** The error a tenant spawn raises for a bound account whose own config dir is not signed in. */
export function tenantSignInRequiredMessage(accountUuid: string): string {
  return (
    `Account ${accountUuid} is not signed in on this VM. Open Settings → Provider Accounts, ` +
    "choose Add account under Anthropic, run the command it shows in a session's Terminal tab, " +
    "and type /login (#4349)."
  );
}
