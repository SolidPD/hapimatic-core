// SPDX-License-Identifier: AGPL-3.0-only
import { getStorageKey } from "@/lib/storage-keys";

/**
 * #6211: a Claude sign-in the user left to finish in their browser. On a phone
 * the PWA is often reloaded while the sign-in page is open, so this survives
 * the reload and `account-usage.tsx` reopens the modal. It holds the link and
 * the token that routes it, never the authorization code.
 */
export type PendingSignIn = {
  provider: "anthropic";
  /** `in-vm`: a tenant VM's sign-in, which a new start resumes on the server.
   *  `oauth`: the web login, whose token still names the started login. */
  flow: "in-vm" | "oauth";
  loginToken: string;
  authorizeUrl: string;
  /** Unix epoch ms; past this the entry is dropped unread. */
  expiresAt: number;
};

/** The server's hard limit on a sign-in child (`NATIVE_SIGN_IN_MAX_LIFETIME_MS`). */
export const IN_VM_PENDING_TTL_MS = 15 * 60 * 1000;
/** The server's single-use window on a web login (`LOGIN_TTL_MS`). */
export const OAUTH_PENDING_TTL_MS = 5 * 60 * 1000;

const STORAGE_KEY = "hapi:pending-sign-in:v1";

function isPendingSignIn(value: unknown): value is PendingSignIn {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.provider === "anthropic" &&
    (v.flow === "in-vm" || v.flow === "oauth") &&
    typeof v.loginToken === "string" &&
    typeof v.authorizeUrl === "string" &&
    typeof v.expiresAt === "number"
  );
}

export function clearPendingSignIn(): void {
  try {
    localStorage.removeItem(getStorageKey(STORAGE_KEY));
  } catch {
    // Storage unavailable: nothing was kept.
  }
}

export function writePendingSignIn(entry: PendingSignIn): void {
  try {
    localStorage.setItem(getStorageKey(STORAGE_KEY), JSON.stringify(entry));
  } catch {
    // Storage full or disabled: the sign-in still works, it just cannot resume.
  }
}

export function readPendingSignIn(now = Date.now()): PendingSignIn | null {
  let parsed: unknown;
  try {
    const raw = localStorage.getItem(getStorageKey(STORAGE_KEY));
    if (!raw) return null;
    parsed = JSON.parse(raw);
  } catch {
    clearPendingSignIn();
    return null;
  }
  if (!isPendingSignIn(parsed) || parsed.expiresAt <= now) {
    clearPendingSignIn();
    return null;
  }
  return parsed;
}
