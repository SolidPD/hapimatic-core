// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Parse a decrypted porter secret bundle without echoing its content (#5543).
 *
 * Both callers of `decryptPorterArchive` — `planImport` (plan time) and
 * `rebuildMcpItems` (commit time) — parse the decrypted plaintext through here.
 * Neither the JSON parser's error text nor zod's may reach an error message,
 * because both can carry bundle content: Bun's `JSON.parse` echoes an unquoted
 * token verbatim (`JSON Parse error: Unexpected identifier "<token>"`), and zod 4
 * names record KEYS in an issue's `path`. Those messages flow into HTTP bodies,
 * the error log and Sentry.
 *
 * So a refusal carries one of two FIXED reasons and the parser's error object
 * never leaves this function — no message, no `cause` chain. Each caller throws
 * its own error class with the reason: `SecretDecryptionError` (400) at plan
 * time, a plain `Error` (500 after the rollback) at commit time.
 *
 * The decrypt step needs the same treatment: age-encryption reports a member
 * that is not age-encrypted as `invalid version <its first line>`, so a
 * plaintext `secrets.age` puts the secret text into the error. Both callers map
 * a decrypt failure through {@link decryptFailureReason}.
 */
import {
  McpSecretBundleSchema,
  type McpSecretBundle,
} from "@hapi/protocol/porter";
import { PORTER_KEY_MISSING } from "../config/porterAgeKeys";

/** The decrypted bytes are not valid JSON. */
export const SECRET_BUNDLE_NOT_JSON =
  "decrypted secret bundle is malformed (not valid JSON)";

/** The decrypted bytes are valid JSON but not a server → slot → value map. */
export const SECRET_BUNDLE_BAD_SHAPE =
  "decrypted secret bundle is malformed (not a map of server names to secret slots)";

/**
 * A refusal reason: one of the fixed strings above, so the compiler rejects a
 * reason built from an error message.
 */
export type SecretBundleRefusal =
  | typeof SECRET_BUNDLE_NOT_JSON
  | typeof SECRET_BUNDLE_BAD_SHAPE;

/** `secrets.age` is age-encrypted, but not to this instance's porter key. */
export const SECRETS_WRONG_RECIPIENT =
  "secrets.age is not encrypted to this instance's Configuration Porter key";

/** `secrets.age` is not a readable age file (plaintext, truncated, corrupt). */
export const SECRETS_NOT_DECRYPTABLE =
  "secrets.age is not a valid age-encrypted file";

/** age-encryption's own (input-free) message for a wrong-recipient file. */
const AGE_NO_MATCHING_IDENTITY =
  "no identity matched any of the file's recipients";

/** A decrypt refusal reason: fixed text only, never the decrypter's message. */
export type SecretDecryptRefusal =
  | typeof SECRETS_WRONG_RECIPIENT
  | typeof SECRETS_NOT_DECRYPTABLE
  | typeof PORTER_KEY_MISSING;

/**
 * Map a `decryptPorterArchive` failure to a fixed reason. Two known
 * input-free messages keep their meaning; anything else — including
 * `invalid version <first line>` — becomes {@link SECRETS_NOT_DECRYPTABLE}, so
 * a library wording change can only make the reason more generic.
 */
export function decryptFailureReason(err: unknown): SecretDecryptRefusal {
  const message = err instanceof Error ? err.message : "";
  if (message === AGE_NO_MATCHING_IDENTITY) return SECRETS_WRONG_RECIPIENT;
  if (message === PORTER_KEY_MISSING) return PORTER_KEY_MISSING;
  return SECRETS_NOT_DECRYPTABLE;
}

/** {@link parseSecretBundle} result: the bundle, or a fixed refusal reason. */
export type SecretBundleParse =
  | { ok: true; bundle: McpSecretBundle }
  | { ok: false; reason: SecretBundleRefusal };

/** Parse and validate decrypted secret-bundle bytes; never echoes their content. */
export function parseSecretBundle(plaintext: Uint8Array): SecretBundleParse {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(plaintext).toString("utf-8"));
  } catch {
    return { ok: false, reason: SECRET_BUNDLE_NOT_JSON };
  }
  const parsed = McpSecretBundleSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: SECRET_BUNDLE_BAD_SHAPE };
  return { ok: true, bundle: parsed.data };
}
