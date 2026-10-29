// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiClient } from "@/api/client";
import { getPlatform } from "@/hooks/usePlatform";
import { Spinner } from "@/components/Spinner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { buildSsoStartUrl } from "@/lib/ssoStartUrl";
import type { ServerUrlResult } from "@/hooks/useServerUrl";

type LoginPromptProps = {
  mode?: "login" | "bind";
  onLogin?: (token: string) => void;
  onBind?: (token: string) => Promise<void>;
  baseUrl: string;
  serverUrl: string | null;
  setServerUrl: (input: string) => ServerUrlResult;
  clearServerUrl: () => void;
  error?: string | null;
  /**
   * Runtime Google SSO gate (#2312). When true (and not in bind mode), render the
   * "Sign in with Google" button. Supplied by App from `useVersion()` — the server
   * reports it on `/api/version` (derived from `HAPI_GOOGLE_HANDOFF_SECRET`), so the
   * same binary shows the button on cloud VMs and hides it on home instances. Defaults
   * to hidden.
   */
  ssoEnabled?: boolean;
};

export function LoginPrompt(props: LoginPromptProps) {
  const isBindMode = props.mode === "bind";
  const [accessToken, setAccessToken] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isServerDialogOpen, setIsServerDialogOpen] = useState(false);
  const [serverInput, setServerInput] = useState(props.serverUrl ?? "");
  const [serverError, setServerError] = useState<string | null>(null);
  const tokenInputRef = useRef<HTMLInputElement>(null);

  // #5766: pressing a button blurs the token field, which drops the touch lift
  // (see the stage div below) and moves the button before the click lands, so
  // the tap is lost. Keep focus in the field while the button is pressed; only
  // the focus change is prevented, the click and submit still run. Touch only,
  // so desktop focus behavior is unchanged.
  const holdTokenFieldFocus = useCallback((e: React.MouseEvent) => {
    if (
      getPlatform().isTouch &&
      document.activeElement === tokenInputRef.current
    ) {
      e.preventDefault();
    }
  }, []);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      const trimmedToken = accessToken.trim();
      if (!trimmedToken) {
        setError("Please enter an access token");
        return;
      }

      setIsLoading(true);
      setError(null);

      try {
        if (isBindMode) {
          if (!props.onBind) {
            setError("Binding is unavailable.");
            return;
          }
          await props.onBind(trimmedToken);
        } else {
          // Validate the token by attempting to authenticate
          const client = new ApiClient("", { baseUrl: props.baseUrl });
          await client.authenticate({ accessToken: trimmedToken });
          // If successful, pass the token to parent
          if (!props.onLogin) {
            setError("Login is unavailable.");
            return;
          }
          props.onLogin(trimmedToken);
        }
      } catch (e) {
        const fallbackMessage = isBindMode
          ? "Binding failed"
          : "Authentication failed";
        setError(e instanceof Error ? e.message : fallbackMessage);
      } finally {
        setIsLoading(false);
      }
    },
    [accessToken, props]
  );

  useEffect(() => {
    if (!isServerDialogOpen) {
      return;
    }
    setServerInput(props.serverUrl ?? "");
    setServerError(null);
  }, [isServerDialogOpen, props.serverUrl]);

  const handleSaveServer = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const result = props.setServerUrl(serverInput);
      if (!result.ok) {
        setServerError(result.error);
        return;
      }
      setServerError(null);
      setServerInput(result.value);
      setIsServerDialogOpen(false);
    },
    [props, serverInput]
  );

  const handleClearServer = useCallback(() => {
    props.clearServerUrl();
    setServerInput("");
    setServerError(null);
    setIsServerDialogOpen(false);
  }, [props]);

  const displayError = error || props.error;
  const serverSummary = props.serverUrl ?? `${props.baseUrl} (same origin)`;
  const title = isBindMode ? "Bind Telegram" : "Hapimatic";
  const submitLabel = isBindMode ? "Bind" : "Sign In";
  // Issue #1003 + #2312: runtime-gated Google SSO button. Default OFF (hidden), so
  // RP1/personal instances are unaffected. The gate is now RUNTIME (not the old
  // build-time VITE_HAPI_SSO_ENABLED): App supplies `ssoEnabled` from `/api/version`,
  // which the server derives from `HAPI_GOOGLE_HANDOFF_SECRET` — so the SAME binary
  // surfaces the button on cloud VMs and hides it on home instances.
  const ssoEnabled = props.ssoEnabled ?? false;

  return (
    // #5766: on touch devices, lift the form to the top while the token field
    // is focused, so it sits above the on-screen keyboard from the first frame
    // and stays still while AppShell shrinks to the visual viewport (a centered
    // form re-centered on every keyboard resize step). CSS, not React state,
    // so it applies in the same style pass as the focus (see the keyboard rules
    // in index.css). pt-14 clears the Server button. The Server dialog's input
    // is portaled out of this div, so it does not trigger the lift.
    <div className="relative h-full flex items-center justify-center p-4 pointer-coarse:has-[input:focus]:items-start pointer-coarse:has-[input:focus]:pt-14">
      {!isBindMode && (
        <div className="absolute right-4 top-4 z-10">
          <Dialog
            open={isServerDialogOpen}
            onOpenChange={setIsServerDialogOpen}
          >
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2">
                Server
                <span className="text-[length:var(--text-caption-xs)] uppercase tracking-wide text-[var(--app-hint)]">
                  {props.serverUrl ? "Custom" : "Default"}
                </span>
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>Server URL</DialogTitle>
                <DialogDescription>
                  Set the hapi server origin for API and live updates.
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleSaveServer} className="space-y-4">
                <div className="text-xs text-[var(--app-hint)]">
                  Current: {serverSummary}
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-medium">Server origin</label>
                  <input
                    type="url"
                    value={serverInput}
                    onChange={e => {
                      setServerInput(e.target.value);
                      setServerError(null);
                    }}
                    placeholder="https://hapi.example.com"
                    className="w-full px-3 py-2.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-2 focus:ring-[var(--app-button)] focus:border-transparent"
                  />
                  <div className="text-[length:var(--text-caption)] text-[var(--app-hint)]">
                    Use http(s) only. Any path is ignored.
                  </div>
                </div>

                {serverError && (
                  <div className="text-sm text-red-500">{serverError}</div>
                )}

                <div className="flex items-center justify-end gap-2">
                  {props.serverUrl && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleClearServer}
                    >
                      Use same origin
                    </Button>
                  )}
                  <Button type="submit">Save server</Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      )}
      <div className="w-full max-w-sm space-y-6">
        {/* Header */}
        <div className="text-center space-y-2">
          {isBindMode ? (
            <div className="text-2xl font-bold">{title}</div>
          ) : (
            <svg
              viewBox="0 0 200 40"
              className="h-8 mx-auto"
              aria-label="Hapimatic"
            >
              <text
                x="100"
                y="30"
                textAnchor="middle"
                fontFamily="'Varela Round', system-ui, sans-serif"
                fontWeight="normal"
                fontSize="28"
                letterSpacing="2"
                fill="var(--app-fg)"
                stroke="var(--brand-accent)"
                strokeWidth="3"
                strokeLinejoin="round"
                strokeLinecap="round"
                paintOrder="stroke fill"
              >
                Hapimatic
              </text>
            </svg>
          )}
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <input
              ref={tokenInputRef}
              type="password"
              value={accessToken}
              onChange={e => setAccessToken(e.target.value)}
              placeholder="Access token"
              autoComplete="current-password"
              disabled={isLoading}
              className="w-full px-3 py-2.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-2 focus:ring-[var(--brand-accent)] focus:border-[var(--brand-accent)]/50 disabled:opacity-50"
            />
          </div>

          {displayError && (
            <div className="text-sm text-red-500 text-center">
              {displayError}
            </div>
          )}

          <Button
            type="submit"
            variant="default"
            disabled={isLoading || !accessToken.trim()}
            aria-busy={isLoading}
            onMouseDown={holdTokenFieldFocus}
            className="h-auto w-full gap-2 rounded-lg py-2.5 transition-all hover:bg-[var(--brand-accent)] hover:text-white hover:opacity-100"
          >
            {isLoading ? (
              <>
                <Spinner
                  size="sm"
                  label={null}
                  className="text-[var(--app-button-text)]"
                />
                {isBindMode ? "Binding..." : "Signing in..."}
              </>
            ) : (
              submitLabel
            )}
          </Button>
        </form>

        {/* Issue #1003: Google SSO — leaves this instance and round-trips through
            the gateway, which lands the user back on the server-rendered exchange
            page. No auth-hook changes (D999-5a); the token-paste form above
            remains the always-available fallback. */}
        {!isBindMode && ssoEnabled && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="h-px flex-1 bg-[var(--app-border)]" />
              <span className="text-xs uppercase tracking-wide text-[var(--app-hint)]">
                or
              </span>
              <div className="h-px flex-1 bg-[var(--app-border)]" />
            </div>
            <Button
              type="button"
              variant="outline"
              onMouseDown={holdTokenFieldFocus}
              onClick={() => {
                // #2650: begin Google SSO directly on the apex gateway instead of
                // landing on hapimatic.com (which forced a second click). Carries a
                // ?return=<subdomain> hint so a multi-instance user returns here.
                window.location.href = buildSsoStartUrl(
                  window.location.hostname
                );
              }}
              className="h-auto w-full gap-2 rounded-lg bg-[var(--app-bg)] py-2.5 font-medium text-[var(--app-fg)] transition-all hover:border-[var(--brand-accent)] hover:bg-[var(--app-bg)]"
            >
              <svg viewBox="0 0 18 18" className="h-4 w-4" aria-hidden="true">
                <path
                  fill="#4285F4" /* design-tokens-allow: Google brand logo color — no design token applies (L3 #3405) */
                  d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
                />
                <path
                  fill="#34A853" /* design-tokens-allow: Google brand logo color — no design token applies (L3 #3405) */
                  d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z"
                />
                <path
                  fill="#FBBC05" /* design-tokens-allow: Google brand logo color — no design token applies (L3 #3405) */
                  d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
                />
                <path
                  fill="#EA4335" /* design-tokens-allow: Google brand logo color — no design token applies (L3 #3405) */
                  d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"
                />
              </svg>
              Sign in with Google
            </Button>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="absolute bottom-4 left-0 right-0 text-center text-xs text-[var(--app-hint)] space-y-1">
        <div>© {new Date().getFullYear()} Hapimatic</div>
      </div>
    </div>
  );
}
