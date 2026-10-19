// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  LOCAL_NODE_ID,
  type AccountHealthEntry,
  type NodeAccountHealth,
  type OpenAiAuthState,
} from "@hapi/protocol";
import { ApiError, type ApiClient } from "@/api/client";
import { Button } from "@/components/ui/button";
import { ChevronIcon } from "@/components/icons";
import { NodeBadge } from "@/components/NodeBadge";
import { AccountChip } from "@/components/session/AccountChip";
import { AddAccountInstructions } from "@/components/AddAccountInstructions";
import {
  useAccountLogin,
  useInVmAccountLogin,
} from "@/hooks/mutations/useAccountActions";
import { useOpenAiLogin } from "@/hooks/mutations/useOpenAiLogin";
import { useAccountHealth } from "@/hooks/queries/useAccountHealth";
import { useProviderAuthState } from "@/hooks/queries/useProviderAuthState";
import { queryKeys } from "@/lib/query-keys";
import {
  IN_VM_SIGN_IN_REQUIRED,
  type InVmLoginStartResponse,
  type OpenAiLoginState,
} from "@/types/api";
import { formatRefreshUtc, formatSince } from "./addModalDone";

const INPUT_CLASS =
  "w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)]";

/** Issue #4349: how often the in-VM panel asks whether `/login` has finished. */
export const IN_VM_CHECK_INTERVAL_MS = 4000;
/** The Codex device-auth status poll (unchanged from #3807's wizard). */
export const DEVICE_POLL_INTERVAL_MS = 3000;

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

/** Issue #4349: a failed check that should not end the wait (rate limit, server error, network). */
export function isTransientCheckError(err: unknown): boolean {
  if (err instanceof ApiError) return err.status === 429 || err.status >= 500;
  return !(err instanceof Error) || err.name === "TypeError";
}

function errCode(err: unknown): string | undefined {
  return err instanceof ApiError ? err.code : undefined;
}

function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

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
 * logins from the provider-auth envelope joined in by node id.
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
  const currentNodeId = health.localNodeId ?? LOCAL_NODE_ID;
  const nodes = useMemo(() => {
    const openaiByNode = new Map<string, OpenAiAuthState[]>();
    for (const n of authState.nodes) openaiByNode.set(n.nodeId, n.openai);
    return health.nodes.map(n => ({
      nodeId: n.nodeId,
      nodeLabel: n.nodeLabel || n.nodeId,
      isUiHost:
        n.isLocal || n.nodeId === currentNodeId || n.nodeId === LOCAL_NODE_ID,
      status: n.status,
      disabledReason: nodeDisabledReason(n, provider),
      accounts: n.accounts.filter(a => a.provider === provider),
      openai:
        openaiByNode.get(n.nodeId) ??
        (n.isLocal ? (openaiByNode.get(LOCAL_NODE_ID) ?? []) : []),
    }));
  }, [health.nodes, authState.nodes, currentNodeId, provider]);
  return {
    nodes,
    currentNodeId,
    hasData: health.hasData,
    error: health.error,
    refetch: health.refetch,
  };
}

/** `GET /api/federation/nodes`, shared by the add modal's two readers. */
export function useFederationNodesInfo(api: ApiClient | null) {
  return useQuery({
    queryKey: queryKeys.federationNodes,
    queryFn: async () => {
      if (!api) throw new Error("API unavailable");
      return await api.getFederationNodes();
    },
    enabled: Boolean(api),
    staleTime: 60000,
    retry: 1,
  });
}

/** The federation read the NodeBadge resource-health switch needs (#4468 Task 2). */
function useResourceHealthEnabled(api: ApiClient | null): boolean {
  const { data } = useFederationNodesInfo(api);
  return Boolean(data?.enabled && data.role !== "node");
}

// ---------------------------------------------------------------------------
// Anthropic login step (R4, R11)
// ---------------------------------------------------------------------------

export type AnthropicStep = ReturnType<typeof useAnthropicLoginStep>;

/**
 * The Anthropic sign-in on the selected node (B's node-targeted routes). The
 * login starts only when "Open sign-in link" is tapped; changing the node
 * discards a started login (its PKCE state belongs to that node). On a tenant VM
 * (#4349) the UI host's start answers `in_vm_sign_in_required` and the step
 * switches to Claude Code's own `/login` inside the VM.
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
  const [saved, setSaved] = useState(0);
  // Bumped on every start and every node change: a start that resolves after the
  // node changed (or the modal closed) belongs to a discarded attempt (TR1-e).
  const attemptRef = useRef(0);
  const inVmRegisteredRef = useRef(false);
  const inVmStoppedRef = useRef(false);
  const inVmInFlightRef = useRef(false);
  const onAddedRef = useRef(onAdded);
  onAddedRef.current = onAdded;
  const nodeName = node?.nodeLabel ?? "this node";

  const clearLink = useCallback(() => {
    setLoginToken(null);
    setAuthorizeUrl(null);
    setCode("");
    setHint(null);
  }, []);

  // R4: a node change discards the started login. The in-VM sign-in is only
  // forgotten locally — the server keeps it resumable (#4349 CR-1).
  const nodeKey = node?.nodeId ?? null;
  useEffect(() => {
    attemptRef.current += 1;
    clearLink();
    setError(null);
    setInVm(null);
    inVmRegisteredRef.current = false;
    inVmStoppedRef.current = false;
  }, [nodeKey, clearLink]);

  useEffect(() => {
    if (isOpen) return;
    attemptRef.current += 1;
  }, [isOpen]);

  const begin = useCallback(async () => {
    const attempt = ++attemptRef.current;
    setError(null);
    clearLink();
    // #4349: Start over forgets the previous in-VM sign-in. Await the cancel: the
    // server resumes an unfinished sign-in, so a start sent first would resume
    // the one being cancelled.
    if (inVm && !inVmRegisteredRef.current)
      await inVmLoginRef.current.cancel(inVm.loginToken);
    if (attempt !== attemptRef.current) return;
    setInVm(null);
    inVmRegisteredRef.current = false;
    inVmStoppedRef.current = false;
    try {
      const res = await start();
      if (attempt !== attemptRef.current) return;
      setLoginToken(res.loginToken);
      setAuthorizeUrl(res.authorizeUrl);
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
        try {
          const res = await inVmLoginRef.current.start();
          if (attempt !== attemptRef.current) return;
          setInVm(res);
        } catch (inner) {
          if (attempt !== attemptRef.current) return;
          setError(errMessage(inner, "Failed to start sign-in."));
        }
        return;
      }
      setError(errMessage(err, "Failed to start login."));
    }
  }, [clearLink, inVm, node?.isUiHost, nodeName, start]);

  // #4349: ask whether /login has finished in the VM. One check at a time
  // (TR1-e): the poll and the button must not overlap, or an `already_added`
  // answer to the second call would show an error after the account was added.
  const checkInVm = useCallback(async (token: string) => {
    if (
      inVmRegisteredRef.current ||
      inVmStoppedRef.current ||
      inVmInFlightRef.current
    )
      return;
    // A check still in flight when Start over runs belongs to the old sign-in;
    // its answer must not land on the new one.
    const attempt = attemptRef.current;
    inVmInFlightRef.current = true;
    setInVmChecking(true);
    try {
      const account = await inVmLoginRef.current.check(token);
      if (attempt !== attemptRef.current) return;
      if (account && !inVmRegisteredRef.current) {
        inVmRegisteredRef.current = true;
        // A Done pressed before /login finished left "not finished" on screen.
        setError(null);
        setSaved(s => s + 1);
        setInVm(null);
        onAddedRef.current();
      }
    } catch (err) {
      if (attempt !== attemptRef.current) return;
      // A rate limit, a server error or a dropped connection is not an
      // answer: keep waiting.
      if (!isTransientCheckError(err)) {
        inVmStoppedRef.current = true;
        setError(errMessage(err, "Sign-in failed."));
      }
    } finally {
      inVmInFlightRef.current = false;
      setInVmChecking(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen || !inVm) return;
    const timer = setInterval(
      () => void checkInVm(inVm.loginToken),
      IN_VM_CHECK_INTERVAL_MS
    );
    return () => clearInterval(timer);
  }, [isOpen, inVm, checkInVm]);

  /**
   * Done's half (R7): complete the pasted code, if any. Resolves the number of
   * problems (0 or 1). The token is single-use even on a rejected code, so any
   * failure except `invalid_code` needs a fresh link.
   */
  const runDone = useCallback(async (): Promise<number> => {
    if (inVm && !inVmRegisteredRef.current) {
      if (!error) setError("Claude sign-in not finished");
      return 1;
    }
    const trimmed = code.trim();
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
    try {
      await complete({ loginToken, code: trimmed });
      clearLink();
      setSaved(s => s + 1);
      onAddedRef.current();
      return 0;
    } catch (err) {
      const c = errCode(err);
      if (c === "invalid_code") {
        setError(
          errMessage(err, "That code was not accepted · paste it again")
        );
        return 1;
      }
      clearLink();
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
  }, [clearLink, code, complete, error, inVm, loginToken, nodeName]);

  const pending = Boolean(inVm && !inVmRegisteredRef.current);
  return {
    loginToken,
    authorizeUrl,
    code,
    setCode,
    error,
    hint,
    inVm,
    inVmChecking,
    isStarting,
    isCompleting,
    begin,
    checkInVm,
    runDone,
    saved,
    pending,
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
  const [saved, setSaved] = useState(0);
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
        setSaved(s => s + 1);
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
        setDevice({
          kind: "pending",
          verificationUrl: res.verificationUrl,
          userCode: res.userCode,
        });
        timerRef.current = setTimeout(
          () => void poll(),
          DEVICE_POLL_INTERVAL_MS
        );
        return;
      }
      settle(res.state);
    } catch {
      // A transient status error should not abort the flow — keep polling.
      if (stoppedRef.current || tokenRef.current !== t) return;
      timerRef.current = setTimeout(() => void poll(), DEVICE_POLL_INTERVAL_MS);
    }
  }, [settle]);

  const beginDevice = useCallback(async () => {
    cancelPending();
    stoppedRef.current = false;
    const attempt = deviceAttemptRef.current;
    setDevice({ kind: "pending" });
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
      tokenRef.current = { nodeId: target, token: res.loginToken };
      if (res.state === "pending") {
        setDevice({
          kind: "pending",
          verificationUrl: res.verificationUrl,
          userCode: res.userCode,
        });
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

  // A node change drops the started device-auth (R4).
  useEffect(() => {
    cancelPending();
    setDevice({ kind: "idle" });
    setCodexError(null);
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
  const runCodexKey = useCallback((): Promise<boolean> => {
    if (codexInflightRef.current) return codexInflightRef.current;
    const key = codexKey.trim();
    if (!key) return Promise.resolve(true);
    const run = (async (): Promise<boolean> => {
      setCodexBusy(true);
      setCodexError(null);
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
          onAddedRef.current();
          return true;
        }
        setCodexError(
          res.state === "disabled" || res.state === "unsupported"
            ? "In-app OpenAI login is not available on this node"
            : "Could not log Codex in with that key. Your existing login is unchanged."
        );
        return false;
      } catch (err) {
        setCodexKey("");
        setCodexError(errMessage(err, "Failed to add the API key."));
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
  }, [codexKey, nodeId]);

  /** Done's half (R7): a pending device-auth is one problem; a typed Codex key
   *  is logged in now, and a failure is one problem. A node that cannot take a
   *  login (R2) gets no request: the typed key is one problem. */
  const disabledReason = node?.disabledReason ?? null;
  const nodeLabel = node?.nodeLabel ?? "This node";
  const runDone = useCallback(async (): Promise<number> => {
    let problems = 0;
    if (device.kind === "pending") {
      setDevice(d => (d.kind === "pending" ? { ...d, unfinished: true } : d));
      problems += 1;
    }
    if (codexKey.trim()) {
      if (disabledReason) {
        setCodexError(`${nodeLabel}: ${disabledReason}`);
        problems += 1;
      } else if (!(await runCodexKey())) {
        problems += 1;
      }
    }
    return problems;
  }, [codexKey, device.kind, disabledReason, nodeLabel, runCodexKey]);

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
    codexBusy,
    runCodexKey,
    runDone,
    saved,
    pending: device.kind === "pending",
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function accountStatusText(
  a: AccountHealthEntry,
  compact: boolean
): { text: string; tone: "bad" | "muted" } {
  if (a.authKind === "env-token") return { text: "env token", tone: "muted" };
  if (a.needsRelogin) {
    return {
      text: `re-login · ${formatSince(a, { compact }) ?? ""}`.trim(),
      tone: "bad",
    };
  }
  if (a.lastRefreshedAt === null)
    return { text: "never refreshed", tone: "muted" };
  return {
    text: `refreshing · last ${formatRefreshUtc(a.lastRefreshedAt, { compact })}`,
    tone: "muted",
  };
}

function nodeSummary(
  node: LoginNode,
  provider: "anthropic" | "openai"
): {
  text: string;
  bad: boolean;
} {
  const where = node.isUiHost ? "this node" : null;
  if (provider === "openai") {
    const n = node.openai.length;
    const count = `${n} login${n === 1 ? "" : "s"}`;
    return { text: [where, count].filter(Boolean).join(" · "), bad: false };
  }
  const total = node.accounts.length;
  const dead = node.accounts.filter(a => a.needsRelogin).length;
  if (dead > 0) {
    return { text: `${dead} of ${total} accounts need re-login`, bad: true };
  }
  const count = `${total} account${total === 1 ? "" : "s"}`;
  const tail = total > 0 ? "all refreshing" : null;
  return {
    text: [where, count, tail].filter(Boolean).join(" · "),
    bad: false,
  };
}

function useIsCompact(): boolean {
  const [compact, setCompact] = useState(
    () => typeof window !== "undefined" && window.innerWidth < 480
  );
  useEffect(() => {
    const onResize = () => setCompact(window.innerWidth < 480);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return compact;
}

function NodeRow(props: {
  node: LoginNode;
  provider: "anthropic" | "openai";
  selected: boolean;
  onSelect: () => void;
  resourceHealth: boolean;
  compact: boolean;
}) {
  const { node, provider, selected, compact } = props;
  const [expanded, setExpanded] = useState(false);
  const summary = nodeSummary(node, provider);
  const disabled = node.disabledReason !== null;
  const radioId = `add-node-${node.nodeId}`;
  return (
    <li
      className={`rounded-md border ${selected ? "border-[var(--app-link)]" : "border-[var(--app-border)]"} bg-[var(--app-secondary-bg)]`}
      data-testid="add-node-row"
      data-node-id={node.nodeId}
      data-disabled={disabled ? "true" : "false"}
    >
      <div className="flex items-center gap-2 px-2.5 py-2">
        <input
          id={radioId}
          type="radio"
          name="add-node"
          checked={selected}
          disabled={disabled && !selected}
          onChange={props.onSelect}
          className="h-4 w-4 shrink-0 accent-[var(--app-link)]"
        />
        <label
          htmlFor={radioId}
          className="flex min-w-0 flex-1 items-center gap-2"
        >
          <NodeBadge
            nodeId={node.nodeId}
            nodeLabel={node.nodeLabel}
            interactive={false}
            resourceHealth={props.resourceHealth}
            labelAsReceived={node.isUiHost}
            nodeStatus={
              node.status === "offline" || node.status === "unreachable"
                ? "offline"
                : "online"
            }
          />
          <span
            className={`min-w-0 truncate text-[length:var(--text-body-dense)] ${
              disabled || summary.bad
                ? "text-[var(--accent-rose-400)]"
                : "text-[var(--app-hint)]"
            }`}
            data-testid="add-node-summary"
          >
            {disabled ? node.disabledReason : summary.text}
          </span>
        </label>
        <Button
          type="button"
          variant="ghostStatic"
          size="bare"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Hide" : "Show"} ${node.nodeLabel} accounts`}
          onClick={() => setExpanded(e => !e)}
          className="shrink-0 p-1 text-[var(--app-hint)]"
          data-testid="add-node-expand"
        >
          <ChevronIcon className="h-3.5 w-3.5" collapsed={!expanded} />
        </Button>
      </div>
      {expanded && (
        <ul
          className="flex flex-col gap-1.5 border-t border-[var(--app-border)] px-2.5 py-2"
          data-testid="add-node-accounts"
        >
          {provider === "anthropic" &&
            node.accounts.map(a => {
              const st = accountStatusText(a, compact);
              return (
                <li
                  key={a.accountUuid}
                  className="flex min-w-0 items-center gap-2"
                  data-testid="add-node-account"
                >
                  <span className="max-w-[45%] shrink-0" title={a.emailAddress}>
                    <AccountChip
                      email={a.emailAddress}
                      label={a.nickname ?? undefined}
                      monogram={a.monogram ?? undefined}
                    />
                  </span>
                  <span
                    className={`min-w-0 truncate font-mono text-[length:var(--text-caption)] ${
                      st.tone === "bad"
                        ? "text-[var(--accent-rose-400)]"
                        : "text-[var(--app-hint)]"
                    }`}
                  >
                    {st.text}
                  </span>
                </li>
              );
            })}
          {provider === "openai" &&
            node.openai.map((o, i) => (
              <li
                key={`${o.source}:${o.accountUuid ?? i}`}
                className="flex min-w-0 items-center gap-2 text-[length:var(--text-caption)]"
                data-testid="add-node-account"
              >
                <span className="min-w-0 truncate text-[var(--app-fg)]">
                  {o.label ?? o.email ?? node.nodeLabel}
                </span>
                {o.plan && (
                  <span className="text-[var(--app-hint)]">{o.plan}</span>
                )}
                {o.expiresAt && (
                  <span className="font-mono text-[var(--app-hint)]">
                    expires{" "}
                    {formatRefreshUtc(Date.parse(o.expiresAt), { compact })}
                  </span>
                )}
              </li>
            ))}
          {(provider === "anthropic"
            ? node.accounts.length
            : node.openai.length) === 0 && (
            <li className="text-[length:var(--text-caption)] text-[var(--app-hint)]">
              No{" "}
              {provider === "anthropic" ? "Claude accounts" : "OpenAI logins"}{" "}
              on {node.nodeLabel} yet
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

function CopyButton(props: { text: string; label: string }) {
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

function AnthropicStepView(props: {
  step: AnthropicStep;
  node: LoginNode | null;
}) {
  const { step, node } = props;
  const canStart = Boolean(node && node.disabledReason === null);
  if (step.inVm) {
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
            className="rounded-md bg-red-900/20 p-2 text-red-400"
            role="alert"
          >
            {step.error}{" "}
            <Button
              type="button"
              variant="ghostStatic"
              onClick={() => void step.begin()}
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
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3" data-testid="anthropic-login-step">
      {step.saved > 0 && (
        <p className="text-[var(--status-ok)]" role="status">
          {step.saved === 1 ? "Account added" : `${step.saved} accounts added`}
        </p>
      )}
      <Button
        type="button"
        className="w-full"
        disabled={!canStart || step.isStarting}
        onClick={() => void step.begin()}
        data-testid="open-sign-in-link"
      >
        {step.isStarting
          ? "Preparing sign-in…"
          : step.authorizeUrl
            ? "Open a new sign-in link"
            : "Open sign-in link"}
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
              onChange={e => step.setCode(e.target.value)}
              placeholder="Paste the whole code, including the part after #"
              className={INPUT_CLASS}
              style={{ fontSize: "16px" }}
            />
          </div>
        </>
      )}
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
  );
}

function OpenAiStepView(props: { step: OpenAiStep; node: LoginNode | null }) {
  const { step, node } = props;
  const [keyOpen, setKeyOpen] = useState(false);
  const canStart = Boolean(node && node.disabledReason === null);
  const d = step.device;
  return (
    <div className="flex flex-col gap-3" data-testid="openai-login-step">
      {step.saved > 0 && (
        <p className="text-[var(--status-ok)]" role="status">
          {step.saved === 1 ? "Login added" : `${step.saved} logins added`}
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
          disabled={!canStart}
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
          />
        </div>
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
                disabled={step.codexBusy}
                onChange={e => step.setCodexKey(e.target.value)}
                className={INPUT_CLASS}
                style={{ fontSize: "16px" }}
                data-testid="codex-key-input"
              />
              <Button
                type="button"
                variant="outline"
                disabled={!canStart || !step.codexKey.trim() || step.codexBusy}
                onClick={() => void step.runCodexKey()}
                data-testid="codex-key-submit"
              >
                {step.codexBusy ? "…" : "Log in"}
              </Button>
            </div>
            {step.codexError && (
              <p
                className="text-[length:var(--text-caption)] text-[var(--accent-rose-400)]"
                role="alert"
              >
                {step.codexError}
              </p>
            )}
          </div>
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
}) {
  const resourceHealth = useResourceHealthEnabled(props.api);
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
        <AnthropicStepView step={props.anthropic} node={selected} />
      )}
      {props.provider === "openai" && props.openai && (
        <OpenAiStepView step={props.openai} node={selected} />
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
