// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useAccountLogin } from "@/hooks/mutations/useAccountActions";
import type { ApiClient } from "@/api/client";
import type { RedactedAccount } from "@/types/api";

export type AddAccountWizardProps = {
  isOpen: boolean;
  onClose: () => void;
  api: ApiClient | null;
  /** Fired with the new account after a successful login. */
  onAdded?: (account: RedactedAccount) => void;
};

/**
 * Local pre-check (#3452): a digits-only paste is the shape of the 6-digit
 * sign-in code claude.com emails during login — never an authorization code.
 * Catching it here keeps the single-use login session alive so the user can
 * paste the real code without starting over.
 */
export const NOT_AN_AUTHORIZATION_CODE_HINT =
  "That looks like the 6-digit sign-in code claude.com emailed you. That code " +
  "belongs on the claude.com sign-in page, not here. Finish signing in there, " +
  "click Authorize, then copy the long authorization code shown on the " +
  "platform.claude.com page and paste that here (the whole thing, including " +
  "the part after #).";

/**
 * Web-initiated OAuth login wizard (issue #1263). Drives the two-step PKCE flow
 * entirely in the browser: on open it requests the Anthropic authorize URL,
 * the user signs in (or uses "Switch account" to add a different one) and
 * copies the authorization code, then pastes it here to complete the login. On
 * success the new account is added to the roster (the accounts query is
 * invalidated by `useAccountLogin`) and `onAdded` fires.
 *
 * No Claude SDK / LLM call is involved — this is the static recovery affordance
 * that replaces the prior "run `claude /login` on the host" instructions.
 */
export function AddAccountWizard({
  isOpen,
  onClose,
  api,
  onAdded,
}: AddAccountWizardProps) {
  const { start, complete, isStarting, isCompleting } = useAccountLogin(api);
  const [loginToken, setLoginToken] = useState<string | null>(null);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Local input hint (no server call was made) — rendered without "Start over".
  const [hint, setHint] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Guards against React 19 strict-mode double-invoke firing `start()` twice.
  const startedRef = useRef(false);

  const beginFlow = async () => {
    setError(null);
    setHint(null);
    setCode("");
    setLoginToken(null);
    setAuthorizeUrl(null);
    setCopied(false);
    try {
      const res = await start();
      setLoginToken(res.loginToken);
      setAuthorizeUrl(res.authorizeUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start login.");
    }
  };

  useEffect(() => {
    if (!isOpen) {
      startedRef.current = false;
      setLoginToken(null);
      setAuthorizeUrl(null);
      setCode("");
      setError(null);
      setHint(null);
      setCopied(false);
      return;
    }
    if (startedRef.current) return;
    startedRef.current = true;
    void beginFlow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const handleCopy = async () => {
    if (!authorizeUrl) return;
    try {
      await navigator.clipboard.writeText(authorizeUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (e.g. insecure context) — the link is still
      // tappable, so this is a non-fatal convenience failure.
    }
  };

  const handleSubmit = async () => {
    if (!loginToken || !code.trim()) return;
    setError(null);
    setHint(null);
    if (/^\d+$/.test(code.trim())) {
      setHint(NOT_AN_AUTHORIZATION_CODE_HINT);
      return;
    }
    try {
      const account = await complete({ loginToken, code: code.trim() });
      onAdded?.(account);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed.");
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a Claude account</DialogTitle>
          <DialogDescription>
            Sign in to Anthropic in your browser, approve access, then paste the
            authorization code Anthropic shows you back here. No desktop access
            required. Finish within 5 minutes of opening this dialog.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 p-1 text-sm text-[var(--app-fg)]">
          {isStarting && !authorizeUrl ? (
            <p className="text-[var(--app-hint)]">Preparing sign-in…</p>
          ) : authorizeUrl ? (
            <>
              <ol className="list-decimal space-y-2 pl-5 text-[var(--app-hint)]">
                <li>
                  Open the Anthropic sign-in page:
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <a
                      href={authorizeUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="break-all text-[var(--app-link)] underline"
                    >
                      Open sign-in page
                    </a>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleCopy}
                    >
                      {copied ? "Copied" : "Copy link"}
                    </Button>
                  </div>
                </li>
                <li>
                  Sign in. To add a different account than the one already
                  signed in, use the “Switch account” link on that page. If
                  claude.com emails you a 6-digit code, enter it there on
                  claude.com — not here.
                </li>
                <li>
                  Click Authorize. Anthropic then shows a long authorization
                  code on a platform.claude.com page. Copy the whole code and
                  paste it below right away — it works once and expires in a few
                  minutes.
                </li>
              </ol>

              <div className="flex flex-col gap-1">
                <label htmlFor="oauth-code" className="font-medium">
                  Authorization code
                </label>
                <input
                  autoCapitalize="none"
                  id="oauth-code"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={code}
                  onChange={e => setCode(e.target.value)}
                  placeholder="Paste the whole code, including the part after #"
                  className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)]"
                />
                <p className="text-xs text-[var(--app-hint)]">
                  The long code from the platform.claude.com page after you
                  approve access — not the 6-digit sign-in code from your email.
                </p>
              </div>

              {hint && (
                <div
                  role="status"
                  className="rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-2 text-[var(--app-fg)]"
                >
                  {hint}
                </div>
              )}

              {error && (
                <div className="rounded-md bg-red-900/20 p-2 text-red-400">
                  {error}{" "}
                  <Button
                    type="button"
                    variant="ghostStatic"
                    onClick={() => void beginFlow()}
                    className="h-auto p-0 font-normal text-red-400 underline hover:text-red-400"
                  >
                    Start over
                  </Button>
                </div>
              )}

              <div className="flex justify-end gap-2">
                <Button type="button" variant="secondary" onClick={onClose}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={handleSubmit}
                  disabled={!code.trim() || isCompleting}
                >
                  {isCompleting ? "Adding…" : "Add account"}
                </Button>
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="rounded-md bg-red-900/20 p-2 text-red-400">
                {error ?? "Could not start sign-in."}
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => void beginFlow()}
              >
                Try again
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
