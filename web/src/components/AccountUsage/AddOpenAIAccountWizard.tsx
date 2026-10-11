// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AddAccountInstructions } from "@/components/AddAccountInstructions";
import { useOpenAiLogin } from "@/hooks/mutations/useOpenAiLogin";
import type { ApiClient } from "@/api/client";
import type { OpenAiLoginState } from "@/types/api";

const INPUT_CLASS =
  "w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)]";

const POLL_INTERVAL_MS = 3000;

export type AddOpenAIAccountWizardProps = {
  isOpen: boolean;
  onClose: () => void;
  api: ApiClient | null;
  /** The federation node to add the account on (LOCAL_NODE_ID = this node). */
  nodeId: string;
  /** Fired after a successful add (either path) so the page can refresh. */
  onAdded?: () => void;
};

type Phase = "choose" | "api-key" | "device-pending" | "terminal";

/**
 * AddOpenAIAccountWizard — the in-app "Add OpenAI account" wizard (issue #3807,
 * epic #3345, Task 4). Mirrors `AddAccountWizard`'s link + code shape.
 *
 * Two paths (R2/R3):
 *   - **API key**: a secure `type="password"` input; the key is posted ONCE to
 *     `start` (`kind:"api-key"`) — `codex login --with-api-key` on the target
 *     node — and is never stored client-side or echoed back. Completes
 *     synchronously (`ok` / `disabled` / `failed`).
 *   - **ChatGPT subscription**: `start` (`kind:"device-auth"`) returns a
 *     verification link + one-time code (`codex login --device-auth`); the user
 *     opens the link and enters the code in their browser while this polls
 *     `status` until a terminal state, with a Cancel button.
 *
 * Terminal handling (R5): `ok` → refresh the #3806 section + close; `disabled`
 * / `unsupported` → the #3806 host-side instruction with the reason;
 * `failed` / `cancelled` → a generic error, prior node auth untouched (the
 * server never writes the host `~/.codex`). No hardcoded URLs — the link comes
 * from codex's device-auth prompt. Cancelling / closing mid-flow cancels the
 * device-auth child so no staging dir is left behind.
 */
export function AddOpenAIAccountWizard({
  isOpen,
  onClose,
  api,
  nodeId,
  onAdded,
}: AddOpenAIAccountWizardProps) {
  const { start, status, cancel, invalidateAuthState } = useOpenAiLogin(api);
  const [phase, setPhase] = useState<Phase>("choose");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [terminalState, setTerminalState] = useState<OpenAiLoginState | null>(
    null
  );
  const [verificationUrl, setVerificationUrl] = useState<string | null>(null);
  const [userCode, setUserCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loginTokenRef = useRef<string | null>(null);
  // True once a terminal state is reached — gates the cancel-on-close.
  const settledRef = useRef(false);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  const resetAll = useCallback(() => {
    stopPolling();
    loginTokenRef.current = null;
    settledRef.current = false;
    setPhase("choose");
    setApiKey("");
    setError(null);
    setTerminalState(null);
    setVerificationUrl(null);
    setUserCode(null);
    setCopied(false);
  }, [stopPolling]);

  // Reset on close; cancel any still-pending device-auth so no staging dir
  // is left behind (R5). Runs when the dialog transitions to closed.
  useEffect(() => {
    if (isOpen) return;
    stopPolling();
    const token = loginTokenRef.current;
    if (token && !settledRef.current) {
      void cancel(nodeId, token).catch(() => undefined);
    }
    resetAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Cancel on unmount too (component removed while a login is pending).
  useEffect(() => {
    return () => {
      stopPolling();
      const token = loginTokenRef.current;
      if (token && !settledRef.current) {
        void cancel(nodeId, token).catch(() => undefined);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const settleTerminal = useCallback(
    (state: OpenAiLoginState) => {
      settledRef.current = true;
      stopPolling();
      if (state === "ok") {
        void invalidateAuthState();
        onAdded?.();
        onClose();
        return;
      }
      setTerminalState(state);
      setPhase("terminal");
    },
    [invalidateAuthState, onAdded, onClose, stopPolling]
  );

  const poll = useCallback(async () => {
    const token = loginTokenRef.current;
    if (!token) return;
    try {
      const res = await status(nodeId, token);
      if (res.state === "pending") {
        if (res.verificationUrl) setVerificationUrl(res.verificationUrl);
        if (res.userCode) setUserCode(res.userCode);
        pollTimer.current = setTimeout(() => void poll(), POLL_INTERVAL_MS);
        return;
      }
      settleTerminal(res.state);
    } catch {
      // A transient status error should not abort the flow — keep polling.
      pollTimer.current = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    }
  }, [nodeId, status, settleTerminal]);

  const beginDeviceAuth = useCallback(async () => {
    setError(null);
    setPhase("device-pending");
    setVerificationUrl(null);
    setUserCode(null);
    try {
      const res = await start.mutateAsync({
        nodeId,
        kind: "device-auth",
        label: "ChatGPT subscription",
      });
      loginTokenRef.current = res.loginToken;
      if (res.verificationUrl) setVerificationUrl(res.verificationUrl);
      if (res.userCode) setUserCode(res.userCode);
      if (res.state === "pending") {
        pollTimer.current = setTimeout(() => void poll(), POLL_INTERVAL_MS);
      } else {
        settleTerminal(res.state);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to start ChatGPT sign-in."
      );
      setPhase("terminal");
      setTerminalState("failed");
    }
  }, [nodeId, start, poll, settleTerminal]);

  const submitApiKey = useCallback(async () => {
    const key = apiKey.trim();
    if (!key) return;
    setError(null);
    try {
      const res = await start.mutateAsync({
        nodeId,
        kind: "api-key",
        label: "OpenAI (API key)",
        key,
      });
      setApiKey(""); // never keep the raw key around
      settleTerminal(res.state);
    } catch (err) {
      setApiKey("");
      setError(
        err instanceof Error ? err.message : "Failed to add the API key."
      );
      setPhase("terminal");
      setTerminalState("failed");
    }
  }, [apiKey, nodeId, start, settleTerminal]);

  const handleCancelDevice = useCallback(async () => {
    const token = loginTokenRef.current;
    stopPolling();
    if (token) await cancel(nodeId, token).catch(() => undefined);
    settledRef.current = true;
    setTerminalState("cancelled");
    setPhase("terminal");
  }, [cancel, nodeId, stopPolling]);

  const handleCopy = useCallback(async () => {
    if (!verificationUrl) return;
    try {
      await navigator.clipboard.writeText(verificationUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the link is still tappable */
    }
  }, [verificationUrl]);

  return (
    <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add an OpenAI account</DialogTitle>
          <DialogDescription>
            Add a Codex (OpenAI) login on this node — an API key, or a ChatGPT
            subscription via a browser sign-in. The credential is stored in a
            per-account directory; your host login is never touched.
          </DialogDescription>
        </DialogHeader>

        <div
          className="flex flex-col gap-4 p-1 text-sm text-[var(--app-fg)]"
          data-testid="add-openai-wizard"
        >
          {phase === "choose" && (
            <div className="flex flex-col gap-3">
              <Button
                type="button"
                onClick={() => {
                  setPhase("api-key");
                  setError(null);
                }}
                data-testid="openai-choose-api-key"
              >
                Use an API key
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => void beginDeviceAuth()}
                data-testid="openai-choose-device-auth"
              >
                Sign in with a ChatGPT subscription
              </Button>
            </div>
          )}

          {phase === "api-key" && (
            <div className="flex flex-col gap-2">
              <label
                htmlFor="openai-api-key"
                className="text-[length:var(--text-body-dense)] text-[var(--app-hint)]"
              >
                OpenAI API key
              </label>
              <input
                id="openai-api-key"
                type="password"
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder="Paste the OpenAI API key"
                autoComplete="off"
                spellCheck={false}
                style={{ fontSize: "16px" }}
                className={INPUT_CLASS}
                data-testid="openai-api-key-input"
              />
              <p className="text-[length:var(--text-caption)] text-[var(--app-hint)]">
                Sent once to this node and never shared with the assistant or
                stored in this conversation.
              </p>
              {error && (
                <p
                  className="text-[length:var(--text-body-dense)] text-[var(--accent-rose-400)]"
                  data-testid="openai-wizard-error"
                >
                  {error}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="secondary" onClick={onClose}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={() => void submitApiKey()}
                  disabled={!apiKey.trim() || start.isPending}
                  data-testid="openai-api-key-submit"
                >
                  {start.isPending ? "Adding…" : "Add API key"}
                </Button>
              </div>
            </div>
          )}

          {phase === "device-pending" && (
            <div
              className="flex flex-col gap-3"
              data-testid="openai-device-pending"
            >
              {verificationUrl && userCode ? (
                <ol className="list-decimal space-y-2 pl-5 text-[var(--app-hint)]">
                  <li>
                    Open the sign-in page:
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <a
                        href={verificationUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="break-all text-[var(--app-link)] underline"
                        data-testid="openai-device-url"
                      >
                        {verificationUrl}
                      </a>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void handleCopy()}
                      >
                        {copied ? "Copied" : "Copy link"}
                      </Button>
                    </div>
                  </li>
                  <li>
                    Enter this one-time code:
                    <span
                      className="ml-1 font-mono font-semibold text-[var(--app-fg)]"
                      data-testid="openai-device-code"
                    >
                      {userCode}
                    </span>
                  </li>
                  <li>
                    Approve the sign-in in your browser — this page updates
                    automatically.
                  </li>
                </ol>
              ) : (
                <p className="text-[var(--app-hint)]">Preparing sign-in…</p>
              )}
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void handleCancelDevice()}
                  data-testid="openai-device-cancel"
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {phase === "terminal" && terminalState && (
            <div className="flex flex-col gap-3" data-testid="openai-terminal">
              {terminalState === "disabled" ||
              terminalState === "unsupported" ? (
                <>
                  <p
                    className="text-[length:var(--text-body)] text-[var(--toast-warning)]"
                    data-testid="openai-terminal-fallback-reason"
                  >
                    {terminalState === "disabled"
                      ? "In-app OpenAI login is disabled on this node. Add the account on the host instead:"
                      : "This node's workspace does not support device-code sign-in. Add the account on the host instead:"}
                  </p>
                  <AddAccountInstructions
                    provider="openai"
                    intro="Add the OpenAI account by logging in directly on the target machine:"
                  />
                  <div className="flex justify-end">
                    <Button type="button" variant="secondary" onClick={onClose}>
                      Close
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <p
                    className="text-[length:var(--text-body)] text-[var(--accent-rose-400)]"
                    data-testid="openai-wizard-error"
                  >
                    {terminalState === "cancelled"
                      ? "Sign-in cancelled. Your existing OpenAI login is unchanged."
                      : (error ??
                        "Could not add the OpenAI account. Your existing login is unchanged.")}
                  </p>
                  <div className="flex justify-end gap-2">
                    <Button type="button" variant="secondary" onClick={onClose}>
                      Close
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={resetAll}
                      data-testid="openai-wizard-retry"
                    >
                      Try again
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
