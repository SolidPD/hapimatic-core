// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  LOCAL_NODE_ID,
  LOCAL_NODE_LABEL,
  type ProviderId,
} from "@hapi/protocol";
import type { ApiClient } from "@/api/client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useVisualViewportHeight } from "@/hooks/useVisualViewportHeight";
import { useRefreshAccountUsage } from "@/hooks/queries/useAccountUsage";
import {
  KeyEntryRows,
  PROVIDER_NAME,
  useKeyRows,
} from "@/components/AccountUsage/KeyEntryRows";
import {
  NodeLoginList,
  useAnthropicLoginStep,
  useInvalidateAfterAdd,
  useLoginNodes,
  useOpenAiLoginStep,
} from "@/components/AccountUsage/NodeLoginList";
import { useFederationNodesInfo } from "@/hooks/queries/useFederationHealthAvailable";

export type AddToProviderModalProps = {
  isOpen: boolean;
  onClose: () => void;
  api: ApiClient | null;
  provider: ProviderId;
  /** Preselect this node (a per-node row, a spawn target, a staged session, or
   *  the re-login deep link). Absent ⇒ the node whose UI is open. */
  initialNodeId?: string;
  /** Fired after each successful add (a login or a stored key). */
  onAdded?: () => void;
};

/**
 * AddToProviderModal — the unified "+ Add" modal per provider (issue #4464,
 * epic #4460 C). "Add to <P>": a "Subscription login" section (Anthropic,
 * OpenAI) above an "API keys" section, no tabs; Gemini shows the keys section
 * only (R1).
 *
 * Done runs only what has no prior pass (R7): the pasted code, a typed Codex
 * key, and every untested key row. Rows that passed a Test are already stored
 * (#4463 D-1 A), so Done skips them. On any failure the modal stays open with a
 * problem count and per-row messages. Cancel closes it; saved rows stay saved,
 * a pending ChatGPT sign-in is cancelled, and a tenant VM's in-VM sign-in stays
 * resumable (R8, R11).
 *
 * The body mounts only while open, so each opening starts from a clean state.
 */
export function AddToProviderModal(props: AddToProviderModalProps) {
  return (
    <Dialog open={props.isOpen} onOpenChange={open => !open && props.onClose()}>
      {props.isOpen ? <AddToProviderBody {...props} /> : null}
    </Dialog>
  );
}

function useUiNodeLabel(api: ApiClient | null): string {
  const { data } = useFederationNodesInfo(api);
  return data?.localNode?.nodeLabel ?? LOCAL_NODE_LABEL;
}

function AddToProviderBody(props: AddToProviderModalProps) {
  const { api, provider, onClose, onAdded } = props;
  // The LOCAL_NODE_ID sentinel names the UI host, which the per-node read lists
  // under its real id: treat it as "no preselection".
  const initialNodeId =
    props.initialNodeId === LOCAL_NODE_ID ? undefined : props.initialNodeId;
  const vvHeight = useVisualViewportHeight();
  const hasLogin = provider !== "google";
  const loginProvider = provider === "openai" ? "openai" : "anthropic";
  const loginNodes = useLoginNodes(api, loginProvider, hasLogin);
  const localNodeLabel = useUiNodeLabel(api);
  const uiHostLabel =
    loginNodes.nodes.find(n => n.isUiHost)?.nodeLabel ?? localNodeLabel;

  // R2: default selection = initialNodeId ?? the UI host. A preselected node that
  // is unavailable stays selected (its disabled reason shows, the step is off);
  // an id the envelope does not carry falls back to the default with a line
  // naming it.
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const initialKnown =
    initialNodeId !== undefined &&
    loginNodes.nodes.some(n => n.nodeId === initialNodeId);
  const unknownNodeId =
    loginNodes.hasData && initialNodeId !== undefined && !initialKnown
      ? initialNodeId
      : undefined;
  useEffect(() => {
    if (selectedNodeId !== null || !loginNodes.hasData) return;
    setSelectedNodeId(initialKnown ? initialNodeId! : loginNodes.currentNodeId);
  }, [
    selectedNodeId,
    loginNodes.hasData,
    loginNodes.currentNodeId,
    initialKnown,
    initialNodeId,
  ]);
  const selectedNode =
    loginNodes.nodes.find(n => n.nodeId === selectedNodeId) ?? null;

  const invalidate = useInvalidateAfterAdd();
  const refreshUsage = useRefreshAccountUsage(api);
  const handleAdded = useCallback(() => {
    invalidate();
    void refreshUsage().catch(() => undefined);
    onAdded?.();
  }, [invalidate, onAdded, refreshUsage]);

  const anthropic = useAnthropicLoginStep(api, {
    node: provider === "anthropic" ? selectedNode : null,
    isOpen: props.isOpen,
    onAdded: handleAdded,
  });
  const openai = useOpenAiLoginStep(api, {
    node: provider === "openai" ? selectedNode : null,
    isOpen: props.isOpen,
    onAdded: handleAdded,
  });
  const keyRows = useKeyRows(api, provider, uiHostLabel);

  // A stored key reports through `handleAdded` too, so the page refreshes.
  const [lastSaved, setLastSaved] = useState(0);
  useEffect(() => {
    if (keyRows.savedCount > lastSaved) handleAdded();
    setLastSaved(keyRows.savedCount);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyRows.savedCount]);

  const [problems, setProblems] = useState(0);
  const [running, setRunning] = useState(false);

  const loginSaved =
    provider === "anthropic"
      ? anthropic.saved
      : provider === "openai"
        ? openai.saved
        : 0;
  const loginPending =
    provider === "anthropic"
      ? (anthropic.pending ? 1 : 0) + (anthropic.loginToken ? 1 : 0)
      : provider === "openai"
        ? (openai.pending ? 1 : 0) + (openai.codexKey.trim() ? 1 : 0)
        : 0;
  const saved = loginSaved + keyRows.savedCount;
  const pending = loginPending + keyRows.pendingCount;

  const handleDone = async () => {
    if (pending === 0 && keyRows.testingCount === 0) {
      onClose();
      return;
    }
    setRunning(true);
    try {
      const loginRun =
        provider === "anthropic"
          ? anthropic.runDone()
          : provider === "openai"
            ? openai.runDone()
            : Promise.resolve(0);
      const [loginProblems, keyProblems] = await Promise.all([
        loginRun,
        keyRows.addUntested(),
      ]);
      const total = loginProblems + keyProblems;
      setProblems(total);
      if (total === 0) onClose();
    } finally {
      setRunning(false);
    }
  };

  const title = useMemo(() => `Add to ${PROVIDER_NAME[provider]}`, [provider]);

  return (
    <DialogContent
      className="flex flex-col overflow-hidden bg-[var(--app-bg)] outline-none"
      style={{ maxHeight: Math.round(vvHeight * 0.85) }}
      onOpenAutoFocus={e => e.preventDefault()}
      data-testid="add-to-provider-modal"
    >
      <DialogHeader className="shrink-0">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {hasLogin
            ? "Sign in on a node, or add API keys. Press Done when you have finished."
            : "Add Gemini API keys. Press Done when you have finished."}
        </DialogDescription>
      </DialogHeader>

      <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overflow-x-hidden px-1 py-1 text-sm text-[var(--app-fg)]">
        {problems > 0 && (
          <div
            className="rounded-md border border-[var(--accent-rose-400)] bg-red-900/20 px-3 py-2 text-red-400"
            role="alert"
            data-testid="add-modal-banner"
          >
            {problems} problem{problems === 1 ? "" : "s"} · fix{" "}
            {problems === 1 ? "it" : "them"} and press Done again
          </div>
        )}
        {hasLogin && (
          <NodeLoginList
            api={api}
            provider={loginProvider}
            nodes={loginNodes.nodes}
            hasData={loginNodes.hasData}
            error={loginNodes.error}
            onRetry={loginNodes.refetch}
            selectedNodeId={selectedNodeId}
            onSelect={setSelectedNodeId}
            unknownNodeId={unknownNodeId}
            anthropic={provider === "anthropic" ? anthropic : undefined}
            openai={provider === "openai" ? openai : undefined}
          />
        )}
        <KeyEntryRows
          api={api}
          provider={provider}
          uiNodeLabel={uiHostLabel}
          keyRows={keyRows}
        />
      </div>

      <div className="mt-3 flex shrink-0 items-center gap-2 border-t border-[var(--app-border)] pt-3">
        <span
          className="min-w-0 flex-1 truncate text-[length:var(--text-caption)] text-[var(--app-hint)]"
          data-testid="add-modal-counts"
        >
          {saved} saved · {pending} pending
        </span>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="button"
          onClick={() => void handleDone()}
          disabled={running}
          data-testid="add-modal-done"
        >
          {running ? "Working…" : "Done"}
        </Button>
      </div>
    </DialogContent>
  );
}
