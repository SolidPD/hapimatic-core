// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Health read token (issue #5444).
 *
 * A per-instance, read-only credential for the operator's monitoring sweep
 * (`infrastructure/cloud-vm/check-cloud-health.sh`). It is accepted ONLY by the
 * health-read routes (`HEALTH_READ_PATHS` in `web/middleware/healthReadAuth.ts`),
 * on GET or HEAD only, and refused by name by the JWT-verifying surfaces (the
 * JWT middleware, the `/terminal` and `/claude-pty` sockets). It never equals
 * `cliApiToken`, so `POST /api/auth` never exchanges it, and it is not a JWT,
 * so it never verifies as a session.
 *
 * Shape: `hhr_` + 32 random bytes, base64url (43 characters). Minted once by
 * this server into `settings.json` (`healthReadToken`, written 0600), separate
 * from `cliApiToken`, so revoking it never touches the owner's sign-in.
 *
 * Revocation is live: the verifier re-reads `settings.json` whenever the file
 * changes (inode, mtime or size), so deleting the key refuses the old value on
 * the next request and replacing it rotates it, with no restart. A restart
 * with the key absent mints a fresh value.
 *
 * The value is never logged and never returned over HTTP.
 */
import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { constantTimeEquals } from "../utils/crypto";
import { getOrCreateSettingsValue } from "./generators";
import { getSettingsFile } from "./settings";

export const HEALTH_READ_TOKEN_PREFIX = "hhr_";

const TOKEN_BYTES = 32;
// base64url of 32 bytes, unpadded, is 43 characters; accept longer bodies so a
// future length increase stays valid.
const TOKEN_BODY = /^[A-Za-z0-9_-]{43,}$/;

export function isHealthReadTokenShape(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(HEALTH_READ_TOKEN_PREFIX) &&
    TOKEN_BODY.test(value.slice(HEALTH_READ_TOKEN_PREFIX.length))
  );
}

export function generateHealthReadToken(): string {
  return (
    HEALTH_READ_TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString("base64url")
  );
}

/**
 * Mint the token into `settings.json` when absent or malformed; keep a valid
 * one. Returns only whether a value was created — never the value itself.
 */
export async function getOrCreateHealthReadToken(
  dataDir: string
): Promise<{ created: boolean }> {
  const result = await getOrCreateSettingsValue({
    settingsFile: getSettingsFile(dataDir),
    readValue: settings =>
      isHealthReadTokenShape(settings.healthReadToken)
        ? { value: settings.healthReadToken }
        : null,
    writeValue: (settings, value) => {
      settings.healthReadToken = value;
    },
    generate: generateHealthReadToken,
  });
  return { created: result.created };
}

export interface HealthReadTokenVerifier {
  /** True only when `token` equals the token currently in `settings.json`. */
  verify(token: string): Promise<boolean>;
}

/**
 * Build a verifier that reads the CURRENT token from `settingsFile`. The file is
 * re-read only when its inode, mtime or size changes; `writeSettings` replaces
 * the file by rename, so every server write is a new inode. A missing,
 * unreadable or unparseable file, or an absent/malformed key, refuses every
 * token. Parse errors are swallowed without logging: their messages can quote
 * file content, and this file holds secrets.
 */
export function createHealthReadTokenVerifier(
  settingsFile: string
): HealthReadTokenVerifier {
  let cacheKey: string | null = null;
  let cachedToken: string | null = null;

  async function currentToken(): Promise<string | null> {
    let key: string;
    try {
      const st = await stat(settingsFile);
      key = `${st.ino}:${st.mtimeMs}:${st.size}`;
    } catch {
      cacheKey = null;
      cachedToken = null;
      return null;
    }
    if (key === cacheKey) return cachedToken;

    let token: string | null = null;
    try {
      const parsed: unknown = JSON.parse(await readFile(settingsFile, "utf8"));
      const value =
        parsed !== null && typeof parsed === "object"
          ? (parsed as { healthReadToken?: unknown }).healthReadToken
          : undefined;
      token = isHealthReadTokenShape(value) ? value : null;
    } catch {
      token = null;
    }
    cacheKey = key;
    cachedToken = token;
    return token;
  }

  return {
    async verify(token: string): Promise<boolean> {
      if (!isHealthReadTokenShape(token)) return false;
      const expected = await currentToken();
      return expected !== null && constantTimeEquals(token, expected);
    },
  };
}
