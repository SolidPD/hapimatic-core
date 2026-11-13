// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError } from "@/api/client";

/**
 * Pull the server's human message out of an `ApiError`.
 *
 * Shared by the admin mutation hooks (`useVmJobActions`,
 * `useExtensionPrefActions`) that surface a server rejection to the user.
 *
 * `ApiError.body` is the raw response TEXT (not a parsed object) and `.message`
 * is the `HTTP <status> <statusText>: <body>` composite — neither is presentable
 * on its own. The admin routes return a JSON `{ error }` body (e.g. the
 * admin-VM `buildJob` allowlist rejection, the deprovision typed-subdomain
 * mismatch, an expired confirmation token, or the extension-prefs
 * `required_at_build` / `unknown_extension` rejections); prefer that verbatim
 * message, appending the error `code` when present. Fall back to the code / raw
 * message for a non-JSON or empty body.
 *
 * A non-`ApiError` value degrades to its `Error.message` (or `String(err)`).
 */
export function apiErrorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) {
    return err instanceof Error ? err.message : String(err);
  }
  const serverMessage = apiErrorServerMessage(err);
  if (serverMessage) {
    return err.code ? `${serverMessage} (${err.code})` : serverMessage;
  }
  return err.code ? `${err.message} (${err.code})` : err.message;
}

/**
 * The server's own message in an `ApiError`'s JSON `{ error }` body, verbatim,
 * or `undefined` when there is none (not an `ApiError`, no body, a non-JSON
 * body, or no string `error`). Issue #6617 (D7-1): the permission-mode picker
 * shows it as is. It never appends the `code`, because `request()` fills `code`
 * from the same `error` string when the body has no `code` field, and
 * {@link apiErrorMessage} would then show the text twice.
 */
export function apiErrorServerMessage(err: unknown): string | undefined {
  if (!(err instanceof ApiError) || !err.body) return undefined;
  try {
    const parsed = JSON.parse(err.body) as { error?: unknown };
    return typeof parsed.error === "string" && parsed.error.length > 0
      ? parsed.error
      : undefined;
  } catch {
    // Non-JSON body: no server message.
    return undefined;
  }
}
