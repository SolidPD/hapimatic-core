// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "@/api/client";
import { Button } from "@/components/ui/button";
import {
  useAccountLogin,
  useInVmAccountLogin,
} from "@/hooks/mutations/useAccountActions";
import { errorReporter } from "@/lib/error-reporter";
import {
  IN_VM_SIGN_IN_REQUIRED,
  type InVmLoginStartResponse,
  type InVmLoginCancelResponse,
} from "@/types/api";
import type { LoginNode } from "./NodeLoginList";
import {
  CopyButton,
  errCode,
  errMessage,
  INPUT_CLASS,
  isTransientCheckError,
} from "./loginStepShared";
import {
  clearPendingSignIn,
  IN_VM_PENDING_TTL_MS,
  OAUTH_PENDING_TTL_MS,
  readPendingSignIn,
  writePendingSignIn,
} from "./pendingSignIn";

/** Issue #4349: how often the in-VM panel asks whether `/login` has finished. */
export const IN_VM_CHECK_INTERVAL_MS = 4000;

/**
 * Local pre-check (#3452): a digits-only paste is the shape of the 6-digit
 * sign-in code claude.com emails during login — never an authorization code.
 * Catching it here keeps the single-use login session alive.
 */
export const NOT_AN_AUTHORIZATION_CODE_HINT =
  "That looks like the 6-digit sign-in code claude.com emailed you. That code " +
  "belongs on the claude.com sign-in page, not here. Finish signing in there, " +
  "click Authorize, then copy the long authorization code shown on the " +
  "platform.claude.com page and paste that here (the whole thing, including " +
  "the part after #).";

/** #6054 SINK-1: Done's failure line for a code exchange whose node the user
 *  left while it ran. The node change discarded the link, so no line asks for
 *  the code again; each names the node the code was sent to. */
function leftNodeDoneError(err: unknown, nodeName: string): string {
  const c = errCode(err);
  const text =
    c === "invalid_code"
      ? "that code was not accepted · open a new link there"
      : c === "login_session_lost"
        ? "the sign-in expired or the node restarted · open a new link there"
        : c === "login_outcome_unknown" || c === undefined
          ? "no answer · check its accounts before retrying"
          : `${errMessage(err, "Login failed.")} · open a new link there`;
  return `${nodeName}: ${text}`;
}

// ---------------------------------------------------------------------------
// Anthropic login step (R4, R11)
// ---------------------------------------------------------------------------

export type AnthropicStep = ReturnType<typeof useAnthropicLoginStep>;

/**
 * The Anthropic sign-in on the selected node (B's node-targeted routes). The
 * login starts only when "Sign in to Claude Code" is tapped; changing the node
 * discards a started login (its PKCE state belongs to that node). On a tenant VM
 * (#4349) the UI host's start answers `in_vm_sign_in_required` and the step
 * switches to the in-VM sign-in: the same link and code paste, driven by the
 * unmodified binary on the VM (#6211), with its terminal `/login` always offered
 * and shown alone when no link could start.
 */
export function useAnthropicLoginStep(
  api: ApiClient | null,
  opts: {
    node: LoginNode | null;
    isOpen: boolean;
    /** Fired once per account the step adds (the in-VM sign-in included). */
    onAdded: () => void;
  }
) {
  const { node, isOpen, onAdded } = opts;
  const nodeId = node && !node.isUiHost ? node.nodeId : undefined;
  const { start, complete, isStarting, isCompleting } = useAccountLogin(
    api,
    nodeId ? { nodeId } : undefined
  );
  // useInVmAccountLogin returns new functions every render; read them through a
  // ref so the callbacks below (and the poll effect) stay stable.
  const inVmLogin = useInVmAccountLogin(api);
  const inVmLoginRef = useRef(inVmLogin);
  inVmLoginRef.current = inVmLogin;

  const [loginToken, setLoginToken] = useState<string | null>(null);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [inVm, setInVm] = useState<InVmLoginStartResponse | null>(null);
  const [inVmChecking, setInVmChecking] = useState(false);
  // #6211: an in-VM start waits for the binary to print its link.
  const [inVmStarting, setInVmStarting] = useState(false);
  // #6211: the user chose the terminal for an in-VM sign-in that also has a link.
  const [inVmTerminal, setInVmTerminal] = useState(false);
  const [inVmSubmitting, setInVmSubmitting] = useState(false);
  // #6211: the exchange outlasted the server's wait; the poll reports its end.
  const [signingIn, setSigningIn] = useState(false);
  // #6211 R20: this identity is already on the node, which is not a failure.
  const [alreadyConnected, setAlreadyConnected] = useState<string | null>(null);
  const [saved, setSaved] = useState(0);
  // #6054 SINK-1: `saved` counts every add, for the footer's "N saved"; the
  // "Account added" line counts only adds on the node selected now, made since
  // it was picked: a node change resets it.
  const [savedHere, setSavedHere] = useState(0);
  // #6054 SINK-1: Done's failure line for a code exchange whose node the user
  // left while it ran, named for that node. A node change clears it, and so
  // does a new sign-in started on that node, as `begin` clears that node's own
  // error line.
  const [leftNodeError, setLeftNodeError] = useState<{
    nodeId: string | null;
    text: string;
  } | null>(null);
  // Bumped on every start and every node change: a start that resolves after the
  // node changed (or the modal closed) belongs to a discarded attempt (TR1-e).
  const attemptRef = useRef(0);
  const inVmRegisteredRef = useRef(false);
  const inVmStoppedRef = useRef(false);
  const countedInVmRef = useRef(new Set<string>());
  const inVmInFlightRef = useRef(false);
  const inVmSubmittingRef = useRef(false);
  const onAddedRef = useRef(onAdded);
  onAddedRef.current = onAdded;
  const nodeName = node?.nodeLabel ?? "this node";

  const clearLink = useCallback(() => {
    setLoginToken(null);
    setAuthorizeUrl(null);
    setCode("");
    setHint(null);
    setSigningIn(false);
  }, []);

  // #6211: a start's answer. A link means the paste view; none means the terminal
  // view, which on a tenant is a degraded sign-in worth a row (kill switch, binary
  // drift, an older server).
  const applyInVmStart = useCallback((res: InVmLoginStartResponse) => {
    setInVm(res);
    setInVmTerminal(false);
    if (res.authorizeUrl) {
      setAuthorizeUrl(res.authorizeUrl);
      writePendingSignIn({
        provider: "anthropic",
        flow: "in-vm",
        loginToken: res.loginToken,
        authorizeUrl: res.authorizeUrl,
        expiresAt: Date.now() + IN_VM_PENDING_TTL_MS,
      });
      return;
    }
    clearPendingSignIn();
    errorReporter.report({
      message: "In-VM sign-in started with no link; showing the terminal path",
      category: "accounts",
      severity: "warn",
    });
  }, []);

  // #6211: the in-VM sign-in has ended, whichever call found out.
  const endInVm = useCallback(() => {
    inVmStoppedRef.current = true;
    clearLink();
    setInVm(null);
    setInVmTerminal(false);
    clearPendingSignIn();
  }, [clearLink]);

  // R4: a node change discards the started login. The in-VM sign-in is only
  // forgotten locally — the server keeps it resumable (#4349 CR-1).
  const nodeKey = node?.nodeId ?? null;
  // #6054: the node picked now, read after an await to place a success line.
  const nodeKeyRef = useRef(nodeKey);
  nodeKeyRef.current = nodeKey;
  useEffect(() => {
    attemptRef.current += 1;
    clearLink();
    setError(null);
    setInVm(null);
    setInVmTerminal(false);
    setAlreadyConnected(null);
    setSavedHere(0);
    setLeftNodeError(null);
    inVmRegisteredRef.current = false;
    inVmStoppedRef.current = false;
  }, [nodeKey, clearLink]);

  // #6211: pick a sign-in back up after the page reloaded. Runs after the effect
  // above, which clears the step, and only on the UI host, which is the only node
  // a pending sign-in is ever stored for. An in-VM one is re-started, which the
  // server resumes; a web login's token still names its started login.
  const restoredRef = useRef(false);
  const isUiHost = node?.isUiHost === true;
  useEffect(() => {
    if (!isOpen || !isUiHost || restoredRef.current) return;
    restoredRef.current = true;
    const pending = readPendingSignIn();
    if (!pending) return;
    if (pending.flow === "oauth") {
      setLoginToken(pending.loginToken);
      setAuthorizeUrl(pending.authorizeUrl);
      return;
    }
    const attempt = ++attemptRef.current;
    setInVmStarting(true);
    inVmLoginRef.current
      .start()
      .then(
        res => {
          if (attempt === attemptRef.current) applyInVmStart(res);
        },
        () => {
          if (attempt === attemptRef.current) clearPendingSignIn();
        }
      )
      .finally(() => setInVmStarting(false));
  }, [isOpen, isUiHost, applyInVmStart]);

  useEffect(() => {
    if (isOpen) return;
    attemptRef.current += 1;
  }, [isOpen]);

  // The body unmounts when the modal closes, so the effect above does not see that.
  // A start still running must not then write the cancelled sign-in back (R9). The
  // reset is for StrictMode's rehearsal, which would otherwise drop the restore.
  useEffect(
    () => () => {
      attemptRef.current += 1;
      restoredRef.current = false;
    },
    []
  );

  // #6211: one sign-in counts once. The server answers a repeat with the same account, so a poll
  // in flight, a cancel and a second tap of Start over can each report the one registration.
  const countInVmAccount = useCallback((token: string, here: boolean) => {
    if (countedInVmRef.current.has(token)) return;
    countedInVmRef.current.add(token);
    setSaved(s => s + 1);
    if (here) setSavedHere(s => s + 1);
    onAddedRef.current();
  }, []);

  const begin = useCallback(async () => {
    const attempt = ++attemptRef.current;
    setError(null);
    setAlreadyConnected(null);
    setLeftNodeError(prev =>
      prev && prev.nodeId === nodeKeyRef.current ? null : prev
    );
    clearLink();
    clearPendingSignIn();
    // #4349: Start over forgets the previous in-VM sign-in. Await the cancel: the
    // server resumes an unfinished sign-in, so a start sent first would resume
    // the one being cancelled. #6028: for the same reason a FAILED cancel must
    // not fall through to a start — stop and say so, keeping the old sign-in.
    if (inVm && !inVmRegisteredRef.current) {
      // The server forgets this sign-in partway through the await, and a poll firing
      // then would read that as the new sign-in having expired.
      inVmStoppedRef.current = true;
      const sentTo = nodeKeyRef.current;
      let finished: InVmLoginCancelResponse | null;
      try {
        finished = await inVmLoginRef.current.cancel(inVm.loginToken);
      } catch (err) {
        if (attempt !== attemptRef.current) return;
        inVmStoppedRef.current = false;
        setError(
          `The previous sign-in could not be cancelled, so a new one was not started (${errMessage(err, "unknown error")}). Try Start over again.`
        );
        return;
      }
      // #6211: that sign-in had already finished, so the server kept it rather than
      // abandon it. There is nothing to start over; a discarded attempt still counts it.
      if (finished?.account) {
        countInVmAccount(inVm.loginToken, nodeKeyRef.current === sentTo);
      }
      if (attempt !== attemptRef.current) return;
      if (finished?.account) {
        inVmRegisteredRef.current = true;
        endInVm();
        return;
      }
      if (finished?.alreadyConnected) {
        endInVm();
        setAlreadyConnected(finished.alreadyConnected);
        return;
      }
    }
    if (attempt !== attemptRef.current) return;
    setInVm(null);
    inVmRegisteredRef.current = false;
    inVmStoppedRef.current = false;
    try {
      const res = await start();
      if (attempt !== attemptRef.current) return;
      setLoginToken(res.loginToken);
      setAuthorizeUrl(res.authorizeUrl);
      // A remote node's login is not stored: the modal reopens on the UI host.
      if (node?.isUiHost) {
        writePendingSignIn({
          provider: "anthropic",
          flow: "oauth",
          loginToken: res.loginToken,
          authorizeUrl: res.authorizeUrl,
          expiresAt: Date.now() + OAUTH_PENDING_TTL_MS,
        });
      }
    } catch (err) {
      if (attempt !== attemptRef.current) return;
      if (errCode(err) === IN_VM_SIGN_IN_REQUIRED) {
        if (!node?.isUiHost) {
          // The in-VM directory must be created on the node that owns the VM;
          // the remote start was proxied before the local tenant check.
          setError(
            `${nodeName} signs in inside its VM · open ${nodeName}'s own Hapimatic to add the account`
          );
          return;
        }
        setInVmStarting(true);
        try {
          const res = await inVmLoginRef.current.start();
          if (attempt !== attemptRef.current) return;
          applyInVmStart(res);
        } catch (inner) {
          if (attempt !== attemptRef.current) return;
          setError(errMessage(inner, "Failed to start sign-in."));
        } finally {
          setInVmStarting(false);
        }
        return;
      }
      setError(errMessage(err, "Failed to start login."));
    }
  }, [
    applyInVmStart,
    clearLink,
    countInVmAccount,
    endInVm,
    inVm,
    node?.isUiHost,
    nodeName,
    start,
  ]);

  // #4349: ask whether /login has finished in the VM. One check at a time
  // (TR1-e): the poll and the button must not overlap, or an `already_added`
  // answer to the second call would show an error after the account was added.
  // #6211: it also holds off while a pasted code is being submitted, whose own
  // answer settles the sign-in.
  const checkInVm = useCallback(
    async (token: string) => {
      if (
        inVmRegisteredRef.current ||
        inVmStoppedRef.current ||
        inVmInFlightRef.current ||
        inVmSubmittingRef.current
      )
        return;
      // A check still in flight when Start over runs belongs to the old sign-in;
      // its answer must not land on the new one.
      const attempt = attemptRef.current;
      const sentTo = nodeKeyRef.current;
      inVmInFlightRef.current = true;
      setInVmChecking(true);
      try {
        const account = await inVmLoginRef.current.check(token);
        if (attempt !== attemptRef.current) {
          // #5467 S8: the answer belongs to a discarded attempt, so it must not
          // land on the new one — but an account it found WAS added, so count it
          // and refresh the page rather than hide it.
          // #6054: its line shows only on the node it was added on.
          if (account) {
            countInVmAccount(token, nodeKeyRef.current === sentTo);
          }
          return;
        }
        if (account && !inVmRegisteredRef.current) {
          inVmRegisteredRef.current = true;
          // A Done pressed before /login finished left "not finished" on screen.
          setError(null);
          clearLink();
          setInVm(null);
          clearPendingSignIn();
          countInVmAccount(token, true);
        }
      } catch (err) {
        if (attempt !== attemptRef.current) return;
        // A rate limit, a server error or a dropped connection is not an
        // answer: keep waiting.
        if (errCode(err) === "already_added") {
          endInVm();
          setAlreadyConnected(errMessage(err, "Already connected."));
        } else if (errCode(err) === "exchange_failed") {
          endInVm();
          // #6275 S12: show the server's own message, which names the cause when it can read one.
          setError(
            errMessage(err, "That code was not accepted · open a new link")
          );
        } else if (!isTransientCheckError(err)) {
          inVmStoppedRef.current = true;
          setError(errMessage(err, "Sign-in failed."));
        }
      } finally {
        inVmInFlightRef.current = false;
        setInVmChecking(false);
      }
    },
    [clearLink, countInVmAccount, endInVm]
  );

  useEffect(() => {
    if (!isOpen || !inVm) return;
    const timer = setInterval(
      () => void checkInVm(inVm.loginToken),
      IN_VM_CHECK_INTERVAL_MS
    );
    return () => clearInterval(timer);
  }, [isOpen, inVm, checkInVm]);

  /**
   * #6211: pass a pasted code to the binary on the VM. The flow is one-shot, so
   * only a malformed paste keeps the link. Resolves the number of problems; a
   * sign-in still running is not one, but it keeps the modal open.
   */
  const submitInVmCode = useCallback(
    async (token: string, pasted: string): Promise<number> => {
      const attempt = attemptRef.current;
      inVmSubmittingRef.current = true;
      setInVmSubmitting(true);
      setError(null);
      setHint(null);
      setSigningIn(false);
      try {
        const account = await inVmLoginRef.current.submit(token, pasted);
        if (attempt !== attemptRef.current) {
          // The account WAS added, on a sign-in the user has since left.
          if (account) countInVmAccount(token, false);
          return 0;
        }
        if (!account) {
          setSigningIn(true);
          return 1;
        }
        // A poll that was already in flight may have registered it first.
        if (!inVmRegisteredRef.current) {
          inVmRegisteredRef.current = true;
          countInVmAccount(token, true);
        }
        clearLink();
        setInVm(null);
        clearPendingSignIn();
        return 0;
      } catch (err) {
        if (attempt !== attemptRef.current) return 0;
        const c = errCode(err);
        if (c === "invalid_code") {
          setError(
            errMessage(err, "That code was not accepted · paste it again")
          );
          return 1;
        }
        if (c === "already_added") {
          endInVm();
          setAlreadyConnected(errMessage(err, "Already connected."));
          // Not a problem, but Done must not close over the line that says so.
          return 1;
        }
        if (c === "exchange_failed" || c === "expired_state") {
          endInVm();
          // #6275 S12: show the server's own message for a failed exchange.
          setError(
            c === "exchange_failed"
              ? errMessage(err, "That code was not accepted · open a new link")
              : "This sign-in expired · open a new link"
          );
          return 1;
        }
        // No answer: the code may have gone through, so the poll stays on it and
        // the link stays up. A second press cannot write the code twice.
        setError("No answer from this VM · the sign-in may still finish");
        return 1;
      } finally {
        inVmSubmittingRef.current = false;
        setInVmSubmitting(false);
      }
    },
    [clearLink, countInVmAccount, endInVm]
  );

  /**
   * Done's half (R7): complete the pasted code, if any. Resolves the number of
   * problems (0 or 1). The token is single-use even on a rejected code, so any
   * failure except `invalid_code` needs a fresh link.
   */
  const runDone = useCallback(async (): Promise<number> => {
    const trimmed = code.trim();
    if (inVm && !inVmRegisteredRef.current) {
      if (!inVm.authorizeUrl || inVmTerminal) {
        if (!error) setError("Claude sign-in not finished");
        return 1;
      }
      if (!trimmed) {
        setError(
          "Paste the authorization code, or press Cancel and come back to it"
        );
        return 1;
      }
      if (/^\d+$/.test(trimmed)) {
        setError(null);
        setHint(NOT_AN_AUTHORIZATION_CODE_HINT);
        return 1;
      }
      return await submitInVmCode(inVm.loginToken, trimmed);
    }
    if (!loginToken) return 0;
    if (!trimmed) {
      // Operator ruling 2026-10-18 (#4464): an opened link that Done would
      // drop is a problem, the same as a pending ChatGPT sign-in.
      setError(
        "Paste the authorization code, or press Cancel to discard this sign-in"
      );
      return 1;
    }
    setError(null);
    setHint(null);
    if (/^\d+$/.test(trimmed)) {
      setHint(NOT_AN_AUTHORIZATION_CODE_HINT);
      return 1;
    }
    // #6054 SINK-1: the node radios stay enabled while Done runs (#5467 D9), so
    // the answer can arrive after a node change. The token alone routes the
    // exchange, so it belongs to the node it was sent to, never the new one.
    const attempt = attemptRef.current;
    const sentTo = nodeKeyRef.current;
    try {
      await complete({ loginToken, code: trimmed });
      if (attempt !== attemptRef.current) {
        // The account WAS added on the node the code was sent to: count it
        // and refresh the page (as checkInVm's stale branch does, #5467 S8).
        // Its line shows only if that node is picked again by now.
        setSaved(s => s + 1);
        if (nodeKeyRef.current === sentTo) setSavedHere(s => s + 1);
        onAddedRef.current();
        // Its stored entry names a token that is now spent; a newer one is not ours.
        if (readPendingSignIn()?.loginToken === loginToken) {
          clearPendingSignIn();
        }
        return 0;
      }
      clearLink();
      clearPendingSignIn();
      setSaved(s => s + 1);
      setSavedHere(s => s + 1);
      onAddedRef.current();
      return 0;
    } catch (err) {
      if (attempt !== attemptRef.current) {
        setLeftNodeError({
          nodeId: sentTo,
          text: leftNodeDoneError(err, nodeName),
        });
        return 1;
      }
      const c = errCode(err);
      if (c === "invalid_code") {
        setError(
          errMessage(err, "That code was not accepted · paste it again")
        );
        return 1;
      }
      clearLink();
      clearPendingSignIn();
      if (c === "login_session_lost") {
        setError(
          `the sign-in on ${nodeName} expired or the node restarted · open a new link`
        );
      } else if (c === "login_outcome_unknown" || c === undefined) {
        // Never auto-retry: the login may have succeeded on that node.
        setError(
          `no answer from ${nodeName} · check its accounts before retrying`
        );
      } else {
        setError(`${errMessage(err, "Login failed.")} · open a new link`);
      }
      return 1;
    }
  }, [
    clearLink,
    code,
    complete,
    error,
    inVm,
    inVmTerminal,
    loginToken,
    nodeName,
    submitInVmCode,
  ]);

  const pending = Boolean(inVm && !inVmRegisteredRef.current);
  // #5467 S12: the problem lines this step shows now. The modal's banner counts
  // these live, so a line that clears (a node change, a new link, a finished
  // sign-in) leaves the count at once.
  const problemCount =
    (error !== null || hint !== null ? 1 : 0) +
    (leftNodeError !== null ? 1 : 0);
  return {
    loginToken,
    authorizeUrl,
    code,
    setCode,
    error,
    hint,
    leftNodeError,
    problemCount,
    inVm,
    inVmChecking,
    /** #6211: this in-VM sign-in shows its link and code field, not the terminal steps. */
    inVmPaste: Boolean(inVm?.authorizeUrl) && !inVmTerminal,
    setInVmTerminal,
    signingIn,
    alreadyConnected,
    isStarting: isStarting || inVmStarting,
    isCompleting: isCompleting || inVmSubmitting,
    begin,
    checkInVm,
    runDone,
    saved,
    savedHere,
    pending,
  };
}

export function AnthropicStepView(props: {
  step: AnthropicStep;
  node: LoginNode | null;
  /** #5467 S8: Done is running — no new link or sign-in, and the code is not
   *  editable. */
  locked: boolean;
}) {
  const { step, node, locked } = props;
  const canStart = Boolean(node && node.disabledReason === null);
  // On a phone these lines land below the dialog's fold, under a banner that only
  // counts them, so the reason for a refused Done would be off screen.
  const messageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (step.hint || step.error) {
      messageRef.current?.scrollIntoView?.({ block: "nearest" });
    }
  }, [step.hint, step.error]);
  // #6054 SINK-1: in both views, because Done counts it as a problem and the
  // in-VM sign-in can open on the UI host while it is still shown.
  const leftNodeLine = step.leftNodeError && (
    <div
      className="rounded-md bg-red-900/20 p-2 text-red-400"
      role="alert"
      data-testid="anthropic-left-node-error"
    >
      {step.leftNodeError.text}
    </div>
  );
  if (step.inVm && !step.inVmPaste) {
    return (
      <div className="flex flex-col gap-3" data-testid="in-vm-sign-in">
        <ol className="list-decimal space-y-2 pl-5 text-[var(--app-hint)]">
          <li>
            Open a terminal on this VM: open a session, or start one, and choose
            its Terminal tab
          </li>
          <li>
            Run this command:
            <pre className="mt-1 whitespace-pre-wrap break-all rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 font-mono text-xs text-[var(--app-fg)]">
              {step.inVm.command}
            </pre>
            <div className="mt-1">
              <CopyButton text={step.inVm.command} label="Copy command" />
            </div>
          </li>
          <li>
            Type <code>/login</code> in Claude Code and follow its prompts in
            your browser
          </li>
          <li>
            Come back to Add account. This sign-in is kept while you are away,
            and the account is added once Claude Code finishes
          </li>
        </ol>
        <p className="text-[var(--app-hint)]">
          You can close this dialog to reach the terminal. Each account&apos;s
          own limits apply.
        </p>
        {step.error ? (
          <div
            ref={messageRef}
            className="rounded-md bg-red-900/20 p-2 text-red-400"
            role="alert"
          >
            {step.error}{" "}
            <Button
              type="button"
              variant="ghostStatic"
              onClick={() => void step.begin()}
              disabled={locked}
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
        <Button
          type="button"
          variant="outline"
          className="self-start"
          onClick={() => step.inVm && void step.checkInVm(step.inVm.loginToken)}
          disabled={step.inVmChecking}
        >
          {step.inVmChecking ? "Checking…" : "I've signed in"}
        </Button>
        {step.inVm.authorizeUrl && (
          <Button
            type="button"
            variant="ghostStatic"
            onClick={() => step.setInVmTerminal(false)}
            className="h-auto self-start p-0 font-normal text-[var(--app-link)] underline hover:text-[var(--app-link)]"
            data-testid="use-sign-in-link"
          >
            Use the sign-in link instead
          </Button>
        )}
        {leftNodeLine}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3" data-testid="anthropic-login-step">
      {step.savedHere > 0 && (
        <p className="text-[var(--status-ok)]" role="status">
          {step.savedHere === 1
            ? "Account added"
            : `${step.savedHere} accounts added`}
        </p>
      )}
      {step.alreadyConnected && (
        <p
          className="text-[var(--status-ok)]"
          role="status"
          data-testid="anthropic-already-connected"
        >
          {step.alreadyConnected}
        </p>
      )}
      <Button
        type="button"
        className="w-full"
        disabled={!canStart || step.isStarting || locked}
        onClick={() => void step.begin()}
        data-testid="open-sign-in-link"
      >
        {step.isStarting
          ? "Preparing sign-in…"
          : step.authorizeUrl
            ? "Open a new sign-in link"
            : "Sign in to Claude Code"}
      </Button>
      {step.authorizeUrl && (
        <>
          <ol className="list-decimal space-y-2 pl-5 text-[var(--app-hint)]">
            <li>
              Open the Anthropic sign-in page:
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <a
                  href={step.authorizeUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="break-all text-[var(--app-link)] underline"
                >
                  Open sign-in page
                </a>
                <CopyButton text={step.authorizeUrl} label="Copy link" />
              </div>
            </li>
            <li>
              Sign in. To add a different account than the one already signed
              in, use the “Switch account” link on that page. If claude.com
              emails you a 6-digit code, enter it there on claude.com — not
              here.
            </li>
            <li>
              Click Authorize, copy the long authorization code Anthropic shows,
              paste it below and press Done. It works once and expires in a few
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
              value={step.code}
              disabled={locked}
              onChange={e => step.setCode(e.target.value)}
              placeholder="Paste the whole code, including the part after #"
              className={INPUT_CLASS}
              style={{ fontSize: "16px" }}
            />
          </div>
          {step.inVm && (
            <Button
              type="button"
              variant="ghostStatic"
              onClick={() => step.setInVmTerminal(true)}
              disabled={locked}
              className="h-auto self-start p-0 font-normal text-[var(--app-link)] underline hover:text-[var(--app-link)]"
              data-testid="use-terminal-instead"
            >
              Use a terminal instead
            </Button>
          )}
        </>
      )}
      {step.signingIn && (
        <p
          role="status"
          className="text-[var(--app-hint)]"
          data-testid="anthropic-signing-in"
        >
          Still signing in… this finishes on its own
        </p>
      )}
      {(step.hint || step.error) && (
        <div ref={messageRef} className="flex flex-col gap-3">
          {step.hint && (
            <div
              role="status"
              className="rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-2 text-[var(--app-fg)]"
            >
              {step.hint}
            </div>
          )}
          {step.error && (
            <div
              className="rounded-md bg-red-900/20 p-2 text-red-400"
              role="alert"
              data-testid="anthropic-login-error"
            >
              {step.error}
            </div>
          )}
        </div>
      )}
      {leftNodeLine}
    </div>
  );
}
