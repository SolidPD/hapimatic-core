// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Live-log secret masking (issue #2471, epic #2467 Sub D — R4).
 *
 * The provisioning scripts already mask secrets in `--dry-run` transcripts (via
 * `with_dry_run` / `mask_secrets` in `scripts/lib/provision-helpers.sh`). A LIVE
 * (non-dry-run) job, however, writes RAW script output to its per-job log file —
 * systemd appends the unit's bytes directly, so the server never touches them in
 * flight and pre-persistence masking is structurally impossible (the at-rest log
 * file's protection is its 0600/0700 mode, filed against #2468; #2473 verifies
 * the at-rest file on a real run). This module masks at the ONE place the server
 * DOES touch the bytes: the SSE-emit / transcript-read boundary in
 * `web/routes/adminVms.ts` — before a line is streamed to (or returned to) the
 * operator.
 *
 * ## Redaction is layered (defense-in-depth) — over-masking is the safe failure
 *
 * A leaked infra credential requires rotation across the tailnet / DNS zone /
 * fleet, so this redactor deliberately errs toward masking too much:
 *
 *   1. **Value-based** — exact-substring redaction of KNOWN secret values, sourced
 *      from the operator's `~/.oci/hapimatic-infra.env` and the fleet inventory's
 *      per-VM `access_token`s (see {@link parseSecretEnvValues} /
 *      {@link parseInventoryAccessTokens}). Length-gated (≥ {@link MIN_VALUE_LEN})
 *      to mirror the bash `mask_secrets` `${#val} >= 6` guard.
 *   2. **NAME=value** — redacts the value that follows any secret env-var NAME
 *      (`TS_AUTHKEY=…`, `CF_API_TOKEN: …`). This is the ONLY server-side masking
 *      that reaches the "unmaskable-by-value" class ({@link UNMASKABLE_BY_VALUE}):
 *      `VM_HANDOFF_SECRET` and the mid-provision minted `cliApiToken` are generated
 *      per-run inside the script and are unknowable server-side. Their live-path
 *      protection is script discipline, verified in #2473 — this NAME=value pass is
 *      an additional net, NOT a proof for that class.
 *   3. **Pattern** — the exact secret shapes the bash `mask_secrets` masks:
 *      Tailscale pre-auth keys, `Bearer <tok>`, and `--auth-key/--token/--api-token
 *      <val>` flag values.
 *   4. **Entropy** — bare high-entropy tokens not tied to a known name/flag: 41+
 *      char base64url runs (catches the ~41-char `cliApiToken` class documented in
 *      the repo's hygiene audit, while sparing 40-char git SHAs) and 64-hex strings.
 *
 * Layers 2–4 need no secret values, so masking still fires on a non-operator
 * instance or in a test where `infra.env` is absent.
 */

/**
 * Canonical secret env-var NAME list — mirrors the single bash source of truth
 * `PROVISION_SECRET_ENV_NAMES` in `scripts/lib/provision-helpers.sh` (the
 * cloud-init / provisioning scripts read these from the environment). Kept as ONE
 * definition here (imported by the tests and the secret-handling proof) rather
 * than hand-copied per file. A drift between this list and the bash list can only
 * UNDER-name a secret; the NAME=value + entropy layers still catch its value.
 *
 * ⚠️ do not reuse as a requirements list — this list is intentionally
 * over-inclusive for MASKING: it names per-run-minted secrets
 * (`VM_HANDOFF_SECRET`; the bash list additionally has `FEEDBACK_RELAY_TOKEN`)
 * that can never pre-exist, and a name no provisioning script consumes
 * (`OCI_CLI_KEY_CONTENT`). Using it to decide what must EXIST before provisioning
 * inverts its contract and fail-closes the capability gate. The gate's required
 * set is `REQUIRED_PROVISION_ENV_NAMES` in `./capability` (issue #2933). Note the
 * bash-only masking names (`FEEDBACK_RELAY_TOKEN`, `GATEWAY_SECRET_ENCRYPTION_KEY`,
 * `GATEWAY_SECRET_ENCRYPTION_KEY_OLD`, and #4804's `GATEWAY_CAMPAIGN_STATS_TOKEN`,
 * minted as 64 hex characters) are caught server-side by the entropy layer, not by
 * name — this list under-naming them does not leak their values. #5744's
 * `GATEWAY_FEEDBACK_OPERATOR_TOKEN` is bash-only because only `provision-gateway.sh`
 * renders the gateway env; the server provisioner never handles it. #4929's
 * `SUDO_MODEL_PASSWORD_HASH` is bash-only for a different reason: the server
 * provisioner never handles it (the operator's S3 password hash is read from an RP1
 * file by `provision.sh` / `reconcile-vm.sh` alone).
 */
export const PROVISION_SECRET_ENV_NAMES = [
  "CF_API_TOKEN",
  "TS_AUTHKEY",
  "GATEWAY_REGISTRATION_TOKEN",
  "HAPI_GOOGLE_HANDOFF_SECRET",
  "VM_HANDOFF_SECRET",
  "GATEWAY_SESSION_SECRET",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_CLIENT_ID",
  "OCI_CLI_KEY_CONTENT",
  "FEDERATION_TOKEN",
] as const;

/**
 * The full masking name set: the 10 provisioning secrets plus `TS_API_KEY`, which
 * is deprovision-only (`scripts/deprovision.sh` adds it to its own copy of the
 * list) and appears in NEITHER the base bash list nor the AC's enumerated set —
 * masked here for completeness per the R4 refinement.
 */
export const ADMIN_VM_SECRET_ENV_NAMES = [
  ...PROVISION_SECRET_ENV_NAMES,
  "TS_API_KEY",
] as const;

/**
 * Secrets whose VALUE cannot be known server-side (generated per-run inside the
 * script) — masked ONLY by the NAME=value + entropy layers, never value-based.
 * Their live-path protection is verified against a real run in #2473; this list
 * documents the boundary so a passing fixture test is not misread as proof for
 * this class. (The mid-provision minted `cliApiToken` has no fixed env-var name,
 * so it is covered by the entropy layer alone.)
 */
export const UNMASKABLE_BY_VALUE = ["VM_HANDOFF_SECRET"] as const;

/** The redaction placeholder (matches the bash `mask_secrets` sentinel). */
export const MASK = "***MASKED***";

/**
 * Minimum length for value-based redaction — mirrors the bash guard
 * `[ "${#val}" -ge 6 ]`. Prevents a short/empty secret value from masking the
 * entire line to noise.
 */
export const MIN_VALUE_LEN = 6;

// ── Pattern layer (mirrors scripts/lib/provision-helpers.sh mask_secrets) ─────
const RE_TSKEY = /tskey-[A-Za-z0-9_-]+/g;
const RE_BEARER = /(Bearer )[A-Za-z0-9._~+/=-]+/g;
const RE_AUTH_KEY_FLAG = /(--auth-key[= ])[^ ]+/g;
const RE_TOKEN_FLAG = /(--token[= ])[^ ]+/g;
const RE_API_TOKEN_FLAG = /(--api-token[= ])[^ ]+/g;

// ── Entropy layer (new — bare tokens not adjacent to a known name/flag) ───────
// 41+ char base64url runs: catches the ~41-char cliApiToken class (hygiene audit)
// and 43-char (32-byte) tokens, while a 40-char git SHA survives. 64-hex covers
// SHA-256 / session-secret shapes. Boundaries via lookaround so a token embedded
// in surrounding punctuation (=, /, quotes) is still bounded correctly.
const RE_B64URL_ENTROPY =
  /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{41,}(?![A-Za-z0-9_-])/g;
const RE_HEX64_ENTROPY = /(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/g;

/** Escape a string for safe interpolation into a `RegExp`. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Precompiled NAME=value / NAME: value matchers, one per secret env-var name.
// `(\bNAME\s*[=:]\s*)(\S+)` → keep the name+separator, mask the value token.
const NAME_VALUE_PATTERNS: readonly RegExp[] = ADMIN_VM_SECRET_ENV_NAMES.map(
  name => new RegExp(`(\\b${escapeRegExp(name)}\\s*[=:]\\s*)(\\S+)`, "g")
);

/**
 * Redact secrets from ONE log line (layers 1–4 in order). `secretValues` are the
 * known literal secret strings (from `infra.env` + inventory `access_token`s);
 * pass an empty iterable to rely on the value-independent layers alone.
 *
 * The line must NOT contain a newline (call per-line, or use {@link maskSecretText}
 * for a multi-line blob) — the flag patterns match `[^ ]+`, which would otherwise
 * span a line break.
 */
export function maskSecretLine(
  line: string,
  secretValues: Iterable<string>
): string {
  let s = line;

  // 1) Known literal secret values — exact substring, length-gated.
  for (const val of secretValues) {
    if (val.length >= MIN_VALUE_LEN && s.includes(val)) {
      s = s.split(val).join(MASK); // literal replace-all (no regex escaping)
    }
  }

  // 2) NAME=value / NAME: value for every secret env-var name.
  for (const re of NAME_VALUE_PATTERNS) {
    s = s.replace(re, `$1${MASK}`);
  }

  // 3) Provisioning secret patterns (bash mask_secrets parity).
  s = s
    .replace(RE_TSKEY, MASK)
    .replace(RE_BEARER, `$1${MASK}`)
    .replace(RE_AUTH_KEY_FLAG, `$1${MASK}`)
    .replace(RE_TOKEN_FLAG, `$1${MASK}`)
    .replace(RE_API_TOKEN_FLAG, `$1${MASK}`);

  // 4) Bare high-entropy tokens (already-masked placeholders are too short to match).
  s = s.replace(RE_B64URL_ENTROPY, MASK).replace(RE_HEX64_ENTROPY, MASK);

  return s;
}

/**
 * Mask a multi-line blob (e.g. a dry-run transcript) line by line — the correct
 * form for {@link maskSecretLine}, which must not see a newline.
 */
export function maskSecretText(
  text: string,
  secretValues: Iterable<string>
): string {
  return text
    .split("\n")
    .map(line => maskSecretLine(line, secretValues))
    .join("\n");
}

/**
 * Parse an env file (`KEY=value` / `export KEY=value`, optionally quoted) and
 * return the VALUES of the known secret names ({@link ADMIN_VM_SECRET_ENV_NAMES})
 * whose value is at least {@link MIN_VALUE_LEN} long. Unknown keys, comments, and
 * blank lines are ignored. Never throws.
 */
export function parseSecretEnvValues(envFileText: string): string[] {
  const names = new Set<string>(ADMIN_VM_SECRET_ENV_NAMES);
  const values: string[] = [];
  for (const rawLine of envFileText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    if (!names.has(key)) continue;
    let val = m[2].trim();
    if (
      val.length >= 2 &&
      ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'")))
    ) {
      val = val.slice(1, -1);
    }
    if (val.length >= MIN_VALUE_LEN) values.push(val);
  }
  return values;
}

/**
 * Collect the per-VM `access_token` values from the fleet inventory JSON (a
 * top-level array of records). Only string tokens of at least {@link MIN_VALUE_LEN}
 * are returned; malformed JSON yields an empty list (never throws).
 */
export function parseInventoryAccessTokens(inventoryText: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inventoryText);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const tokens: string[] = [];
  for (const record of parsed) {
    if (record == null || typeof record !== "object") continue;
    const token = (record as Record<string, unknown>).access_token;
    if (typeof token === "string" && token.length >= MIN_VALUE_LEN) {
      tokens.push(token);
    }
  }
  return tokens;
}
