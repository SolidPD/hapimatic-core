// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { ApiError, NetworkError, RequestTimeoutError } from "@/api/client";
import { Button } from "@/components/ui/button";

export const INPUT_CLASS =
  "w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)]";

/** Issue #4349: a failed check that should not end the wait (rate limit,
 *  server error, network, or the request's own timeout — #5467 S2: one slow
 *  answer must not end a sign-in that may still finish). */
export function isTransientCheckError(err: unknown): boolean {
  if (err instanceof ApiError) return err.status === 429 || err.status >= 500;
  return (
    !(err instanceof Error) ||
    err instanceof NetworkError || // #5409: ApiClient tags fetch failures
    err instanceof RequestTimeoutError ||
    err.name === "TypeError"
  );
}

export function errCode(err: unknown): string | undefined {
  return err instanceof ApiError ? err.code : undefined;
}

export function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function CopyButton(props: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(props.text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard unavailable — the text is still selectable.
        }
      }}
    >
      {copied ? "Copied" : props.label}
    </Button>
  );
}
