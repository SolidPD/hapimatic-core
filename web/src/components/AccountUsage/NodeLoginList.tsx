// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  LOCAL_NODE_ID,
  type AccountHealthEntry,
  type NodeAccountHealth,
  type NodeProviderAuthState,
  type OpenAiAuthState,
} from "@hapi/protocol";
import type { ApiClient } from "@/api/client";
import { Button } from "@/components/ui/button";
import { ChevronIcon } from "@/components/icons";
import { AddAccountInstructions } from "@/components/AddAccountInstructions";
import { useOpenAiLogin } from "@/hooks/mutations/useOpenAiLogin";
import { useAccountHealth } from "@/hooks/queries/useAccountHealth";
import { useProviderAuthState } from "@/hooks/queries/useProviderAuthState";
import {
  useFederationHealthAvailable,
  useFederationNodesInfo,
} from "@/hooks/queries/useFederationHealthAvailable";
import { queryKeys } from "@/lib/query-keys";
import type { OpenAiLoginState } from "@/types/api";
import { AnthropicStepView, type AnthropicStep } from "./AnthropicLoginStep";
import {
  CopyButton,
  errMessage,
  INPUT_CLASS,
  isTransientCheckError,
} from "./loginStepShared";
import { NodeRow, useIsCompact } from "./NodeLoginRow";

export {
  IN_VM_CHECK_INTERVAL_MS,
  NOT_AN_AUTHORIZATION_CODE_HINT,
  useAnthropicLoginStep,
  type AnthropicStep,
} from "./AnthropicLoginStep";
export { isTransientCheckError } from "./loginStepShared";

/** The Codex device-auth status poll (unchanged from #3807's wizard). */
export const DEVICE_POLL_INTERVAL_MS = 3000;
/**
 * #5871: OpenAI's own Linux/macOS installer for the Codex CLI. It places a
 * standalone `codex` in `~/.local/bin`, which the server's Codex login finds
 * without a PATH change or a restart.
 */
export const CODEX_INSTALL_COMMAND =
  "curl -fsSL https://chatgpt.com/codex/install.sh | sh";

// ---------------------------------------------------------------------------
// Node model
// ---------------------------------------------------------------------------

export type LoginNode = {
  nodeId: string;
  nodeLabel: string;
  isUiHost: boolean;
  status: NodeAccountHealth["status"];
  /** Why the radio is disabled; null when the node can take a login. */
  disabledReason: string | null;
  accounts: AccountHealthEntry[];
  openai: OpenAiAuthState[];
  /** #5467 S10: the provider-auth row's status for this node; "error" when the
   *  whole envelope read failed, "loading" while the read has not answered yet
   *  (#6054 SINK-2), undefined when it answered with no row for the node or
   *  when no read runs (the Anthropic tab). A non-ok status means `openai` is
   *  unknown, not empty. */
  openaiStatus?: NodeProviderAuthState["status"] | "loading";
  /** #5467 S6: the node's federation role, when federation is on: the UI
   *  host's own role, or the role the UI host's registry polled for a peer. */
  role?: "hub" | "node" | "peer";
};

/**
 * Whether a node can take a login in this modal (R2). The Anthropic modal also
 * needs B's capability (`loginSupported.anthropic`); the OpenAI modal does not,
 * because the #3807 OpenAI receivers predate #4461.
 */
export function nodeDisabledReason(
  node: Pick<NodeAccountHealth, "status" | "loginSupported" | "nodeLabel">,
  provider: "anthropic" | "openai"
): string | null {
  if (node.status === "offline" || node.status === "unreachable") {
    return "offline · cannot log in now";
  }
  if (provider === "openai") return null;
  if (
    node.status === "unsupported" ||
    node.loginSupported?.anthropic !== true
  ) {
    return `update ${node.nodeLabel} to log in here`;
  }
  return null;
}

/**
 * The node rows for the modal: every federation node from #4461's per-node
 * health read (the UI host first, as the server emits it), with the OpenAI
 * logins from the provider-auth envelope joined in by node id — and that row's
 * status, so a failed read is never shown as an empty list (#5467 S10). The
 * role comes from `GET /api/federation/nodes`, which the modal already reads:
 * the UI host's is the top-level `role`, a peer's is its polled `info.role`,
 * keyed by `config.id` (the health envelope's node id) (#5467 S6).
 */
export function useLoginNodes(
  api: ApiClient | null,
  provider: "anthropic" | "openai",
  enabled: boolean
): {
  nodes: LoginNode[];
  currentNodeId: string;
  hasData: boolean;
  error: string | null;
  refetch: () => void;
} {
  const health = useAccountHealth(api, enabled);
  const authState = useProviderAuthState(api, enabled && provider === "openai");
  const { data: federation } = useFederationNodesInfo(api);
  const currentNodeId = health.localNodeId ?? LOCAL_NODE_ID;
  // A failed envelope read with no cached data leaves every node's logins
  // unknown, so each row shows the degraded line rather than an empty list.
  const envelopeFailed =
    provider === "openai" &&
    authState.error !== null &&
    authState.nodes.length === 0;
  // #6054 SINK-2: no answer yet (loading, or a first fetch paused offline), so
  // the logins are unknown, not zero.
  const envelopeLoading = provider === "openai" && authState.awaitingAnswer;
  const nodes = useMemo(() => {
    const authByNode = new Map<string, NodeProviderAuthState>();
    for (const n of authState.nodes) authByNode.set(n.nodeId, n);
    const peerRoles = new Map<string, LoginNode["role"]>();
    if (federation?.enabled) {
      for (const s of federation.nodes) {
        if (s.info?.role) peerRoles.set(s.config.id, s.info.role);
      }
    }
    return health.nodes.map((n): LoginNode => {
      const isUiHost =
        n.isLocal || n.nodeId === currentNodeId || n.nodeId === LOCAL_NODE_ID;
      const auth =
        authByNode.get(n.nodeId) ??
        (n.isLocal ? authByNode.get(LOCAL_NODE_ID) : undefined);
      return {
        nodeId: n.nodeId,
        nodeLabel: n.nodeLabel || n.nodeId,
        isUiHost,
        status: n.status,
        disabledReason: nodeDisabledReason(n, provider),
        accounts: n.accounts.filter(a => a.provider === provider),
        openai: auth?.openai ?? [],
        openaiStatus:
          auth?.status ??
          (envelopeFailed ? "error" : envelopeLoading ? "loading" : undefined),
        role: !federation?.enabled
          ? undefined
          : isUiHost
            ? federation.role
            : peerRoles.get(n.nodeId),
      };
    });
  }, [
    health.nodes,
    authState.nodes,
    envelopeFailed,
    envelopeLoading,
    currentNodeId,
    provider,
    federation,
  ]);
  return {
    nodes,
    currentNodeId,
    hasData: health.hasData,
    error: health.error,
    refetch: health.refetch,
  };
}

// ---------------------------------------------------------------------------
// OpenAI login step (R4; C-1 A)
// ---------------------------------------------------------------------------

export type OpenAiStep = ReturnType<typeof useOpenAiLoginStep>;

type DeviceState =
  | { kind: "idle" }
  | {
      kind: "pending";
      verificationUrl?: string;
      userCode?: string;
      /** Set when Done counted this pending sign-in as a problem. */
      unfinished?: boolean;
    }
  | { kind: "done" }
  | { kind: "failed"; message: string }
  | { kind: "fallback"; state: "disabled" | "unsupported" };

/**
 * The OpenAI sign-in on the selected node: the ChatGPT device-auth loop lifted
 * from #3807's wizard (its `nodeId` contract unchanged), plus the "Log Codex in
 * with an API key" disclosure (ruling C-1 A — a Codex login, not a vault key).
 */
export function useOpenAiLoginStep(
  api: ApiClient | null,
  opts: { node: LoginNode | null; isOpen: boolean; onAdded: () => void }
) {
  const { node, isOpen, onAdded } = opts;
  const nodeId = node?.nodeId ?? LOCAL_NODE_ID;
  // useOpenAiLogin returns new functions every render; read them through a ref
  // so cancelPending (an effect dependency) and the poll stay stable — otherwise
  // the node-change effect re-runs every render.
  const openAiLogin = useOpenAiLogin(api);
  const loginRef = useRef(openAiLogin);
  loginRef.current = openAiLogin;
  const [device, setDevice] = useState<DeviceState>({ kind: "idle" });
  const [codexKey, setCodexKey] = useState("");
  const [codexError, setCodexError] = useState<string | null>(null);
  const [codexBusy, setCodexBusy] = useState(false);
  // #5871: the node answered that it has no Codex CLI — shown once for both
  // paths, in place of their generic failure lines.
  const [codexMissing, setCodexMissing] = useState(false);
  // #5467 S11: an API-key answer for a node the user has left, shown under that
  // node's name. Its own state, so the new node's resets (a not-installed
  // answer, a new key attempt) never wipe a line Done may still count; only the
  // next node change clears it.
  const [leftNodeError, setLeftNodeError] = useState<{
    nodeId: string;
    text: string;
  } | null>(null);
  const [saved, setSaved] = useState(0);
  // #6054: the "Login added" line counts only logins added on the node selected
  // now, since it was picked (the Anthropic step's rule); `saved` keeps every
  // add for the footer.
  const [savedHere, setSavedHere] = useState(0);
  const tokenRef = useRef<{ nodeId: string; token: string } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set once the loop has stopped (settled, cancelled, node changed, unmounted):
  // a status call in flight then must not schedule another poll (TR1-e).
  const stoppedRef = useRef(true);
  const onAddedRef = useRef(onAdded);
  onAddedRef.current = onAdded;

  const stop = useCallback(() => {
    stoppedRef.current = true;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /** Cancel a pending device-auth so no staging dir is left behind. */
  // Each ChatGPT start gets a number; cancelling bumps it, so a start that
  // answers after a Cancel or a node change is recognised as abandoned.
  const deviceAttemptRef = useRef(0);
  const cancelPending = useCallback(() => {
    const t = tokenRef.current;
    deviceAttemptRef.current += 1;
    stop();
    tokenRef.current = null;
    if (t)
      void loginRef.current.cancel(t.nodeId, t.token).catch(() => undefined);
  }, [stop]);

  const settle = useCallback(
    (state: OpenAiLoginState) => {
      stop();
      tokenRef.current = null;
      if (state === "ok") {
        void loginRef.current.invalidateAuthState();
        // A node change cancels device auth, so its success is always for the
        // node selected now.
        setSaved(s => s + 1);
        setSavedHere(s => s + 1);
        setDevice({ kind: "done" });
        onAddedRef.current();
      } else if (state === "disabled" || state === "unsupported") {
        setDevice({ kind: "fallback", state });
      } else if (state === "cancelled") {
        setDevice({ kind: "idle" });
      } else {
        setDevice({
          kind: "failed",
          message:
            "Could not add the ChatGPT account. Your existing login is unchanged.",
        });
      }
    },
    [stop]
  );

  const poll = useCallback(async () => {
    const t = tokenRef.current;
    if (!t || stoppedRef.current) return;
    try {
      const res = await loginRef.current.status(t.nodeId, t.token);
      if (stoppedRef.current || tokenRef.current !== t) return;
      if (res.state === "pending") {
        // #5467 S14: keep the flag Done set, or "ChatGPT sign-in not finished"
        // disappears at the next poll while Done still counts it.
        setDevice(d => ({
          kind: "pending",
          verificationUrl: res.verificationUrl,
          userCode: res.userCode,
          ...(d.kind === "pending" && d.unfinished ? { unfinished: true } : {}),
        }));
        timerRef.current = setTimeout(
          () => void poll(),
          DEVICE_POLL_INTERVAL_MS
        );
        return;
      }
      settle(res.state);
    } catch (err) {
      if (stoppedRef.current || tokenRef.current !== t) return;
      // A rate limit, a server error, a dropped connection or a timeout is
      // not an answer: keep polling.
      if (isTransientCheckError(err)) {
        timerRef.current = setTimeout(
          () => void poll(),
          DEVICE_POLL_INTERVAL_MS
        );
        return;
      }
      // #5467 S2: an error that will not clear (an expired session, a 4xx)
      // would retry forever. Stop, cancel the attempt, and say why.
      cancelPending();
      setDevice({
        kind: "failed",
        message: errMessage(err, "Could not check the ChatGPT sign-in."),
      });
    }
  }, [cancelPending, settle]);

  const beginDevice = useCallback(async () => {
    cancelPending();
    stoppedRef.current = false;
    const attempt = deviceAttemptRef.current;
    setDevice({ kind: "pending" });
    setCodexMissing(false);
    const target = nodeId;
    try {
      const res = await loginRef.current.start.mutateAsync({
        nodeId: target,
        kind: "device-auth",
        label: "ChatGPT subscription",
      });
      if (stoppedRef.current || attempt !== deviceAttemptRef.current) {
        void loginRef.current
          .cancel(target, res.loginToken)
          .catch(() => undefined);
        return;
      }
      if (res.state === "failed" && res.reason === "codex-not-installed") {
        stop();
        setDevice({ kind: "idle" });
        // The notice stands in for the API-key path's failure line as well.
        setCodexError(null);
        setCodexMissing(true);
        return;
      }
      tokenRef.current = { nodeId: target, token: res.loginToken };
      if (res.state === "pending") {
        // #5467 S14: Done can run while the start is in flight; keep its flag.
        setDevice(d => ({
          kind: "pending",
          verificationUrl: res.verificationUrl,
          userCode: res.userCode,
          ...(d.kind === "pending" && d.unfinished ? { unfinished: true } : {}),
        }));
        timerRef.current = setTimeout(
          () => void poll(),
          DEVICE_POLL_INTERVAL_MS
        );
      } else {
        settle(res.state);
      }
    } catch (err) {
      if (attempt !== deviceAttemptRef.current) return;
      stop();
      setDevice({
        kind: "failed",
        message: errMessage(err, "Failed to start ChatGPT sign-in."),
      });
    }
  }, [cancelPending, nodeId, poll, settle, stop]);

  // A node change drops the started device-auth (R4), and every line shown for
  // the previous node, the left-node line included (#5467 S11).
  useEffect(() => {
    cancelPending();
    setDevice({ kind: "idle" });
    setCodexError(null);
    setCodexMissing(false);
    setLeftNodeError(null);
    setSavedHere(0);
  }, [nodeId, cancelPending]);

  // Closing the modal cancels a pending device-auth (R8); unmount does too.
  useEffect(() => {
    if (!isOpen) cancelPending();
  }, [isOpen, cancelPending]);
  useEffect(() => () => cancelPending(), [cancelPending]);

  /** `codex login --with-api-key` on the selected node. Resolves true on ok.
   *  A call while one is in flight shares it, so Done never sends the key a
   *  second time. */
  const codexInflightRef = useRef<Promise<boolean> | null>(null);
  // #5871: the node picked now. An answer for a node the user has since left
  // is shown under that node's name, never as the new node's notice.
  const nodeIdRef = useRef(nodeId);
  nodeIdRef.current = nodeId;
  const nodeLabel = node?.nodeLabel ?? "This node";
  const runCodexKey = useCallback((): Promise<boolean> => {
    if (codexInflightRef.current) return codexInflightRef.current;
    const key = codexKey.trim();
    if (!key) return Promise.resolve(true);
    const label = nodeLabel;
    // #5467 S11: an answer for a node the user has left is shown under that
    // node's name, in its own state, so the new node's resets keep it.
    const showLeft = (text: string) =>
      setLeftNodeError({ nodeId, text: `${label}: ${text}` });
    const run = (async (): Promise<boolean> => {
      setCodexBusy(true);
      setCodexError(null);
      setCodexMissing(false);
      try {
        const res = await loginRef.current.start.mutateAsync({
          nodeId,
          kind: "api-key",
          label: "OpenAI (API key)",
          key,
        });
        setCodexKey(""); // never keep the raw key around
        if (res.state === "ok") {
          setSaved(s => s + 1);
          // #6054: a login added on a node the user has since left counts,
          // but shows no line under the new node.
          if (nodeIdRef.current === nodeId) setSavedHere(s => s + 1);
          onAddedRef.current();
          return true;
        }
        // If the node changed while the login ran, the node-change effect has
        // cleared what the new node shows; name the node this answer is for,
        // because Done still counts the failure and must have a line to show.
        const left = nodeIdRef.current !== nodeId;
        if (res.state === "failed" && res.reason === "codex-not-installed") {
          if (left) {
            showLeft(
              "Codex is not installed there. Your existing login is unchanged."
            );
          } else {
            // The notice stands in for the ChatGPT path's failure line too.
            setDevice(d => (d.kind === "failed" ? { kind: "idle" } : d));
            setCodexMissing(true);
          }
          return false;
        }
        const message =
          res.state === "disabled" || res.state === "unsupported"
            ? `In-app OpenAI login is not available ${left ? "there" : "on this node"}`
            : "Could not log Codex in with that key. Your existing login is unchanged.";
        if (left) showLeft(message);
        else setCodexError(message);
        return false;
      } catch (err) {
        setCodexKey("");
        const message = errMessage(err, "Failed to add the API key.");
        if (nodeIdRef.current === nodeId) setCodexError(message);
        else showLeft(message);
        return false;
      } finally {
        setCodexBusy(false);
      }
    })();
    codexInflightRef.current = run;
    void run.finally(() => {
      if (codexInflightRef.current === run) codexInflightRef.current = null;
    });
    return run;
  }, [codexKey, nodeId, nodeLabel]);

  /** Done's half (R7): a pending device-auth is one problem; a typed Codex key
   *  is logged in now, and a failure is one problem. A node that cannot take a
   *  login (R2) gets no request: the typed key is one problem. So does no node
   *  at all (#5467 S3): with the nodes still loading or failed to load, the key
   *  would otherwise go to LOCAL_NODE_ID, which the Log in button refuses. */
  const disabledReason = node?.disabledReason ?? null;
  const hasNode = node !== null;
  const runDone = useCallback(async (): Promise<number> => {
    let problems = 0;
    if (device.kind === "pending") {
      setDevice(d => (d.kind === "pending" ? { ...d, unfinished: true } : d));
      problems += 1;
    }
    if (codexKey.trim()) {
      if (!hasNode) {
        setCodexError("No node selected · the key was not sent");
        problems += 1;
      } else if (disabledReason) {
        setCodexError(`${nodeLabel}: ${disabledReason}`);
        problems += 1;
      } else if (!(await runCodexKey())) {
        problems += 1;
      }
    }
    return problems;
  }, [codexKey, device.kind, disabledReason, hasNode, nodeLabel, runCodexKey]);

  // #5467 S12: the problems Done reports that are still on screen (the modal's
  // banner counts them live). A failed ChatGPT sign-in is not one: nothing is
  // pending, so the next Done closes. The not-installed notice stands in for
  // the Codex key's line.
  const problemCount =
    (device.kind === "pending" && device.unfinished ? 1 : 0) +
    (codexError !== null || codexMissing ? 1 : 0) +
    (leftNodeError !== null ? 1 : 0);

  return {
    device,
    beginDevice,
    cancelDevice: () => {
      cancelPending();
      setDevice({ kind: "idle" });
    },
    cancelPending,
    codexKey,
    setCodexKey,
    codexError,
    leftNodeError,
    problemCount,
    codexBusy,
    codexMissing,
    runCodexKey,
    runDone,
    saved,
    savedHere,
    pending: device.kind === "pending",
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * #5871: the node has no Codex CLI, so neither sign-in path can run there.
 * Says so, and gives OpenAI's own install command to run on that machine.
 */
function CodexNotInstalledNotice(props: { nodeLabel: string }) {
  const { nodeLabel } = props;
  return (
    <div
      className="flex flex-col gap-2"
      role="alert"
      data-testid="codex-not-installed"
    >
      <p className="text-[var(--accent-rose-400)]">
        Codex is not installed on {nodeLabel}, so it cannot sign in there. Your
        existing login is unchanged.
      </p>
      <ol className="list-decimal space-y-2 pl-5 text-[var(--app-hint)]">
        <li>
          Open a terminal on {nodeLabel} and run this command:
          {/* break-words, not break-all: wrap at the spaces. A word is split
              only when it alone is wider than the box; the URL fits at 393 px. */}
          <pre className="mt-1 whitespace-pre-wrap break-words rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 font-mono text-xs text-[var(--app-fg)]">
            {CODEX_INSTALL_COMMAND}
          </pre>
          <div className="mt-1">
            <CopyButton text={CODEX_INSTALL_COMMAND} label="Copy command" />
          </div>
        </li>
        <li>Come back here and sign in again</li>
      </ol>
    </div>
  );
}

function OpenAiStepView(props: {
  step: OpenAiStep;
  node: LoginNode | null;
  /** #5467 S8: Done is running — no new sign-in, and the key is not editable. */
  locked: boolean;
}) {
  const { step, node, locked } = props;
  const [keyOpen, setKeyOpen] = useState(false);
  const canStart = Boolean(node && node.disabledReason === null);
  const d = step.device;
  return (
    <div className="flex flex-col gap-3" data-testid="openai-login-step">
      {step.savedHere > 0 && (
        <p className="text-[var(--status-ok)]" role="status">
          {step.savedHere === 1
            ? "Login added"
            : `${step.savedHere} logins added`}
        </p>
      )}
      {d.kind === "pending" ? (
        <div
          className="flex flex-col gap-2"
          data-testid="openai-device-pending"
        >
          {d.verificationUrl && d.userCode ? (
            <ol className="list-decimal space-y-2 pl-5 text-[var(--app-hint)]">
              <li>
                Open the sign-in page:
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <a
                    href={d.verificationUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="break-all text-[var(--app-link)] underline"
                    data-testid="openai-device-url"
                  >
                    {d.verificationUrl}
                  </a>
                  <CopyButton text={d.verificationUrl} label="Copy link" />
                </div>
              </li>
              <li>
                Enter this one-time code:
                <span
                  className="ml-1 font-mono font-semibold text-[var(--app-fg)]"
                  data-testid="openai-device-code"
                >
                  {d.userCode}
                </span>
              </li>
              <li>
                Approve the sign-in in your browser — this updates on its own.
              </li>
            </ol>
          ) : (
            <p className="text-[var(--app-hint)]">Preparing sign-in…</p>
          )}
          {d.unfinished && (
            <p
              className="text-[var(--accent-rose-400)]"
              role="alert"
              data-testid="openai-device-unfinished"
            >
              ChatGPT sign-in not finished · approve it in your browser or
              cancel it
            </p>
          )}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="self-start"
            onClick={step.cancelDevice}
            data-testid="openai-device-cancel"
          >
            Cancel sign-in
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          className="w-full"
          disabled={!canStart || locked}
          onClick={() => void step.beginDevice()}
          data-testid="openai-device-start"
        >
          Sign in with a ChatGPT subscription
        </Button>
      )}
      {d.kind === "failed" && (
        <p className="text-[var(--accent-rose-400)]" role="alert">
          {d.message}
        </p>
      )}
      {d.kind === "fallback" && (
        <div className="flex flex-col gap-2">
          <p className="text-[var(--toast-warning)]">
            {d.state === "disabled"
              ? "In-app OpenAI login is disabled on this node. Add the account on the host instead:"
              : "This node's workspace does not support device-code sign-in. Add the account on the host instead:"}
          </p>
          <AddAccountInstructions
            provider="openai"
            intro="Add the OpenAI account by logging in directly on the target machine:"
            showInAppStep={false}
          />
        </div>
      )}
      {step.codexMissing && (
        <CodexNotInstalledNotice nodeLabel={node?.nodeLabel ?? "this node"} />
      )}
      <div className="flex flex-col gap-1.5">
        <Button
          type="button"
          variant="ghostStatic"
          size="bare"
          aria-expanded={keyOpen}
          onClick={() => setKeyOpen(o => !o)}
          className="flex items-center justify-start gap-1.5 self-start font-normal text-[var(--app-link)]"
          data-testid="codex-key-toggle"
        >
          <ChevronIcon className="h-3 w-3" collapsed={!keyOpen} />
          Log Codex in with an API key
        </Button>
        {keyOpen && (
          <div className="flex flex-col gap-1.5">
            <p className="text-[length:var(--text-caption)] text-[var(--app-hint)]">
              Creates a Codex account on {node?.nodeLabel ?? "this node"} from
              the key (not a vault key). Sent once and never stored in this
              browser.
            </p>
            <div className="flex gap-2">
              <input
                type="password"
                aria-label="OpenAI API key for Codex"
                placeholder="Paste the OpenAI API key"
                autoComplete="off"
                spellCheck={false}
                value={step.codexKey}
                disabled={step.codexBusy || locked}
                onChange={e => step.setCodexKey(e.target.value)}
                className={INPUT_CLASS}
                style={{ fontSize: "16px" }}
                data-testid="codex-key-input"
              />
              <Button
                type="button"
                variant="outline"
                disabled={
                  !canStart || !step.codexKey.trim() || step.codexBusy || locked
                }
                onClick={() => void step.runCodexKey()}
                data-testid="codex-key-submit"
              >
                {step.codexBusy ? "…" : "Log in"}
              </Button>
            </div>
          </div>
        )}
        {/* #5467 S13: outside the panel. Done sends a typed key even when the
            panel is collapsed, so a failure it counts must stay visible. */}
        {step.codexError && (
          <p
            className="text-[length:var(--text-caption)] text-[var(--accent-rose-400)]"
            role="alert"
            data-testid="codex-key-error"
          >
            {step.codexError}
          </p>
        )}
        {/* #5467 S11: an answer for a node the user has left. */}
        {step.leftNodeError && (
          <p
            className="text-[length:var(--text-caption)] text-[var(--accent-rose-400)]"
            role="alert"
            data-testid="codex-left-node-error"
          >
            {step.leftNodeError.text}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * NodeLoginList — the "Subscription login" section of the "+ Add" modal (issue
 * #4464 R2–R4, R11): every federation node as a collapsed radio row (the radio
 * picks the node that stores the login), an expandable list of every account
 * that node holds, and the login step for the selected node underneath.
 */
export function NodeLoginList(props: {
  api: ApiClient | null;
  provider: "anthropic" | "openai";
  nodes: LoginNode[];
  hasData: boolean;
  error: string | null;
  onRetry: () => void;
  selectedNodeId: string | null;
  onSelect: (nodeId: string) => void;
  /** An `initialNodeId` that is not in the envelope (#4462 Task 7's last case). */
  unknownNodeId?: string;
  anthropic?: AnthropicStep;
  openai?: OpenAiStep;
  /** #5467 S8: Done is running; the login step's text inputs and the controls
   *  that start a sign-in are locked. */
  locked?: boolean;
}) {
  const locked = props.locked ?? false;
  const resourceHealth = useFederationHealthAvailable(props.api);
  const compact = useIsCompact();
  const selected =
    props.nodes.find(n => n.nodeId === props.selectedNodeId) ?? null;
  return (
    <section className="flex flex-col gap-2" data-testid="add-modal-login">
      <h3 className="text-[length:var(--text-label-strong)] font-semibold text-[var(--app-fg)]">
        Subscription login
      </h3>
      {props.unknownNodeId && (
        <p className="text-[length:var(--text-caption)] text-[var(--toast-warning)]">
          Unknown node: {props.unknownNodeId}
        </p>
      )}
      {!props.hasData ? (
        props.error ? (
          <div
            className="flex items-center gap-2 text-[var(--toast-warning)]"
            role="alert"
          >
            <span className="min-w-0 flex-1">Could not load the nodes</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={props.onRetry}
            >
              Retry
            </Button>
          </div>
        ) : (
          <p className="text-[var(--app-hint)]" data-testid="add-node-loading">
            Loading nodes…
          </p>
        )
      ) : (
        <ul className="flex flex-col gap-1.5">
          {props.nodes.map(n => (
            <NodeRow
              key={n.nodeId}
              node={n}
              provider={props.provider}
              selected={n.nodeId === props.selectedNodeId}
              onSelect={() => props.onSelect(n.nodeId)}
              resourceHealth={resourceHealth}
              compact={compact}
            />
          ))}
        </ul>
      )}
      {props.provider === "anthropic" && props.anthropic && (
        <AnthropicStepView
          step={props.anthropic}
          node={selected}
          locked={locked}
        />
      )}
      {props.provider === "openai" && props.openai && (
        <OpenAiStepView step={props.openai} node={selected} locked={locked} />
      )}
    </section>
  );
}

/** For tests and the modal: invalidate everything a finished add changes. */
export function useInvalidateAfterAdd() {
  const queryClient = useQueryClient();
  return useCallback(() => {
    for (const queryKey of [
      queryKeys.accounts,
      queryKeys.providerAuthState,
      queryKeys.apiKeys,
      queryKeys.accountHealth,
    ]) {
      void queryClient.invalidateQueries({ queryKey });
    }
  }, [queryClient]);
}
