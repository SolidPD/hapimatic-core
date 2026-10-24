// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError } from "@/api/client";

/**
 * #4284 — the text the import review shows for a failed plan or commit. A porter
 * refusal arrives as an `ApiError` whose message is the transport envelope
 * (`HTTP 409 Conflict: {"error":…}`); the operator should read the body's
 * `error` sentence instead. Display-only: `ApiError.message` itself stays
 * byte-identical, because other callers regex-parse it (#1720).
 *
 * Returns the body's `error` when `err` is an `ApiError` whose body parses to an
 * object with a non-empty string `error`; otherwise `err.message`, or `fallback`
 * when there is no message. No other body field is read: the `registryMissing`
 * and `symlinkedSettings` extras belong to their own gates.
 */
export function porterErrorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.body) {
    let body: unknown;
    try {
      body = JSON.parse(err.body);
    } catch {
      body = null;
    }
    const error = (body as { error?: unknown } | null)?.error;
    if (typeof error === "string" && error !== "") return error;
  }
  return err instanceof Error && err.message ? err.message : fallback;
}
