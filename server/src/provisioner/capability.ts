// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Capability gate (issue #2468, R6 — inert on user VMs).
 *
 * The same binary ships to operator RP1 and to user cloud VMs. The provisioner
 * module must stay INERT (no init, no unit spawn) unless BOTH:
 *   1. the `HAPI_VM_ADMIN` env flag is truthy, AND
 *   2. a runtime preflight confirms the `~/.oci` credentials, the provisioning
 *      scripts, and the provisioning secret env (names only) exist.
 *
 * DEFAULT CLOSED. The verdict carries a human `reason` so Sub B can surface WHY
 * the panel is disabled (env-gated, default-disabled config idiom mirrors
 * `server/src/config/githubWebhookConfig.ts` / `workflowReconcileConfig.ts`).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { ALL_SCRIPT_REL_PATHS } from "./jobModel";

/** The capability env flag (truthy → provisioner may enable). */
export const PROVISIONER_ENV = "HAPI_VM_ADMIN";

/**
 * OCI credential files (relative to the home dir) the scripts require at
 * runtime. `provision.sh` / `oci-create-vm.sh` read both; the capability
 * preflight checks the SAME paths so a disabled reason is accurate.
 *
 * Known limitation (issue #2933, F4): `.oci/hapimatic-infra.env` is checked here
 * at its LITERAL home-relative path, whereas the store-union scan (third stage)
 * resolves the same file through the `HAPIMATIC_INFRA_ENV` override. So a caller
 * that relocates infra.env via the override still needs the default path to
 * exist for THIS creds check — the two resolution rules only diverge under a
 * non-default override (a test/dev knob), and both fail CLOSED, so the
 * inconsistency is benign for the real operator (default paths).
 */
export const REQUIRED_CREDS: readonly string[] = [
  ".oci/config",
  ".oci/hapimatic-infra.env",
];

/**
 * Env-var NAMES the provisioning control plane requires UNCONDITIONALLY — the
 * exact set `scripts/provision.sh`'s top-level `require_env` demands
 * (provision.sh:196-197), cross-validated against the operator-env evidence in
 * `claudedocs/issue-2335-operator-env-evidence.md`. This is deliberately NOT the
 * log-masking list (`PROVISION_SECRET_ENV_NAMES` in `./logMasking`), which is
 * intentionally over-inclusive: it names per-run-minted secrets
 * (`VM_HANDOFF_SECRET`, `FEEDBACK_RELAY_TOKEN`) that can never pre-exist, and a
 * name no script consumes (`OCI_CLI_KEY_CONTENT`). Conditional secrets
 * (`--federate` → `FEDERATION_TOKEN`; `--deploy-gateway` → the GOOGLE_* / gateway
 * set) are validated PER-JOB by `provision.sh`'s own guards, never at capability
 * level. Reusing the masking list here inverted its contract and fail-closed the
 * gate on the operator host (issue #2933).
 */
export const REQUIRED_PROVISION_ENV_NAMES: readonly string[] = [
  "CF_API_TOKEN",
  "CF_ZONE_ID",
  "USER_SSH_PUBKEY",
  "GATEWAY_REGISTRATION_TOKEN",
  "HAPI_GOOGLE_HANDOFF_SECRET",
  "GATEWAY_URL",
];

/**
 * A provisioning-secret env STORE: a file whose NAMES the capability preflight
 * unions, plus the `HAPIMATIC_*` override env var that can relocate it (loader
 * parity with `scripts/lib/load-provision-env.sh:47-50`).
 */
export interface ProvisionEnvStore {
  /** `HAPIMATIC_*` override env var that relocates this store. */
  readonly overrideEnv: string;
  /** Default path relative to the home dir when the override is unset/blank. */
  readonly defaultRelPath: string;
}

/**
 * The provisioning-secret env STORES whose UNION the capability preflight scans
 * for the required NAMES — mirroring the unconditional no-gateway store union
 * `scripts/lib/load-provision-env.sh` sources (`_hapi_protected_load
 * "$_HAPI_INFRA_ENV" "$_HAPI_PROVISION_ENV" "$_HAPI_CLOUDFLARE_ENV"`,
 * load-provision-env.sh:112). The OLD single-file check (only
 * `.oci/hapimatic-provision.env`) modeled a DIFFERENT env assembly than the
 * runtime it guards, so required names that legitimately live in the cloudflare
 * store (`CF_API_TOKEN` / `CF_ZONE_ID`) read as "missing" and the gate
 * fail-closed on the operator host (issue #2933). The conditional gateway-secrets
 * store is DELIBERATELY absent — it loads only under `--deploy-gateway`
 * (load-provision-env.sh Key Decision 1), so requiring it would fail every
 * no-gateway run.
 */
export const PROVISION_ENV_STORES: readonly ProvisionEnvStore[] = [
  {
    overrideEnv: "HAPIMATIC_INFRA_ENV",
    defaultRelPath: ".oci/hapimatic-infra.env",
  },
  {
    overrideEnv: "HAPIMATIC_PROVISION_ENV",
    defaultRelPath: ".oci/hapimatic-provision.env",
  },
  {
    overrideEnv: "HAPIMATIC_CLOUDFLARE_ENV",
    defaultRelPath: ".bashrc.d/96-cloudflare.sh",
  },
];

const TRUTHY = new Set(["1", "true", "yes"]);

/**
 * Truthy iff the raw value is exactly `1` / `true` / `yes` (case-insensitive,
 * NOT trimmed) — matches the house env-flag idiom
 * (`porterPluginInstallConfig.ts`). `undefined`, blank, `0`, `on`, `y`, and a
 * whitespace-padded ` true ` are all falsey.
 */
export function isEnvFlagTruthy(raw: string | undefined): boolean {
  return raw !== undefined && TRUTHY.has(raw.toLowerCase());
}

export interface CapabilityVerdict {
  enabled: boolean;
  /** Human-readable reason (surfaced by #2469 when disabled). */
  reason: string;
  /**
   * When the provisioning secret env is present but missing required NAMES, the
   * absent names (names only — never a secret value). Set ONLY on that
   * fail-closed path; absent otherwise (issue #2551, R3).
   */
  missingEnvNames?: readonly string[];
}

export interface CapabilityDeps {
  /** Env source (default: process.env). */
  env?: Record<string, string | undefined>;
  /** Existence probe (default: node:fs existsSync) — injectable for tests. */
  fileExists?: (path: string) => boolean;
  /** Home dir for credential resolution (default: os.homedir()). */
  homeDir?: string;
  /** Repo root the scripts live under (resolved by the factory). */
  repoRoot: string;
  /** Scripts required to exist (default: every script the module can invoke). */
  requiredScripts?: readonly string[];
  /** Credential files required to exist (default: {@link REQUIRED_CREDS}). */
  requiredCreds?: readonly string[];
  /**
   * Reads a provisioning secret env STORE's raw text (default: node:fs
   * readFileSync, utf8) — injectable for tests. Called once per store in
   * {@link PROVISION_ENV_STORES}; only NAMES are parsed from the returned text, a
   * value is never stored in the verdict.
   */
  readEnvFile?: (path: string) => string;
  /**
   * Required provisioning secret env NAMES (default:
   * {@link REQUIRED_PROVISION_ENV_NAMES} — provision.sh's unconditional
   * `require_env` set, NOT the over-inclusive masking list). Issue #2933.
   */
  requiredEnvNames?: readonly string[];
  /**
   * The provisioning-secret env STORES whose union is scanned for the required
   * NAMES (default: {@link PROVISION_ENV_STORES} — the unconditional no-gateway
   * store union `load-provision-env.sh` sources). Issue #2933.
   */
  provisionEnvStores?: readonly ProvisionEnvStore[];
}

/**
 * Extract the env-var NAMES declared with a NON-EMPTY value in a provisioning
 * secret env store's raw text — NEVER the values. Matches an `export NAME=` or
 * bare `NAME=` at line start (leading whitespace tolerated), skipping comment
 * (`#`) and blank lines. A trailing `(?=\S)` lookahead requires a non-whitespace
 * character after `=`, so a bare `NAME=` (empty value) counts the name as ABSENT
 * — mirroring `require_env`'s non-empty `[ -n "${!v:-}" ]` check
 * (provision-helpers.sh:206-211; issue #2933, ER S-3). The capture group is the
 * name only; the value to the right is never captured into a group, read into a
 * variable, or stored — the hard "names only" constraint (R2/R3) enforced at the
 * parse layer, not just the surface layer (the lookahead tests one char without
 * binding it).
 */
function parseProvisionEnvNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    const match = line.match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=\s*(?=\S)/
    );
    if (match) names.add(match[1]);
  }
  return names;
}

/**
 * Evaluate the capability verdict. Read at call time (never cached at module
 * load) so a test — or a live re-check — sees the current env + filesystem.
 * Fails CLOSED on the first missing prerequisite, in this order:
 * flag → credentials → scripts → provisioning secret env.
 */
export function evaluateCapability(deps: CapabilityDeps): CapabilityVerdict {
  const env = deps.env ?? process.env;
  const fileExists = deps.fileExists ?? existsSync;
  const homeDir = deps.homeDir ?? homedir();
  const requiredScripts = deps.requiredScripts ?? ALL_SCRIPT_REL_PATHS;
  const requiredCreds = deps.requiredCreds ?? REQUIRED_CREDS;

  if (!isEnvFlagTruthy(env[PROVISIONER_ENV])) {
    return {
      enabled: false,
      reason: `${PROVISIONER_ENV} not set (default: disabled)`,
    };
  }

  for (const cred of requiredCreds) {
    const path = join(homeDir, cred);
    if (!fileExists(path)) {
      return {
        enabled: false,
        reason: `required OCI credential missing: ${path}`,
      };
    }
  }

  for (const script of requiredScripts) {
    const path = join(deps.repoRoot, script);
    if (!fileExists(path)) {
      return {
        enabled: false,
        reason: `provisioning script missing: ${path}`,
      };
    }
  }

  // Third stage (issue #2551, rewritten for #2933): the required NAMES must be
  // present across the UNION of the same unconditional stores
  // `load-provision-env.sh` sources for a no-gateway run — infra ∪ provision ∪
  // cloudflare, each honoring its HAPIMATIC_* override. The required set is
  // provision.sh's unconditional `require_env` (REQUIRED_PROVISION_ENV_NAMES),
  // NOT the over-inclusive masking list. Fails CLOSED on either leg:
  //   (a) any store FILE is absent — mirrors load-provision-env.sh:64's
  //       `[ -f "$f" ] || die`: every job hard-dies at Phase 0 without all three
  //       stores, so an open gate MUST imply all three exist; OR
  //   (b) a required NAME is absent from the store union.
  // NAME presence resolves from the on-disk stores ONLY, never `process.env`: the
  // panel's jobs run as `systemd-run --user` transient units with no env
  // forwarding, so a name present only in the server's process env is invisible
  // to the job (issue #2933, ER S-2). `env` is still consulted for the
  // HAPIMATIC_* override PATHS below.
  const readEnvFile =
    deps.readEnvFile ?? ((path: string) => readFileSync(path, "utf8"));
  const stores = deps.provisionEnvStores ?? PROVISION_ENV_STORES;

  const presentNames = new Set<string>();
  for (const store of stores) {
    // `||` (not `??`) mirrors the loader's `${HAPIMATIC_*:-default}`: a blank
    // override falls back to the default path (load-provision-env.sh:47-50).
    const storePath =
      env[store.overrideEnv] || join(homeDir, store.defaultRelPath);
    if (!fileExists(storePath)) {
      return {
        enabled: false,
        reason: `provisioning secret env store missing: ${storePath}`,
      };
    }
    let storeText: string;
    try {
      storeText = readEnvFile(storePath);
    } catch {
      // Present per existsSync but unreadable (perms/race) — fail CLOSED rather
      // than throw out of the preflight (default-closed doctrine).
      return {
        enabled: false,
        reason: `provisioning secret env store unreadable: ${storePath}`,
      };
    }
    for (const name of parseProvisionEnvNames(storeText))
      presentNames.add(name);
  }

  const requiredEnvNames =
    deps.requiredEnvNames ?? REQUIRED_PROVISION_ENV_NAMES;
  const missingEnvNames = requiredEnvNames.filter(
    name => !presentNames.has(name)
  );
  if (missingEnvNames.length > 0) {
    return {
      enabled: false,
      reason: `provisioning secret env missing required name(s): ${missingEnvNames.join(", ")}`,
      missingEnvNames,
    };
  }

  return { enabled: true, reason: "enabled" };
}

/** Convenience boolean form of {@link evaluateCapability}. */
export function isProvisionerEnabled(deps: CapabilityDeps): boolean {
  return evaluateCapability(deps).enabled;
}
