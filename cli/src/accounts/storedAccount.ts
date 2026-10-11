// SPDX-License-Identifier: AGPL-3.0-only
import {
  validateStoredAccount,
  type StoredAccount,
  type ValidateAccountResult,
} from "@hapi/protocol/accounts";

/**
 * CLI-side serialization surface for stored accounts.
 *
 * The schema + types are the single source of truth in `@hapi/protocol/accounts`
 * (shared) — this module re-exports them (so CLI code has one import site) and
 * adds the CLI-only serialize/deserialize helpers. The schema is NOT redefined
 * here (avoids drift between two copies).
 */
export * from "@hapi/protocol/accounts";

/**
 * Serialize a StoredAccount to its on-disk JSON representation (pretty-printed,
 * matching the repo convention for human-inspectable config files).
 */
export function serializeAccount(account: StoredAccount): string {
  return JSON.stringify(account, null, 2);
}

/**
 * Parse + validate a raw per-account file body. Never throws — a JSON syntax
 * error OR a schema-validation failure both return `{ok:false,error}` so the
 * `AccountStore` (and downstream callers) can skip-or-surface a malformed
 * record rather than crash (issue #1447 R6). This is the CLI-side "structured
 * error type" surface referenced by the issue's acceptance criteria.
 */
export function deserializeAccount(raw: string): ValidateAccountResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return validateStoredAccount(parsed);
}
