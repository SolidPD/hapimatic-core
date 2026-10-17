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
import {
  useAccountLogin,
  useInVmAccountLogin,
} from "@/hooks/mutations/useAccountActions";
import { ApiError, type ApiClient } from "@/api/client";
import {
  IN_VM_SIGN_IN_REQUIRED,
  type InVmLoginStartResponse,
  type RedactedAccount,
} from "@/types/api";

/** Issue #4349: how often the in-VM panel asks whether `/login` has finished. */
const IN_VM_CHECK_INTERVAL_MS = 4000;

/** Issue #4349: a failed check that should not end the wait (rate limit, server error, network). */
function isTransientCheckError(err: unknown): boolean {
  if (err instanceof ApiError) return err.status === 429 || err.status >= 500;
  return !(err instanceof Error) || err.name === "TypeError";
}

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
  // Issue #4349: on a tenant VM the user signs in inside the VM with Claude Code's own /login.
  const inVmLogin = useInVmAccountLogin(api);
  const [inVm, setInVm] = useState<InVmLoginStartResponse | null>(null);
  const [inVmCopied, setInVmCopied] = useState(false);
  const [inVmChecking, setInVmChecking] = useState(false);
  // Registered = the account was added (never cancel it). Stopped = a final error ended the wait.
  const inVmRegisteredRef = useRef(false);
  const inVmStoppedRef = useRef(false);
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
    // #4349: "Start over" forgets the previous in-VM sign-in (its dir is removed only while empty).
    // Await it: the server resumes an unfinished sign-in, so a start sent first would resume the
    // one being cancelled. (cancel never throws; a failed one leaves that sign-in resumable.)
    if (inVm && !inVmRegisteredRef.current)
      await inVmLogin.cancel(inVm.loginToken);
    setInVm(null);
    inVmRegisteredRef.current = false;
    inVmStoppedRef.current = false;
    try {
      const res = await start();
      setLoginToken(res.loginToken);
      setAuthorizeUrl(res.authorizeUrl);
    } catch (err) {
      // #4349: a tenant VM answers in_vm_sign_in_required — switch to the in-VM sign-in.
      if (err instanceof ApiError && err.code === IN_VM_SIGN_IN_REQUIRED) {
        try {
          setInVm(await inVmLogin.start());
        } catch (inner) {
          setError(
            inner instanceof Error ? inner.message : "Failed to start sign-in."
          );
        }
        return;
      }
      setError(err instanceof Error ? err.message : "Failed to start login.");
    }
  };

  // #4349: ask the server whether /login has finished in the VM; register the account when it has.
  const checkInVm = async (token: string) => {
    if (inVmRegisteredRef.current || inVmStoppedRef.current) return;
    setInVmChecking(true);
    try {
      const account = await inVmLogin.check(token);
      if (account && !inVmRegisteredRef.current) {
        inVmRegisteredRef.current = true;
        onAdded?.(account);
        onClose();
      }
    } catch (err) {
      // A rate limit, a server error or a dropped connection is not an answer: keep waiting.
      if (isTransientCheckError(err)) return;
      inVmStoppedRef.current = true;
      setError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setInVmChecking(false);
    }
  };

  useEffect(() => {
    if (!isOpen || !inVm) return;
    const timer = setInterval(
      () => void checkInVm(inVm.loginToken),
      IN_VM_CHECK_INTERVAL_MS
    );
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, inVm]);

  const handleClose = () => {
    // #4349: keep an unfinished in-VM sign-in. The user leaves this dialog to reach a terminal;
    // reopening Add account resumes it and registers the account. "Start over" cancels it, and the
    // server removes its dir at expiry while it is still empty.
    onClose();
  };

  const handleCopyCommand = async () => {
    if (!inVm) return;
    try {
      await navigator.clipboard.writeText(inVm.command);
      setInVmCopied(true);
      setTimeout(() => setInVmCopied(false), 1500);
    } catch {
      // Clipboard unavailable — the command is selectable text, so this is non-fatal.
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
      setInVm(null);
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
    <Dialog open={isOpen} onOpenChange={open => !open && handleClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a Claude account</DialogTitle>
          <DialogDescription>
            {inVm
              ? "Sign in inside this VM with Claude Code's own sign-in. Your credential stays on this VM, in the account's own folder. Hapimatic uses it only to read the account's usage and model list from Anthropic."
              : "Sign in to Anthropic in your browser, approve access, then paste the authorization code Anthropic shows you back here. No desktop access required. Finish within 5 minutes of opening this dialog."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 p-1 text-sm text-[var(--app-fg)]">
          {inVm ? (
            <div className="flex flex-col gap-3" data-testid="in-vm-sign-in">
              <ol className="list-decimal space-y-2 pl-5 text-[var(--app-hint)]">
                <li>
                  Open a terminal on this VM: open a session, or start one, and
                  choose its Terminal tab
                </li>
                <li>
                  Run this command:
                  <pre className="mt-1 whitespace-pre-wrap break-all rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 font-mono text-xs text-[var(--app-fg)]">
                    {inVm.command}
                  </pre>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleCopyCommand}
                    className="mt-1"
                  >
                    {inVmCopied ? "Copied" : "Copy command"}
                  </Button>
                </li>
                <li>
                  Type <code>/login</code> in Claude Code and follow its prompts
                  in your browser
                </li>
                <li>
                  Come back to Add account. This sign-in is kept while you are
                  away, and the account is added once Claude Code finishes
                </li>
              </ol>
              <p className="text-[var(--app-hint)]">
                You can close this dialog to reach the terminal. Each
                account&apos;s own limits apply.
              </p>
              {error ? (
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
              ) : (
                <p role="status" className="text-[var(--app-hint)]">
                  Waiting for sign-in…
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="secondary" onClick={handleClose}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={() => void checkInVm(inVm.loginToken)}
                  disabled={inVmChecking}
                >
                  {inVmChecking ? "Checking…" : "I've signed in"}
                </Button>
              </div>
            </div>
          ) : isStarting && !authorizeUrl ? (
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
